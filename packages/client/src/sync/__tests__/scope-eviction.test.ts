/**
 * Scope eviction reads the row index (#978).
 *
 * Membership is an index answer, so a value leaving the cache cannot change
 * which groups a row is in, while a membership write is observed. Scope is a
 * residency filter over the replica, never an authorization boundary.
 */

import { describe, expect, it } from "vitest";
import { makeHlc, type Action, type FieldValue, type Update } from "@ebbjs/core";
import { createMemoryAdapter } from "@ebbjs/storage/memory";

import { createClient } from "../client";
import { evictableRowIds, scopeEvictedGroupIds } from "../scope-eviction";
import { callApplyAction, rowComponents, waitFor } from "../test-utils";

const SERVER_URL = "http://localhost:4000";
const ACTOR_ID = "actor_1";

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
  action(
    opts.actionId,
    opts.gsn,
    opts.ms,
    rowComponents(type, fields).map(
      ([component, value]): Update => ({
        id: `u_${opts.actionId}_${component}`,
        subject_id: id,
        component,
        method: "replace" as const,
        data: field(value, `u_${opts.actionId}`, opts.ms),
      }),
    ),
  );

/** A map-shaped component, which lives in the replica's value cache, not its entry. */
const mapPut = (
  id: string,
  model: string,
  fieldName: string,
  entries: Record<string, FieldValue>,
  opts: { actionId: string; gsn: number; ms: number },
): Action =>
  action(opts.actionId, opts.gsn, opts.ms, [
    {
      id: `u_${opts.actionId}`,
      subject_id: id,
      component: `${model}/${fieldName}`,
      method: "merge",
      data: { map: entries },
    },
  ]);

const membership = (
  rowId: string,
  entityId: string,
  groupId: string,
  opts: { actionId: string; gsn: number; ms: number },
): Action => put(rowId, "membership", { entity_id: entityId, group_id: groupId }, opts);

const remove = (rowId: string, opts: { actionId: string; gsn: number; ms: number }): Action =>
  action(opts.actionId, opts.gsn, opts.ms, [
    { id: `u_${opts.actionId}`, subject_id: rowId, method: "delete", data: null },
  ]);

const mkClient = (
  storage: ReturnType<typeof createMemoryAdapter>,
  opts: { residencyTtlMs?: number } = {},
) =>
  createClient({
    serverUrl: SERVER_URL,
    actorId: ACTOR_ID,
    storage,
    fetchImpl: (async () =>
      new Response(JSON.stringify({ rejected: [] }), { status: 200 })) as unknown as typeof fetch,
    ...opts,
  });

type Client = ReturnType<typeof mkClient>;

/**
 * Two groups, two rows, and one membership each: `todo_1` is in the
 * unsubscribed `group_2`, `todo_2` in `group_1`. `todo_1` also carries a
 * map-shaped body that can leave the value cache without touching its entry.
 */
const seedScope = async (client: Client): Promise<void> => {
  await callApplyAction(
    client,
    put("group_1", "group", { name: "One" }, { actionId: "a_g1", gsn: 1, ms: 10 }),
  );
  await callApplyAction(
    client,
    put("group_2", "group", { name: "Two" }, { actionId: "a_g2", gsn: 2, ms: 20 }),
  );
  await callApplyAction(
    client,
    put("todo_1", "todo", { title: "One" }, { actionId: "a_t1", gsn: 3, ms: 30 }),
  );
  await callApplyAction(
    client,
    put("todo_2", "todo", { title: "Two" }, { actionId: "a_t2", gsn: 4, ms: 40 }),
  );
  await callApplyAction(
    client,
    mapPut(
      "todo_1",
      "todo",
      "body",
      { run_1: field("large body", "u_body", 50) },
      {
        actionId: "a_body",
        gsn: 5,
        ms: 50,
      },
    ),
  );
  await callApplyAction(
    client,
    membership("eg_1", "todo_1", "group_2", { actionId: "a_eg1", gsn: 6, ms: 60 }),
  );
  await callApplyAction(
    client,
    membership("eg_2", "todo_2", "group_1", { actionId: "a_eg2", gsn: 7, ms: 70 }),
  );
};

const scope = (client: Client, groupIds: readonly string[]): readonly string[] =>
  [...evictableRowIds(client.replica, groupIds)].sort();

describe("scope eviction reads the row index (#978)", () => {
  it("keeps the scope when a value leaves the cache", async () => {
    const client = mkClient(createMemoryAdapter(), { residencyTtlMs: 10 });
    await seedScope(client);

    const before = scope(client, ["group_1"]);
    expect(before).toEqual(["eg_1", "group_2", "todo_1"].sort());

    // Evicting the row and reading it back installs its body as a claim-owned
    // value, the only kind the replica may expire while the row stays.
    client.replica.evict(["todo_1"]);
    await client.replica.read("todo_1", ["todo/body"]);
    expect(client.replica.isComponentResident("todo_1", "todo/body")).toBe(true);
    expect(scope(client, ["group_1"])).toEqual(before);
    const revision = client.replica.revision;

    await waitFor(() => !client.replica.isComponentResident("todo_1", "todo/body"));

    // The body left the value cache; the row, the component it carries, and
    // the groups it belongs to did not move.
    expect(client.replica.get("todo_1")).toBeDefined();
    expect(client.replica.components("todo/body")).toEqual(["todo_1"]);
    expect(client.replica.revision).toBe(revision);
    expect(scope(client, ["group_1"])).toEqual(before);
  });

  it("follows a membership write from the row index", async () => {
    const client = mkClient(createMemoryAdapter());
    await seedScope(client);

    expect(scope(client, ["group_1"])).toEqual(["eg_1", "group_2", "todo_1"].sort());
    expect(scopeEvictedGroupIds(client.replica, ["group_1"])).toEqual(["group_2"]);

    // A second membership in a subscribed group keeps the entity: the index
    // answers per group, so one unsubscribed membership does not decide for it.
    await callApplyAction(
      client,
      membership("eg_3", "todo_1", "group_1", { actionId: "a_eg3", gsn: 8, ms: 80 }),
    );
    expect(scope(client, ["group_1"])).toEqual(["eg_1", "group_2"].sort());

    // A tombstoned membership is no membership at all.
    await callApplyAction(client, remove("eg_3", { actionId: "a_del_eg3", gsn: 9, ms: 90 }));
    expect(scope(client, ["group_1"])).toEqual(["eg_1", "group_2", "todo_1"].sort());

    await callApplyAction(client, remove("eg_1", { actionId: "a_del_eg1", gsn: 10, ms: 100 }));
    expect(scope(client, ["group_1"])).toEqual(["group_2"]);
  });
});
