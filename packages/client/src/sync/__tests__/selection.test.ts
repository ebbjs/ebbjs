/**
 * Component selection on reads (#940).
 *
 * One declaration — `.select({ title: true })` on a query,
 * `get(id, { select })` on a row — is the projection, the lease set, and the
 * invalidation key. System components (`ebb/link`, `ebb/membership`, the
 * `groups` join) are planner-supplied: derived from predicates, order, joins,
 * and the `groupIds` every query row carries, never selectable.
 */

import { describe, expect, it } from "vitest";
import { decodeSync, makeHlc, type Action, type Update } from "@ebbjs/core";
import { createMemoryAdapter } from "@ebbjs/storage/memory";
import type { TSchema } from "@sinclair/typebox/type";
import {
  defineComponent,
  defineModel,
  defineRelationship,
  defineSchema,
  e,
  type ModelDef,
  type RelationshipDef,
  type Schema,
} from "@ebbjs/schema";

import { createClient } from "../client";
import type { EntityEvent } from "../namespace";
import type { Query } from "../query";
import { queryCacheKey, selectionReadComponents } from "../selection";
import type { SyncClientOptions } from "../types";
import {
  callApplyAction,
  flushTasks,
  jsonResponse,
  platformEntity,
  seedReplicaRow,
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

const note = defineModel("note", {
  title: e.string(),
  status: e.string(),
  // A component the drop test does not select, so the row stays resident when
  // the selected components are detached.
  updated_at: e.number(),
  body: defineComponent("note/body", e.string()),
});
const page = defineModel("page", { title: e.string() });
const pageContent = defineModel("page_content", { text: e.string() });
const pageContentJoin = defineRelationship({
  source: page,
  target: pageContent,
  as: "content",
  sourceCardinality: "one",
});
const schema = defineSchema({
  models: { note, page, page_content: pageContent },
  relationships: { content: pageContentJoin },
  version: 1,
});

/** One monotonic gsn for every applied action, so the journal never rewinds. */
let gsn = 0;

/** Run a draft callback and fold every Action it wrote into the replica. */
const seed = async (
  client: MountedClient<typeof schema>,
  written: Action[],
  run: () => Promise<unknown>,
): Promise<void> => {
  const before = written.length;
  await run();
  for (const action of written.slice(before)) {
    await callApplyAction(client, { ...action, gsn: (gsn += 1) });
  }
};

const createNote = async (
  client: MountedClient<typeof schema>,
  written: Action[],
  input: { title: string; status: string; body: string; group?: string },
): Promise<string> => {
  let id = "";
  await seed(client, written, async () => {
    const created = await client.actions.run(({ note: notes }) => {
      const row = notes.create(
        { title: input.title, status: input.status, updated_at: 0, body: input.body },
        { groups: [input.group ?? "g_1"] },
      );
      id = row.id;
      return { id: row.id };
    });
    void created;
  });
  return id;
};

const updateNote = (
  client: MountedClient<typeof schema>,
  written: Action[],
  id: string,
  patch: Record<string, unknown>,
): Promise<void> =>
  seed(client, written, async () => {
    await client.actions.run(({ note: notes }) => {
      notes.update(id, patch);
    });
  });

const deleteNote = (
  client: MountedClient<typeof schema>,
  written: Action[],
  id: string,
): Promise<void> =>
  seed(client, written, async () => {
    await client.actions.run(({ note: notes }) => {
      notes.delete(id);
    });
  });

const createLinkedPage = async (
  client: MountedClient<typeof schema>,
  written: Action[],
  input: { title: string; text: string },
): Promise<{ pageId: string; contentId: string }> => {
  const out = { pageId: "", contentId: "" };
  await seed(client, written, async () => {
    await client.actions.run(({ page: pages, page_content: contents }) => {
      const host = pages.create({ title: input.title }, { groups: ["g_1"] });
      const target = contents.create({ text: input.text }, { groups: ["g_1"] });
      pages.link(host.id, "content", target.id);
      out.pageId = host.id;
      out.contentId = target.id;
    });
  });
  return out;
};

/** The projected data keys of a row, without its handle and accessors. */
const dataKeys = (row: object): readonly string[] =>
  Object.keys(row)
    .filter((key) => !["groups", "subscribe", "subscribeAccessors"].includes(key))
    .sort();

const droppedUpdate = (
  actionId: string,
  subjectId: string,
  components: readonly `${string}/${string}`[],
): Action => {
  gsn += 1;
  return {
    id: actionId,
    actor_id: "actor_1",
    hlc: makeHlc(1_711_036_900_000 + gsn),
    gsn,
    updates: components.map(
      (component, index): Update => ({
        id: `${actionId}_${index}`,
        subject_id: subjectId,
        component,
        method: "drop",
        data: null,
      }),
    ),
  };
};

describe("selection: the projection", () => {
  it("narrows a query row to the selected fields, its id, and its group ids", async () => {
    const { client, written } = harness(schema);
    const id = await createNote(client, written, {
      title: "One",
      status: "open",
      body: "300 KB body",
    });

    const rows = await client.note.query().select({ title: true });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id, title: "One", groupIds: ["g_1"] });
    expect(Object.keys(rows[0]).sort()).toEqual(["groupIds", "id", "title"]);
    // The body was not projected, and the read took no claim on it: a
    // selection is the projection and the lease set, nothing wider.
    expect(rows[0]).not.toHaveProperty("body");
    expect(client.replicaStats.leases.byComponent["note/body"]).toBeUndefined();
  });

  it("narrows a get row to the selected fields and its id", async () => {
    const { client, written } = harness(schema);
    const id = await createNote(client, written, {
      title: "One",
      status: "open",
      body: "300 KB body",
    });

    const row = await client.note.get(id, { select: { title: true } });

    expect(row).not.toBeNull();
    expect(dataKeys(row!)).toEqual(["id", "title"]);
    expect(row?.title).toBe("One");
    // The unselected component was not read or claimed.
    expect(client.replicaStats.leases.byComponent["note/body"]).toBeUndefined();
  });

  it("rejects an unknown field at runtime on a query and a get", async () => {
    const { client, written } = harness(schema);
    const id = await createNote(client, written, {
      title: "One",
      status: "open",
      body: "300 KB body",
    });

    expect(() => client.note.query().select({ nope: true } as never)).toThrow(/nope/);
    await expect(client.note.get(id, { select: { nope: true } as never })).rejects.toThrow(/nope/);
  });

  it("returns only the structural keys for an empty selection", async () => {
    const { client, written } = harness(schema);
    const id = await createNote(client, written, {
      title: "One",
      status: "open",
      body: "300 KB body",
    });

    const rows = await client.note.query().select({});

    expect(rows[0]).toEqual({ id, groupIds: ["g_1"] });
  });
});

describe("selection: system reads are planner-supplied", () => {
  const readSet = (query: Query) => selectionReadComponents(query);

  it("adds membership to every query row and never makes it selectable", async () => {
    const { client } = harness(schema);
    const selected = client.note.query().select({ title: true }).toQuery();

    expect(selectionReadComponents(selected)).toEqual(["note/title", "ebb/membership"]);
    expect(readSet(selected)).toEqual(["note/title", "ebb/membership"]);
    // `groupIds` is structural: the shape has no such field to select.
    expect(() => client.note.query().select({ groupIds: true } as never)).toThrow(/groupIds/);
  });

  it("keeps membership in the read set for a groups predicate and the group rows for a join", async () => {
    const { client } = harness(schema);
    const filtered = client.note.query().select({ title: true }).where("groups", "g_1").toQuery();

    expect(readSet(filtered)).toEqual(["note/title", "ebb/membership"]);

    const joined = client.note.query().select({ title: true }).with({ groups: true }).toQuery();
    expect(readSet(joined)).toEqual(["note/title", "ebb/membership", "ebb/group"]);
  });

  it("keeps predicate and ordering components in the lease set without projecting them", async () => {
    const { client } = harness(schema);
    const query = client.note
      .query()
      .select({ title: true })
      .where("status", "open")
      .orderBy("status", "asc")
      .toQuery();

    expect(readSet(query)).toEqual(["note/title", "note/status", "ebb/membership"]);
  });

  it("projects nothing for an empty selection on a value view", () => {
    const { client } = harness(schema);
    const query = client.group.query().select({}).toQuery();

    // A value view's component is the scan's seed, not a selected field: an
    // empty selection names no component, the same rule the page acquisition
    // follows. The plan still reads the view's component to know which rows
    // exist, which is invalidation rather than projection.
    expect(query.selected).toEqual({ fields: [], components: [] });
    expect(selectionReadComponents(query)).toEqual(["ebb/group", "ebb/membership"]);
  });

  it("returns the issues in a group with groupIds present and no membership field", async () => {
    const { client, written } = harness(schema);
    const inGroup = await createNote(client, written, {
      title: "In",
      status: "open",
      body: "b",
      group: "g_1",
    });
    await createNote(client, written, {
      title: "Out",
      status: "open",
      body: "b",
      group: "g_2",
    });

    const rows = await client.note.query().select({ title: true }).where("groups", "g_1");

    expect(rows.map((row) => row.title)).toEqual(["In"]);
    expect(rows[0]).toMatchObject({ id: inGroup, groupIds: ["g_1"] });
    expect(Object.keys(rows[0]).sort()).toEqual(["groupIds", "id", "title"]);
  });
});

describe("selection: invalidation", () => {
  it("does not invalidate on an unselected component write", async () => {
    const { client, written } = harness(schema, { residencyTtlMs: 0 });
    const id = await createNote(client, written, {
      title: "One",
      status: "open",
      body: "300 KB body",
    });

    const store = client.note.query().select({ body: true }).result();
    let notifications = 0;
    const detach = store.subscribe(() => (notifications += 1));
    await waitFor(() => store.getSnapshot().status === "current");
    await flushTasks();
    const settled = notifications;
    // The selected component is leased by the live result.
    expect(client.replicaStats.leases.byComponent["note/body"]).toMatchObject({ leased: 1 });

    await updateNote(client, written, id, { title: "Renamed" });
    await flushTasks();
    expect(notifications).toBe(settled);
    expect(client.replicaStats.leases.byComponent["note/body"]).toMatchObject({ leased: 1 });

    await updateNote(client, written, id, { body: "new body" });
    await waitFor(() => notifications > settled);
    expect(store.getSnapshot().data?.[0]).toMatchObject({ id, body: "new body" });

    detach();
  });

  it("invalidates a create and a delete through the membership dependency", async () => {
    const { client, written } = harness(schema);
    const seeded = await createNote(client, written, {
      title: "One",
      status: "open",
      body: "b",
    });

    const store = client.note.query().select({}).result();
    let notifications = 0;
    const detach = store.subscribe(() => (notifications += 1));
    await waitFor(() => store.getSnapshot().status === "current");
    await flushTasks();
    expect(store.getSnapshot().data).toEqual([{ id: seeded, groupIds: ["g_1"] }]);
    const settled = notifications;

    await createNote(client, written, { title: "Two", status: "open", body: "b" });
    await waitFor(() => notifications > settled);
    expect(store.getSnapshot().data).toHaveLength(2);

    const afterCreate = notifications;
    await deleteNote(client, written, seeded);
    await waitFor(() => notifications > afterCreate);
    expect(store.getSnapshot().data?.map((row) => row.id)).not.toContain(seeded);

    detach();
  });
});

describe("selection: two-phase read", () => {
  it("reads a projection the replica does not hold, narrowing ids before acquiring the page", async () => {
    const { client, written } = harness(schema, { residencyTtlMs: 0 });
    const first = await createNote(client, written, {
      title: "One",
      status: "open",
      body: "first body",
    });
    const second = await createNote(client, written, {
      title: "Two",
      status: "open",
      body: "second body",
    });

    const rows = await client.note.query().select({ body: true }).orderBy("title", "asc").limit(1);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ id: first, groupIds: ["g_1"], body: "first body" });
    // The page is narrowed before anything is acquired, and only the page is:
    // the first row's body was claimed for the read and the second's was not.
    expect(client.replicaStats.leases.byComponent["note/body"]).toMatchObject({
      leased: 0,
      inactive: 1,
    });
    expect(second).not.toBe(first);
  });

  it("no longer refuses a query over an on-demand source", async () => {
    const { client, written } = harness(schema, { residencyTtlMs: 0 });
    const { contentId } = await createLinkedPage(client, written, {
      title: "One",
      text: "body",
    });

    const rows = await client.page_content.query().select({ text: true });

    expect(rows).toEqual([{ id: contentId, groupIds: ["g_1"], text: "body" }]);
  });
});

describe("selection: joins lease their targets", () => {
  it("leases a joined target on a one-shot read and releases it after projection", async () => {
    const { client, written } = harness(schema, { residencyTtlMs: 0 });
    const { pageId, contentId } = await createLinkedPage(client, written, {
      title: "One",
      text: "body",
    });

    const rows = await client.page.query().select({ title: true }).with({ content: true });

    expect(rows[0]).toMatchObject({ id: pageId, title: "One", groupIds: ["g_1"] });
    expect(rows[0].content).toMatchObject({ id: contentId, text: "body" });
    // The read acquired the target's component and released it after
    // projecting, so the value is warm but nothing holds a lease.
    expect(client.replicaStats.leases.byComponent["page_content/text"]).toMatchObject({
      leased: 0,
      inactive: 1,
    });
  });

  it("leases a joined target for the life of a cached read", async () => {
    const { client, written } = harness(schema, { residencyTtlMs: 20 });
    const { contentId } = await createLinkedPage(client, written, {
      title: "One",
      text: "body",
    });

    const store = client.page.query().select({ title: true }).with({ content: true }).result();
    const detach = store.subscribe(() => {});
    await waitFor(() => store.getSnapshot().status === "current");
    await flushTasks();

    expect(client.replicaStats.leases.byComponent["page_content/text"]).toMatchObject({
      leased: 1,
      inactive: 0,
    });
    expect(client.replica.isComponentResident(contentId, "page_content/text")).toBe(true);

    // The inactive result still owns the target's component: nothing may take
    // it away from a remount inside the one residency TTL.
    detach();
    expect(client.replicaStats.leases.byComponent["page_content/text"]).toMatchObject({
      leased: 1,
      inactive: 0,
    });

    // When the result's lifetime ends the claim goes with it, and the value
    // waits out the same TTL before it leaves.
    await waitFor(() => client.replicaStats.leases.byComponent["page_content/text"]?.leased === 0);
    expect(client.replicaStats.leases.byComponent["page_content/text"]).toMatchObject({
      leased: 0,
      inactive: 1,
    });
  });
});

describe("selection: cache key", () => {
  it("gives two selections of the same query different cache keys", () => {
    const { client } = harness(schema);
    const key = (query: Parameters<typeof queryCacheKey>[1]) => queryCacheKey("rows", query);

    const title = key(client.note.query().select({ title: true }).toQuery());
    const titleAndStatus = key(client.note.query().select({ title: true, status: true }).toQuery());

    expect(title).not.toEqual(titleAndStatus);
    expect(title).toEqual(key(client.note.query().select({ title: true }).toQuery()));
    expect(title).not.toEqual(key(client.note.query().toQuery()));
  });
});

describe("selection: row events", () => {
  it("emits a snapshot on a selected change", async () => {
    const { client, written } = harness(schema);
    const id = await createNote(client, written, {
      title: "One",
      status: "open",
      body: "body",
    });
    const row = await client.note.get(id, { select: { body: true } });
    const events: EntityEvent<never>[] = [];
    const detach = row!.subscribe((event) => events.push(event as never));

    await updateNote(client, written, id, { body: "new body" });
    await waitFor(() => events.length > 0);

    expect(events[0]).toMatchObject({
      type: "snapshot",
      row: { id, body: "new body" },
    });

    detach();
  });

  it("emits one unloaded per released component", async () => {
    const { client, written } = harness(schema);
    const id = await createNote(client, written, {
      title: "One",
      status: "open",
      body: "body",
    });
    const row = await client.note.get(id, { select: { title: true, status: true } });
    const events: EntityEvent<never>[] = [];
    const detach = row!.subscribe((event) => events.push(event as never));
    await flushTasks();

    await callApplyAction(client, droppedUpdate("a_drop", id, ["note/title", "note/status"]));
    await flushTasks();

    expect(
      events
        .filter((event) => event.type === "unloaded")
        .map((event) => (event as { component?: string }).component)
        .sort(),
    ).toEqual(["note/status", "note/title"]);

    detach();
  });

  it("reports a released component once, never on a later batch", async () => {
    const { client, written } = harness(schema);
    const id = await createNote(client, written, {
      title: "One",
      status: "open",
      body: "body",
    });
    const row = await client.note.get(id, { select: { title: true, status: true } });
    const events: EntityEvent<never>[] = [];
    const detach = row!.subscribe((event) => events.push(event as never));
    await flushTasks();
    const unloaded = () =>
      events.filter((event) => event.type === "unloaded") as { component?: string }[];

    await callApplyAction(client, droppedUpdate("a_drop", id, ["note/title", "note/status"]));
    await flushTasks();
    expect(
      unloaded()
        .map((event) => event.component)
        .sort(),
    ).toEqual(["note/status", "note/title"]);

    // The claim set healed to what the replica still holds, so the release is
    // not re-derived from a selection the entry no longer leases.
    await updateNote(client, written, id, { updated_at: 1 });
    await flushTasks();
    expect(unloaded()).toHaveLength(2);

    await updateNote(client, written, id, { updated_at: 2 });
    await flushTasks();
    expect(unloaded()).toHaveLength(2);

    detach();
  });

  it("never reports a component the read never leased", async () => {
    const { client, written } = harness(schema);
    const id = await createNote(client, written, {
      title: "One",
      status: "open",
      body: "body",
    });
    // The selected component's value is gone before the read opens, so the
    // subscription never claims it and has no release to report.
    await callApplyAction(client, droppedUpdate("a_body_drop", id, ["note/body"]));
    const row = await client.note.get(id, { select: { body: true } });
    const events: EntityEvent<never>[] = [];
    const detach = row!.subscribe((event) => events.push(event as never));
    await flushTasks();

    await updateNote(client, written, id, { title: "Two" });
    await flushTasks();
    await updateNote(client, written, id, { title: "Three" });
    await flushTasks();

    expect(events.filter((event) => event.type === "unloaded")).toEqual([]);

    detach();
  });

  it("reports a value view's missing component as an unloaded component", async () => {
    const { client, storage } = harness(schema);
    const group = platformEntity("g_1", "group", { name: "Demo", apps: ["notes"] });
    seedReplicaRow(client.replica, group);
    await storage.entities.set(group);
    const row = await client.group.get("g_1");
    const events: EntityEvent<never>[] = [];
    const detach = row!.subscribe((event) => events.push(event as never));
    await flushTasks();

    await callApplyAction(client, droppedUpdate("a_group_drop", "g_1", ["ebb/group"]));
    await flushTasks();

    // The row is still here; the component the view projects is not. That is a
    // component release, not the row leaving the replica.
    expect(events).toEqual([{ type: "unloaded", id: "g_1", component: "ebb/group" }]);

    detach();
  });

  it("treats a tombstone as a snapshot", async () => {
    const { client, written } = harness(schema);
    const id = await createNote(client, written, {
      title: "One",
      status: "open",
      body: "body",
    });
    const row = await client.note.get(id, { select: { title: true } });
    const events: EntityEvent<never>[] = [];
    const detach = row!.subscribe((event) => events.push(event as never));

    await deleteNote(client, written, id);
    await waitFor(() => events.length > 0);

    expect(events[0]?.type).toBe("snapshot");
    expect(
      (events[0] as { row: { entity: { deleted_hlc: unknown } } }).row.entity.deleted_hlc,
    ).not.toBeNull();
    expect(events.some((event) => event.type === "unloaded")).toBe(false);

    detach();
  });

  it("emits a bare unloaded when the row leaves the replica", async () => {
    const { client, written } = harness(schema);
    const id = await createNote(client, written, {
      title: "One",
      status: "open",
      body: "body",
    });
    const row = await client.note.get(id, { select: { title: true } });
    const events: EntityEvent<never>[] = [];
    const detach = row!.subscribe((event) => events.push(event as never));

    client.replica.evict([id]);
    await waitFor(() => events.length > 0);

    expect(events).toEqual([{ type: "unloaded", id }]);

    detach();
  });
});

describe("selection: row sharing", () => {
  const rowEntries = (client: MountedClient<typeof schema>) =>
    client.subscriptions.entries().filter((entry) => entry.kind === "row");

  it("shares one entry per selection, not one per row", async () => {
    const { client, written } = harness(schema);
    const id = await createNote(client, written, {
      title: "One",
      status: "open",
      body: "body",
    });

    const titleRow = (await client.note.get(id, { select: { title: true } }))!;
    const first = titleRow.subscribe(() => {});
    const second = titleRow.subscribe(() => {});
    await flushTasks();
    expect(rowEntries(client)).toHaveLength(1);
    expect(rowEntries(client)[0].refs).toBe(2);

    const statusRow = (await client.note.get(id, { select: { status: true } }))!;
    const third = statusRow.subscribe(() => {});
    await flushTasks();
    expect(rowEntries(client)).toHaveLength(2);

    first();
    second();
    third();
  });

  it("leases every reader's own selection of one row", async () => {
    const { client, written } = harness(schema, { residencyTtlMs: 10 });
    const id = await createNote(client, written, {
      title: "One",
      status: "open",
      body: "body",
    });

    const titleRow = (await client.note.get(id, { select: { title: true } }))!;
    const detachTitle = titleRow.subscribe(() => {});
    await flushTasks();
    expect(client.replicaStats.leases.byComponent["note/body"]).toBeUndefined();

    const wholeRow = (await client.note.get(id))!;
    const detachWhole = wholeRow.subscribe(() => {});
    await flushTasks();

    // The whole-row reader claims the body its own read names, even though the
    // narrower read opened the row's entry first.
    expect(client.replicaStats.leases.byComponent["note/body"]).toMatchObject({ leased: 1 });

    // The narrower reader's claim set is its own selection: releasing the
    // whole-row reader ends the body's claim, not the narrower reader's.
    detachWhole();
    await waitFor(
      () =>
        client.replicaStats.leases.byComponent["note/body"]?.leased === undefined ||
        client.replicaStats.leases.byComponent["note/body"]?.leased === 0,
    );
    const [narrow] = rowEntries(client);
    expect(narrow.state).toBe("live");
    expect(narrow.dependencies).toEqual([{ id, components: ["note/title"] }]);

    detachTitle();
  });

  it("reports each reader's release once", async () => {
    const { client, written } = harness(schema);
    const id = await createNote(client, written, {
      title: "One",
      status: "open",
      body: "body",
    });
    const titleRow = (await client.note.get(id, { select: { title: true } }))!;
    const narrow: EntityEvent<never>[] = [];
    const detachNarrow = titleRow.subscribe((event) => narrow.push(event as never));
    const wholeRow = (await client.note.get(id))!;
    const whole: EntityEvent<never>[] = [];
    const detachWhole = wholeRow.subscribe((event) => whole.push(event as never));
    await flushTasks();

    await callApplyAction(client, droppedUpdate("a_drop", id, ["note/title"]));
    await flushTasks();
    const unloadedOf = (events: readonly EntityEvent<never>[]) =>
      events.filter((event) => event.type === "unloaded") as { component?: string }[];
    expect(unloadedOf(narrow)).toEqual([{ type: "unloaded", id, component: "note/title" }]);
    expect(unloadedOf(whole)).toEqual([{ type: "unloaded", id, component: "note/title" }]);

    await updateNote(client, written, id, { status: "done" });
    await flushTasks();
    expect(unloadedOf(narrow)).toHaveLength(1);
    expect(unloadedOf(whole)).toHaveLength(1);

    detachNarrow();
    detachWhole();
  });
});

describe("selection: no on-demand refusal", () => {
  it("no longer exports OnDemandQueryError", async () => {
    const pkg = await import("../../index");
    expect("OnDemandQueryError" in pkg).toBe(false);
  });
});
