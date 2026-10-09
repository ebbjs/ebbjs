/**
 * Integration tests for the `client.conflicts` surface (#310).
 *
 * These pin the application-facing contract over a conflict detected by
 * the #308 inbound sweep: how it is surfaced and counted, how `retry`
 * rebases and re-enqueues the losing write, how `discard` converges the
 * local cache on the server's view, and that the count survives a reload
 * over the same durable storage.
 */

import { describe, it, expect } from "vitest";
import { Type } from "@sinclair/typebox";
import { decodeSync, isFieldMap, makeHlc, type Action } from "@ebbjs/core";
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

/** Seed one detected conflict: a pending local write out-dated by a peer. */
const seedConflict = async () => {
  const storage = createMemoryAdapter();
  const stub = mkStubFetch();
  const client = mkClient(stub.fn, storage);
  await client.outbox.enqueue(
    mkTodoWrite({ id: "act_local", value: "mine", updateId: "u_local", hlc: LOCAL_HLC, gsn: 0 }),
  );
  await callApplyAction(
    client,
    mkTodoWrite({ id: "act_peer", value: "theirs", updateId: "u_peer", hlc: PEER_HLC, gsn: 9 }),
    "g_1",
  );
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
    client.conflicts.onChange((entries) => seen.push(entries.length));

    await client.outbox.enqueue(
      mkTodoWrite({ id: "act_local", value: "mine", updateId: "u_local", hlc: LOCAL_HLC, gsn: 0 }),
    );
    await callApplyAction(
      client,
      mkTodoWrite({ id: "act_peer", value: "theirs", updateId: "u_peer", hlc: PEER_HLC, gsn: 9 }),
      "g_1",
    );

    const entries = await client.conflicts.list();

    expect(entries).toHaveLength(1);
    expect(entries[0]?.action.id).toBe("act_local");
    expect(entries[0]?.losses.map((loss) => loss.slot)).toEqual([
      { subjectId: "todo_1", field: "title", path: [] },
    ]);
    expect(entries[0]?.losses[0]?.winner).toEqual({
      update_id: "u_peer",
      hlc: PEER_HLC,
      value: "theirs",
    });
    expect(client.conflicts.count()).toBe(1);

    // Surfaced from the durable store, not a private cache.
    expect((await storage.conflicts.list()).map((entry) => entry.action.id)).toEqual(["act_local"]);
    // The losing Action was never posted.
    expect(actionCalls(stub.calls)).toBe(0);
    // onChange reported the detection without a poll.
    expect(seen).toContain(1);
  });

  it("retry re-enqueues a rebased Action that wins and flushes", async () => {
    const { client, calls } = await seedConflict();

    await client.conflicts.resolve("act_local", "retry");

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

  it("retry re-stamps only the conflicting field, leaving the rest of the write", async () => {
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
    await callApplyAction(
      client,
      mkTodoWrite({ id: "act_peer", value: "theirs", updateId: "u_peer", hlc: PEER_HLC, gsn: 9 }),
      "g_1",
    );
    expect((await client.conflicts.list())[0]?.losses.map((loss) => loss.slot)).toEqual([
      { subjectId: "todo_1", field: "title", path: [] },
    ]);

    await client.conflicts.resolve("act_local", "retry");

    const actions = postedActions(stub.calls);
    expect(actions).toHaveLength(1);
    const fields = actions[0]?.updates[0]?.data?.fields ?? {};
    expect(Object.keys(fields)).toEqual(["title"]);
    expect(fields.title?.value).toBe("mine");
  });

  it("discard converges local state on the server view and removes the conflict", async () => {
    const { client, calls } = await seedConflict();

    expect((await client.readLocalEntity("todo_1"))?.data.fields.title.value).toBe("theirs");

    await client.conflicts.resolve("act_local", "discard");

    expect(await client.conflicts.list()).toEqual([]);
    expect((await client.readLocalEntity("todo_1"))?.data.fields.title.value).toBe("theirs");
    expect(actionCalls(calls)).toBe(0);
  });

  it("counts a persisted conflict after a reload over the same storage", async () => {
    const { client, storage } = await seedConflict();
    client.close();

    const reloaded = mkStubFetch();
    const clientB = mkClient(reloaded.fn, storage);
    await clientB.conflicts.rehydrate();

    expect(clientB.conflicts.count()).toBe(1);
    expect((await clientB.conflicts.list()).map((entry) => entry.action.id)).toEqual(["act_local"]);
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
    await callApplyAction(
      client,
      mkTodoWrite({
        id: "act_peer",
        value: "theirs",
        updateId: "u_peer",
        hlc: PEER_HLC,
        gsn: 9,
      }),
      "g_1",
    );

    expect((await client.readLocalEntity("todo_2"))?.data.fields.title.value).toBe("mine");

    await client.conflicts.resolve("act_local", "discard");

    expect((await client.readLocalEntity("todo_2"))?.data.fields.title.value).toBe("server");
    expect((await client.readLocalEntity("todo_1"))?.data.fields.title.value).toBe("theirs");
  });

  it("retry re-stamps only the losing map key and leaves siblings out", async () => {
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

    await callApplyAction(
      client,
      {
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
      },
      "g_1",
    );

    const [entry] = await client.conflicts.list();
    expect(entry?.losses.map((loss) => loss.slot)).toEqual([
      { subjectId: "doc_1", field: "content", path: ["a"] },
    ]);

    await client.conflicts.resolve("act_local", "retry");

    const actions = postedActions(stub.calls);
    expect(actions).toHaveLength(1);
    const content = actions[0]?.updates[0]?.data?.fields.content;
    if (content === undefined || !isFieldMap(content)) throw new Error("expected a map field");
    expect(Object.keys(content.map)).toEqual(["a"]);
    const a = content.map.a;
    if (a === undefined || isFieldMap(a)) throw new Error("expected a leaf");
    expect(a.value).toBe("mine");
    expect(a.update_id).not.toBe("u_local");
    expect(a.hlc).not.toBe(LOCAL_HLC);
  });
});
