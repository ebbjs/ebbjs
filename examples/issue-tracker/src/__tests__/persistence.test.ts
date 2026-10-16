/**
 * The demo's durable-storage wiring: a pending Outbox entry written
 * through `createAppStorage` must still be there when the app reopens the
 * same database — the client-side half of "a pending write survives a
 * page reload". The rehydrate-and-flush half lives in `@ebbjs/client` and
 * `@ebbjs/storage`; this pins the per-actor database the app opens.
 */

import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import { buildSeedAction } from "@ebbjs/core/seed";
import type { OutboxEntry } from "@ebbjs/storage/types";
import { createAppStorage } from "../bootstrap";

const pendingEntry = (actorId: string): OutboxEntry => ({
  action: buildSeedAction(actorId, {
    groups: [],
    groupMembers: [],
    entities: [
      {
        id: `ent_${actorId}`,
        type: "issue",
        patches: [{ fields: { title: "pending write" } }],
      },
    ],
  }),
  status: "pending",
  enqueuedAtHlc: "1-0",
  basedOnGsn: 0,
});

describe("createAppStorage", () => {
  it("keeps a pending Outbox entry across a reopen", async () => {
    const actorId = `persist_${Date.now().toString(36)}`;
    const entry = pendingEntry(actorId);

    const first = await createAppStorage(actorId);
    await first.outbox.put(entry);

    // A reload opens a fresh adapter over the same per-actor database.
    const reloaded = await createAppStorage(actorId);
    const entries = await reloaded.outbox.list();
    expect(entries.map((row) => row.action.id)).toEqual([entry.action.id]);
    expect(entries[0]?.status).toBe("pending");
  });
});
