/**
 * On-demand documents (#500) at the client seam.
 *
 * Metadata (page, relationship, membership) stays held in the replica. An
 * on-demand document's row exists as soon as its create arrives, with no
 * fields; its components are materialized only while a read leases them. A
 * parent row reaches its document through `row.body`; the document itself is
 * read through its own namespace's `get`, which leases the components it
 * installs and releases them before returning. The value stays resident for one
 * residency grace period and the body is never persisted as a replica row. A
 * query over an on-demand source is refused; a held source may join an
 * on-demand target, reading the joined row before projecting it.
 */

import { describe, expect, it } from "vitest";
import {
  decodeSync,
  makeHlc,
  updateModel,
  type Action,
  type FieldValue,
  type Update,
} from "@ebbjs/core";
import { createMemoryAdapter } from "@ebbjs/storage/memory";
import type { TSchema } from "@sinclair/typebox/type";

import {
  e,
  defineComponent,
  defineModel,
  makeRunId,
  ROOT_ANCHOR,
  TextCellSchema,
  type ModelDef,
  type TextCell,
} from "@ebbjs/schema";
import { defineRelationship, type RelationshipDef } from "@ebbjs/schema";
import { defineSchema, type Schema } from "@ebbjs/schema";
import { createClient } from "../client";
import { OnDemandQueryError } from "../query-builder";
import type { SyncClientOptions } from "../types";
import {
  callApplyAction,
  flushTasks,
  jsonResponse,
  linkAction,
  rowComponents,
  testActions,
  waitFor,
} from "../test-utils";

type AnyModelDef = ModelDef<Record<string, TSchema>>;
type AnyRelationshipDef = RelationshipDef<AnyModelDef, AnyModelDef>;
type AnySchema = Schema<
  Record<string, AnyModelDef>,
  Record<string, AnyRelationshipDef> | undefined
>;

/** A client mounted with the harness's actions, so `client.actions` is typed. */
type MountedClient<S extends AnySchema> = ReturnType<typeof harness<S>>["client"];

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

const page = defineModel("page", { title: e.string() });
const pageBody = defineModel(
  "page_body",
  { content: e.log(TextCellSchema) },
  { materialization: "on-demand" },
);
const pageSchema = defineSchema({
  models: { page, page_body: pageBody },
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
const bodyDocModel = "page_body";
const bodyComponent = "page_body/content";

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
      { content: initialContent(input.body) },
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
    (update) => updateModel(update) === bodyDocModel,
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

/** A link merge on its source row: one presence key at `(as, type)`. */
const link = (gsn: number, sourceId: string, as: string, type: string, targetId: string): Action =>
  linkAction({
    id: `a_${gsn}`,
    hlc: makeHlc(10 + gsn),
    gsn,
    sourceId,
    edges: [{ as, type, targetId }],
  });

const put = (gsn: number, id: string, type: string, fields: Record<string, unknown>): Action =>
  seedAction(
    gsn,
    rowComponents(type, fields).map(
      ([component, value]): Update => ({
        id: `u_${gsn}_${component}`,
        subject_id: id,
        component,
        method: "replace" as const,
        data: field(value, `u_${gsn}_${component}`),
      }),
    ),
  );

// ---------------------------------------------------------------------------
// Residency
// ---------------------------------------------------------------------------

describe("on-demand document residency", () => {
  it("holds page metadata and memberships while holding no body component", async () => {
    const { client, written } = harness(pageSchema);
    const { pageId, bodyId } = await createPage(
      client,
      written,
      { title: "One", body: "hello" },
      1,
    );

    // The link and the two memberships are platform rows, so they share the
    // `ebb` model and the component is what distinguishes them.
    // The two memberships are platform rows; the page's edge is a key of the
    // page row itself, so it adds no row.
    expect(client.replicaStats.byModel).toMatchObject({ page: 1, ebb: 2 });
    expect(client.replica.get(pageId)?.data.fields.title.value).toBe("One");
    expect(client.replica.components("ebb/membership")).toHaveLength(2);
    expect(client.replica.components("ebb/link")).toEqual([pageId]);

    // A create makes the body row present with the create's facts and no
    // fields; which components the replica holds is residency, not existence.
    expect(client.replicaStats.byModel[bodyDocModel]).toBe(1);
    const created = client.replica.get(bodyId);
    expect(created?.exists).toBe(true);
    expect(created?.model).toBe(bodyDocModel);
    expect(created?.created_hlc).not.toBeNull();
    expect(Object.keys(created?.data.fields ?? {})).toEqual([]);
    expect(client.replicaStats.heldByModel[bodyDocModel]).toBeUndefined();
    expect(client.replicaStats.nonResidentComponents).toMatchObject({
      "page_body/content": 1,
    });

    // Reading a body component still needs the residency path.
    const body = await client.page_body.get(bodyId);
    expect(textOf(body!.content ?? {})).toBe("hello");
    expect(client.replica.isComponentResident(bodyId, bodyComponent)).toBe(true);

    const parent = await client.page.get(pageId);
    expect((await parent!.body)!.id).toBe(bodyId);
  });

  it("leases a body through its namespace and leaves it warm for the grace period", async () => {
    const { client, written } = harness(pageSchema, { residencyTtlMs: 0 });
    const { bodyId } = await createPage(client, written, { title: "One", body: "hello" });

    const body = await client.page_body.get(bodyId);

    expect(textOf(body!.content ?? {})).toBe("hello");
    expect(client.replica.get(bodyId)).toBeDefined();
    // The read released its claim before projecting, so nothing holds a lease
    // and the value stays resident on the grace period alone.
    expect(client.replicaStats.leases).toMatchObject({
      leased: 0,
      inactive: 1,
      resident: 1,
      byComponent: { "page_body/content": { leased: 0, inactive: 1 } },
    });
  });

  it("releases a read body once its grace period elapses, journaling nothing", async () => {
    const { client, written } = harness(pageSchema, { residencyTtlMs: 10 });
    const { bodyId } = await createPage(client, written, { title: "One", body: "hello" });

    await client.page_body.get(bodyId);
    expect(client.replica.get(bodyId)).toBeDefined();
    const revision = client.replica.revision;

    await waitFor(() => client.replica.get(bodyId) === undefined);

    // Expiry is a residency event: no content change, no journal entry.
    expect(client.replica.revision).toBe(revision);
    expect(client.replica.changesSince(revision)).toEqual([]);
    expect(client.replicaStats.leases).toMatchObject({ leased: 0, inactive: 0, resident: 0 });
  });

  it("persists held rows only, never a read body", async () => {
    const { client, storage, written } = harness(pageSchema);
    const { bodyId } = await createPage(client, written, { title: "One", body: "hello" }, 1);

    await client.page_body.get(bodyId);
    expect(client.replica.isComponentResident(bodyId, bodyComponent)).toBe(true);

    await client.persistReplica();

    const record = await storage.replica.load();
    const types = (record?.entities ?? []).map((row) => row.model);
    expect(types).not.toContain(bodyDocModel);
    expect(types).toContain("page");
    // The two membership rows are the `ebb` rows; the page's edge rides on the
    // page row.
    expect(types.filter((type) => type === "ebb")).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Residency per component (#802)
// ---------------------------------------------------------------------------

describe("residency per component", () => {
  // #775's shape: the note's metadata and its body are components of one row,
  // and only the body is on demand.
  const note = defineModel("note", {
    title: e.string(),
    status: e.string(),
    updated_at: e.number(),
    body: defineComponent("note/body", e.string(), { loading: "lazy" }),
  });
  const noteSchema = defineSchema({ models: { note }, version: 1 });
  const noteId = "note_1";

  const seedNote = (client: ReturnType<typeof harness<typeof noteSchema>>["client"]) =>
    callApplyAction(
      client,
      put(1, noteId, "note", {
        title: "One",
        status: "open",
        updated_at: 7,
        body: "300 KB body",
      }),
    );

  it("holds the metadata components and leases only the body", async () => {
    const { client } = harness(noteSchema, { residencyTtlMs: 0 });
    await seedNote(client);

    expect(Object.keys(client.replica.get(noteId)?.data.fields ?? {}).sort()).toEqual([
      "status",
      "title",
      "updated_at",
    ]);
    expect(client.replicaStats).toMatchObject({
      held: 1,
      components: 4,
      residentComponents: 3,
      nonResident: 1,
      nonResidentComponents: { "note/body": 1 },
    });

    const row = await client.note.get(noteId);
    expect(row?.body).toBe("300 KB body");
    expect(client.replica.get(noteId)?.data.fields.body).toBeDefined();
    expect(client.replicaStats).toMatchObject({
      residentComponents: 4,
      nonResident: 0,
      leases: { leased: 0, inactive: 1, byComponent: { "note/body": { leased: 0 } } },
    });
  });

  it("releases the body after its grace period and keeps the metadata row", async () => {
    const { client } = harness(noteSchema, { residencyTtlMs: 10 });
    await seedNote(client);
    await client.note.get(noteId);
    expect(client.replica.isComponentResident(noteId, "note/body")).toBe(true);

    await waitFor(() => client.replica.get(noteId)?.data.fields.body === undefined);

    expect(client.replica.components("note/body")).toEqual([noteId]);
    expect(client.replicaStats).toMatchObject({ nonResident: 1, residentComponents: 3 });
  });

  it("keeps the lazy value in the local store when the replica mirrors a write", async () => {
    const { client, storage } = harness(noteSchema);
    await seedNote(client);

    const stored = await storage.entities.get(noteId);
    expect(stored?.data.fields.body).toEqual(expect.objectContaining({ value: "300 KB body" }));

    await client.note.get(noteId);
    const reopened = await client.note.get(noteId);
    expect(reopened?.body).toBe("300 KB body");
  });
});

// ---------------------------------------------------------------------------
// Every component of a row (#934)
// ---------------------------------------------------------------------------

describe("a row with more on-demand components than the old window", () => {
  // Twenty on-demand components on one row, past the 16 the removed window
  // held: on that code the earliest reads are dropped from the returned row.
  const fields = Array.from({ length: 20 }, (_, index) => `f_${index}`);
  const values = Object.fromEntries(fields.map((field) => [field, `${field} value`]));
  const lazyNote = defineModel(
    "lazy_note",
    Object.fromEntries(
      fields.map((field) => [
        field,
        defineComponent(`lazy_note/${field}`, e.string(), { loading: "lazy" }),
      ]),
    ),
  );
  const lazyNoteSchema = defineSchema({ models: { lazy_note: lazyNote }, version: 1 });
  const lazyNoteId = "lazy_note_1";

  it("returns every component the read opened", async () => {
    const { client } = harness(lazyNoteSchema, { residencyTtlMs: 0 });
    await callApplyAction(client, put(1, lazyNoteId, "lazy_note", values));

    const row = await client.lazy_note.get(lazyNoteId);

    expect(row).toMatchObject({ id: lazyNoteId, ...values });
    expect(
      fields.filter(
        (field) => !client.replica.isComponentResident(lazyNoteId, `lazy_note/${field}`),
      ),
    ).toEqual([]);
    // Twenty leases, one grace period: no cap trimmed the earliest reads.
    expect(client.replicaStats.leases).toMatchObject({
      leased: 0,
      inactive: 20,
      resident: 20,
    });
    expect(Object.keys(client.replicaStats.leases.byComponent)).toHaveLength(20);
  });
});

describe("a row with three on-demand components", () => {
  const lazyNote = defineModel("lazy_note", {
    title: defineComponent("lazy_note/title", e.string(), { loading: "lazy" }),
    body: defineComponent("lazy_note/body", e.string(), { loading: "lazy" }),
    appendix: defineComponent("lazy_note/appendix", e.string(), { loading: "lazy" }),
  });
  const lazyNoteSchema = defineSchema({ models: { lazy_note: lazyNote }, version: 1 });
  const lazyNoteId = "lazy_note_1";

  it("returns all three after all three are read", async () => {
    const { client } = harness(lazyNoteSchema, { residencyTtlMs: 0 });
    await callApplyAction(
      client,
      put(1, lazyNoteId, "lazy_note", {
        title: "One",
        body: "300 KB body",
        appendix: "1 MB appendix",
      }),
    );

    const row = await client.lazy_note.get(lazyNoteId);

    expect(row).toMatchObject({
      id: lazyNoteId,
      title: "One",
      body: "300 KB body",
      appendix: "1 MB appendix",
    });
    expect(
      ["title", "body", "appendix"].map((field) =>
        client.replica.isComponentResident(lazyNoteId, `lazy_note/${field}`),
      ),
    ).toEqual([true, true, true]);
    expect(client.replicaStats.leases).toMatchObject({ leased: 0, inactive: 3, resident: 3 });
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
    await flushTasks();

    expect(store.getSnapshot().status).toBe("current");
    expect(store.getSnapshot().data?.map((row) => row.title)).toEqual(["One"]);
    unsubscribe();
  });
});

// ---------------------------------------------------------------------------
// Held source joining an on-demand target
// ---------------------------------------------------------------------------

describe("held source with an on-demand join", () => {
  const pageEntity = defineModel("page", { title: e.string() });
  const contentEntity = defineModel(
    "page_content",
    { text: e.string() },
    { materialization: "on-demand" },
  );
  const joinSchema = defineSchema({
    models: { page: pageEntity, page_content: contentEntity },
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
    await callApplyAction(client, link(3, "page_1", "content", "page", "page_content_1"));
  };

  it("reads the joined row before projecting, without journaling the read", async () => {
    const { client } = harness(joinSchema, { residencyTtlMs: 0 });
    await seed(client);

    const store = client.page.query().with({ content: true }).result();
    const unsubscribe = store.subscribe(() => {});
    await waitFor(() => store.getSnapshot().status === "current");

    const joined = (): { id: string; text: string } | null | undefined =>
      store.getSnapshot().data?.[0]?.content as { id: string; text: string } | null | undefined;
    expect(joined()).toMatchObject({ id: "page_content_1", text: "body" });
    expect(client.replica.isComponentResident("page_content_1", "page_content/text")).toBe(true);

    // The joined body was installed by a read: residency, not content, so the
    // cached result has no reason to re-run.
    const revision = client.replica.revision;
    await flushTasks();
    expect(store.getSnapshot().status).toBe("current");
    expect(joined()).toMatchObject({ id: "page_content_1", text: "body" });
    expect(client.replica.revision).toBe(revision);
    expect(client.replica.changesSince(revision)).toEqual([]);

    unsubscribe();
  });
});
