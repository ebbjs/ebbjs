/**
 * Client-level integration for relationship and membership adjacency on
 * the materialized replica (#520).
 *
 * The read path under test is `client.<entity>.get(id)` and the accessors
 * it attaches: forward-one, forward-many, reverse, and the built-in
 * `groups`. Each must read the replica's adjacency index — not the async
 * storage shim — and `get` must hydrate the replica itself rather than
 * require a manual `hydrateReplica()`.
 *
 * Rows are seeded through the inbound Action funnel so the action log and
 * the replica stay one source of truth; a second client over the same
 * storage proves the accessors work without a manual hydration call.
 */

import { describe, expect, it } from "vitest";
import { makeHlc, type Action, type Entity, type FieldValue, type Update } from "@ebbjs/core";
import { createMemoryAdapter } from "@ebbjs/storage/memory";
import { createReplica } from "@ebbjs/storage/replica";

import { defineEntity, e } from "../../schema/entity";
import { defineRelationship } from "../../schema/relationship";
import { defineSchema } from "../../schema/schema";
import { createClient } from "../client";
import { callApplyAction } from "../test-utils";

const SERVER_URL = "http://localhost:4000";
const ACTOR_ID = "actor_1";

const todo = defineEntity("todo", { title: e.string() });
const user = defineEntity("user", { name: e.string() });
const label = defineEntity("label", { name: e.string() });
const list = defineEntity("list", { name: e.string() });

const schema = defineSchema({
  entities: { todo, user, label, list },
  relationships: {
    todo_owner: defineRelationship({ source: todo, target: user, as: "owner" }),
    todo_tags: defineRelationship({
      source: todo,
      target: label,
      as: "tags",
      sourceCardinality: "many",
    }),
    todo_parentList: defineRelationship({ source: todo, target: list, as: "parentList" }),
  },
  version: 1,
});

const field = (value: unknown, updateId: string, ms: number): FieldValue => ({
  value,
  update_id: updateId,
  hlc: makeHlc(ms),
});

const action = (id: string, gsn: number, ms: number, updates: Update[]): Action => ({
  id,
  actor_id: ACTOR_ID,
  hlc: makeHlc(ms),
  gsn,
  updates,
});

const put = (
  id: string,
  type: string,
  fields: Record<string, unknown>,
  opts: { actionId: string; gsn: number; ms: number },
): Action =>
  action(opts.actionId, opts.gsn, opts.ms, [
    {
      id: `u_${opts.actionId}`,
      subject_id: id,
      subject_type: type,
      method: "put",
      data: {
        fields: Object.fromEntries(
          Object.entries(fields).map(([k, v]) => [k, field(v, `u_${opts.actionId}`, opts.ms)]),
        ),
      },
    },
  ]);

const remove = (
  id: string,
  type: string,
  opts: { actionId: string; gsn: number; ms: number },
): Action =>
  action(opts.actionId, opts.gsn, opts.ms, [
    { id: `u_${opts.actionId}`, subject_id: id, subject_type: type, method: "delete", data: null },
  ]);

const putRel = (
  relId: string,
  sourceId: string,
  targetId: string,
  as: string,
  type: string,
  opts: { actionId: string; gsn: number; ms: number },
): Action =>
  put(relId, "relationship", { source_id: sourceId, target_id: targetId, field: as, type }, opts);

const putMembership = (
  rowId: string,
  entityId: string,
  groupId: string,
  opts: { actionId: string; gsn: number; ms: number },
): Action => put(rowId, "entityGroup", { entity_id: entityId, group_id: groupId }, opts);

const mkClient = (storage: ReturnType<typeof createMemoryAdapter>) =>
  createClient({
    serverUrl: SERVER_URL,
    actorId: ACTOR_ID,
    storage,
    schema,
    fetchImpl: (async () =>
      new Response(JSON.stringify({ rejected: [] }), { status: 200 })) as unknown as typeof fetch,
  });

/** A shim-only entity row (no action-log entry, no replica adjacency). */
const mkEntity = (id: string, type: string, fields: Record<string, unknown>): Entity => ({
  id,
  type,
  data: {
    fields: Object.fromEntries(
      Object.entries(fields).map(([k, v]) => [k, { value: v, update_id: "u" }]),
    ),
  },
  created_hlc: "1",
  updated_hlc: "1",
  deleted_hlc: null,
  last_gsn: 0,
});

/** Fold `actions` into a replica, as hydration would from the log. */
const seedReplica = (actions: readonly Action[]) => {
  const replica = createReplica();
  actions.forEach((a, i) => replica.ingest(a, a.updates, i + 1));
  return replica;
};

describe("replica adjacency accessors (#520)", () => {
  it("reads adjacency from a persisted replica record without a manual hydrate", async () => {
    const storage = createMemoryAdapter();
    const replica = seedReplica([
      put("todo_1", "todo", { title: "Ship" }, { actionId: "a_1", gsn: 1, ms: 10 }),
      put("user_1", "user", { name: "Ada" }, { actionId: "a_2", gsn: 2, ms: 20 }),
      put("group_1", "group", { name: "Work" }, { actionId: "a_3", gsn: 3, ms: 30 }),
      putRel("rel_1", "todo_1", "user_1", "owner", "todo", { actionId: "a_4", gsn: 4, ms: 40 }),
      putMembership("eg_1", "todo_1", "group_1", { actionId: "a_5", gsn: 5, ms: 50 }),
    ]);
    await storage.replica.save(replica.toRecord());
    // The shim holds the entity rows so `get` can project them; the
    // adjacency rows live only in the replica record.
    await storage.entities.set(mkEntity("todo_1", "todo", { title: "Ship" }));
    await storage.entities.set(mkEntity("user_1", "user", { name: "Ada" }));
    await storage.entities.set(mkEntity("group_1", "group", { name: "Work" }));

    const client = mkClient(storage);
    const row = await client.todo.get("todo_1");
    if (row === null) throw new Error("expected row");

    expect((await row.owner)?.id).toBe("user_1");
    expect((await row.groups).map((g) => g.id)).toEqual(["group_1"]);

    const target = await client.user.get("user_1");
    if (target === null) throw new Error("expected target row");
    expect((await target.owner).map((r) => r.id)).toEqual(["todo_1"]);
  });

  it("resolves forward, reverse, and groups over the replica without a manual hydrate", async () => {
    const storage = createMemoryAdapter();
    const writer = mkClient(storage);
    await callApplyAction(
      writer,
      put("todo_1", "todo", { title: "Ship" }, { actionId: "a_1", gsn: 1, ms: 10 }),
    );
    await callApplyAction(
      writer,
      put("user_1", "user", { name: "Ada" }, { actionId: "a_2", gsn: 2, ms: 20 }),
    );
    await callApplyAction(
      writer,
      put("group_1", "group", { name: "Work" }, { actionId: "a_3", gsn: 3, ms: 30 }),
    );
    await callApplyAction(
      writer,
      putRel("rel_1", "todo_1", "user_1", "owner", "todo", {
        actionId: "a_4",
        gsn: 4,
        ms: 40,
      }),
    );
    await callApplyAction(
      writer,
      putMembership("eg_1", "todo_1", "group_1", { actionId: "a_5", gsn: 5, ms: 50 }),
    );

    // A fresh client over the same storage: `get` must hydrate the
    // replica before the accessors read it.
    const reader = mkClient(storage);
    const row = await reader.todo.get("todo_1");
    if (row === null) throw new Error("expected row");

    expect((await row.owner)?.id).toBe("user_1");

    const target = await reader.user.get("user_1");
    if (target === null) throw new Error("expected target row");
    expect((await target.owner).map((r) => r.id)).toEqual(["todo_1"]);

    expect((await row.groups).map((g) => g.id)).toEqual(["group_1"]);
  });

  it("returns null after a link is cleared", async () => {
    const storage = createMemoryAdapter();
    const client = mkClient(storage);
    await callApplyAction(
      client,
      put("todo_1", "todo", { title: "Ship" }, { actionId: "a_1", gsn: 1, ms: 10 }),
    );
    await callApplyAction(
      client,
      put("user_1", "user", { name: "Ada" }, { actionId: "a_2", gsn: 2, ms: 20 }),
    );
    await callApplyAction(
      client,
      putRel("rel_1", "todo_1", "user_1", "owner", "todo", { actionId: "a_3", gsn: 3, ms: 30 }),
    );
    await callApplyAction(
      client,
      remove("rel_1", "relationship", { actionId: "a_4", gsn: 4, ms: 40 }),
    );

    const row = await client.todo.get("todo_1");
    if (row === null) throw new Error("expected row");
    expect(await row.owner).toBeNull();
  });

  it("returns undefined when an edge's target is dangling", async () => {
    const storage = createMemoryAdapter();
    const client = mkClient(storage);
    await callApplyAction(
      client,
      put("todo_1", "todo", { title: "Ship" }, { actionId: "a_1", gsn: 1, ms: 10 }),
    );
    await callApplyAction(
      client,
      putRel("rel_ghost", "todo_1", "user_ghost", "owner", "todo", {
        actionId: "a_2",
        gsn: 2,
        ms: 20,
      }),
    );

    const row = await client.todo.get("todo_1");
    if (row === null) throw new Error("expected row");
    expect(await row.owner).toBeUndefined();
  });

  it("reflects a membership put then delete in the groups accessor", async () => {
    const storage = createMemoryAdapter();
    const client = mkClient(storage);
    await callApplyAction(
      client,
      put("todo_1", "todo", { title: "Ship" }, { actionId: "a_1", gsn: 1, ms: 10 }),
    );
    await callApplyAction(
      client,
      put("group_1", "group", { name: "Work" }, { actionId: "a_2", gsn: 2, ms: 20 }),
    );
    await callApplyAction(
      client,
      putMembership("eg_1", "todo_1", "group_1", { actionId: "a_3", gsn: 3, ms: 30 }),
    );

    const member = await client.todo.get("todo_1");
    if (member === null) throw new Error("expected row");
    expect((await member.groups).map((g) => g.id)).toEqual(["group_1"]);

    await callApplyAction(
      client,
      remove("eg_1", "entityGroup", { actionId: "a_4", gsn: 4, ms: 40 }),
    );

    const after = await client.todo.get("todo_1");
    if (after === null) throw new Error("expected row");
    expect(await after.groups).toEqual([]);
  });

  it("projects a shared natural key once forward and once reverse", async () => {
    const storage = createMemoryAdapter();
    const client = mkClient(storage);
    await callApplyAction(
      client,
      put("todo_1", "todo", { title: "Ship" }, { actionId: "a_1", gsn: 1, ms: 10 }),
    );
    await callApplyAction(
      client,
      put("label_1", "label", { name: "urgent" }, { actionId: "a_2", gsn: 2, ms: 20 }),
    );
    // Two rows name the same natural key; the reads stay distinct.
    await callApplyAction(
      client,
      putRel("rel_a", "todo_1", "label_1", "tags", "todo", { actionId: "a_3", gsn: 3, ms: 30 }),
    );
    await callApplyAction(
      client,
      putRel("rel_b", "todo_1", "label_1", "tags", "todo", { actionId: "a_4", gsn: 4, ms: 40 }),
    );

    const row = await client.todo.get("todo_1");
    if (row === null) throw new Error("expected row");
    expect((await row.tags).map((t) => t.id)).toEqual(["label_1"]);

    const target = await client.label.get("label_1");
    if (target === null) throw new Error("expected target row");
    expect((await target.tags).map((t) => t.id)).toEqual(["todo_1"]);
  });

  it("surfaces an optimistic link before the server echo", async () => {
    const storage = createMemoryAdapter();
    const client = mkClient(storage);
    await callApplyAction(
      client,
      put("todo_1", "todo", { title: "Ship" }, { actionId: "a_1", gsn: 1, ms: 10 }),
    );
    await callApplyAction(
      client,
      put("user_1", "user", { name: "Ada" }, { actionId: "a_2", gsn: 2, ms: 20 }),
    );

    await client.todo.link("todo_1", "owner", "user_1");

    const row = await client.todo.get("todo_1");
    if (row === null) throw new Error("expected row");
    expect((await row.owner)?.id).toBe("user_1");
  });
});
