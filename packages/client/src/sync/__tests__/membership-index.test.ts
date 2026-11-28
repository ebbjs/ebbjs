/**
 * The membership index resolver (#1010).
 *
 * A membership row files a different entity than the one it is, so the index is
 * keyed by the member entity id. A change that moved a membership row has to
 * name that member even after the row is gone: an unshare or an eviction
 * removes the row that stated the subject, and the journal's delta carries it
 * instead. The resolver answers in three terms — `[]` for a change that is not
 * a membership row this index answers for, exactly one key for a subject it can
 * name, and `null` when it cannot say, which touches every entry that declared
 * the index.
 */

import { describe, expect, it } from "vitest";
import { makeHlc, type Action, type Update } from "@ebbjs/core";
import { createMemoryAdapter } from "@ebbjs/storage/memory";
import {
  createReplica,
  type ChangeDelta,
  type Replica,
  type ReplicaChange,
} from "@ebbjs/storage/replica";
import { defineModel, defineSchema, e } from "@ebbjs/schema";

import { createClient } from "../client";
import { createIndexResolvers, MEMBERSHIP_INDEX } from "../index-resolvers";
import { callApplyAction, flushTasks, rowComponents } from "../test-utils";

const todo = defineModel("todo", { title: e.string() });

const schema = defineSchema({ models: { todo }, version: 1 });

type Client = ReturnType<typeof createClient<typeof schema>>;

const makeClient = (): Client =>
  createClient({
    serverUrl: "http://x",
    actorId: "actor_1",
    storage: createMemoryAdapter(),
    schema,
  });

const action = (gsn: number, updates: Update[]): Action => ({
  id: `a_${gsn}`,
  actor_id: "actor_1",
  hlc: makeHlc(1_711_036_800_000, gsn),
  gsn,
  updates,
});

const field = (value: unknown, updateId: string) => ({
  value,
  update_id: updateId,
  hlc: makeHlc(1),
});

const put = (gsn: number, id: string, type: string, fields: Record<string, unknown>): Action =>
  action(
    gsn,
    rowComponents(type, fields).map(
      ([component, value]): Update => ({
        id: `u_${gsn}_${component}`,
        subject_id: id,
        component,
        method: "replace" as const,
        data: field(value, `u_${gsn}`),
      }),
    ),
  );

const membership = (gsn: number, rowId: string, entityId: string, groupId: string): Action =>
  put(gsn, rowId, "membership", { entity_id: entityId, group_id: groupId });

/** An unshare: the membership row is deleted, and the entity it filed stays. */
const unshare = (gsn: number, rowId: string): Action =>
  action(gsn, [{ id: `u_${gsn}`, subject_id: rowId, method: "delete", data: null }]);

/** The membership component leaves a row that stays in its model. */
const dropMembership = (gsn: number, rowId: string): Action =>
  action(gsn, [
    {
      id: `u_${gsn}`,
      subject_id: rowId,
      component: "ebb/membership",
      method: "drop",
      data: null,
    },
  ]);

const ingest = (replica: Replica, write: Action): number =>
  replica.ingest(write, write.updates, write.gsn);

/** The one change a single-Update mutation journalled. */
const changeAt = (replica: Replica, revision: number): ReplicaChange => {
  const [change] = replica.changesSince(revision - 1);
  if (change === undefined) throw new Error(`no change at revision ${revision}`);
  return change;
};

/**
 * Nothing moved. Every journal entry states all three parts, so a fixture that
 * names only the part its case is about spreads this and overrides that part.
 */
const noMovement: ChangeDelta = {
  edges: [],
  existence: { added: [], removed: [] },
  membership: { before: null, after: null },
};

/**
 * A change with no delta at all — the shape the type now forbids and #1025
 * deletes the fallback for. Only the transitional fallback tests build one.
 */
const stateless = (
  revision: number,
  id: string,
  shape:
    | { readonly kind: "content"; readonly components: readonly string[] }
    | { readonly kind: "membership"; readonly models: readonly string[] },
): ReplicaChange =>
  ({
    revision,
    id,
    deleted: shape.kind === "membership",
    ...(shape.kind === "content"
      ? { kind: "content", components: shape.components }
      : { kind: "membership", membership: "left", models: shape.models }),
  }) as ReplicaChange;

/** The resolver for one index name, as the dispatcher would look it up. */
const resolveFor = (replica: Replica, index: string) => {
  const resolvers = createIndexResolvers(replica);
  const exact = resolvers[index];
  if (exact !== undefined) return (change: Parameters<typeof exact>[0]) => exact(change, index);
  throw new Error(`no resolver for ${index}`);
};

describe("membership resolver: the three keys", () => {
  it("keys a membership row's arrival on the entity it files", () => {
    const replica = createReplica();
    ingest(replica, membership(1, "m_1", "todo_1", "grp_1"));

    expect(resolveFor(replica, MEMBERSHIP_INDEX)(changeAt(replica, 1))).toEqual(["todo_1"]);
  });

  it("keys a group refile on the entity it keeps filing", () => {
    const replica = createReplica();
    ingest(replica, membership(1, "m_1", "todo_1", "grp_1"));
    ingest(replica, membership(2, "m_1", "todo_1", "grp_2"));

    expect(resolveFor(replica, MEMBERSHIP_INDEX)(changeAt(replica, 2))).toEqual(["todo_1"]);
  });

  it("names both entities a row was refiled between", () => {
    const replica = createReplica();
    ingest(replica, membership(1, "m_1", "todo_1", "grp_1"));
    ingest(replica, membership(2, "m_1", "todo_2", "grp_1"));

    // The group stayed and only the filed entity moved: the row stopped filing
    // `todo_1` and started filing `todo_2`, so both row subscriptions see
    // their groups move.
    expect(resolveFor(replica, MEMBERSHIP_INDEX)(changeAt(replica, 2))).toEqual([
      "todo_1",
      "todo_2",
    ]);
  });

  it("keys the member the journal's pair names when no row is left to read", () => {
    const replica = createReplica();
    const resolve = resolveFor(replica, MEMBERSHIP_INDEX);

    // The removed row is the only place the filing was stated, so the change's
    // delta carries the pair on each side and the resolver answers its member
    // half.
    expect(
      resolve({
        revision: 1,
        id: "m_gone",
        kind: "membership",
        deleted: true,
        membership: "left",
        models: ["ebb"],
        delta: {
          ...noMovement,
          membership: {
            before: { entityId: "todo_1", groupId: "grp_1" },
            after: null,
          },
        },
      }),
    ).toEqual(["todo_1"]);
  });

  it("keys a membership value write on the entity it still files", () => {
    const replica = createReplica();
    ingest(replica, membership(1, "m_1", "todo_1", "grp_1"));
    ingest(replica, membership(2, "m_1", "todo_1", "grp_2"));

    expect(resolveFor(replica, MEMBERSHIP_INDEX)(changeAt(replica, 2))).toEqual(["todo_1"]);
  });

  it("keys an unshared row on the entity it filed while that entity stays", () => {
    const replica = createReplica();
    ingest(replica, put(1, "todo_1", "todo", { title: "One" }));
    ingest(replica, membership(2, "m_1", "todo_1", "grp_1"));
    ingest(replica, membership(3, "m_2", "todo_1", "grp_2"));
    ingest(replica, unshare(4, "m_1"));

    const change = changeAt(replica, 4);
    // One row is deleted; the entity stays, and the other filing it is intact.
    expect(replica.memberships({ entityId: "todo_1" })).toEqual(["grp_2"]);
    expect(resolveFor(replica, MEMBERSHIP_INDEX)(change)).toEqual(["todo_1"]);
  });

  it("keys a row that stopped filing on the entity it filed", () => {
    const replica = createReplica();
    ingest(replica, put(1, "todo_1", "todo", { title: "One" }));
    ingest(replica, membership(2, "m_1", "todo_1", "grp_1"));
    ingest(replica, dropMembership(3, "m_1"));

    const change = changeAt(replica, 3);
    // The row is readable but no longer names its member, so only the journal
    // can say whose groups moved.
    expect(replica.get("m_1")).toBeDefined();
    expect(resolveFor(replica, MEMBERSHIP_INDEX)(change)).toEqual(["todo_1"]);
  });

  it("keys an evicted row on the entity it filed", () => {
    const replica = createReplica();
    ingest(replica, put(1, "todo_1", "todo", { title: "One" }));
    ingest(replica, membership(2, "m_1", "todo_1", "grp_1"));

    replica.evict(["m_1", "todo_1"]);

    const change = replica.changesSince(2).find((entry) => entry.id === "m_1");
    if (change === undefined) throw new Error("expected the membership row's change");
    expect(resolveFor(replica, MEMBERSHIP_INDEX)(change)).toEqual(["todo_1"]);
  });

  it("answers no key for a change that is not a membership row this index answers for", () => {
    const replica = createReplica();
    ingest(replica, put(1, "todo_1", "todo", { title: "One" }));
    const resolve = resolveFor(replica, MEMBERSHIP_INDEX);

    // A row entering `todo` names a model, not a filed subject.
    expect(resolve(changeAt(replica, 1))).toEqual([]);

    ingest(replica, put(2, "todo_1", "todo", { title: "Two" }));
    // A value write names no membership component.
    expect(resolve(changeAt(replica, 2))).toEqual([]);

    replica.evict(["todo_1"]);
    // The row is gone, but its delta names no filed subject: it filed nobody.
    expect(resolve(changeAt(replica, 3))).toEqual([]);
  });

  it("answers cannot say only for a change the journal gives no delta (#1025)", () => {
    const replica = createReplica();
    const resolve = resolveFor(replica, MEMBERSHIP_INDEX);

    // Transitional: every journal path now states a movement, so these shapes
    // are unreachable from the replica and #1025 deletes the branch.
    expect(resolve(stateless(1, "m_missing", { kind: "membership", models: ["ebb"] }))).toBeNull();
    expect(
      resolve(stateless(2, "m_missing", { kind: "content", components: ["ebb/membership"] })),
    ).toBeNull();
  });

  it("answers no key for a readable row that filed nobody", () => {
    const replica = createReplica();
    // A component-less row: it files nobody and nothing about it moved, so the
    // journal states an empty movement.
    ingest(
      replica,
      action(1, [
        {
          id: "u_1",
          subject_id: "m_bare",
          model: "ebb",
          method: "create",
          hlc: makeHlc(1),
          data: null,
        },
      ]),
    );

    const change = changeAt(replica, 1);
    expect(replica.get("m_bare")).toBeDefined();
    expect(change.delta).toEqual(noMovement);
    // No part moved, so no key exists for this change rather than a fallback
    // over every entry.
    expect(resolveFor(replica, MEMBERSHIP_INDEX)(change)).toEqual([]);
  });
});

/** What the last dispatched batch cost, as the registry reports it. */
const touched = (client: Client): number => client.subscriptions.stats().dispatch.touched;

/** One write through the client's inbound path, settled like a delivery. */
const write = async (client: Client, next: Action): Promise<void> => {
  await callApplyAction(client, next);
  await flushTasks();
};

const seed = async (client: Client): Promise<void> => {
  await write(client, put(1, "todo_1", "todo", { title: "One" }));
  await write(client, put(2, "todo_2", "todo", { title: "Two" }));
  await write(client, membership(3, "m_1", "todo_1", "grp_1"));
  await write(client, membership(4, "m_2", "todo_2", "grp_1"));
};

/** A row subscription on `id`, counting what its listener saw. */
const watch = async (client: Client, id: string) => {
  const row = await client.todo.get(id);
  if (row === null) throw new Error(`expected row ${id}`);
  const fired: unknown[] = [];
  const unsubscribe = row.subscribe(() => fired.push(1));
  await flushTasks();
  return { fired, unsubscribe };
};

describe("membership dispatch: a departure's breadth", () => {
  it("touches exactly the row subscriptions keyed on the entity an eviction filed", async () => {
    const client = makeClient();
    await seed(client);
    const one = await watch(client, "todo_1");
    const two = await watch(client, "todo_2");

    client.replica.evict(["m_1"]);
    await flushTasks();

    // The membership row filed `todo_1`, so only that row subscription is
    // handed the change — and it fires, because the entity's groups moved.
    expect(touched(client)).toBe(1);
    expect(one.fired).toHaveLength(1);
    expect(two.fired).toHaveLength(0);

    one.unsubscribe();
    two.unsubscribe();
  });

  it("touches exactly the row subscriptions keyed on the entity an unshare filed", async () => {
    const client = makeClient();
    await seed(client);
    const one = await watch(client, "todo_1");
    const two = await watch(client, "todo_2");

    await write(client, unshare(5, "m_1"));

    expect(touched(client)).toBe(1);
    expect(one.fired).toHaveLength(1);
    expect(two.fired).toHaveLength(0);

    one.unsubscribe();
    two.unsubscribe();
  });

  it("touches nobody for a bare `ebb` row that filed nothing", async () => {
    const client = makeClient();
    await seed(client);
    const one = await watch(client, "todo_1");
    const two = await watch(client, "todo_2");

    // An `ebb` row with no component: neither its arrival nor its departure
    // moved a pair, and the change states that much (#1024), so no row
    // subscription's filing can have changed.
    client.replica.ingest(
      {
        id: "a_bare",
        actor_id: "actor_1",
        hlc: makeHlc(1_711_036_800_000, 90),
        gsn: 90,
        updates: [],
      },
      [
        {
          id: "u_bare",
          subject_id: "m_bare",
          model: "ebb",
          method: "create",
          hlc: makeHlc(1_711_036_800_000, 90),
          data: null,
        },
      ],
      90,
    );
    await flushTasks();

    expect(touched(client)).toBe(0);
    expect(one.fired).toHaveLength(0);
    expect(two.fired).toHaveLength(0);

    client.replica.evict(["m_bare"]);
    await flushTasks();

    expect(touched(client)).toBe(0);
    expect(one.fired).toHaveLength(0);
    expect(two.fired).toHaveLength(0);

    one.unsubscribe();
    two.unsubscribe();
  });

  it("leaves row subscriptions alone for a change that names no key under the index", async () => {
    const client = makeClient();
    await seed(client);
    const one = await watch(client, "todo_1");
    const two = await watch(client, "todo_2");

    await write(client, put(5, "todo_3", "todo", { title: "Three" }));

    // A plain todo write is not a membership row: the resolver names no key,
    // so dispatch touches nobody and neither row subscription fires.
    expect(touched(client)).toBe(0);
    expect(one.fired).toHaveLength(0);
    expect(two.fired).toHaveLength(0);

    one.unsubscribe();
    two.unsubscribe();
  });
});
