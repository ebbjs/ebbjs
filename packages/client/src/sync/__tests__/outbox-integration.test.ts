/**
 * Integration tests for the Outbox seam (#227).
 *
 * These pin the behaviour the seam must preserve or add on top of the
 * direct-POST write path:
 *
 * - every write funnels through `client.outbox` (enqueue + flush);
 * - the local cache reflects the write before the server echo;
 * - an accepted write stays `acknowledged` until its own sync echo
 *   retires it, and a reload between ack and echo neither drops nor
 *   double-applies it;
 * - a server rejection is queryable through `outbox.errors()` and is
 *   retained until the application retries or clears it;
 * - the echo arriving over the sync path re-applies without changing
 *   the converged state (the materializer is HLC-ordered);
 * - a failed flush leaves the entries observable as pending.
 */

import { describe, it, expect } from "vitest";
import { decodeSync, makeHlc, type Action, type Update } from "@ebbjs/core";
import { createMemoryAdapter } from "@ebbjs/storage/memory";

import { createClient } from "../client";
import { callApplyAction } from "../test-utils";
import { defineEntity, e } from "../../schema/entity";
import { defineSchema } from "../../schema/schema";

const SERVER_URL = "http://localhost:4000";
const ACTOR_ID = "actor_1";

const todo = defineEntity("todo", {
  title: e.string(),
  completed: e.boolean(),
});

const schema = defineSchema({ entities: { todo }, version: 1 });

const mkAction = (): Action => ({
  id: "act_1",
  actor_id: ACTOR_ID,
  hlc: makeHlc(1_711_036_800_000),
  gsn: 0,
  updates: [
    {
      id: "u_1",
      subject_id: "todo_1",
      subject_type: "todo",
      method: "put",
      data: {
        fields: {
          title: { value: "Hello", update_id: "u_1", hlc: makeHlc(1_711_036_800_000) },
          completed: { value: false, update_id: "u_1", hlc: makeHlc(1_711_036_800_000) },
        },
      },
    },
  ],
});

interface StubFetch {
  fn: typeof fetch;
  calls: { url: string; init: RequestInit }[];
}

/**
 * Recording fetch stub. Responses come from a FIFO queue; once drained
 * it accepts writes with `{ rejected: [] }`.
 */
const mkStubFetch = (responses: { status?: number; body?: string }[] = []): StubFetch => {
  const calls: { url: string; init: RequestInit }[] = [];
  const queue = [...responses];
  const fn = (async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    const next = queue.shift();
    if (next !== undefined) {
      return new Response(next.body ?? "", { status: next.status ?? 200 });
    }
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
    fetchImpl,
    ...(storage === undefined ? {} : { storage }),
  });

const actionCalls = (calls: { url: string }[]): number =>
  calls.filter((c) => c.url.endsWith("/sync/actions")).length;

describe("client.outbox", () => {
  it("is exposed on the client and starts empty", () => {
    const client = mkClient(mkStubFetch().fn);

    expect(client.outbox.size()).toBe(0);
    expect(client.outbox.pending()).toEqual([]);
  });

  it("leaves an accepted entry acknowledged until its echo removes it", async () => {
    const { fn } = mkStubFetch();
    const storage = createMemoryAdapter();
    const client = mkClient(fn, storage);

    await client.write([mkAction()]);

    expect(client.outbox.size("acknowledged")).toBe(1);
    expect(await storage.outbox.get("act_1")).not.toBeNull();

    await callApplyAction(client, { ...mkAction(), gsn: 11 });

    expect(client.outbox.size()).toBe(0);
    expect(client.outbox.size("acknowledged")).toBe(0);
    expect(await storage.outbox.get("act_1")).toBeNull();
  });

  it("a reload between ack and echo keeps the entry for echo-matching without re-flushing", async () => {
    const storage = createMemoryAdapter();
    const writer = mkStubFetch();
    const clientA = mkClient(writer.fn, storage);
    await clientA.write([mkAction()]);

    // "Reload": a fresh client over the same durable storage.
    const reloaded = mkStubFetch();
    const clientB = mkClient(reloaded.fn, storage);
    await clientB.outbox.rehydrate();

    expect(clientB.outbox.size("pending")).toBe(0);
    expect(clientB.outbox.size("acknowledged")).toBe(1);
    // An acknowledged entry awaits its echo; it is never re-flushed.
    expect(actionCalls(reloaded.calls)).toBe(0);

    // The echo (as catch-up would replay it) retires the entry.
    await callApplyAction(clientB, { ...mkAction(), gsn: 4 });

    expect(clientB.outbox.size("acknowledged")).toBe(0);
    expect(await storage.outbox.get("act_1")).toBeNull();
    // The row was already applied before the reload; it is not re-applied.
    expect((await clientB.readLocalEntity("todo_1"))?.data.fields.title.value).toBe("Hello");
  });

  it("surfaces a server-rejected entry through errors() without removing it", async () => {
    const storage = createMemoryAdapter();
    const { fn } = mkStubFetch([
      { body: JSON.stringify({ rejected: [{ id: "act_1", reason: "permission_denied" }] }) },
    ]);
    const client = mkClient(fn, storage);

    const response = await client.write([mkAction()]);

    expect(response.rejected).toEqual([{ id: "act_1", reason: "permission_denied" }]);
    expect(client.outbox.errors().map((entry) => entry.action.id)).toEqual(["act_1"]);
    expect(await storage.outbox.get("act_1")).toMatchObject({ status: "error" });

    await client.outbox.retry("act_1");

    expect(client.outbox.errors()).toEqual([]);
    expect(client.outbox.size("pending")).toBe(1);
  });

  it("client.write() enqueues + flushes and leaves nothing pending on success", async () => {
    const { fn, calls } = mkStubFetch();
    const client = mkClient(fn);

    await client.write([mkAction()]);

    expect(client.outbox.size()).toBe(0);
    expect(actionCalls(calls)).toBe(1);
  });

  it("client.write() applies the action locally before the echo", async () => {
    const { fn } = mkStubFetch();
    const client = mkClient(fn);

    await client.write([mkAction()]);

    const row = await client.readLocalEntity("todo_1");
    expect(row?.data.fields.title.value).toBe("Hello");
  });

  it("optimistically merges map patches key by key before the echo", async () => {
    const { fn } = mkStubFetch();
    const client = mkClient(fn);
    const hlcA = makeHlc(1_711_036_800_000);
    const hlcB = makeHlc(1_711_036_800_001);

    await client.outbox.enqueue({
      id: "act_a",
      actor_id: ACTOR_ID,
      hlc: hlcA,
      gsn: 0,
      updates: [
        {
          id: "u_a",
          subject_id: "doc_1",
          subject_type: "doc",
          method: "put",
          data: {
            fields: { content: { map: { a: { value: "A", update_id: "u_a", hlc: hlcA } } } },
          },
        },
      ],
    });
    await client.outbox.enqueue({
      id: "act_b",
      actor_id: ACTOR_ID,
      hlc: hlcB,
      gsn: 0,
      updates: [
        {
          id: "u_b",
          subject_id: "doc_1",
          subject_type: "doc",
          method: "patch",
          data: {
            fields: { content: { map: { b: { value: "B", update_id: "u_b", hlc: hlcB } } } },
          },
        },
      ],
    });

    const row = await client.readLocalEntity("doc_1");

    expect(row?.data.fields.content).toEqual({
      map: {
        a: { value: "A", update_id: "u_a", hlc: hlcA },
        b: { value: "B", update_id: "u_b", hlc: hlcB },
      },
    });
  });

  it("client.write() fires the storage change emitter before the echo", async () => {
    const { fn } = mkStubFetch();
    const storage = createMemoryAdapter();
    const client = mkClient(fn, storage);
    if (storage.changeEmitter === undefined) {
      throw new Error("memory adapter must ship a change emitter");
    }
    const seen: unknown[] = [];
    storage.changeEmitter.onEntityChange("todo_1", (entity) => {
      if (entity !== null) seen.push(entity.data.fields.title.value);
    });

    await client.write([mkAction()]);

    expect(seen).toEqual(["Hello"]);
  });

  it("batches a multi-action write into a single request", async () => {
    const { fn, calls } = mkStubFetch();
    const client = mkClient(fn);
    const second: Action = {
      ...mkAction(),
      id: "act_2",
      updates: [
        {
          id: "u_2",
          subject_id: "todo_2",
          subject_type: "todo",
          method: "put",
          data: { fields: {} },
        } as never,
      ],
    };

    await client.write([mkAction(), second]);

    expect(actionCalls(calls)).toBe(1);
    const body = calls.find((c) => c.url.endsWith("/sync/actions"))?.init.body as Uint8Array;
    const decoded = decodeSync<{ actions: unknown[] }>(body);
    expect(decoded.actions).toHaveLength(2);
  });

  it("keeps the entries pending and rethrows when the flush fails", async () => {
    const { fn } = mkStubFetch([{ status: 500, body: "boom" }]);
    const client = mkClient(fn);

    await expect(client.write([mkAction()])).rejects.toThrow(/write failed: 500/);

    expect(client.outbox.size()).toBe(1);
    expect(client.outbox.pending()[0]?.action.id).toBe("act_1");
    // Stop the scheduler's background retry so it cannot fire into a later test.
    client.close();
  });

  it("re-applying the server echo converges on the optimistically-applied state", async () => {
    const { fn } = mkStubFetch();
    const client = mkClient(fn);

    await client.write([mkAction()]);
    const optimistic = await client.readLocalEntity("todo_1");
    const echo: Action = { ...mkAction(), gsn: 7 };

    await callApplyAction(client, echo);
    const afterEcho = await client.readLocalEntity("todo_1");
    await callApplyAction(client, echo);
    const afterDuplicate = await client.readLocalEntity("todo_1");

    expect(afterEcho?.data.fields).toEqual(optimistic?.data.fields);
    expect(afterDuplicate).toEqual(afterEcho);
  });

  it("advances updated_hlc on a locally-authored patch to the action's HLC", async () => {
    const { fn } = mkStubFetch();
    const client = mkClient(fn);
    // Seed the base row with an older HLC through the inbound path.
    await callApplyAction(client, { ...mkAction(), gsn: 1 });
    const base = await client.readLocalEntity("todo_1");
    const patchHlc = makeHlc(1_711_036_800_000, 1);
    const patch: Action = {
      id: "act_patch",
      actor_id: ACTOR_ID,
      hlc: patchHlc,
      gsn: 0,
      updates: [
        {
          id: "u_patch",
          subject_id: "todo_1",
          subject_type: "todo",
          method: "patch",
          data: {
            fields: {
              title: { value: "Patched", update_id: "u_patch", hlc: patchHlc },
            },
          },
        },
      ],
    };

    await client.write([patch]);

    const optimistic = await client.readLocalEntity("todo_1");
    expect(optimistic?.updated_hlc).toBe(patchHlc);
    expect(optimistic?.updated_hlc).not.toBe(base?.updated_hlc);
    // The post-echo replay must land on the same updated_hlc.
    await callApplyAction(client, { ...patch, gsn: 2 });
    expect((await client.readLocalEntity("todo_1"))?.updated_hlc).toBe(patchHlc);
  });

  it("updates a server-originated row without breaking materialization", async () => {
    const { fn } = mkStubFetch();
    const client = mkClient(fn);
    // Seed the row through the inbound path, as catch-up would.
    await callApplyAction(client, { ...mkAction(), gsn: 1 });
    const patch: Action = {
      id: "act_patch",
      actor_id: ACTOR_ID,
      hlc: makeHlc(1_711_036_800_000, 1),
      gsn: 0,
      updates: [
        {
          id: "u_patch",
          subject_id: "todo_1",
          subject_type: "todo",
          method: "patch",
          data: {
            fields: {
              title: {
                value: "Patched",
                update_id: "u_patch",
                hlc: makeHlc(1_711_036_800_000, 1),
              },
            },
          },
        },
      ],
    };

    await client.write([patch]);

    expect((await client.readLocalEntity("todo_1"))?.data.fields.title.value).toBe("Patched");
    // The echo must land on top of the server's base put, not trip over
    // the optimistic patch (which never enters the replay log).
    await callApplyAction(client, { ...patch, gsn: 2 });
    expect((await client.readLocalEntity("todo_1"))?.data.fields.title.value).toBe("Patched");
  });

  it("deletes a server-originated row without breaking materialization", async () => {
    const { fn } = mkStubFetch();
    const client = mkClient(fn);
    await callApplyAction(client, { ...mkAction(), gsn: 1 });
    const remove: Action = {
      id: "act_delete",
      actor_id: ACTOR_ID,
      hlc: makeHlc(1_711_036_800_000, 1),
      gsn: 0,
      updates: [
        {
          id: "u_delete",
          subject_id: "todo_1",
          subject_type: "todo",
          method: "delete",
          data: null,
        },
      ],
    };

    await client.write([remove]);

    expect((await client.readLocalEntity("todo_1"))?.deleted_hlc).not.toBeNull();
    await callApplyAction(client, { ...remove, gsn: 2 });
    expect((await client.readLocalEntity("todo_1"))?.deleted_hlc).not.toBeNull();
  });

  it("submitRelationshipUpdates() applies locally through the outbox", async () => {
    const { fn, calls } = mkStubFetch();
    const client = mkClient(fn);
    const update: Update = {
      id: "u_rel_1",
      subject_id: "rel_1",
      subject_type: "relationship",
      method: "put",
      data: {
        fields: { source_id: { value: "todo_1", update_id: "u_rel_1" } },
      },
    };

    await client.submitRelationshipUpdates([update]);

    expect(client.outbox.size()).toBe(0);
    expect(actionCalls(calls)).toBe(1);
    expect(await client.readLocalEntity("rel_1")).not.toBeNull();
  });
});

describe("client.<entity> writes through the outbox", () => {
  const mkSchemaClient = () => {
    const storage = createMemoryAdapter();
    const stub = mkStubFetch();
    const client = createClient({
      serverUrl: SERVER_URL,
      actorId: ACTOR_ID,
      storage,
      schema,
      fetchImpl: stub.fn,
    });
    return { client, storage, ...stub };
  };

  it("create() is visible to a local read before the echo", async () => {
    const { client } = mkSchemaClient();

    await client.todo.create({ title: "Ship", completed: false }, { groups: ["g_1"] });

    const rows = await client.todo.query();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("Ship");
    expect(client.outbox.size()).toBe(0);
  });

  it("update() optimistically patches the local row", async () => {
    const { client, storage } = mkSchemaClient();
    await client.todo.create({ title: "Ship", completed: false }, { groups: ["g_1"] });
    const id = (await storage.entities.query("todo"))[0]!.id;

    await client.todo.update(id, { completed: true });

    const row = await client.readLocalEntity(id);
    expect(row?.data.fields.completed.value).toBe(true);
    expect(row?.data.fields.title.value).toBe("Ship");
  });

  it("delete() optimistically tombstones the local row", async () => {
    const { client, storage } = mkSchemaClient();
    await client.todo.create({ title: "Ship", completed: false }, { groups: ["g_1"] });
    const id = (await storage.entities.query("todo"))[0]!.id;

    await client.todo.delete(id);

    const row = await client.readLocalEntity(id);
    expect(row?.deleted_hlc).not.toBeNull();
  });
});

describe("outbox rehydration across a simulated reload", () => {
  it("re-enqueues a write that failed to flush and submits it from a new client", async () => {
    const storage = createMemoryAdapter();
    const failing = mkStubFetch([{ status: 500, body: "boom" }]);
    const clientA = mkClient(failing.fn, storage);

    await expect(clientA.write([mkAction()])).rejects.toThrow(/write failed: 500/);
    expect(await storage.outbox.get("act_1")).not.toBeNull();
    // Stop clientA's background retry; the shared store is clientB's now.
    clientA.close();

    // "Reload": a fresh client over the same durable storage.
    const reloaded = mkStubFetch();
    const clientB = mkClient(reloaded.fn, storage);
    await clientB.outbox.rehydrate();

    expect(clientB.outbox.pending().map((entry) => entry.action.id)).toEqual(["act_1"]);

    // No caller involvement beyond the flush: the persisted entry is
    // re-enqueued and submitted from the reloaded client.
    await clientB.outbox.flush();

    expect(actionCalls(reloaded.calls)).toBe(1);
    expect(clientB.outbox.size()).toBe(0);
  });

  it("does not re-apply rehydrated entries to the local cache", async () => {
    const storage = createMemoryAdapter();
    const failing = mkStubFetch([{ status: 500, body: "boom" }]);
    const clientA = mkClient(failing.fn, storage);
    await expect(clientA.write([mkAction()])).rejects.toThrow(/write failed: 500/);
    // Stop clientA's background retry; the shared store is clientB's now.
    clientA.close();

    if (storage.changeEmitter === undefined) {
      throw new Error("memory adapter must ship a change emitter");
    }
    // Count every local apply after the failed writer is done. The
    // rehydrating client must not touch the cache: re-applying an
    // already-optimistically-applied Action is the double-apply bug.
    const applies: string[] = [];
    storage.changeEmitter.onEntityChange("todo_1", () => applies.push("change"));

    const reloaded = mkStubFetch();
    const clientB = mkClient(reloaded.fn, storage);
    await clientB.outbox.rehydrate();

    expect(clientB.outbox.size()).toBe(1);
    expect(applies).toEqual([]);
    expect((await clientB.readLocalEntity("todo_1"))?.data.fields.title.value).toBe("Hello");
    expect(applies).toEqual([]);
  });
});

describe("client.outbox LWW conflict detection (#308)", () => {
  const mkSchemaClient = () => {
    const storage = createMemoryAdapter();
    const stub = mkStubFetch();
    const client = createClient({
      serverUrl: SERVER_URL,
      actorId: ACTOR_ID,
      storage,
      schema,
      fetchImpl: stub.fn,
    });
    return { client, storage, ...stub };
  };

  /** A `put` for `todo_1` writing one LWW field at the given HLC. */
  const mkTodoWrite = (args: {
    id: string;
    value: string;
    updateId: string;
    hlc: string;
    gsn: number;
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
        method: "put",
        data: { fields: { title: { value: args.value, update_id: args.updateId, hlc: args.hlc } } },
      },
    ],
  });

  it("moves a pending local write to the Conflicts table when a peer out-dates it", async () => {
    const { client, storage, calls } = mkSchemaClient();
    const localHlc = makeHlc(1_711_036_800_000);
    await client.outbox.enqueue(
      mkTodoWrite({ id: "act_local", value: "mine", updateId: "u_local", hlc: localHlc, gsn: 0 }),
    );

    const peerHlc = makeHlc(1_711_036_800_001);
    await callApplyAction(
      client,
      mkTodoWrite({ id: "act_peer", value: "theirs", updateId: "u_peer", hlc: peerHlc, gsn: 9 }),
      "g_1",
    );

    expect(client.outbox.pending()).toEqual([]);
    expect(await storage.outbox.get("act_local")).toBeNull();
    const conflicts = await storage.conflicts.list();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.action.id).toBe("act_local");
    expect(conflicts[0]?.losses.map((loss) => loss.slot)).toEqual([
      { subjectId: "todo_1", field: "title", path: [] },
    ]);
    expect(conflicts[0]?.losses[0]?.winner).toEqual({
      update_id: "u_peer",
      hlc: peerHlc,
      value: "theirs",
    });

    // The losing Action was never posted.
    await expect(client.outbox.flush()).resolves.toEqual({ kind: "empty" });
    expect(actionCalls(calls)).toBe(0);
  });

  it("leaves the pending write flushable when the peer's edit is older", async () => {
    const { client, storage } = mkSchemaClient();
    await client.outbox.enqueue(
      mkTodoWrite({
        id: "act_local",
        value: "mine",
        updateId: "u_local",
        hlc: makeHlc(1_711_036_800_100),
        gsn: 0,
      }),
    );

    await callApplyAction(
      client,
      mkTodoWrite({
        id: "act_peer",
        value: "theirs",
        updateId: "u_peer",
        hlc: makeHlc(1_711_036_800_000),
        gsn: 9,
      }),
      "g_1",
    );

    expect(client.outbox.pending().map((entry) => entry.action.id)).toEqual(["act_local"]);
    expect(await storage.conflicts.list()).toEqual([]);
  });

  it("never flags a relationship edge as an LWW conflict", async () => {
    const { client, storage } = mkSchemaClient();
    const mkRelationship = (id: string, gsn: number, target: string): Action => ({
      id,
      actor_id: ACTOR_ID,
      hlc: makeHlc(1_711_036_800_000),
      gsn,
      updates: [
        {
          id: `u_${id}`,
          subject_id: "rel_1",
          subject_type: "relationship",
          method: "put",
          data: {
            fields: {
              source_id: { value: "todo_1", update_id: `u_${id}`, hlc: makeHlc(1_711_036_800_000) },
              target_id: { value: target, update_id: `u_${id}`, hlc: makeHlc(1_711_036_800_000) },
              type: { value: "link", update_id: `u_${id}`, hlc: makeHlc(1_711_036_800_000) },
              field: { value: "target", update_id: `u_${id}`, hlc: makeHlc(1_711_036_800_000) },
            },
          },
        },
      ],
    });
    await client.outbox.enqueue(mkRelationship("act_local", 0, "todo_a"));

    await callApplyAction(client, mkRelationship("act_peer", 9, "todo_b"), "g_1");

    expect(client.outbox.pending().map((entry) => entry.action.id)).toEqual(["act_local"]);
    expect(await storage.conflicts.list()).toEqual([]);
  });

  it("flags a same-run race and ignores writes to a different run", async () => {
    const storage = createMemoryAdapter();
    const client = mkClient(mkStubFetch().fn, storage);
    const mkDocWrite = (id: string, gsn: number, runId: string, hlc: string): Action => ({
      id,
      actor_id: ACTOR_ID,
      hlc,
      gsn,
      updates: [
        {
          id: `u_${id}`,
          subject_id: "doc_1",
          subject_type: "text_document",
          method: "put",
          data: {
            fields: {
              content: { map: { [runId]: { value: id, update_id: `u_${id}`, hlc } } },
            },
          },
        },
      ],
    });

    // Different run keys merge independently: no slot is out-dated.
    await client.outbox.enqueue(
      mkDocWrite("act_local_other", 0, "run:r1", makeHlc(1_711_036_800_000)),
    );
    await callApplyAction(
      client,
      mkDocWrite("act_peer_other", 9, "run:r2", makeHlc(1_711_036_800_001)),
      "g_1",
    );
    expect(client.outbox.pending().map((entry) => entry.action.id)).toEqual(["act_local_other"]);
    expect(await storage.conflicts.list()).toEqual([]);

    // Same run key, concurrent HLC: the inbound wins and the local
    // Action moves to the Conflicts store.
    await client.outbox.enqueue(
      mkDocWrite("act_local_same", 0, "run:r3", makeHlc(1_711_036_800_000)),
    );
    await callApplyAction(
      client,
      mkDocWrite("act_peer_same", 9, "run:r3", makeHlc(1_711_036_800_001)),
      "g_1",
    );

    expect(client.outbox.pending().map((entry) => entry.action.id)).toEqual(["act_local_other"]);
    expect((await storage.conflicts.list()).map((entry) => entry.action.id)).toEqual([
      "act_local_same",
    ]);
  });

  it("treats a server rejection as an Outbox error, not a conflict", async () => {
    const storage = createMemoryAdapter();
    const { fn } = mkStubFetch([
      { body: JSON.stringify({ rejected: [{ id: "act_1", reason: "not_authorized" }] }) },
    ]);
    const client = mkClient(fn, storage);

    await client.write([mkAction()]);

    expect(client.outbox.errors().map((entry) => entry.action.id)).toEqual(["act_1"]);
    expect(await storage.conflicts.list()).toEqual([]);
  });
});
