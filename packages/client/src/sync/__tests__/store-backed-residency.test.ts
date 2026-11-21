/**
 * Residency at the client seam (#943).
 *
 * A row the replica holds carries a value for every component it knows, and a
 * row it does not hold is the entity store's to serve. A read claims what it
 * installs, so the value stays warm for one grace period and a remount inside
 * it reads nothing. Nothing is declared: a selection and a lease decide what a
 * read projects and what stays in memory.
 */

import { describe, expect, it, vi } from "vitest";
import {
  decodeSync,
  makeHlc,
  updateModel,
  type Action,
  type Entity,
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
  storage = createMemoryAdapter(),
) {
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
const pageBody = defineModel("page_body", { content: e.log(TextCellSchema) });
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

describe("a synced row is resident", () => {
  it("keeps every component a synced row carries, with no declaration to consult", async () => {
    const { client, written } = harness(pageSchema);
    const { pageId, bodyId } = await createPage(
      client,
      written,
      { title: "One", body: "hello" },
      1,
    );

    // The link and the two memberships are platform rows, so they share the
    // `ebb` model and the component is what distinguishes them. The page's
    // edge is a key of the page row itself, so it adds no row.
    expect(client.replicaStats.byModel).toMatchObject({ page: 1, page_body: 1, ebb: 2 });
    expect(client.replica.get(pageId)?.data.fields.title.value).toBe("One");
    expect(client.replica.components("ebb/membership")).toHaveLength(2);
    expect(client.replica.components("ebb/link")).toEqual([pageId]);

    const created = client.replica.get(bodyId);
    expect(created?.exists).toBe(true);
    expect(created?.model).toBe(bodyDocModel);
    expect(client.replica.isComponentResident(bodyId, bodyComponent)).toBe(true);
    // Nothing holds it: the component arrived with the row, so no lease decides
    // its residency.
    expect(client.replicaStats.leases.resident).toBe(0);

    const body = await client.page_body.get(bodyId);
    expect(textOf(body!.content ?? {})).toBe("hello");

    const parent = await client.page.get(pageId);
    expect((await parent!.body)!.id).toBe(bodyId);
  });

  it("leaves a row it installed for a read warm for the grace period", async () => {
    const { client, written } = harness(pageSchema, { residencyTtlMs: 0 });
    const { bodyId } = await createPage(client, written, { title: "One", body: "hello" });
    // A row outside the client's subscribed set: the store keeps it, the
    // replica does not hold it.
    client.replica.evict([bodyId]);
    expect(client.replica.get(bodyId)).toBeUndefined();

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

  it("releases a row a read installed once its grace period elapses, journaling nothing", async () => {
    const { client, written } = harness(pageSchema, { residencyTtlMs: 10 });
    const { bodyId } = await createPage(client, written, { title: "One", body: "hello" }, 1);
    client.replica.evict([bodyId]);

    await client.page_body.get(bodyId);
    expect(client.replica.get(bodyId)).toBeDefined();
    const revision = client.replica.revision;

    await waitFor(() => client.replica.get(bodyId) === undefined);

    // Expiry is a residency event: no content change, no journal entry.
    expect(client.replica.revision).toBe(revision);
    expect(client.replica.changesSince(revision)).toEqual([]);
    expect(client.replicaStats.leases).toMatchObject({ leased: 0, inactive: 0, resident: 0 });
  });

  it("persists the row a read installed, so a remount inside the grace period re-reads nothing", async () => {
    const { client, storage, written } = harness(pageSchema);
    const { bodyId } = await createPage(client, written, { title: "One", body: "hello" }, 1);
    client.replica.evict([bodyId]);
    await client.page_body.get(bodyId);
    expect(client.replica.isComponentResident(bodyId, bodyComponent)).toBe(true);

    await client.persistReplica();

    // The record is the fast path back to the view, so what memory holds it
    // holds; the durable rows are the store's own.
    const record = await storage.replica.load();
    const types = (record?.entities ?? []).map((row) => row.model);
    expect(types).toContain(bodyDocModel);
    expect(types).toContain("page");
    expect(types.filter((type) => type === "ebb")).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Store-backed reads with no declaration (#943)
// ---------------------------------------------------------------------------

describe("store-backed reads with no declaration", () => {
  const note = defineModel("note", { title: e.string(), body: e.string() });
  const storeSchema = defineSchema({ models: { note }, version: 1 });
  const storedId = "note_1";

  it("serves a component the replica does not hold from the entity store and makes it resident", async () => {
    const { client, storage } = harness(storeSchema, { residencyTtlMs: 0 });
    await callApplyAction(client, put(1, storedId, "note", { title: "One", body: "300 KB body" }));
    // Eviction is what a row outside the client's subscribed set looks like:
    // the store keeps it, the replica does not hold it.
    client.replica.evict([storedId]);
    expect(client.replica.get(storedId)).toBeUndefined();

    const served = vi.spyOn(storage.entities, "get");
    const row = await client.note.get(storedId);

    expect(row).toMatchObject({ id: storedId, title: "One", body: "300 KB body" });
    // The store was the row's source, and the values it served are the
    // replica's now: no declaration said they should be.
    expect(served).toHaveBeenCalledWith(storedId);
    expect(served.mock.results.length).toBeGreaterThan(0);
    expect(client.replica.isComponentResident(storedId, "note/title")).toBe(true);
    expect(client.replica.isComponentResident(storedId, "note/body")).toBe(true);
    served.mockRestore();
  });

  it("makes a selected component resident with no static declaration", async () => {
    const { client } = harness(storeSchema, { residencyTtlMs: 0 });
    await callApplyAction(client, put(1, storedId, "note", { title: "One", body: "300 KB body" }));

    const row = await client.note.get(storedId, { select: { body: true } });

    expect(row).toMatchObject({ id: storedId, body: "300 KB body" });
    expect(row).not.toHaveProperty("title");
    expect(client.replica.isComponentResident(storedId, "note/body")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Residency per row (#943)
// ---------------------------------------------------------------------------

describe("residency per row", () => {
  const note = defineModel("note", {
    title: e.string(),
    status: e.string(),
    updated_at: e.number(),
    body: defineComponent("note/body", e.string()),
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

  it("keeps every component of a row the log folded", async () => {
    const { client } = harness(noteSchema, { residencyTtlMs: 0 });
    await seedNote(client);

    expect(Object.keys(client.replica.get(noteId)?.data.fields ?? {}).sort()).toEqual([
      "body",
      "status",
      "title",
      "updated_at",
    ]);
    expect(client.replicaStats).toMatchObject({ components: 4, leases: { resident: 0 } });

    const row = await client.note.get(noteId);
    expect(row?.body).toBe("300 KB body");
    expect(client.replicaStats.leases.resident).toBe(0);
  });

  it("re-reads a row the replica released instead of losing it", async () => {
    const { client } = harness(noteSchema, { residencyTtlMs: 10 });
    await seedNote(client);
    client.replica.evict([noteId]);

    expect(await client.note.get(noteId)).toMatchObject({ body: "300 KB body" });
    await waitFor(() => client.replica.get(noteId) === undefined);

    expect(await client.note.get(noteId)).toMatchObject({ body: "300 KB body" });
    expect(client.replica.components("note/body")).toEqual([noteId]);
  });

  it("keeps the value in the local store when the replica mirrors a write", async () => {
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
// The store-mirror rule (#943)
// ---------------------------------------------------------------------------

describe("the store-mirror rule", () => {
  const note = defineModel("note", { title: e.string(), body: e.string() });
  const noteSchema = defineSchema({ models: { note }, version: 1 });
  const noteId = "note_1";

  const row = (fields: Record<string, unknown>): Entity => ({
    id: noteId,
    model: "note",
    data: {
      fields: Object.fromEntries(
        Object.entries(fields).map(([name, value]) => [name, field(value, `u_${name}`)]),
      ),
    },
    exists: true,
    created_hlc: makeHlc(10),
    updated_hlc: makeHlc(10),
    deleted_hlc: null,
    last_gsn: 1,
  });

  it("does not truncate the store row when a pre-#943 record carried only the held components", async () => {
    const storage = createMemoryAdapter();
    await storage.entities.set(row({ title: "One", body: "300 KB body" }));
    // A format-6 record from a client whose body was `loading: "lazy"`: it kept
    // the title and named the body in `notResident`, so the row it carries has
    // no body to adopt.
    await storage.replica.save({
      format: 6,
      // The record already folded the create, so the tail is empty and cannot
      // supply the body the record left behind.
      position: 1,
      revision: 1,
      entities: [row({ title: "One" })],
      componentVersions: { [noteId]: { "note/title": 1, "note/body": 1 } },
      notResident: { [noteId]: ["note/body"] },
    } as unknown as Parameters<typeof storage.replica.save>[0]);
    await storage.actions.append(put(1, noteId, "note", { title: "One", body: "300 KB body" }));

    const { client } = harness(noteSchema, {}, storage);
    await client.hydrateReplica();
    // The record is a different shape, so it is not adopted: replaying the log
    // rebuilds the row whole, body included.
    expect(client.replicaLoad?.recordEntities).toBe(0);
    expect(client.replicaLoad?.tailEntries).toBe(1);

    await client.actions.run(({ note: notes }) => notes.update(noteId, { title: "Two" }));

    const stored = await storage.entities.get(noteId);
    expect(stored?.data.fields.title).toEqual(expect.objectContaining({ value: "Two" }));
    expect(stored?.data.fields.body).toEqual(expect.objectContaining({ value: "300 KB body" }));
  });

  it("mirrors only when the replica covers every component the store row carries", async () => {
    const { client, storage } = harness(noteSchema);
    // The store's row is whole; the replica has never seen it, so a local patch
    // only knows the component it writes. Mirroring that view would drop the
    // body the store still carries.
    await storage.entities.set(row({ title: "One", body: "300 KB body" }));

    await client.actions.run(({ note: notes }) => notes.update(noteId, { title: "Two" }));

    const stored = await storage.entities.get(noteId);
    expect(stored?.data.fields.title).toEqual(expect.objectContaining({ value: "Two" }));
    expect(stored?.data.fields.body).toEqual(expect.objectContaining({ value: "300 KB body" }));
  });

  it("mirrors a folded row whole into the store", async () => {
    const { client, storage } = harness(noteSchema);
    await callApplyAction(client, put(1, noteId, "note", { title: "One", body: "300 KB body" }));

    await client.actions.run(({ note: notes }) => notes.update(noteId, { title: "Two" }));

    const stored = await storage.entities.get(noteId);
    expect(stored?.data.fields.title).toEqual(expect.objectContaining({ value: "Two" }));
    expect(stored?.data.fields.body).toEqual(expect.objectContaining({ value: "300 KB body" }));
  });
});

// ---------------------------------------------------------------------------
// Every component of a row (#934)
// ---------------------------------------------------------------------------

describe("a row with more components than the old window", () => {
  // Twenty components on one row, past the 16 the removed window held: on that
  // code the earliest reads were dropped from the returned row.
  const fields = Array.from({ length: 20 }, (_, index) => `f_${index}`);
  const values = Object.fromEntries(fields.map((field) => [field, `${field} value`]));
  const wideNote = defineModel(
    "wide_note",
    Object.fromEntries(
      fields.map((field) => [field, defineComponent(`wide_note/${field}`, e.string())]),
    ),
  );
  const wideNoteSchema = defineSchema({ models: { wide_note: wideNote }, version: 1 });
  const wideNoteId = "wide_note_1";

  it("returns every component the read projects", async () => {
    const { client } = harness(wideNoteSchema, { residencyTtlMs: 0 });
    await callApplyAction(client, put(1, wideNoteId, "wide_note", values));

    const row = await client.wide_note.get(wideNoteId);

    expect(row).toMatchObject({ id: wideNoteId, ...values });
    expect(
      fields.filter(
        (field) => !client.replica.isComponentResident(wideNoteId, `wide_note/${field}`),
      ),
    ).toEqual([]);
    // No cap trimmed the earliest reads, and nothing had to be leased: the row
    // arrived whole.
    expect(client.replicaStats.leases.resident).toBe(0);
  });

  it("returns every component of a row it reads back from the store", async () => {
    const { client } = harness(wideNoteSchema, { residencyTtlMs: 0 });
    await callApplyAction(client, put(1, wideNoteId, "wide_note", values));
    client.replica.evict([wideNoteId]);

    const row = await client.wide_note.get(wideNoteId);

    expect(row).toMatchObject({ id: wideNoteId, ...values });
    expect(
      fields.filter(
        (field) => !client.replica.isComponentResident(wideNoteId, `wide_note/${field}`),
      ),
    ).toEqual([]);
    expect(client.replicaStats.leases).toMatchObject({ leased: 0, inactive: 20, resident: 20 });
  });
});

describe("a row with three components", () => {
  const threeNote = defineModel("three_note", {
    title: defineComponent("three_note/title", e.string()),
    body: defineComponent("three_note/body", e.string()),
    appendix: defineComponent("three_note/appendix", e.string()),
  });
  const threeNoteSchema = defineSchema({ models: { three_note: threeNote }, version: 1 });
  const threeNoteId = "three_note_1";

  it("returns all three after all three are read", async () => {
    const { client } = harness(threeNoteSchema, { residencyTtlMs: 0 });
    await callApplyAction(
      client,
      put(1, threeNoteId, "three_note", {
        title: "One",
        body: "300 KB body",
        appendix: "1 MB appendix",
      }),
    );
    client.replica.evict([threeNoteId]);

    const row = await client.three_note.get(threeNoteId);

    expect(row).toMatchObject({
      id: threeNoteId,
      title: "One",
      body: "300 KB body",
      appendix: "1 MB appendix",
    });
    expect(
      ["title", "body", "appendix"].map((field) =>
        client.replica.isComponentResident(threeNoteId, `three_note/${field}`),
      ),
    ).toEqual([true, true, true]);
    expect(client.replicaStats.leases).toMatchObject({ leased: 0, inactive: 3, resident: 3 });
  });
});

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

describe("querying resident types", () => {
  it("keeps a query over resident rows synchronous", async () => {
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
// A source row joining a row the replica does not hold
// ---------------------------------------------------------------------------

describe("a source joining a row the replica does not hold", () => {
  const pageEntity = defineModel("page", { title: e.string() });
  const contentEntity = defineModel("page_content", { text: e.string() });
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
    // The joined row is the store's to serve for this read.
    client.replica.evict(["page_content_1"]);
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
