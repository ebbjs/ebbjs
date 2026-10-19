/**
 * Client-level integration for the materialized replica (#496).
 *
 * The engine read path is `client.replica`. Hydration is the persisted
 * record ⊕ the action-log tail ⊕ the durable outbox overlay; the sync
 * lifecycle persists the record as a fast path, and an engine reading
 * the replica directly awaits `hydrateReplica`.
 */

import { describe, expect, it } from "vitest";
import { makeHlc, type Action } from "@ebbjs/core";
import { createMemoryAdapter } from "@ebbjs/storage/memory";

import { createClient } from "../client";
import { callApplyAction } from "../test-utils";

const SERVER_URL = "http://localhost:4000";
const ACTOR_ID = "actor_1";

const put = (opts: {
  id: string;
  entityId: string;
  value: string;
  gsn: number;
  ms: number;
}): Action => {
  const hlc = makeHlc(opts.ms);
  return {
    id: opts.id,
    actor_id: ACTOR_ID,
    hlc,
    gsn: opts.gsn,
    updates: [
      {
        id: `u_${opts.id}`,
        subject_id: opts.entityId,
        subject_type: "todo",
        method: "put",
        data: { fields: { title: { value: opts.value, update_id: `u_${opts.id}`, hlc } } },
      },
    ],
  };
};

const mkClient = (storage: ReturnType<typeof createMemoryAdapter>) =>
  createClient({
    serverUrl: SERVER_URL,
    actorId: ACTOR_ID,
    storage,
    fetchImpl: (async () =>
      new Response(JSON.stringify({ rejected: [] }), { status: 200 })) as unknown as typeof fetch,
  });

describe("client replica (#496)", () => {
  it("hydrates from the persisted record plus the action-log tail", async () => {
    const storage = createMemoryAdapter();
    const client = mkClient(storage);
    await callApplyAction(
      client,
      put({ id: "a_1", entityId: "todo_1", value: "Hello", gsn: 1, ms: 10 }),
    );
    await callApplyAction(
      client,
      put({ id: "a_2", entityId: "todo_2", value: "World", gsn: 2, ms: 20 }),
    );
    expect(client.replica.get("todo_1")?.data.fields.title.value).toBe("Hello");

    // Snapshot here, then advance the log behind the record.
    await client.persistReplica();
    await callApplyAction(
      client,
      put({ id: "a_3", entityId: "todo_3", value: "Third", gsn: 3, ms: 30 }),
    );

    const reloaded = mkClient(storage);
    await reloaded.hydrateReplica();
    expect(reloaded.replica.get("todo_1")?.data.fields.title.value).toBe("Hello");
    expect(reloaded.replica.get("todo_3")?.data.fields.title.value).toBe("Third");
    expect(reloaded.replica.iterate("todo")).toHaveLength(3);
  });

  it("replays the durable outbox overlay into the replica on hydrate", async () => {
    const storage = createMemoryAdapter();
    const client = mkClient(storage);
    await callApplyAction(
      client,
      put({ id: "a_1", entityId: "todo_1", value: "Base", gsn: 1, ms: 10 }),
    );
    await client.outbox.enqueue({
      id: "a_local",
      actor_id: ACTOR_ID,
      hlc: makeHlc(20),
      gsn: 0,
      updates: [
        {
          id: "u_local",
          subject_id: "todo_1",
          subject_type: "todo",
          method: "patch",
          data: {
            fields: { title: { value: "Local", update_id: "u_local", hlc: makeHlc(20) } },
          },
        },
      ],
    });

    const reloaded = mkClient(storage);
    await reloaded.hydrateReplica();
    expect(reloaded.replica.get("todo_1")?.data.fields.title.value).toBe("Local");
  });
});
