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
import { decodeSync, makeHlc, type Action, type FieldValue, type Update } from "@ebbjs/core";
import { createMemoryAdapter } from "@ebbjs/storage/memory";

import { createClient } from "../client";
import { callApplyAction, jsonResponse, waitFor } from "../test-utils";
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

describe("catch-up conflict detection (#308, #390)", () => {
  /**
   * A path-dispatching fetch that serves the catch-up window, the live
   * SSE stream, and the write endpoint. `missedByGroup` lets a test give
   * each subscribed group its own window; `pushLive` injects a live data
   * event into the open stream.
   */
  const mkSyncFetch = (
    opts: {
      missed?: readonly Action[];
      missedByGroup?: Record<string, readonly Action[]>;
      rejected?: readonly { id: string; reason: string }[];
      handshakeGroups?: readonly { id: string; cursor: number }[];
    } = {},
  ) => {
    const calls: string[] = [];
    const encoder = new TextEncoder();
    let liveController: ReadableStreamDefaultController<Uint8Array> | null = null;
    const liveResponse = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          liveController = controller;
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
    const fn = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push(url);
      if (url.includes("/sync/handshake")) {
        return jsonResponse({
          actor_id: ACTOR_ID,
          groups: (opts.handshakeGroups ?? []).map((group) => ({
            id: group.id,
            permissions: [],
            cursor_valid: true,
            reason: null,
            cursor: group.cursor,
          })),
        });
      }
      if (url.includes("/sync/groups/")) {
        const groupId = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
        const actions = opts.missedByGroup?.[groupId] ?? opts.missed ?? [];
        const nextOffset = actions.reduce((max, action) => Math.max(max, action.gsn), 0);
        return jsonResponse(actions, {
          "stream-next-offset": String(nextOffset),
          "stream-up-to-date": "true",
        });
      }
      if (url.includes("/sync/actions")) {
        return jsonResponse({ rejected: opts.rejected ?? [] });
      }
      if (url.includes("/sync/live")) return liveResponse;
      return jsonResponse({});
    }) as unknown as typeof fetch;
    const pushLive = (action: Action): void => {
      liveController?.enqueue(encoder.encode(`event: data\ndata: ${JSON.stringify(action)}\n\n`));
    };
    return { fn, calls, pushLive };
  };

  const mkSchemaClient = (fetchImpl: typeof fetch) => {
    const storage = createMemoryAdapter();
    const client = createClient({
      serverUrl: SERVER_URL,
      actorId: ACTOR_ID,
      storage,
      schema,
      fetchImpl,
    });
    return { client, storage };
  };

  /**
   * A `todo_1` write at the given HLC, defaulting to a `put` of one
   * `title` field. `method` and `fields` override those defaults.
   */
  const mkTodoWrite = (args: {
    id: string;
    value: string;
    updateId: string;
    hlc: string;
    gsn: number;
    method?: "put" | "patch";
    fields?: Record<string, FieldValue>;
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
        data: {
          fields: args.fields ?? {
            title: { value: args.value, update_id: args.updateId, hlc: args.hlc },
          },
        },
      },
    ],
  });

  it("moves a pending local write to the Conflicts store when the missed window out-dates it", async () => {
    const localHlc = makeHlc(1_711_036_800_000);
    const peerHlc = makeHlc(1_711_036_800_001);
    const { fn, calls } = mkSyncFetch({
      missed: [
        mkTodoWrite({ id: "act_peer", value: "theirs", updateId: "u_peer", hlc: peerHlc, gsn: 9 }),
      ],
    });
    const { client, storage } = mkSchemaClient(fn);

    // Enqueued before subscribe, so the write's base is 0.
    await client.outbox.enqueue(
      mkTodoWrite({ id: "act_local", value: "mine", updateId: "u_local", hlc: localHlc, gsn: 0 }),
    );
    expect(client.outbox.pending()[0]?.basedOnGsn).toBe(0);

    const unsubscribe = client.subscribe(["grp_1"], 0, () => {});
    await waitFor(async () => (await storage.conflicts.list()).length > 0);
    unsubscribe();

    const conflicts = await storage.conflicts.list();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.action.id).toBe("act_local");
    expect(conflicts[0]?.subjects).toEqual(["todo_1"]);
    expect(conflicts[0]?.basedOnGsn).toBe(0);
    expect(conflicts[0]?.catchUpId).toMatch(/^cu_/);
    expect(conflicts[0]?.conflictId).toMatch(/^c_/);
    expect(conflicts[0]?.slots).toEqual([
      {
        subjectId: "todo_1",
        field: "title",
        path: [],
        local: { value: "mine", update_id: "u_local", hlc: localHlc },
        remote: { value: "theirs", update_id: "u_peer", hlc: peerHlc },
      },
    ]);

    expect(await storage.outbox.get("act_local")).toBeNull();
    expect(client.outbox.pending()).toEqual([]);
    // The losing Action was never posted.
    expect(calls.some((url) => url.includes("/sync/actions"))).toBe(false);
  });

  it("moves a pending local patch to Conflicts when a missed put omits its field", async () => {
    const localHlc = makeHlc(1_711_036_800_000);
    const peerHlc = makeHlc(1_711_036_800_001);
    const { fn, calls } = mkSyncFetch({
      missed: [
        mkTodoWrite({
          id: "act_peer",
          value: "",
          updateId: "u_peer",
          hlc: peerHlc,
          gsn: 9,
          fields: { completed: { value: true, update_id: "u_peer", hlc: peerHlc } },
        }),
      ],
    });
    const { client, storage } = mkSchemaClient(fn);

    await client.outbox.enqueue(
      mkTodoWrite({
        id: "act_local",
        value: "mine",
        updateId: "u_local",
        hlc: localHlc,
        gsn: 0,
        method: "patch",
      }),
    );

    const unsubscribe = client.subscribe(["grp_1"], 0, () => {});
    await waitFor(async () => (await storage.conflicts.list()).length > 0);
    unsubscribe();

    const conflicts = await storage.conflicts.list();
    expect(conflicts).toHaveLength(1);
    // A missed `put` replaces the subject, so the omitted `title` is
    // reverted on the server: the remote side holds no value.
    expect(conflicts[0]?.slots).toEqual([
      {
        subjectId: "todo_1",
        field: "title",
        path: [],
        local: { value: "mine", update_id: "u_local", hlc: localHlc },
        remote: { value: undefined },
      },
    ]);

    expect(await storage.outbox.get("act_local")).toBeNull();
    expect(calls.some((url) => url.includes("/sync/actions"))).toBe(false);
  });

  it("does not flag a write whose base is at or ahead of the missed window", async () => {
    const localHlc = makeHlc(1_711_036_800_000);
    const peerHlc = makeHlc(1_711_036_800_001);
    const { fn, calls } = mkSyncFetch({
      handshakeGroups: [{ id: "grp_1", cursor: 5 }],
      missed: [
        mkTodoWrite({ id: "act_peer", value: "theirs", updateId: "u_peer", hlc: peerHlc, gsn: 3 }),
      ],
    });
    const { client, storage } = mkSchemaClient(fn);

    // The handshake cursor is this write's base, so the missed gsn 3 is
    // deliberately not concurrent.
    await client.handshake();
    await client.outbox.enqueue(
      mkTodoWrite({ id: "act_local", value: "mine", updateId: "u_local", hlc: localHlc, gsn: 0 }),
    );
    expect(client.outbox.pending()[0]?.basedOnGsn).toBe(5);

    const unsubscribe = client.subscribe(["grp_1"], 0, () => {});
    await waitFor(() => client.outbox.size("acknowledged") === 1);
    unsubscribe();

    expect(await storage.conflicts.list()).toEqual([]);
    expect(calls.filter((url) => url.includes("/sync/actions"))).toHaveLength(1);
  });

  it("never flags a structural relationship edge", async () => {
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
    const { fn, calls } = mkSyncFetch({ missed: [mkRelationship("act_peer", 9, "todo_b")] });
    const { client, storage } = mkSchemaClient(fn);
    await client.outbox.enqueue(mkRelationship("act_local", 0, "todo_a"));

    const unsubscribe = client.subscribe(["grp_1"], 0, () => {});
    // Detection runs before `live`; the structural edge never flags, so
    // the buffered write reaches the wire.
    await waitFor(() => client.state === "live");
    await waitFor(() => calls.some((url) => url.includes("/sync/actions")));
    expect(await storage.conflicts.list()).toEqual([]);
    unsubscribe();
  });

  it("flags a same-run race and ignores writes to a different run", async () => {
    const mkDocPatch = (
      id: string,
      runId: string,
      value: string,
      hlc: string,
      gsn: number,
    ): Action => ({
      id,
      actor_id: ACTOR_ID,
      hlc,
      gsn,
      updates: [
        {
          id: `u_${id}`,
          subject_id: "doc_1",
          subject_type: "text_document",
          method: "patch",
          data: {
            fields: { content: { map: { [runId]: { value, update_id: `u_${id}`, hlc } } } },
          },
        },
      ],
    });
    const { fn } = mkSyncFetch({
      missed: [
        mkDocPatch("act_peer_other", "run:r2", "peer-other", makeHlc(1_711_036_800_001), 9),
        mkDocPatch("act_peer_same", "run:r3", "peer-same", makeHlc(1_711_036_800_002), 10),
      ],
    });
    const { client, storage } = mkSchemaClient(fn);

    // Seed the document so the missed patches have a base to apply to.
    await callApplyAction(client, {
      id: "act_doc_base",
      actor_id: ACTOR_ID,
      hlc: makeHlc(1_711_036_799_000),
      gsn: 1,
      updates: [
        {
          id: "u_doc_base",
          subject_id: "doc_1",
          subject_type: "text_document",
          method: "put",
          data: {
            fields: {
              content: {
                map: {
                  "run:base": {
                    value: "base",
                    update_id: "u_doc_base",
                    hlc: makeHlc(1_711_036_799_000),
                  },
                },
              },
            },
          },
        },
      ],
    });

    // Different run keys merge independently: no slot is contested.
    await client.outbox.enqueue(
      mkDocPatch("act_local_other", "run:r1", "mine-other", makeHlc(1_711_036_800_000), 0),
    );
    await client.outbox.enqueue(
      mkDocPatch("act_local_same", "run:r3", "mine-same", makeHlc(1_711_036_800_000), 0),
    );

    const unsubscribe = client.subscribe(["grp_1"], 0, () => {});
    await waitFor(async () => (await storage.conflicts.list()).length > 0);
    unsubscribe();

    const conflicts = await storage.conflicts.list();
    expect(conflicts.map((entry) => entry.action.id)).toEqual(["act_local_same"]);
    expect(conflicts[0]?.subjects).toEqual(["doc_1"]);
    expect(conflicts[0]?.slots.map((slot) => slot.path)).toEqual([["run:r3"]]);
    expect(conflicts[0]?.slots[0]?.local).toMatchObject({ value: "mine-same" });
    expect(conflicts[0]?.slots[0]?.remote).toMatchObject({ value: "peer-same" });
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

  it("does not detect a live inbound write (detection is catch-up only)", async () => {
    const localHlc = makeHlc(1_711_036_800_000);
    const peerHlc = makeHlc(1_711_036_800_001);
    const { fn, pushLive } = mkSyncFetch({ missed: [] });
    const { client, storage } = mkSchemaClient(fn);

    await client.outbox.enqueue(
      mkTodoWrite({ id: "act_local", value: "mine", updateId: "u_local", hlc: localHlc, gsn: 0 }),
    );
    const unsubscribe = client.subscribe(["grp_1"], 0, () => {});
    await waitFor(() => client.state === "live");
    // The buffered write is accepted and its base is still 0, so the
    // live write below would be concurrent if detection ran live.
    await waitFor(async () => (await storage.outbox.get("act_local"))?.status === "acknowledged");

    pushLive(
      mkTodoWrite({ id: "act_peer", value: "theirs", updateId: "u_peer", hlc: peerHlc, gsn: 9 }),
    );
    await waitFor(
      async () => (await client.readLocalEntity("todo_1"))?.data.fields.title.value === "theirs",
    );

    expect(await storage.conflicts.list()).toEqual([]);
    expect(await storage.outbox.get("act_local")).not.toBeNull();
    unsubscribe();
  });

  it("stamps basedOnGsn from the minimum applied cursor across subscribed groups", async () => {
    const { fn } = mkSyncFetch({
      missedByGroup: {
        grp_1: [
          mkTodoWrite({
            id: "act_g1",
            value: "g1",
            updateId: "u_g1",
            hlc: makeHlc(1_711_036_800_000),
            gsn: 7,
          }),
        ],
        grp_2: [
          mkTodoWrite({
            id: "act_g2",
            value: "g2",
            updateId: "u_g2",
            hlc: makeHlc(1_711_036_800_001),
            gsn: 3,
          }),
        ],
      },
    });
    const { client } = mkSchemaClient(fn);

    const unsubscribe = client.subscribe(["grp_1", "grp_2"], 0, () => {});
    await waitFor(() => client.state === "live");

    await client.outbox.enqueue(
      mkTodoWrite({
        id: "act_local",
        value: "mine",
        updateId: "u_local",
        hlc: makeHlc(1_711_036_800_002),
        gsn: 0,
      }),
    );

    expect(client.outbox.pending()[0]?.basedOnGsn).toBe(3);
    unsubscribe();
  });
});
