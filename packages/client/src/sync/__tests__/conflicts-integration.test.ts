/**
 * Integration tests for the `client.conflicts` surface (#310, #781).
 *
 * These pin the application-facing contract over a conflict detected by
 * the #308 inbound sweep: how it is surfaced and counted as an
 * entity-level {@link Conflict}, how `sendLocalActions` submits the held
 * Actions unchanged, how `clearLocalActions` converges the local cache on
 * the server's view, how the subject hold keeps later writes off the wire
 * until resolution, and that the hold survives a reload over the same
 * durable storage.
 */

import { describe, it, expect } from "vitest";
import { Type } from "@sinclair/typebox";
import { decodeSync, makeHlc, type Action } from "@ebbjs/core";
import { createMemoryAdapter } from "@ebbjs/storage/memory";

import { createClient } from "../client";
import { callApplyAction } from "../test-utils";
import { testActions } from "./test-actions";
import { defineModel, e } from "@ebbjs/schema";
import { defineSchema } from "@ebbjs/schema";
import type { Conflict, ConflictEntry } from "../conflicts";

const SERVER_URL = "http://localhost:4000";
const ACTOR_ID = "actor_1";

const todo = defineModel("todo", {
  title: e.string(),
  completed: e.boolean(),
});

const schema = defineSchema({ models: { todo }, version: 1 });

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
    actions: testActions(schema),
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
      id: `${args.updateId}_0`,
      subject_id: "todo_1",
      component: "todo/title",
      method: "merge",
      data: { value: args.value, update_id: args.updateId, hlc: args.hlc },
    },
  ],
});

const LOCAL_HLC = makeHlc(1_711_036_800_000);
const PEER_HLC = makeHlc(1_711_036_800_001);
const LATER_HLC = makeHlc(1_711_036_800_002);

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
  entry?.slots?.map((slot) => ({
    subjectId: slot.subjectId,
    component: slot.component,
    path: slot.path,
  }));

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

const allPostedActions = (calls: { url: string; init: RequestInit }[]): Action[] =>
  calls
    .filter((call) => call.url.endsWith("/sync/actions"))
    .flatMap((call) => decodeSync<{ actions: Action[] }>(call.init.body as Uint8Array).actions);

describe("client.conflicts (#781)", () => {
  it("surfaces a detected conflict with its scope, slots, and remote context", async () => {
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
    expect(conflict?.scope).toBe("field");
    expect(conflict?.entries[0]?.action.id).toBe("act_local");
    expect(conflict?.entries[0]?.subjects).toEqual(["todo_1"]);
    expect(conflict?.subjects).toEqual(["todo_1"]);
    expect(slotPaths(conflict?.entries[0])).toEqual([
      { subjectId: "todo_1", component: "todo/title", path: [] },
    ]);
    expect(conflict?.entries[0]?.slots?.[0]?.local).toEqual({
      value: "mine",
      update_id: "u_local",
      hlc: LOCAL_HLC,
    });
    expect(conflict?.entries[0]?.slots?.[0]?.remote).toEqual({
      value: "theirs",
      update_id: "u_peer",
      hlc: PEER_HLC,
    });
    expect(conflict?.entries[0]?.slots?.[0]?.remoteWins()).toBe(true);
    expect(conflict?.remoteActions).toEqual([{ actorId: ACTOR_ID, actionId: "act_peer", gsn: 9 }]);
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

  it("sendLocalActions submits the held Action unchanged and flushes", async () => {
    const { client, calls, conflictId } = await seedConflict();
    const held = (await onlyConflict(client)).entries[0]?.action;
    if (held === undefined) throw new Error("expected a held Action");

    await client.conflicts.sendLocalActions(conflictId);

    const actions = postedActions(calls);
    expect(actions).toHaveLength(1);
    // Nothing was re-stamped: same Action, same Update, same field HLC.
    expect(actions[0]).toEqual(held);

    expect(await client.conflicts.list()).toEqual([]);
    expect(client.conflicts.count()).toBe(0);
    expect((await client.readLocalEntity("todo_1"))?.data.fields.title.value).toBe("theirs");
  });

  it("sendLocalActions leaves the action log entry's envelope unchanged end to end", async () => {
    const { client, storage, conflictId } = await seedConflict();
    const held = (await onlyConflict(client)).entries[0]?.action;
    if (held === undefined) throw new Error("expected a held Action");

    await client.conflicts.sendLocalActions(conflictId);
    // The server accepts the write it was sent and echoes it back.
    await callApplyAction(client, { ...held, gsn: 9 }, "g_1");

    const logged = (await storage.actions.getForEntity("todo_1")).find(
      (action) => action.id === held.id,
    );
    expect(logged?.updates).toEqual(held.updates);
    expect(logged?.hlc).toBe(held.hlc);
    expect(logged?.actor_id).toBe(held.actor_id);
  });

  it("sendLocalActions submits a component an inbound delete reverted unchanged", async () => {
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
    const local: Action = {
      id: "act_local",
      actor_id: ACTOR_ID,
      hlc: LOCAL_HLC,
      gsn: 0,
      updates: [
        {
          id: "u_local_0",
          subject_id: "todo_1",
          component: "todo/title",
          method: "merge",
          data: { value: "mine", update_id: "u_local", hlc: LOCAL_HLC },
        },
      ],
    };
    await client.outbox.enqueue(local);
    // The peer's delete clears the subject, so the local component write is
    // reverted rather than out-dated.
    const peer: Action = {
      id: "act_peer",
      actor_id: ACTOR_ID,
      hlc: PEER_HLC,
      gsn: 9,
      updates: [{ id: "u_peer_del", subject_id: "todo_1", method: "delete", data: null }],
    };
    await callApplyAction(client, peer, "g_1");
    await client.outbox.detectConflicts([peer], "cu_1");

    const conflict = await onlyConflict(client);
    expect(slotPaths(conflict.entries[0])).toEqual([
      { subjectId: "todo_1", component: "todo/title", path: [] },
    ]);
    expect(conflict.entries[0]?.slots?.[0]?.remote).toEqual({ value: undefined });

    await client.conflicts.sendLocalActions(conflict.id);

    const actions = postedActions(stub.calls);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toEqual(local);
    const field = actions[0]?.updates[0];
    expect(field?.data).toEqual({ value: "mine", update_id: "u_local", hlc: LOCAL_HLC });
  });

  it("clearLocalActions converges local state on the server view and removes the conflict", async () => {
    const { client, calls, conflictId } = await seedConflict();

    // The remote HLC wins the merge, so the materialized row is already the
    // server's view; clearing removes the held Action without sending it.
    expect((await client.readLocalEntity("todo_1"))?.data.fields.title.value).toBe("theirs");

    await client.conflicts.clearLocalActions(conflictId);

    expect(await client.conflicts.list()).toEqual([]);
    expect((await client.readLocalEntity("todo_1"))?.data.fields.title.value).toBe("theirs");
    expect(actionCalls(calls)).toBe(0);
  });

  it("clearLocalActions drops a later write to the held subject so the subject converges", async () => {
    const { client, storage, conflictId, calls } = await seedConflict();
    const later = mkTodoWrite({
      id: "act_later",
      value: "local edit",
      updateId: "u_later",
      hlc: LATER_HLC,
      gsn: 0,
    });
    await client.outbox.enqueue(later);
    // The later write out-dates the peer, so it would win on the server.
    expect((await client.readLocalEntity("todo_1"))?.data.fields.title.value).toBe("local edit");

    await client.conflicts.clearLocalActions(conflictId);

    expect(await storage.outbox.get("act_later")).toBeNull();
    expect(client.outbox.unrejected()).toEqual([]);
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
    expect(conflict.entries[0]?.slots?.[0]?.local).toEqual({
      value: "mine",
      update_id: "u_local",
      hlc: LOCAL_HLC,
    });
    expect(conflict.entries[0]?.slots?.[0]?.remote).toEqual({
      value: "theirs",
      update_id: "u_peer",
      hlc: PEER_HLC,
    });
  });

  it("persists subjectStates with both rows across a reload and projects the diff", async () => {
    const storage = createMemoryAdapter();
    const stub = mkStubFetch();
    const client = mkClient(stub.fn, storage);
    await client.outbox.enqueue(
      mkTodoWrite({ id: "act_local", value: "mine", updateId: "u_local", hlc: LOCAL_HLC, gsn: 0 }),
    );
    // Capture the optimistic row the way a catch-up pass does, before the
    // peer's window replaces it.
    await (
      client as unknown as { capturePreSyncSnapshots(catchUpId: string): Promise<void> }
    ).capturePreSyncSnapshots("cu_1");
    const peer = mkTodoWrite({
      id: "act_peer",
      value: "theirs",
      updateId: "u_peer",
      hlc: PEER_HLC,
      gsn: 9,
    });
    await callApplyAction(client, peer, "g_1");
    await client.outbox.detectConflicts([peer], "cu_1");

    const states = client.outbox.conflicts()[0]?.conflict.subjectStates;
    expect(states?.[0]?.before?.data.fields.title.value).toBe("mine");
    expect(states?.[0]?.after?.data.fields.title.value).toBe("theirs");
    client.close();

    const reloaded = mkStubFetch();
    const clientB = mkClient(reloaded.fn, storage);
    await clientB.outbox.rehydrate();

    expect(clientB.outbox.conflicts()[0]?.conflict.subjectStates).toEqual(states);

    // A reload must reconstruct the diff from the durable rows alone:
    // no in-memory capture survives `close()`.
    await clientB.conflicts.rehydrate();
    const conflict = await onlyConflict(clientB);
    const state = conflict.subjectStates[0];
    expect(state?.subjectId).toBe("todo_1");
    expect(state?.model).toBe("todo");
    expect(state?.before?.data.fields.title.value).toBe("mine");
    expect(state?.after?.data.fields.title.value).toBe("theirs");
    expect(state?.diff).toEqual([
      { field: "title", path: [], before: "mine", after: "theirs", kind: "changed" },
    ]);
  });

  it("duplicate({ at: preSync }) copies the captured row over a real detected conflict", async () => {
    const storage = createMemoryAdapter();
    const stub = mkStubFetch();
    const client = mkClient(stub.fn, storage);
    await client.outbox.enqueue({
      id: "act_local",
      actor_id: ACTOR_ID,
      hlc: LOCAL_HLC,
      gsn: 0,
      updates: [
        {
          id: "u_local_0",
          subject_id: "todo_1",
          component: "todo/title",
          method: "replace",
          data: { value: "mine", update_id: "u_local", hlc: LOCAL_HLC },
        },
        {
          id: "u_local_1",
          subject_id: "todo_1",
          component: "todo/completed",
          method: "replace",
          data: { value: false, update_id: "u_local", hlc: LOCAL_HLC },
        },
      ],
    });
    await (
      client as unknown as { capturePreSyncSnapshots(catchUpId: string): Promise<void> }
    ).capturePreSyncSnapshots("cu_1");
    const peer = mkTodoWrite({
      id: "act_peer",
      value: "theirs",
      updateId: "u_peer",
      hlc: PEER_HLC,
      gsn: 9,
    });
    await callApplyAction(client, peer, "g_1");
    await client.outbox.detectConflicts([peer], "cu_1");

    const { id } = await client.actions.duplicate({
      entity: "todo",
      id: "todo_1",
      at: "preSync",
      groups: ["g_1"],
    });

    const title = postedActions(stub.calls)
      .flatMap((action) => action.updates)
      .find((update) => update.method !== "delete" && update.component === "todo/title");
    expect((title?.data as { value: unknown } | null)?.value).toBe("mine");
    expect(title?.subject_id).toBe(id);
    // The conflict's source row is untouched by the backup.
    expect((await client.readLocalEntity("todo_1"))?.data.fields.title.value).toBe("theirs");
  });

  it("re-materializes a losing Action's non-conflicting entity on clear", async () => {
    const storage = createMemoryAdapter();
    const stub = mkStubFetch();
    const client = mkClient(stub.fn, storage);

    // todo_2 exists on the server with title "server", older than the local write.
    await callApplyAction(
      client,
      {
        id: "act_seed",
        actor_id: ACTOR_ID,
        hlc: makeHlc(1_711_036_799_000),
        gsn: 5,
        updates: [
          {
            id: "u_seed_0",
            subject_id: "todo_2",
            component: "todo/title",
            method: "replace",
            data: {
              value: "server",
              update_id: "u_seed",
              hlc: makeHlc(1_711_036_799_000),
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
          id: "u_local_1_0",
          subject_id: "todo_1",
          component: "todo/title",
          method: "merge",
          data: { value: "mine", update_id: "u_local_1", hlc: LOCAL_HLC },
        },
        {
          id: "u_local_2_0",
          subject_id: "todo_2",
          component: "todo/title",
          method: "merge",
          data: { value: "mine", update_id: "u_local_2", hlc: LOCAL_HLC },
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

    await client.conflicts.clearLocalActions(conflict.id);

    expect((await client.readLocalEntity("todo_2"))?.data.fields.title.value).toBe("server");
    expect((await client.readLocalEntity("todo_1"))?.data.fields.title.value).toBe("theirs");
  });

  it("groups losing Actions on one entity into one conflict and fans sendLocalActions out", async () => {
    const { client, calls } = await seedTwoLosers();

    const conflicts = await client.conflicts.list();
    expect(conflicts).toHaveLength(1);
    const [conflict] = conflicts;
    if (conflict === undefined) throw new Error("expected a conflict");
    expect(conflict.entries.map((entry) => entry.action.id)).toEqual(["act_a", "act_b"]);

    const fanOut = await client.conflicts.sendLocalActions(conflict.id);
    expect(fanOut).toEqual({ resolved: ["act_a", "act_b"], failed: [] });
    expect(await client.conflicts.list()).toEqual([]);
    // One flush carries the whole group, still in authoring order.
    expect(postedActions(calls).map((action) => action.id)).toEqual(["act_a", "act_b"]);
  });

  it("keeps a later write to a held subject durable and off the wire until resolution", async () => {
    const { client, storage, conflictId, calls } = await seedConflict();
    const later = mkTodoWrite({
      id: "act_later",
      value: "local edit",
      updateId: "u_later",
      hlc: LATER_HLC,
      gsn: 0,
    });
    await client.outbox.enqueue(later);

    // Durable, and held out of the flushable set by the open conflict.
    expect(await storage.outbox.get("act_later")).toMatchObject({ status: "pending" });
    expect(client.outbox.pending()).toEqual([]);
    await expect(client.outbox.flush()).resolves.toEqual({ kind: "empty" });
    expect(actionCalls(calls)).toBe(0);

    // A reload preserves the hold: it is derived from the durable
    // conflicted row, not a session-private map.
    client.close();
    const reloaded = mkStubFetch();
    const clientB = mkClient(reloaded.fn, storage);
    await clientB.conflicts.rehydrate();
    expect(clientB.conflicts.count()).toBe(1);
    expect(clientB.outbox.pending()).toEqual([]);

    // Resolution releases the whole held set, in authoring order.
    await clientB.conflicts.sendLocalActions(conflictId);

    expect(postedActions(reloaded.calls).map((action) => action.id)).toEqual([
      "act_local",
      "act_later",
    ]);
    expect(await clientB.conflicts.list()).toEqual([]);
  });

  it("entity-scope loss with no position overlap reports the diff and keeps the envelope", async () => {
    const storage = createMemoryAdapter();
    const stub = mkStubFetch();
    const entityScopeDoc = defineModel(
      "doc",
      { content: Type.Record(Type.String(), Type.String()) },
      { conflictScope: "entity" },
    );
    const entityScopeSchema = defineSchema({ models: { doc: entityScopeDoc }, version: 3 });
    const client = createClient({
      serverUrl: SERVER_URL,
      actorId: ACTOR_ID,
      schema: entityScopeSchema,
      fetchImpl: stub.fn,
      storage,
    });

    const local: Action = {
      id: "act_local",
      actor_id: ACTOR_ID,
      hlc: LOCAL_HLC,
      gsn: 0,
      updates: [
        {
          id: "u_local_0",
          subject_id: "doc_1",
          component: "doc/content",
          method: "merge",
          data: { map: { a: { value: "mine", update_id: "u_local", hlc: LOCAL_HLC } } },
        },
      ],
    };
    await client.outbox.enqueue(local);

    // Capture the optimistic row the way a catch-up pass does, before the
    // peer's window replaces it.
    await (
      client as unknown as { capturePreSyncSnapshots(catchUpId: string): Promise<void> }
    ).capturePreSyncSnapshots("cu_1");

    // A disjoint map key: the peer touches the entity but no position the
    // local write holds, so entity scope surfaces the loss with no slot.
    const peer: Action = {
      id: "act_peer",
      actor_id: ACTOR_ID,
      hlc: PEER_HLC,
      gsn: 9,
      updates: [
        {
          id: "u_peer_0",
          subject_id: "doc_1",
          component: "doc/content",
          method: "merge",
          data: { map: { b: { value: "theirs", update_id: "u_peer", hlc: PEER_HLC } } },
        },
      ],
    };
    await callApplyAction(client, peer, "g_1");
    await client.outbox.detectConflicts([peer], "cu_1");

    const conflict = await onlyConflict(client);
    expect(conflict.scope).toBe("entity");
    expect(conflict.subjects).toEqual(["doc_1"]);
    // No slot list at entity scope; the report is the rows and their diff.
    expect(conflict.entries[0]?.slots).toBeUndefined();
    expect(conflict.subjectStates).toHaveLength(1);
    const state = conflict.subjectStates[0];
    expect(state?.subjectId).toBe("doc_1");
    expect(state?.before?.data.fields.content).toEqual({
      map: { a: { value: "mine", update_id: "u_local", hlc: LOCAL_HLC } },
    });
    expect(state?.after?.data.fields.content).toEqual({
      map: { b: { value: "theirs", update_id: "u_peer", hlc: PEER_HLC } },
    });
    expect(state?.diff).toEqual([
      { field: "content", path: ["a"], before: "mine", after: undefined, kind: "removed" },
      { field: "content", path: ["b"], before: undefined, after: "theirs", kind: "added" },
    ]);

    await client.conflicts.sendLocalActions(conflict.id);

    const actions = postedActions(stub.calls);
    expect(actions).toHaveLength(1);
    // Sent verbatim: the local update id and HLC are untouched.
    expect(actions[0]).toEqual(local);
  });

  it("reports per-entry send failures and leaves the failed entry resolvable", async () => {
    const storage = createMemoryAdapter();
    const outboxStore = storage.outbox;
    let failRelease = false;
    const guarded: ReturnType<typeof createMemoryAdapter> = {
      ...storage,
      outbox: {
        ...outboxStore,
        put: async (entry) => {
          if (failRelease && entry.status === "pending")
            throw new Error("outbox store unavailable");
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

    // A fault on the release write leaves the entry conflicted and
    // enqueues nothing.
    failRelease = true;
    const result = await client.conflicts.sendLocalActions(conflict.id);

    expect(result.resolved).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.entryId).toBe(entryId);
    expect(result.failed[0]?.error).toBeInstanceOf(Error);
    expect(client.outbox.pending()).toEqual([]);
    expect((await client.conflicts.list())[0]?.id).toBe(conflict.id);

    // The entry is still resolvable once the store recovers, and the send
    // replaces the hold rather than duplicating the Action.
    failRelease = false;
    const recovered = await client.conflicts.sendLocalActions(conflict.id);
    expect(recovered).toEqual({ resolved: [entryId], failed: [] });
    expect(await client.conflicts.list()).toEqual([]);
    expect(allPostedActions(stub.calls)).toHaveLength(1);
  });
});
