/**
 * Integration tests for the `client.conflicts` surface (#310).
 *
 * These pin the application-facing contract over a conflict detected by
 * the #308 inbound sweep: how it is surfaced and counted as an
 * entity-level {@link Conflict}, how `retry` re-asserts the whole losing
 * Action, how `discard` converges the local cache on the server's view,
 * how a partial resolution leaves the remainder grouped under the same
 * `conflictId`, and that the count survives a reload over the same
 * durable storage.
 */

import { describe, it, expect } from "vitest";
import { Type } from "@sinclair/typebox";
import { decodeSync, isFieldMap, makeHlc, type Action } from "@ebbjs/core";
import { createMemoryAdapter } from "@ebbjs/storage/memory";

import { createClient } from "../client";
import { callApplyAction } from "../test-utils";
import { defineEntity, e } from "../../schema/entity";
import { defineSchema } from "../../schema/schema";
import type { Conflict, ConflictEntry } from "../conflicts";

const SERVER_URL = "http://localhost:4000";
const ACTOR_ID = "actor_1";

const todo = defineEntity("todo", {
  title: e.string(),
  completed: e.boolean(),
});

const schema = defineSchema({ entities: { todo }, version: 1 });

/** A map-valued field: the unit of per-key conflict resolution. */
const doc = defineEntity("doc", { content: Type.Record(Type.String(), Type.String()) });
const docSchema = defineSchema({ entities: { doc }, version: 2 });

interface StubFetch {
  fn: typeof fetch;
  calls: { url: string; init: RequestInit }[];
}

/** Recording fetch stub. Once its FIFO queue drains it accepts writes. */
const mkStubFetch = (): StubFetch => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    return new Response(JSON.stringify({ rejected: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fn, calls };
};

const mkClient = (fetchImpl: typeof fetch, storage?: ReturnType<typeof createMemoryAdapter>) =>
  createClient({
    serverUrl: SERVER_URL,
    actorId: ACTOR_ID,
    schema,
    fetchImpl,
    ...(storage === undefined ? {} : { storage }),
  });

/** A one-field `todo_1` write at an explicit HLC so LWW is pinnable. */
const mkTodoWrite = (args: {
  id: string;
  value: string;
  updateId: string;
  hlc: string;
  gsn: number;
  method?: "put" | "patch";
}): Action => ({
  id: args.id,
  actor_id: ACTOR_ID,
  hlc: args.hlc,
  gsn: args.gsn,
  updates: [
    {
      id: args.updateId,
      subject_id: "todo_1",
      subject_type: "todo",
      method: args.method ?? "put",
      data: { fields: { title: { value: args.value, update_id: args.updateId, hlc: args.hlc } } },
    },
  ],
});

const LOCAL_HLC = makeHlc(1_711_036_800_000);
const PEER_HLC = makeHlc(1_711_036_800_001);

/** The single conflict a client currently reports; asserts one exists. */
const onlyConflict = async (client: {
  conflicts: { list(): Promise<readonly Conflict[]> };
}): Promise<Conflict> => {
  const [conflict] = await client.conflicts.list();
  if (conflict === undefined) throw new Error("expected a conflict");
  return conflict;
};

/** One entry's contested positions flattened for shape assertions. */
const slotPaths = (entry: ConflictEntry | undefined) =>
  entry?.slots.map((slot) => ({ subjectId: slot.subjectId, field: slot.field, path: slot.path }));

/** Seed one detected conflict: a pending local write out-dated by a peer. */
const seedConflict = async () => {
  const storage = createMemoryAdapter();
  const stub = mkStubFetch();
  const client = mkClient(stub.fn, storage);
  await client.outbox.enqueue(
    mkTodoWrite({ id: "act_local", value: "mine", updateId: "u_local", hlc: LOCAL_HLC, gsn: 0 }),
  );
  const peer = mkTodoWrite({
    id: "act_peer",
    value: "theirs",
    updateId: "u_peer",
    hlc: PEER_HLC,
    gsn: 9,
  });
  await callApplyAction(client, peer, "g_1");
  // Live inbound is echo-only now; detection is a catch-up pass over the
  // missed window.
  await client.outbox.detectConflicts([peer], "cu_1");
  const conflict = await onlyConflict(client);
  return { client, storage, conflictId: conflict.id, ...stub };
};

/** Two pending `todo_1` writes, both out-dated by one peer in a catch-up. */
const seedTwoLosers = async () => {
  const storage = createMemoryAdapter();
  const stub = mkStubFetch();
  const client = mkClient(stub.fn, storage);
  await client.outbox.enqueue(
    mkTodoWrite({ id: "act_a", value: "mine a", updateId: "u_a", hlc: LOCAL_HLC, gsn: 0 }),
  );
  await client.outbox.enqueue(
    mkTodoWrite({ id: "act_b", value: "mine b", updateId: "u_b", hlc: LOCAL_HLC, gsn: 0 }),
  );
  const peer = mkTodoWrite({
    id: "act_peer",
    value: "theirs",
    updateId: "u_peer",
    hlc: PEER_HLC,
    gsn: 9,
  });
  await callApplyAction(client, peer, "g_1");
  await client.outbox.detectConflicts([peer], "cu_1");
  return { client, storage, ...stub };
};

const actionCalls = (calls: { url: string }[]): number =>
  calls.filter((call) => call.url.endsWith("/sync/actions")).length;

const postedActions = (calls: { url: string; init: RequestInit }[]): Action[] => {
  const call = calls.find((candidate) => candidate.url.endsWith("/sync/actions"));
  if (call === undefined) return [];
  return decodeSync<{ actions: Action[] }>(call.init.body as Uint8Array).actions;
};

describe("client.conflicts (#310)", () => {
  it("surfaces a detected conflict with its winner, fields, and count", async () => {
    const storage = createMemoryAdapter();
    const stub = mkStubFetch();
    const client = mkClient(stub.fn, storage);
    const seen: number[] = [];
    client.conflicts.onChange((conflicts) => seen.push(conflicts.length));

    await client.outbox.enqueue(
      mkTodoWrite({ id: "act_local", value: "mine", updateId: "u_local", hlc: LOCAL_HLC, gsn: 0 }),
    );
    const peer = mkTodoWrite({
      id: "act_peer",
      value: "theirs",
      updateId: "u_peer",
      hlc: PEER_HLC,
      gsn: 9,
    });
    await callApplyAction(client, peer, "g_1");
    await client.outbox.detectConflicts([peer], "cu_1");

    const conflicts = await client.conflicts.list();

    expect(conflicts).toHaveLength(1);
    const [conflict] = conflicts;
    expect(conflict?.entries[0]?.action.id).toBe("act_local");
    expect(conflict?.entries[0]?.subjects).toEqual(["todo_1"]);
    expect(conflict?.subjects).toEqual(["todo_1"]);
    expect(slotPaths(conflict?.entries[0])).toEqual([
      { subjectId: "todo_1", field: "title", path: [] },
    ]);
    expect(conflict?.entries[0]?.slots[0]?.local).toEqual({
      value: "mine",
      update_id: "u_local",
      hlc: LOCAL_HLC,
    });
    expect(conflict?.entries[0]?.slots[0]?.remote).toEqual({
      value: "theirs",
      update_id: "u_peer",
      hlc: PEER_HLC,
    });
    expect(conflict?.remoteWins()).toBe(true);
    expect(client.conflicts.count()).toBe(1);

    // Surfaced from the durable store, not a private cache.
    expect((await client.conflicts.list()).map((c) => c.entries[0]?.action.id)).toEqual([
      "act_local",
    ]);
    // The losing Action was never posted.
    expect(actionCalls(stub.calls)).toBe(0);
    // onChange reported the detection without a poll.
    expect(seen).toContain(1);
  });

  it("retry re-enqueues a rebased Action that wins and flushes", async () => {
    const { client, calls, conflictId } = await seedConflict();

    await client.conflicts.resolve(conflictId, "retry");

    const actions = postedActions(calls);
    expect(actions).toHaveLength(1);
    const field = actions[0]?.updates[0]?.data?.fields.title;
    expect(field?.value).toBe("mine");
    expect(field?.update_id).not.toBe("u_local");
    // The rebased HLC out-dates the peer's write.
    expect(field?.hlc).not.toBe(LOCAL_HLC);

    expect(await client.conflicts.list()).toEqual([]);
    expect(client.conflicts.count()).toBe(0);
    expect((await client.readLocalEntity("todo_1"))?.data.fields.title.value).toBe("mine");
  });

  it("retry re-asserts the whole Action, re-stamping every field", async () => {
    const storage = createMemoryAdapter();
    const stub = mkStubFetch();
    const client = mkClient(stub.fn, storage);

    // Seed the entity so the patches below have something to apply to.
    await callApplyAction(
      client,
      mkTodoWrite({
        id: "act_base",
        value: "base",
        updateId: "u_base",
        hlc: makeHlc(1_711_036_799_000),
        gsn: 1,
      }),
      "g_1",
    );
    await client.outbox.enqueue({
      id: "act_local",
      actor_id: ACTOR_ID,
      hlc: LOCAL_HLC,
      gsn: 0,
      updates: [
        {
          id: "u_local",
          subject_id: "todo_1",
          subject_type: "todo",
          method: "patch",
          data: {
            fields: {
              title: { value: "mine", update_id: "u_local", hlc: LOCAL_HLC },
              completed: { value: true, update_id: "u_local", hlc: LOCAL_HLC },
            },
          },
        },
      ],
    });
    const peer = mkTodoWrite({
      id: "act_peer",
      value: "theirs",
      updateId: "u_peer",
      hlc: PEER_HLC,
      gsn: 9,
      // A patch only touches `title`, so the local `completed` is not
      // swept and the test isolates which fields retry re-asserts.
      method: "patch",
    });
    await callApplyAction(client, peer, "g_1");
    await client.outbox.detectConflicts([peer], "cu_1");

    const conflict = await onlyConflict(client);
    expect(slotPaths(conflict.entries[0])).toEqual([
      { subjectId: "todo_1", field: "title", path: [] },
    ]);

    await client.conflicts.resolve(conflict.id, "retry");

    const actions = postedActions(stub.calls);
    expect(actions).toHaveLength(1);
    const fields = actions[0]?.updates[0]?.data?.fields ?? {};
    // The conflict named only `title`, but retry re-asserts the whole
    // Action, so `completed` travels with it.
    expect(Object.keys(fields).sort()).toEqual(["completed", "title"]);
    expect(fields.title?.value).toBe("mine");
    expect(fields.completed?.value).toBe(true);
    expect(fields.title?.update_id).not.toBe("u_local");
    expect(fields.completed?.update_id).not.toBe("u_local");
  });

  it("retry re-stamps a field an inbound put reverted", async () => {
    const storage = createMemoryAdapter();
    const stub = mkStubFetch();
    const client = mkClient(stub.fn, storage);

    await callApplyAction(
      client,
      mkTodoWrite({
        id: "act_base",
        value: "base",
        updateId: "u_base",
        hlc: makeHlc(1_711_036_799_000),
        gsn: 1,
      }),
      "g_1",
    );
    await client.outbox.enqueue({
      id: "act_local",
      actor_id: ACTOR_ID,
      hlc: LOCAL_HLC,
      gsn: 0,
      updates: [
        {
          id: "u_local",
          subject_id: "todo_1",
          subject_type: "todo",
          method: "patch",
          data: { fields: { title: { value: "mine", update_id: "u_local", hlc: LOCAL_HLC } } },
        },
      ],
    });
    // The peer's put replaces the entity and omits `title`, so the local
    // patch's field is reverted rather than out-dated.
    const peer: Action = {
      id: "act_peer",
      actor_id: ACTOR_ID,
      hlc: PEER_HLC,
      gsn: 9,
      updates: [
        {
          id: "u_peer",
          subject_id: "todo_1",
          subject_type: "todo",
          method: "put",
          data: { fields: { completed: { value: true, update_id: "u_peer", hlc: PEER_HLC } } },
        },
      ],
    };
    await callApplyAction(client, peer, "g_1");
    await client.outbox.detectConflicts([peer], "cu_1");

    const conflict = await onlyConflict(client);
    expect(slotPaths(conflict.entries[0])).toEqual([
      { subjectId: "todo_1", field: "title", path: [] },
    ]);
    expect(conflict.entries[0]?.slots[0]?.remote).toEqual({ value: undefined });

    await client.conflicts.resolve(conflict.id, "retry");

    const actions = postedActions(stub.calls);
    expect(actions).toHaveLength(1);
    const fields = actions[0]?.updates[0]?.data?.fields ?? {};
    expect(Object.keys(fields)).toEqual(["title"]);
    expect(fields.title?.value).toBe("mine");
    expect((await client.readLocalEntity("todo_1"))?.data.fields.title.value).toBe("mine");
  });

  it("discard converges local state on the server view and removes the conflict", async () => {
    const { client, calls, conflictId } = await seedConflict();

    expect((await client.readLocalEntity("todo_1"))?.data.fields.title.value).toBe("theirs");

    await client.conflicts.resolve(conflictId, "discard");

    expect(await client.conflicts.list()).toEqual([]);
    expect((await client.readLocalEntity("todo_1"))?.data.fields.title.value).toBe("theirs");
    expect(actionCalls(calls)).toBe(0);
  });

  it("persists a conflict across a reload with both sides available", async () => {
    const { client, storage } = await seedConflict();
    client.close();

    const reloaded = mkStubFetch();
    const clientB = mkClient(reloaded.fn, storage);
    await clientB.conflicts.rehydrate();

    expect(clientB.conflicts.count()).toBe(1);
    const conflict = await onlyConflict(clientB);
    expect(conflict.entries.map((entry) => entry.action.id)).toEqual(["act_local"]);
    expect(conflict.entries[0]?.slots[0]?.local).toEqual({
      value: "mine",
      update_id: "u_local",
      hlc: LOCAL_HLC,
    });
    expect(conflict.entries[0]?.slots[0]?.remote).toEqual({
      value: "theirs",
      update_id: "u_peer",
      hlc: PEER_HLC,
    });
  });

  it("re-materializes a losing Action's non-conflicting entity on discard", async () => {
    const storage = createMemoryAdapter();
    const stub = mkStubFetch();
    const client = mkClient(stub.fn, storage);

    // todo_2 exists on the server with title "server".
    await callApplyAction(
      client,
      {
        id: "act_seed",
        actor_id: ACTOR_ID,
        hlc: makeHlc(1_711_036_800_000),
        gsn: 5,
        updates: [
          {
            id: "u_seed",
            subject_id: "todo_2",
            subject_type: "todo",
            method: "put",
            data: {
              fields: {
                title: {
                  value: "server",
                  update_id: "u_seed",
                  hlc: makeHlc(1_711_036_800_000),
                },
              },
            },
          },
        ],
      },
      "g_1",
    );

    // One local Action writes two entities; only todo_1 conflicts.
    await client.outbox.enqueue({
      id: "act_local",
      actor_id: ACTOR_ID,
      hlc: LOCAL_HLC,
      gsn: 0,
      updates: [
        {
          id: "u_local_1",
          subject_id: "todo_1",
          subject_type: "todo",
          method: "patch",
          data: { fields: { title: { value: "mine", update_id: "u_local_1", hlc: LOCAL_HLC } } },
        },
        {
          id: "u_local_2",
          subject_id: "todo_2",
          subject_type: "todo",
          method: "patch",
          data: { fields: { title: { value: "mine", update_id: "u_local_2", hlc: LOCAL_HLC } } },
        },
      ],
    });
    const peer = mkTodoWrite({
      id: "act_peer",
      value: "theirs",
      updateId: "u_peer",
      hlc: PEER_HLC,
      gsn: 9,
    });
    await callApplyAction(client, peer, "g_1");
    await client.outbox.detectConflicts([peer], "cu_1");

    const conflict = await onlyConflict(client);
    expect((await client.readLocalEntity("todo_2"))?.data.fields.title.value).toBe("mine");

    await client.conflicts.resolve(conflict.id, "discard");

    expect((await client.readLocalEntity("todo_2"))?.data.fields.title.value).toBe("server");
    expect((await client.readLocalEntity("todo_1"))?.data.fields.title.value).toBe("theirs");
  });

  it("groups losing Actions on one entity into one conflict and fans resolution out", async () => {
    const { client } = await seedTwoLosers();

    const conflicts = await client.conflicts.list();
    expect(conflicts).toHaveLength(1);
    const [conflict] = conflicts;
    if (conflict === undefined) throw new Error("expected a conflict");
    expect(conflict.entries.map((entry) => entry.action.id)).toEqual(["act_a", "act_b"]);

    // `resolve` fans out to every entry under the conflict.
    const fanOut = await client.conflicts.resolve(conflict.id, "retry");
    expect(fanOut).toEqual({ resolved: ["act_a", "act_b"], failed: [] });
    expect(await client.conflicts.list()).toEqual([]);

    // A partial resolution leaves the remaining entry under the same id.
    const second = await seedTwoLosers();
    const shared = await onlyConflict(second.client);
    const [firstId] = shared.entries.map((entry) => entry.action.id);
    if (firstId === undefined) throw new Error("expected an entry");

    const partial = await second.client.conflicts.resolveEntries([firstId], "retry");
    expect(partial).toEqual({ resolved: [firstId], failed: [] });

    // The remainder stays under the same id, even across a reload.
    second.client.close();
    const reloaded = mkStubFetch();
    const clientC = mkClient(reloaded.fn, second.storage);
    await clientC.conflicts.rehydrate();
    const [remaining] = await clientC.conflicts.list();
    expect(remaining?.id).toBe(shared.id);
    expect(remaining?.entries.map((entry) => entry.action.id)).toEqual(["act_b"]);
  });

  it("entity-scope loss with no position overlap reports non-winning and stays retryable", async () => {
    const storage = createMemoryAdapter();
    const stub = mkStubFetch();
    const entityScopeDoc = defineEntity(
      "doc",
      { content: Type.Record(Type.String(), Type.String()) },
      { conflictScope: "entity" },
    );
    const entityScopeSchema = defineSchema({ entities: { doc: entityScopeDoc }, version: 3 });
    const client = createClient({
      serverUrl: SERVER_URL,
      actorId: ACTOR_ID,
      schema: entityScopeSchema,
      fetchImpl: stub.fn,
      storage,
    });

    await client.outbox.enqueue({
      id: "act_local",
      actor_id: ACTOR_ID,
      hlc: LOCAL_HLC,
      gsn: 0,
      updates: [
        {
          id: "u_local",
          subject_id: "doc_1",
          subject_type: "doc",
          method: "put",
          data: {
            fields: {
              content: { map: { a: { value: "mine", update_id: "u_local", hlc: LOCAL_HLC } } },
            },
          },
        },
      ],
    });

    // A disjoint map key: the peer touches the entity but no position the
    // local write holds, so entity scope surfaces the loss with no slot.
    const peer: Action = {
      id: "act_peer",
      actor_id: ACTOR_ID,
      hlc: PEER_HLC,
      gsn: 9,
      updates: [
        {
          id: "u_peer",
          subject_id: "doc_1",
          subject_type: "doc",
          method: "put",
          data: {
            fields: {
              content: { map: { b: { value: "theirs", update_id: "u_peer", hlc: PEER_HLC } } },
            },
          },
        },
      ],
    };
    await callApplyAction(client, peer, "g_1");
    await client.outbox.detectConflicts([peer], "cu_1");

    const conflict = await onlyConflict(client);
    expect(conflict.subjects).toEqual(["doc_1"]);
    expect(conflict.entries[0]?.slots).toEqual([]);
    expect(conflict.remoteWins()).toBe(false);

    await client.conflicts.resolve(conflict.id, "retry");

    const actions = postedActions(stub.calls);
    expect(actions).toHaveLength(1);
    const content = actions[0]?.updates[0]?.data?.fields.content;
    if (content === undefined || !isFieldMap(content)) throw new Error("expected a map field");
    expect(Object.keys(content.map)).toEqual(["a"]);
    const a = content.map.a;
    if (a === undefined || isFieldMap(a)) throw new Error("expected a leaf");
    expect(a.value).toBe("mine");
    expect(a.update_id).not.toBe("u_local");
  });

  it("retry re-asserts the whole map field, re-stamping both keys", async () => {
    const storage = createMemoryAdapter();
    const stub = mkStubFetch();
    const client = createClient({
      serverUrl: SERVER_URL,
      actorId: ACTOR_ID,
      schema: docSchema,
      fetchImpl: stub.fn,
      storage,
    });

    await client.outbox.enqueue({
      id: "act_local",
      actor_id: ACTOR_ID,
      hlc: LOCAL_HLC,
      gsn: 0,
      updates: [
        {
          id: "u_local",
          subject_id: "doc_1",
          subject_type: "doc",
          method: "put",
          data: {
            fields: {
              content: {
                map: {
                  a: { value: "mine", update_id: "u_local", hlc: LOCAL_HLC },
                  b: { value: "keep", update_id: "u_local", hlc: LOCAL_HLC },
                },
              },
            },
          },
        },
      ],
    });

    const peer: Action = {
      id: "act_peer",
      actor_id: ACTOR_ID,
      hlc: PEER_HLC,
      gsn: 9,
      updates: [
        {
          id: "u_peer",
          subject_id: "doc_1",
          subject_type: "doc",
          method: "put",
          data: {
            fields: {
              content: { map: { a: { value: "theirs", update_id: "u_peer", hlc: PEER_HLC } } },
            },
          },
        },
      ],
    };
    await callApplyAction(client, peer, "g_1");
    await client.outbox.detectConflicts([peer], "cu_1");

    const conflict = await onlyConflict(client);
    expect(slotPaths(conflict.entries[0])).toEqual([
      { subjectId: "doc_1", field: "content", path: ["a"] },
    ]);
    expect(conflict.entries[0]?.slots[0]?.local).toEqual({
      value: "mine",
      update_id: "u_local",
      hlc: LOCAL_HLC,
    });
    expect(conflict.entries[0]?.slots[0]?.remote).toEqual({
      value: "theirs",
      update_id: "u_peer",
      hlc: PEER_HLC,
    });

    await client.conflicts.resolve(conflict.id, "retry");

    const actions = postedActions(stub.calls);
    expect(actions).toHaveLength(1);
    const content = actions[0]?.updates[0]?.data?.fields.content;
    if (content === undefined || !isFieldMap(content)) throw new Error("expected a map field");
    // Only `a` lost, but retry re-asserts the whole map field, so `b` is
    // re-stamped and travels too.
    expect(Object.keys(content.map).sort()).toEqual(["a", "b"]);
    const a = content.map.a;
    const b = content.map.b;
    if (a === undefined || isFieldMap(a)) throw new Error("expected a leaf");
    if (b === undefined || isFieldMap(b)) throw new Error("expected a leaf");
    expect(a.value).toBe("mine");
    expect(b.value).toBe("keep");
    expect(a.update_id).not.toBe("u_local");
    expect(b.update_id).not.toBe("u_local");
    expect(a.hlc).not.toBe(LOCAL_HLC);
  });

  it("reports per-entry resolution failures and keeps the failed entry resolvable", async () => {
    const storage = createMemoryAdapter();
    const outboxStore = storage.outbox;
    let failPut = false;
    const guarded: ReturnType<typeof createMemoryAdapter> = {
      ...storage,
      outbox: {
        ...outboxStore,
        put: async (entry) => {
          if (failPut) throw new Error("outbox store unavailable");
          await outboxStore.put(entry);
        },
      },
    };
    const stub = mkStubFetch();
    const client = mkClient(stub.fn, guarded);
    await client.outbox.enqueue(
      mkTodoWrite({ id: "act_local", value: "mine", updateId: "u_local", hlc: LOCAL_HLC, gsn: 0 }),
    );
    const peer = mkTodoWrite({
      id: "act_peer",
      value: "theirs",
      updateId: "u_peer",
      hlc: PEER_HLC,
      gsn: 9,
    });
    await callApplyAction(client, peer, "g_1");
    await client.outbox.detectConflicts([peer], "cu_1");

    const conflict = await onlyConflict(client);
    const entryId = conflict.entries[0]?.action.id;
    if (entryId === undefined) throw new Error("expected an entry");

    // A store fault refilling the pending write leaves the entry
    // conflicted rather than dropped.
    failPut = true;
    const result = await client.conflicts.resolveEntries([entryId], "retry");

    expect(result.resolved).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.entryId).toBe(entryId);
    expect(result.failed[0]?.error).toBeInstanceOf(Error);
    expect((await client.conflicts.list())[0]?.id).toBe(conflict.id);

    // The entry is still resolvable once the store recovers.
    failPut = false;
    const recovered = await client.conflicts.resolve(conflict.id, "retry");
    expect(recovered).toEqual({ resolved: [entryId], failed: [] });
    expect(await client.conflicts.list()).toEqual([]);
  });
});
