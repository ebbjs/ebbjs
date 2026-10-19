/**
 * Replica lifecycle (#499): persisted-replica save policy, measured bounded
 * startup, group-scope eviction, and materialized-set observability.
 */

import { describe, expect, it, vi } from "vitest";
import { makeHlc, type Action, type FieldValue, type Update } from "@ebbjs/core";
import { createMemoryAdapter } from "@ebbjs/storage/memory";

import { evictableRowIds, scopeEvictedGroupIds } from "../scope-eviction";
import { createClient } from "../client";
import { emptyQuery } from "../query";
import type { SyncClientOptions } from "../types";
import { callApplyAction, emptyCatchUpResponse, openSseResponse, waitFor } from "../test-utils";

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
  action(opts.actionId, opts.gsn, opts.ms, [
    {
      id: `u_${opts.actionId}`,
      subject_id: id,
      subject_type: type,
      method: "put",
      data: {
        fields: Object.fromEntries(
          Object.entries(fields).map(([key, value]) => [
            key,
            field(value, `u_${opts.actionId}`, opts.ms),
          ]),
        ),
      },
    },
  ]);

const membership = (
  rowId: string,
  entityId: string,
  groupId: string,
  opts: { actionId: string; gsn: number; ms: number },
): Action => put(rowId, "entityGroup", { entity_id: entityId, group_id: groupId }, opts);

const mkClient = (
  storage: ReturnType<typeof createMemoryAdapter>,
  opts: Omit<SyncClientOptions, "serverUrl" | "actorId"> = {},
) =>
  createClient({
    serverUrl: SERVER_URL,
    actorId: ACTOR_ID,
    storage,
    fetchImpl: (async () =>
      new Response(JSON.stringify({ rejected: [] }), { status: 200 })) as unknown as typeof fetch,
    ...opts,
  });

const streamingFetch = () =>
  vi.fn(async (url: string) => {
    if (url.includes("/sync/groups/")) return emptyCatchUpResponse();
    if (url.includes("/sync/live")) return openSseResponse();
    return new Response(JSON.stringify({ rejected: [] }), { status: 200 });
  }) as unknown as typeof fetch;

describe("replica save policy (#499)", () => {
  it("saves every N durable Actions and hydrates a later client with an empty tail", async () => {
    const storage = createMemoryAdapter();
    const client = mkClient(storage, {
      replicaSaveEvery: 2,
      replicaSaveIntervalMs: 0,
    });
    await callApplyAction(
      client,
      put("todo_1", "todo", { title: "One" }, { actionId: "a_1", gsn: 1, ms: 10 }),
    );
    await callApplyAction(
      client,
      put("todo_2", "todo", { title: "Two" }, { actionId: "a_2", gsn: 2, ms: 20 }),
    );

    await waitFor(async () => (await storage.replica.load())?.position === 2);
    const record = await storage.replica.load();
    expect(record?.entities).toHaveLength(2);
    expect(record?.position).toBe(2);

    const reloaded = mkClient(storage);
    await reloaded.hydrateReplica();
    expect(reloaded.replica.get("todo_1")?.data.fields.title.value).toBe("One");
    expect(reloaded.replicaLoad).toMatchObject({
      recordEntities: 2,
      tailEntries: 0,
      tailActions: 0,
      outboxEntries: 0,
      position: 2,
    });
  });

  it("coalesces a burst past the save threshold into one follow-up save", async () => {
    const storage = createMemoryAdapter();
    let saves = 0;
    let releaseFirst!: () => void;
    const save = storage.replica.save.bind(storage.replica);
    storage.replica.save = async (record) => {
      saves += 1;
      if (saves === 1) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      await save(record);
    };

    const client = mkClient(storage, {
      replicaSaveEvery: 1,
      replicaSaveIntervalMs: 0,
    });
    for (let i = 1; i <= 5; i += 1) {
      await callApplyAction(
        client,
        put(
          `todo_${i}`,
          "todo",
          { title: `Title ${i}` },
          {
            actionId: `a_${i}`,
            gsn: i,
            ms: i,
          },
        ),
      );
    }
    expect(saves).toBe(1);

    releaseFirst();
    await waitFor(() => saves === 2);
    expect(saves).toBe(2);
    expect((await storage.replica.load())?.entities).toHaveLength(5);
  });

  it("reports a bounded, measured cold load instead of replaying the whole log", async () => {
    const storage = createMemoryAdapter();
    const writer = mkClient(storage, {
      replicaSaveEvery: 0,
      replicaSaveIntervalMs: 0,
    });
    for (let i = 1; i <= 30; i += 1) {
      await callApplyAction(
        writer,
        put(
          `todo_${i}`,
          "todo",
          { title: `Title ${i}` },
          {
            actionId: `a_${i}`,
            gsn: i,
            ms: i,
          },
        ),
      );
    }
    await writer.persistReplica();
    for (let i = 31; i <= 33; i += 1) {
      await callApplyAction(
        writer,
        put(
          `todo_${i}`,
          "todo",
          { title: `Title ${i}` },
          {
            actionId: `a_${i}`,
            gsn: i,
            ms: i,
          },
        ),
      );
    }

    const reader = mkClient(storage);
    await reader.hydrateReplica();

    expect(reader.replicaLoad).not.toBeNull();
    expect(reader.replicaLoad?.recordEntities).toBe(30);
    expect(reader.replicaLoad?.tailEntries).toBe(3);
    expect(reader.replicaLoad?.tailActions).toBe(3);
    expect(reader.replicaLoad?.durationMs).toBeGreaterThanOrEqual(0);
    expect(reader.replicaStats).toMatchObject({
      entities: 33,
      position: 33,
      byType: { todo: 33 },
    });
  });
});

describe("replica scope eviction (#499)", () => {
  const seedGroups = async (client: ReturnType<typeof mkClient>): Promise<void> => {
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
      membership("eg_1", "todo_1", "group_1", { actionId: "a_eg1", gsn: 5, ms: 50 }),
    );
    await callApplyAction(
      client,
      membership("eg_2", "todo_2", "group_2", { actionId: "a_eg2", gsn: 6, ms: 60 }),
    );
    await callApplyAction(
      client,
      put(
        "rel_1",
        "relationship",
        { source_id: "todo_1", target_id: "todo_2", field: "related", type: "todo" },
        { actionId: "a_rel", gsn: 7, ms: 70 },
      ),
    );
  };

  it("computes the rows unreachable from the subscribed groups", async () => {
    const storage = createMemoryAdapter();
    const client = mkClient(storage);
    await seedGroups(client);

    expect(scopeEvictedGroupIds(client.replica, ["group_1"])).toEqual(["group_2"]);
    expect([...evictableRowIds(client.replica, ["group_1"])].sort()).toEqual(
      ["eg_2", "group_2", "rel_1", "todo_2"].sort(),
    );
    // A row in a subscribed group survives a relationship that crosses scope.
    expect(evictableRowIds(client.replica, ["group_1"])).not.toContain("todo_1");
  });

  it("drops a leaving group's rows and keeps the rest resident", async () => {
    const storage = createMemoryAdapter();
    const client = mkClient(storage, { fetchImpl: streamingFetch() });
    await seedGroups(client);

    const both = client.subscribe(["group_1", "group_2"], 0, () => {});
    expect(client.replica.get("todo_2")).toBeDefined();

    const onlyFirst = client.subscribe(["group_1"], 0, () => {});
    expect(client.replica.get("todo_1")).toBeDefined();
    expect(client.replica.get("group_1")).toBeDefined();
    expect(client.replica.get("todo_2")).toBeUndefined();
    expect(client.replica.get("group_2")).toBeUndefined();
    expect(client.replica.get("eg_2")).toBeUndefined();
    expect(client.replica.get("rel_1")).toBeUndefined();
    expect(client.replicaStats.entities).toBeLessThan(7);

    onlyFirst();
    both();
  });

  it("does not evict when the SSE session is torn down", async () => {
    const storage = createMemoryAdapter();
    const client = mkClient(storage, { fetchImpl: streamingFetch() });
    await seedGroups(client);

    const unsubscribe = client.subscribe(["group_1"], 0, () => {});
    unsubscribe();
    expect(client.replica.get("todo_1")).toBeDefined();
    expect(client.replica.get("group_1")).toBeDefined();
  });

  it("restores an evicted group from the durable base when it is subscribed again", async () => {
    const storage = createMemoryAdapter();
    const client = mkClient(storage, { fetchImpl: streamingFetch() });
    await seedGroups(client);

    client.subscribe(["group_1"], 0, () => {});
    expect(client.replica.get("todo_2")).toBeUndefined();

    const second = client.subscribe(["group_2"], 0, () => {});
    await waitFor(() => client.replica.get("todo_2") !== undefined);
    expect(client.replica.get("todo_1")).toBeUndefined();
    expect(client.replica.get("group_2")).toBeDefined();
    expect(client.replica.get("rel_1")).toBeUndefined();
    second();
  });

  it("invalidates cached queries when restored rows come back at the same revision", async () => {
    const storage = createMemoryAdapter();
    const client = mkClient(storage, { fetchImpl: streamingFetch() });
    await seedGroups(client);
    client.subscribe(["group_1"], 0, () => {});

    const store = client.queries.watch("rows", emptyQuery("todo"), {
      ready: () => {},
      isReady: () => true,
      execute: () => client.replica.iterate("todo"),
    });
    store.subscribe(() => {});
    await waitFor(() => store.getSnapshot().data?.length === 1);
    expect(store.getSnapshot().data?.map((row) => row.id)).toEqual(["todo_1"]);

    client.subscribe(["group_1", "group_2"], 0, () => {});
    await waitFor(() => store.getSnapshot().data?.length === 2);
    expect(
      store
        .getSnapshot()
        .data?.map((row) => row.id)
        .sort(),
    ).toEqual(["todo_1", "todo_2"]);
  });

  it("saves the full durable base even after evicting a group", async () => {
    const storage = createMemoryAdapter();
    const client = mkClient(storage, { fetchImpl: streamingFetch() });
    await seedGroups(client);

    client.subscribe(["group_1"], 0, () => {});
    await client.persistReplica();

    const record = await storage.replica.load();
    expect(record?.entities.map((row) => row.id).sort()).toEqual(
      ["eg_1", "eg_2", "group_1", "group_2", "rel_1", "todo_1", "todo_2"].sort(),
    );
  });
});
