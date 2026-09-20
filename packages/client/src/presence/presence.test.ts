/**
 * PresenceManager unit tests.
 *
 * Uses a `__testInjectEntry__` seam to bypass the SSE pipeline for
 * data-ingest assertions — testing the network round-trip itself is
 * covered by the integration tests under packages/client/src/__tests__/integration/.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PresenceManager, type PresenceEntry } from "./presence";
import type { SyncClient } from "../sync/client";

interface CapturedCall {
  url: string;
  init: RequestInit;
}

function makeStubClient(handshakeGroups: string[]): SyncClient & {
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const fetchStub = vi.fn(async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    calls.push({ url, init: init ?? {} });
    if (url.endsWith("/sync/handshake")) {
      return new Response(JSON.stringify({ groups: handshakeGroups.map((id) => ({ id })) }), {
        status: 200,
      }) as unknown as Response;
    }
    if (url.endsWith("/sync/presence")) {
      return new Response(null, { status: 204 }) as unknown as Response;
    }
    return new Response(null, { status: 404 }) as unknown as Response;
  });
  // Cast: the stub only implements the surface PresenceManager reads
  // (serverUrl, actorId, fetchImpl). Cast through unknown to skip the
  // rest of SyncClient's required fields, which aren't exercised here.
  const client = {
    actorId: "local-actor",
    serverUrl: "http://localhost:4000",
    fetchImpl: fetchStub as typeof fetch,
    calls,
  } as unknown as SyncClient & { calls: CapturedCall[] };
  return client;
}

describe("PresenceManager", () => {
  let client: ReturnType<typeof makeStubClient>;
  let pm: PresenceManager;

  beforeEach(() => {
    vi.useFakeTimers();
    client = makeStubClient(["grp_demo"]);
    pm = new PresenceManager(client);
  });

  afterEach(() => {
    pm.dispose();
    vi.useRealTimers();
  });

  it("POSTs the local cursor to /sync/presence after the debounce", async () => {
    pm.setLocalCursor("doc_demo", {
      anchorId: "r_a",
      anchorOffset: 5,
      headId: "r_b",
      headOffset: 7,
    });
    expect(client.calls.length).toBe(0);
    await vi.advanceTimersByTimeAsync(150);
    expect(client.calls.length).toBe(1);
    expect(client.calls[0]!.url).toBe("http://localhost:4000/sync/presence");
    const body = JSON.parse(client.calls[0]!.init.body as string);
    expect(body).toEqual({
      entity_id: "doc_demo",
      data: { anchorId: "r_a", anchorOffset: 5, headId: "r_b", headOffset: 7 },
    });
  });

  it("collapses repeated setLocalCursor calls into one POST", async () => {
    for (let i = 0; i < 5; i++) {
      pm.setLocalCursor("doc_demo", {
        anchorId: "r",
        anchorOffset: i,
        headId: "r",
        headOffset: i,
      });
    }
    await vi.advanceTimersByTimeAsync(150);
    expect(client.calls.length).toBe(1);
    const body = JSON.parse(client.calls[0]!.init.body as string);
    expect(body.data.anchorOffset).toBe(4);
  });

  it("sendNow bypasses the debounce", async () => {
    await pm.sendNow("doc_demo", {
      anchorId: "r",
      anchorOffset: 0,
      headId: "r",
      headOffset: 0,
    });
    expect(client.calls.length).toBe(1);
  });

  it("forEntity excludes the local actor and filters by entity", () => {
    const entry: PresenceEntry = {
      actorId: "alice",
      entityId: "doc_demo",
      cursor: { anchorId: "r", anchorOffset: 1, headId: "r", headOffset: 1 },
    };
    pm.__testInjectEntry__(entry);
    pm.__testInjectEntry__({
      ...entry,
      actorId: "local-actor", // self — should be excluded
    });
    pm.__testInjectEntry__({
      ...entry,
      actorId: "bob",
      entityId: "other_doc", // different entity — excluded
    });

    const map = pm.forEntity("doc_demo");
    expect(map.has("alice")).toBe(true);
    expect(map.has("bob")).toBe(false);
    expect(map.has("local-actor")).toBe(false);
  });

  it("onUpdate fires when a presence event arrives", () => {
    let calls = 0;
    pm.onUpdate(() => calls++);
    pm.__testInjectEntry__({
      actorId: "alice",
      entityId: "doc_demo",
      cursor: { anchorId: "r", anchorOffset: 1, headId: "r", headOffset: 1 },
    });
    expect(calls).toBe(1);
  });

  it("dispose tears down listeners and stops pending sends", async () => {
    pm.setLocalCursor("doc_demo", {
      anchorId: "r",
      anchorOffset: 0,
      headId: "r",
      headOffset: 0,
    });
    pm.dispose();
    await vi.advanceTimersByTimeAsync(200);
    expect(client.calls.length).toBe(0);
  });

  it("onUpdate returns an unsubscribe function", () => {
    let calls = 0;
    const unsub = pm.onUpdate(() => calls++);
    pm.__testInjectEntry__({
      actorId: "alice",
      entityId: "doc_demo",
      cursor: { anchorId: "r", anchorOffset: 1, headId: "r", headOffset: 1 },
    });
    expect(calls).toBe(1);
    unsub();
    pm.__testInjectEntry__({
      actorId: "alice",
      entityId: "doc_demo",
      cursor: { anchorId: "r", anchorOffset: 2, headId: "r", headOffset: 2 },
    });
    expect(calls).toBe(1);
  });
});
