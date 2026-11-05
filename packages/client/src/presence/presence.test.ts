/**
 * Presence rides the client's live SSE stream (#666).
 *
 * These tests drive a real `SyncClient` against a path-dispatching fetch
 * mock: the live stream is an open body the test pushes presence packets
 * into. Assertions read what a consumer of `client.presence` sees — the
 * map, `onUpdate`, the subscriber's `onEvent`, and the request log — so a
 * later rewrite of the presence internals (#677) keeps them honest.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { createClient, type SyncClient } from "../sync/client";
import type { SSEEvent } from "../sync/types";
import {
  emptyCatchUpResponse,
  emptyListingResponse,
  isListingRequest,
  jsonResponse,
  waitFor,
} from "../sync/test-utils";

const SERVER_URL = "http://localhost:4000";
const LOCAL_ACTOR = "a_drew";

const cursor = {
  anchorId: "r_a",
  anchorOffset: 1,
  headId: "r_b",
  headOffset: 2,
};

/** An SSE `control` block asking the client to resume from `catchUpFrom`. */
const reconnectChunk = (catchUpFrom: number): string =>
  `event: control\ndata: ${JSON.stringify({
    reconnect: true,
    reason: "behind_watermark",
    catchUpFrom,
  })}\n\n`;

/** An SSE `presence` block, shaped as `GroupServer.broadcast_presence/4` emits it. */
const presenceChunk = (actorId: string, entityId = "doc_demo"): string =>
  `event: presence\ndata: ${JSON.stringify({
    actor_id: actorId,
    entity_id: entityId,
    data: cursor,
  })}\n\n`;

interface RecordedCall {
  readonly url: string;
  readonly init: RequestInit;
}

interface Harness {
  readonly fetchImpl: typeof fetch;
  /** Every request the client issued, in order. */
  readonly calls: readonly RecordedCall[];
  /** Push a chunk into the n-th (0-based) live stream. */
  readonly push: (stream: number, chunk: string) => void;
  readonly liveRequests: () => number;
  /** Live streams still open, i.e. neither ended nor torn down by the client. */
  readonly openStreams: () => number;
}

/**
 * A fetch mock for the whole sync surface. The live endpoint hands back an
 * open body per request and records when the client tears it down (via the
 * request's abort signal), so a test can assert how many streams are open.
 */
function harness(): Harness {
  const calls: RecordedCall[] = [];
  const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
  const closedStreams = new Set<number>();

  const fetchImpl = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });

    if (url.includes("/sync/presence")) return new Response(null, { status: 204 });
    if (isListingRequest(url)) return emptyListingResponse(0, "grp_1");
    if (url.includes("/sync/groups/")) return emptyCatchUpResponse();
    if (url.includes("/sync/live")) {
      const index = controllers.length;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controllers.push(controller);
        },
      });
      // A client-initiated close aborts the request; the body then ends, as
      // it would against a real server.
      init.signal?.addEventListener("abort", () => {
        closedStreams.add(index);
        try {
          controllers[index]?.close();
        } catch {
          // Already ended by the test.
        }
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    return jsonResponse({});
  }) as unknown as typeof fetch;

  return {
    fetchImpl,
    calls,
    push: (stream, chunk) => controllers[stream]!.enqueue(new TextEncoder().encode(chunk)),
    liveRequests: () => calls.filter((call) => call.url.includes("/sync/live")).length,
    openStreams: () => controllers.length - closedStreams.size,
  };
}

function connectedClient(h: Harness, opts: { reconnectInitialMs?: number } = {}): SyncClient {
  return createClient({
    serverUrl: SERVER_URL,
    actorId: LOCAL_ACTOR,
    fetchImpl: h.fetchImpl,
    ...opts,
  });
}

const urlsOf = (calls: readonly RecordedCall[]): string[] => calls.map((call) => call.url);

const bodyOf = (call: RecordedCall): unknown => JSON.parse(String(call.init.body));

afterEach(() => {
  vi.useRealTimers();
});

describe("client presence", () => {
  it("POSTs the local cursor to /sync/presence after the debounce", async () => {
    vi.useFakeTimers();
    const h = harness();
    const client = connectedClient(h);

    client.presence.setLocalCursor("doc_demo", cursor);
    expect(h.calls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(150);

    expect(urlsOf(h.calls)).toEqual([`${SERVER_URL}/sync/presence`]);
    expect(bodyOf(h.calls[0]!)).toEqual({ entity_id: "doc_demo", data: cursor });
    client.close();
  });

  it("collapses repeated setLocalCursor calls into one POST", async () => {
    vi.useFakeTimers();
    const h = harness();
    const client = connectedClient(h);

    for (let i = 0; i < 5; i++) {
      client.presence.setLocalCursor("doc_demo", { ...cursor, anchorOffset: i });
    }
    await vi.advanceTimersByTimeAsync(150);

    expect(h.calls).toHaveLength(1);
    expect((bodyOf(h.calls[0]!) as { data: { anchorOffset: number } }).data.anchorOffset).toBe(4);
    client.close();
  });

  it("sendNow bypasses the debounce", async () => {
    const h = harness();
    const client = connectedClient(h);

    await client.presence.sendNow("doc_demo", cursor);

    expect(urlsOf(h.calls)).toEqual([`${SERVER_URL}/sync/presence`]);
    client.close();
  });

  it("feeds the map from the live stream, excluding the local actor", async () => {
    const h = harness();
    const client = connectedClient(h);
    let updates = 0;
    client.presence.onUpdate(() => updates++);

    const unsubscribe = client.subscribe(["grp_1"], () => {});
    await waitFor(() => h.liveRequests() === 1);

    h.push(0, presenceChunk("a_alice"));
    h.push(0, presenceChunk(LOCAL_ACTOR));
    h.push(0, presenceChunk("a_bob", "other_doc"));

    await waitFor(() => client.presence.forEntity("doc_demo").has("a_alice"));
    const map = client.presence.forEntity("doc_demo");
    expect([...map.keys()]).toEqual(["a_alice"]);
    expect(map.get("a_alice")!.cursor).toEqual(cursor);
    expect(updates).toBeGreaterThan(0);

    unsubscribe();
    client.close();
  });

  it("delivers a presence packet to the subscriber's onEvent exactly once", async () => {
    const h = harness();
    const client = connectedClient(h);
    const events: SSEEvent[] = [];
    const mapSizes: number[] = [];

    const unsubscribe = client.subscribe(["grp_1"], (event) => {
      events.push(event);
      mapSizes.push(client.presence.forEntity("doc_demo").size);
    });
    await waitFor(() => h.liveRequests() === 1);

    h.push(0, presenceChunk("a_alice"));
    await waitFor(() => events.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("presence");
    // The map is fed before the subscriber sees the packet.
    expect(mapSizes).toEqual([1]);

    unsubscribe();
    client.close();
  });

  it("opens exactly one /sync/live and issues no /sync/handshake", async () => {
    const h = harness();
    const client = connectedClient(h);

    client.presence.start();
    const unsubscribe = client.subscribe(["grp_1"], () => {});
    await waitFor(() => h.liveRequests() === 1);
    // Give a stray second stream time to appear.
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(h.liveRequests()).toBe(1);
    expect(urlsOf(h.calls).some((url) => url.includes("/sync/handshake"))).toBe(false);

    unsubscribe();
    client.close();
  });

  it("start() and dispose() open no stream and issue no requests", async () => {
    const h = harness();
    const client = connectedClient(h);

    client.presence.start();
    client.presence.dispose();
    client.presence.start();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(h.calls).toHaveLength(0);
    client.close();
  });

  it("clears the map when the subscription closes", async () => {
    const h = harness();
    const client = connectedClient(h);

    const unsubscribe = client.subscribe(["grp_1"], () => {});
    await waitFor(() => h.liveRequests() === 1);
    h.push(0, presenceChunk("a_alice"));
    await waitFor(() => client.presence.forEntity("doc_demo").size === 1);

    unsubscribe();

    expect(client.presence.forEntity("doc_demo").size).toBe(0);
    client.close();
  });

  it("clears the map when the client closes", async () => {
    const h = harness();
    const client = connectedClient(h);

    client.subscribe(["grp_1"], () => {});
    await waitFor(() => h.liveRequests() === 1);
    h.push(0, presenceChunk("a_alice"));
    await waitFor(() => client.presence.forEntity("doc_demo").size === 1);

    client.close();

    expect(client.presence.forEntity("doc_demo").size).toBe(0);
  });

  it("does not carry stale peers across a reconnect", async () => {
    const h = harness();
    const client = connectedClient(h, { reconnectInitialMs: 1 });

    const unsubscribe = client.subscribe(["grp_1"], () => {});
    await waitFor(() => h.liveRequests() === 1);
    h.push(0, presenceChunk("a_alice"));
    await waitFor(() => client.presence.forEntity("doc_demo").size === 1);

    // The server reports our cursor is stale; the client drops the stream,
    // catches up, and re-opens it.
    h.push(0, reconnectChunk(5));
    await waitFor(() => h.liveRequests() === 2);

    expect(client.presence.forEntity("doc_demo").size).toBe(0);

    h.push(1, presenceChunk("a_bob"));
    await waitFor(() => client.presence.forEntity("doc_demo").size === 1);
    expect([...client.presence.forEntity("doc_demo").keys()]).toEqual(["a_bob"]);

    unsubscribe();
    client.close();
  });

  it("leaves one open stream across a StrictMode mount/unmount/remount", async () => {
    const h = harness();
    const client = connectedClient(h);

    // Mount.
    client.presence.start();
    const firstUnsubscribe = client.subscribe(["grp_1"], () => {});
    await waitFor(() => h.liveRequests() === 1);

    // StrictMode's immediate cleanup.
    client.presence.dispose();
    firstUnsubscribe();

    // Remount.
    client.presence.start();
    const secondUnsubscribe = client.subscribe(["grp_1"], () => {});
    await waitFor(() => h.liveRequests() === 2);
    await waitFor(() => h.openStreams() === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(h.openStreams()).toBe(1);

    secondUnsubscribe();
    client.close();
  });
});
