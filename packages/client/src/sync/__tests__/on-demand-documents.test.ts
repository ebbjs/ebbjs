/**
 * On-demand documents (#500) at the client seam.
 *
 * Metadata (page, relationship, membership) stays held in the replica while an
 * on-demand document entity is materialized only while it is open. A parent
 * row reaches its document through `row.body`; the document itself is read
 * through its own namespace's `get`, which pins it in an LRU window. `close`
 * or the TTL releases it, and it is never persisted as a replica row. A query
 * over an on-demand source is refused; a held source may join an on-demand
 * target, with the cached result going `stale` while the joined row loads.
 */

import { describe, expect, it, vi } from "vitest";
import { decodeSync, makeHlc, type Action, type FieldValue, type Update } from "@ebbjs/core";
import { createMemoryAdapter } from "@ebbjs/storage/memory";
import type { TSchema } from "@sinclair/typebox/type";

import {
  CURRENT_TEXT_VERSION,
  e,
  defineEntity,
  makeRunId,
  ROOT_ANCHOR,
  TextCellSchema,
  type EntityDef,
  type TextCell,
} from "@ebbjs/schema";
import { defineRelationship, type RelationshipDef } from "@ebbjs/schema";
import { defineSchema, type Schema } from "@ebbjs/schema";
import { createClient } from "../client";
import { OnDemandQueryError } from "../query-builder";
import type { SyncClientOptions } from "../types";
import { callApplyAction, jsonResponse, waitFor } from "../test-utils";
import { testActions } from "./test-actions";

type AnyEntityDef = EntityDef<Record<string, TSchema>>;
type AnyRelationshipDef = RelationshipDef<AnyEntityDef, AnyEntityDef>;
type AnySchema = Schema<
  Record<string, AnyEntityDef>,
  Record<string, AnyRelationshipDef> | undefined
>;

/** A client mounted with the harness's actions, so `client.actions` is typed. */
type MountedClient<S extends AnySchema> = ReturnType<typeof harness<S>>["client"];

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function harness<S extends AnySchema>(
  activeSchema: S,
  opts: Omit<SyncClientOptions, "serverUrl" | "actorId" | "schema"> = {},
) {
  const storage = createMemoryAdapter();
  const written: Action[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/sync/actions")) {
      if (init?.body instanceof Uint8Array) {
        written.push(...decodeSync<{ actions: Action[] }>(init.body).actions);
      }
      return jsonResponse({ rejected: [] });
    }
    return jsonResponse({});
  }) as typeof fetch;
  const client = createClient({
    serverUrl: "http://x",
    actorId: "actor_1",
    storage,
    schema: activeSchema,
    actions: testActions(activeSchema),
    fetchImpl,
    ...opts,
  });
  return { client, storage, written };
}

const page = defineEntity("page", { title: e.string() });
const pageBody = defineEntity(
  "page_body",
  { content: e.map(TextCellSchema), version: e.number() },
  { materialization: "on-demand" },
);
const pageSchema = defineSchema({
  entities: { page, page_body: pageBody },
  relationships: {
    body: defineRelationship({
      source: page,
      target: pageBody,
      as: "body",
      sourceCardinality: "one",
    }),
  },
  version: 1,
});
const bodyDocType = "page_body";

let seededDocument = 0;

/** The initial run an app passes to the document entity's `create`. */
const initialContent = (text: string): Record<string, TextCell> => {
  seededDocument += 1;
  const stamp = makeHlc(1_711_036_800_000 + seededDocument);
  const run: TextCell = {
    kind: "run",
    id: makeRunId(stamp, "actor_1"),
    text,
    author: "actor_1",
    stamp,
    anchor: ROOT_ANCHOR,
  };
  return { [run.id]: run };
};

/** The run text of a projected document row. */
const textOf = (content: Record<string, TextCell>): string =>
  Object.values(content)
    .flatMap((cell) => (cell.kind === "run" ? [cell.text] : []))
    .join("");

/**
 * Create a page with its document in one Action, optionally folding the echo
 * so the rows are durable.
 */
const createPage = async (
  client: MountedClient<typeof pageSchema>,
  written: readonly Action[],
  input: { title: string; body: string },
  gsn?: number,
): Promise<{ pageId: string; bodyId: string }> => {
  const before = written.length;
  const { pageId } = await client.actions.run(({ page: pageDraft, page_body }) => {
    const createdPage = pageDraft.create({ title: input.title }, { groups: ["g_1"] });
    const createdBody = page_body.create(
      { content: initialContent(input.body), version: CURRENT_TEXT_VERSION },
      { groups: ["g_1"] },
    );
    pageDraft.link(createdPage.id, "body", createdBody.id);
    return { pageId: createdPage.id };
  });
  const created = written.slice(before);
  if (gsn !== undefined) {
    for (const action of created) await callApplyAction(client, { ...action, gsn });
  }
  const bodyId = created[0]!.updates.find(
    (update) => update.subject_type === bodyDocType,
  )!.subject_id;
  return { pageId, bodyId };
};

const field = (value: unknown, id: string): FieldValue => ({
  value,
  update_id: id,
  hlc: makeHlc(1),
});

const seedAction = (gsn: number, updates: Update[]): Action => ({
  id: `a_${gsn}`,
  actor_id: "actor_1",
  hlc: makeHlc(10 + gsn),
  gsn,
  updates,
});

const put = (gsn: number, id: string, type: string, fields: Record<string, unknown>): Action =>
  seedAction(gsn, [
    {
      id: `u_${gsn}`,
      subject_id: id,
      subject_type: type,
      method: "put",
      data: {
        fields: Object.fromEntries(
          Object.entries(fields).map(([key, value]) => [key, field(value, `u_${gsn}`)]),
        ),
      },
    },
  ]);

// ---------------------------------------------------------------------------
// Residency
// ---------------------------------------------------------------------------

describe("on-demand document residency", () => {
  it("holds page metadata and memberships while leaving the body out of the replica", async () => {
    const { client, written } = harness(pageSchema);
    const { pageId, bodyId } = await createPage(
      client,
      written,
      { title: "One", body: "hello" },
      1,
    );

    expect(client.replicaStats.byType).toMatchObject({
      page: 1,
      relationship: 1,
      entityGroup: 2,
    });
    expect(client.replicaStats.byType[bodyDocType]).toBeUndefined();
    expect(client.replica.get(bodyId)).toBeUndefined();
    expect(client.replica.get(pageId)?.data.fields.title.value).toBe("One");

    const parent = await client.page.get(pageId);
    expect((await parent!.body)!.id).toBe(bodyId);
  });

  it("opens a body through its namespace, pinning it, and releases it on close", async () => {
    const { client, written } = harness(pageSchema, { pinnedTtlMs: 0 });
    const { bodyId } = await createPage(client, written, { title: "One", body: "hello" });

    const body = await client.page_body.get(bodyId);

    expect(textOf(body!.content ?? {})).toBe("hello");
    expect(client.replica.isOpen(bodyId)).toBe(true);
    expect(client.replica.get(bodyId)).toBeDefined();
    expect(client.replicaStats.pinned).toBe(1);

    client.replica.close(bodyId);

    expect(client.replica.isOpen(bodyId)).toBe(false);
    expect(client.replica.get(bodyId)).toBeUndefined();
    expect(client.replicaStats.pinned).toBe(0);
  });

  it("keeps a closed body cached until its TTL, then releases it", async () => {
    const { client, written } = harness(pageSchema, { pinnedTtlMs: 10 });
    const { bodyId } = await createPage(client, written, { title: "One", body: "hello" });

    await client.page_body.get(bodyId);
    client.replica.close(bodyId);

    expect(client.replica.isOpen(bodyId)).toBe(false);
    expect(client.replica.get(bodyId)).toBeDefined();

    await waitFor(() => client.replica.get(bodyId) === undefined);
    expect(client.replicaStats.pinned).toBe(0);
  });

  it("releases a closed body after the pinned TTL", async () => {
    const { client, written } = harness(pageSchema, { pinnedTtlMs: 10 });
    const { bodyId } = await createPage(client, written, { title: "One", body: "hello" });

    await client.page_body.get(bodyId);
    expect(client.replica.isOpen(bodyId)).toBe(true);

    client.replica.close(bodyId);
    await waitFor(() => !client.replica.get(bodyId));

    expect(client.replicaStats.pinned).toBe(0);
  });

  it("releases the least recently opened body when the pinned window overflows", async () => {
    const { client, written } = harness(pageSchema, { pinnedCapacity: 1, pinnedTtlMs: 0 });
    const first = await createPage(client, written, { title: "One", body: "hello" });
    const second = await createPage(client, written, { title: "Two", body: "world" });

    await client.page_body.get(first.bodyId);
    expect(client.replica.isOpen(first.bodyId)).toBe(true);

    const secondBody = await client.page_body.get(second.bodyId);
    expect(textOf(secondBody!.content ?? {})).toBe("world");
    expect(client.replica.isOpen(second.bodyId)).toBe(true);
    expect(client.replica.isOpen(first.bodyId)).toBe(false);
    expect(client.replica.get(first.bodyId)).toBeUndefined();
  });

  it("persists held rows only, never an opened body", async () => {
    const { client, storage, written } = harness(pageSchema);
    const { bodyId } = await createPage(client, written, { title: "One", body: "hello" }, 1);

    await client.page_body.get(bodyId);
    expect(client.replica.isOpen(bodyId)).toBe(true);

    await client.persistReplica();

    const record = await storage.replica.load();
    const types = (record?.entities ?? []).map((row) => row.type);
    expect(types).not.toContain(bodyDocType);
    expect(types).toContain("page");
    expect(types).toContain("relationship");
    expect(types).toContain("entityGroup");
  });
});

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

describe("querying on-demand types", () => {
  it("refuses a query whose source type is on demand", () => {
    const { client } = harness(pageSchema);

    expect(() => client.page_body.query()).toThrow(OnDemandQueryError);
    expect(() => client.page_body.query()).toThrow(/held-only/);
  });

  it("keeps a held-source query over held rows synchronous", async () => {
    const { client, written } = harness(pageSchema);
    await createPage(client, written, { title: "One", body: "hello" }, 1);

    const store = client.page.query().result();
    const unsubscribe = store.subscribe(() => {});
    await flush();

    expect(store.getSnapshot().status).toBe("current");
    expect(store.getSnapshot().data?.map((row) => row.title)).toEqual(["One"]);
    unsubscribe();
  });
});

// ---------------------------------------------------------------------------
// Held source joining an on-demand target
// ---------------------------------------------------------------------------

describe("held source with an on-demand join", () => {
  const pageEntity = defineEntity("page", { title: e.string() });
  const contentEntity = defineEntity(
    "page_content",
    { text: e.string() },
    { materialization: "on-demand" },
  );
  const joinSchema = defineSchema({
    entities: { page: pageEntity, page_content: contentEntity },
    relationships: {
      page_content: defineRelationship({
        source: pageEntity,
        target: contentEntity,
        as: "content",
        sourceCardinality: "one",
      }),
    },
    version: 1,
  });

  const seed = async (client: MountedClient<typeof joinSchema>) => {
    await callApplyAction(client, put(1, "page_content_1", "page_content", { text: "body" }));
    await callApplyAction(client, put(2, "page_1", "page", { title: "One" }));
    await callApplyAction(
      client,
      put(3, "rel_1", "relationship", {
        source_id: "page_1",
        target_id: "page_content_1",
        field: "content",
        type: "page",
      }),
    );
  };

  it("loads the joined row before projecting and shows stale then current on a re-run", async () => {
    const { client, storage } = harness(joinSchema, { pinnedTtlMs: 0 });
    await seed(client);

    const store = client.page.query().with({ content: true }).result();
    const unsubscribe = store.subscribe(() => {});
    await waitFor(() => store.getSnapshot().status === "current");

    const joined = (): { id: string; text: string } | null | undefined =>
      store.getSnapshot().data?.[0]?.content as { id: string; text: string } | null | undefined;
    expect(joined()).toMatchObject({ id: "page_content_1", text: "body" });
    expect(client.replica.isOpen("page_content_1")).toBe(true);

    const contentRow = await storage.entities.get("page_content_1");
    expect(contentRow).not.toBeNull();
    const realGet = storage.entities.get.bind(storage.entities);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const getSpy = vi.spyOn(storage.entities, "get").mockImplementation(async (id: string) => {
      if (id !== "page_content_1") return realGet(id);
      await gate;
      return contentRow;
    });

    // Closing the pin evicts the joined row, so the cached result re-runs and
    // must load it again. The load stays pending until the gate opens.
    client.replica.close("page_content_1");
    await flush();

    expect(store.getSnapshot().status).toBe("stale");
    // The stale result stays usable while the load is in flight.
    expect(joined()).toMatchObject({ id: "page_content_1", text: "body" });

    release();
    await waitFor(() => store.getSnapshot().status === "current");
    expect(joined()).toMatchObject({ id: "page_content_1", text: "body" });
    expect(client.replica.isOpen("page_content_1")).toBe(true);

    getSpy.mockRestore();
    unsubscribe();
  });
});
