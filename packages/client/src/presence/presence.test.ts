/**
 * Presence: declared ephemeral channels over the live stream (#677).
 *
 * Three seams, one per piece of the module:
 *
 * - `definePresence` — the pure registry (defaults, freezing).
 * - The send half — driven through a real `SyncClient` and the injected
 *   `fetchImpl`, so assertions read the requests a server would see.
 * - The receive half — the store fed directly with `presence` packets, plus
 *   the same packets pushed through an open live stream so the client's
 *   wiring stays covered.
 */

import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createClient, type SyncClient } from "../sync/client";
import {
  createPresenceStore,
  DEFAULT_PRESENCE_MAX_ENTRIES,
  DEFAULT_PRESENCE_TTL_MS,
  definePresence,
  MAX_PRESENCE_PAYLOAD_BYTES,
  PresencePayloadTooLargeError,
  PresenceValidationError,
  UndeclaredPresenceChannelError,
  type PeerPresence,
  type PresenceChannelConfig,
  type PresenceChange,
  type UntypedPresenceApi,
} from "./presence";
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

const camera = { x: 10, y: 4, zoom: 1.5 };

const cursorSchema = Type.Object({
  anchorId: Type.String(),
  anchorOffset: Type.Number(),
  headId: Type.String(),
  headOffset: Type.Number(),
});

const cameraSchema = Type.Object({
  x: Type.Number(),
  y: Type.Number(),
  zoom: Type.Number(),
});

/** An SSE `control` block asking the client to resume from `catchUpFrom`. */
const reconnectChunk = (catchUpFrom: number): string =>
  `event: control\ndata: ${JSON.stringify({
    reconnect: true,
    reason: "behind_watermark",
    catchUpFrom,
  })}\n\n`;

/** An SSE `presence` block, shaped as `GroupServer.broadcast_presence/4` emits it. */
const presenceChunk = (
  actorId: string,
  entityId: string,
  channel: string,
  value: unknown,
): string =>
  `event: presence\ndata: ${JSON.stringify({
    actor_id: actorId,
    entity_id: entityId,
    data: { channel, value },
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

const presenceCalls = (calls: readonly RecordedCall[]): readonly RecordedCall[] =>
  calls.filter((call) => call.url.includes("/sync/presence"));

const bodyOf = (call: RecordedCall): unknown => JSON.parse(String(call.init.body));

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// definePresence
// ---------------------------------------------------------------------------

describe("definePresence", () => {
  it("normalizes every channel to its effective options", () => {
    const registry = definePresence({
      cursor: cursorSchema,
      camera: { schema: cameraSchema, debounceMs: 16, ttlMs: Infinity, maxEntries: 4 },
    });

    expect(registry.channels.cursor).toMatchObject({
      schema: cursorSchema,
      debounceMs: 100,
      ttlMs: DEFAULT_PRESENCE_TTL_MS,
      maxEntries: DEFAULT_PRESENCE_MAX_ENTRIES,
    });
    expect(registry.channels.camera).toMatchObject({
      schema: cameraSchema,
      debounceMs: 16,
      ttlMs: Infinity,
      maxEntries: 4,
    });
  });

  it("is pure and frozen", () => {
    const channels = { cursor: cursorSchema };
    const registry = definePresence(channels);

    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.channels)).toBe(true);
    expect(Object.isFrozen(registry.channels.cursor)).toBe(true);
    // The input is untouched, and the registry is a new object.
    expect(Object.isFrozen(channels)).toBe(false);
    expect(Object.keys(registry.channels)).toEqual(["cursor"]);
  });
});

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

describe("presence send", () => {
  it("POSTs the channel envelope after the debounce", async () => {
    vi.useFakeTimers();
    const h = harness();
    const client = connectedClient(h);

    client.presence.set("doc_demo", "cursor", cursor);
    expect(h.calls).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(150);

    expect(presenceCalls(h.calls)).toHaveLength(1);
    expect(bodyOf(presenceCalls(h.calls)[0]!)).toEqual({
      entity_id: "doc_demo",
      data: { channel: "cursor", value: cursor },
    });
    client.close();
  });

  it("collapses repeated sends on one (entity, channel) into one POST", async () => {
    vi.useFakeTimers();
    const h = harness();
    const client = connectedClient(h);

    for (let i = 0; i < 5; i++) {
      client.presence.set("doc_demo", "cursor", { ...cursor, anchorOffset: i });
    }
    await vi.advanceTimersByTimeAsync(150);

    const calls = presenceCalls(h.calls);
    expect(calls).toHaveLength(1);
    expect((bodyOf(calls[0]!) as { data: { value: { anchorOffset: number } } }).data.value).toEqual(
      {
        ...cursor,
        anchorOffset: 4,
      },
    );
    client.close();
  });

  it("keeps a send on another channel of the same entity", async () => {
    vi.useFakeTimers();
    const h = harness();
    const client = connectedClient(h);

    client.presence.set("doc_demo", "cursor", cursor);
    client.presence.set("doc_demo", "camera", camera);
    await vi.advanceTimersByTimeAsync(150);

    const bodies = presenceCalls(h.calls).map(bodyOf);
    expect(bodies).toHaveLength(2);
    expect(bodies).toEqual(
      expect.arrayContaining([
        { entity_id: "doc_demo", data: { channel: "cursor", value: cursor } },
        { entity_id: "doc_demo", data: { channel: "camera", value: camera } },
      ]),
    );
    client.close();
  });

  it("keeps a pending send on another entity", async () => {
    vi.useFakeTimers();
    const h = harness();
    const client = connectedClient(h);

    client.presence.set("doc_a", "cursor", cursor);
    client.presence.set("doc_b", "cursor", { ...cursor, anchorOffset: 9 });
    await vi.advanceTimersByTimeAsync(150);

    const bodies = presenceCalls(h.calls).map(bodyOf) as { entity_id: string }[];
    expect(bodies.map((body) => body.entity_id).sort()).toEqual(["doc_a", "doc_b"]);
    client.close();
  });

  it("clear sends a null value for just that channel", async () => {
    const h = harness();
    const client = connectedClient(h);

    client.presence.clear("doc_demo", "camera");
    await client.presence.flush();

    expect(presenceCalls(h.calls).map(bodyOf)).toEqual([
      { entity_id: "doc_demo", data: { channel: "camera", value: null } },
    ]);
    client.close();
  });

  it("works without a registry, with dynamic channels and unvalidated values", async () => {
    const h = harness();
    const client = connectedClient(h);

    client.presence.set("doc_demo", "activeTool", { name: "pen", width: 3 });
    await client.presence.flush();

    expect(presenceCalls(h.calls).map(bodyOf)).toEqual([
      { entity_id: "doc_demo", data: { channel: "activeTool", value: { name: "pen", width: 3 } } },
    ]);
    client.close();
  });

  it("uses a declared channel's own debounce", async () => {
    vi.useFakeTimers();
    const h = harness();
    const presence = definePresence({
      cursor: cursorSchema,
      camera: { schema: cameraSchema, debounceMs: 1_000 },
    });
    const client = createClient({
      serverUrl: SERVER_URL,
      actorId: LOCAL_ACTOR,
      fetchImpl: h.fetchImpl,
      presence,
    });

    client.presence.set("doc_demo", "cursor", cursor);
    client.presence.set("doc_demo", "camera", camera);

    await vi.advanceTimersByTimeAsync(150);
    expect(presenceCalls(h.calls).map(bodyOf)).toEqual([
      { entity_id: "doc_demo", data: { channel: "cursor", value: cursor } },
    ]);

    await vi.advanceTimersByTimeAsync(900);
    expect(presenceCalls(h.calls)).toHaveLength(2);
    client.close();
  });

  it("throws on a channel the registry does not declare", () => {
    const h = harness();
    const client = createClient({
      serverUrl: SERVER_URL,
      actorId: LOCAL_ACTOR,
      fetchImpl: h.fetchImpl,
      presence: definePresence({ cursor: cursorSchema }),
    });
    // A JS caller (or a cast) can still reach the untyped shape.
    const untyped = client.presence as unknown as UntypedPresenceApi;

    expect(() => untyped.set("doc_demo", "tool", "pen")).toThrow(UndeclaredPresenceChannelError);
    expect(() => untyped.clear("doc_demo", "tool")).toThrow(UndeclaredPresenceChannelError);
    expect(presenceCalls(h.calls)).toHaveLength(0);
    client.close();
  });

  it("rejects a value the channel's schema does not accept", () => {
    const h = harness();
    const client = createClient({
      serverUrl: SERVER_URL,
      actorId: LOCAL_ACTOR,
      fetchImpl: h.fetchImpl,
      presence: definePresence({ cursor: cursorSchema }),
    });
    const untyped = client.presence as unknown as UntypedPresenceApi;

    expect(() => untyped.set("doc_demo", "cursor", { ...cursor, anchorOffset: "one" })).toThrow(
      PresenceValidationError,
    );
    expect(presenceCalls(h.calls)).toHaveLength(0);
    client.close();
  });

  it("rejects an oversized payload at the call site", async () => {
    const h = harness();
    const client = connectedClient(h);

    const oversized = { blob: "x".repeat(MAX_PRESENCE_PAYLOAD_BYTES) };
    let thrown: unknown = null;
    try {
      client.presence.set("doc_demo", "cursor", oversized);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(PresencePayloadTooLargeError);
    expect((thrown as PresencePayloadTooLargeError).limit).toBe(MAX_PRESENCE_PAYLOAD_BYTES);
    expect((thrown as PresencePayloadTooLargeError).channel).toBe("cursor");

    await client.presence.flush();
    expect(presenceCalls(h.calls)).toHaveLength(0);
    client.close();
  });

  it("drops a failed send instead of queueing or retrying it", async () => {
    const failingFetch = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    const client = createClient({
      serverUrl: SERVER_URL,
      actorId: LOCAL_ACTOR,
      fetchImpl: failingFetch,
    });

    client.presence.set("doc_demo", "cursor", cursor);
    await client.presence.flush();
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(failingFetch).toHaveBeenCalledTimes(1);
    expect(await client.storage.outbox.list()).toHaveLength(0);
    client.close();
  });

  it("cancels pending sends when the client closes", async () => {
    vi.useFakeTimers();
    const h = harness();
    const client = connectedClient(h);

    client.presence.set("doc_demo", "cursor", cursor);
    client.close();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(presenceCalls(h.calls)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Receive store
// ---------------------------------------------------------------------------

const packet = (actorId: string, entityId: string, channel: string, value: unknown): unknown => ({
  actor_id: actorId,
  entity_id: entityId,
  data: { channel, value },
});

const channelsWith = (
  config: Partial<PresenceChannelConfig>,
): {
  readonly channels: Readonly<Record<string, PresenceChannelConfig>>;
} => ({
  channels: {
    cursor: {
      schema: cursorSchema,
      debounceMs: 100,
      ttlMs: DEFAULT_PRESENCE_TTL_MS,
      maxEntries: DEFAULT_PRESENCE_MAX_ENTRIES,
      ...config,
    },
  },
});

describe("presence receive store", () => {
  it("keys entries by (entity, channel, actor) and excludes the local actor", () => {
    const store = createPresenceStore({ localActorId: LOCAL_ACTOR });

    store.ingest(packet("a_alice", "doc_a", "cursor", cursor));
    store.ingest(packet("a_bob", "doc_a", "camera", camera));
    store.ingest(packet("a_bob", "doc_b", "cursor", cursor));
    store.ingest(packet(LOCAL_ACTOR, "doc_a", "cursor", cursor));

    expect([...store.forEntity("doc_a", "cursor").keys()]).toEqual(["a_alice"]);
    expect([...store.forEntity("doc_a", "camera").keys()]).toEqual(["a_bob"]);
    expect([...store.forEntity("doc_b", "cursor").keys()]).toEqual(["a_bob"]);

    const entry = store.forEntity<typeof cursor>("doc_a", "cursor").get("a_alice")!;
    expect(entry).toMatchObject({
      actorId: "a_alice",
      entityId: "doc_a",
      channel: "cursor",
      data: cursor,
    });
    expect(typeof entry.updatedAt).toBe("number");
  });

  it("reports the changed (entity, channel) and lets a listener ignore others", () => {
    const store = createPresenceStore({ localActorId: LOCAL_ACTOR });
    const changes: PresenceChange[] = [];
    const cursorChanges: PresenceChange[] = [];
    store.onUpdate((change) => {
      changes.push(change);
      if (change.channel === "cursor") cursorChanges.push(change);
    });

    store.ingest(packet("a_alice", "doc_a", "cursor", cursor));
    store.ingest(packet("a_alice", "doc_a", "camera", camera));
    store.ingest(packet("a_alice", "doc_a", "camera", camera));

    expect(changes).toEqual([
      { entityId: "doc_a", channel: "cursor" },
      { entityId: "doc_a", channel: "camera" },
      { entityId: "doc_a", channel: "camera" },
    ]);
    expect(cursorChanges).toEqual([{ entityId: "doc_a", channel: "cursor" }]);
  });

  it("removes only that actor's entry for that (entity, channel) on a null value", () => {
    const store = createPresenceStore({ localActorId: LOCAL_ACTOR });
    store.ingest(packet("a_alice", "doc_a", "cursor", cursor));
    store.ingest(packet("a_bob", "doc_a", "cursor", cursor));
    store.ingest(packet("a_alice", "doc_a", "camera", camera));

    store.ingest(packet("a_alice", "doc_a", "cursor", null));

    expect([...store.forEntity("doc_a", "cursor").keys()]).toEqual(["a_bob"]);
    expect([...store.forEntity("doc_a", "camera").keys()]).toEqual(["a_alice"]);
  });

  it("expires an entry after its channel's finite TTL and reports the eviction", async () => {
    vi.useFakeTimers();
    const store = createPresenceStore({
      localActorId: LOCAL_ACTOR,
      ...channelsWith({ ttlMs: 1_000 }),
    });
    const changes: PresenceChange[] = [];
    store.onUpdate((change) => changes.push(change));

    store.ingest(packet("a_alice", "doc_a", "cursor", cursor));
    expect(store.forEntity("doc_a", "cursor").size).toBe(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(store.forEntity("doc_a", "cursor").size).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(store.forEntity("doc_a", "cursor").size).toBe(0);
    expect(changes).toEqual([
      { entityId: "doc_a", channel: "cursor" },
      { entityId: "doc_a", channel: "cursor" },
    ]);
  });

  it("sweeps expired peers lazily on the next ingest, without the timer", () => {
    let clock = 0;
    const store = createPresenceStore({
      localActorId: LOCAL_ACTOR,
      ...channelsWith({ ttlMs: 1_000 }),
      now: () => clock,
    });
    const changes: PresenceChange[] = [];
    store.onUpdate((change) => changes.push(change));

    store.ingest(packet("a_alice", "doc_a", "cursor", cursor));
    clock = 2_000;
    // A packet on another target is evidence the stream is live: the expired
    // cursor is swept now, not whenever a throttled timer gets to run.
    store.ingest(packet("a_bob", "doc_b", "cursor", cursor));

    expect(store.forEntity("doc_a", "cursor").size).toBe(0);
    expect(store.forEntity("doc_b", "cursor").size).toBe(1);
    expect(changes).toEqual([
      { entityId: "doc_a", channel: "cursor" },
      { entityId: "doc_a", channel: "cursor" },
      { entityId: "doc_b", channel: "cursor" },
    ]);
  });

  it("never expires a channel whose ttlMs is Infinity", async () => {
    vi.useFakeTimers();
    const store = createPresenceStore({
      localActorId: LOCAL_ACTOR,
      ...channelsWith({ ttlMs: Infinity }),
    });

    store.ingest(packet("a_alice", "doc_a", "cursor", cursor));
    await vi.advanceTimersByTimeAsync(60 * 60 * 1_000);

    expect(store.forEntity("doc_a", "cursor").size).toBe(1);
  });

  it("evicts the least-recently-updated entry past the per (entity, channel) cap", async () => {
    vi.useFakeTimers();
    const store = createPresenceStore({
      localActorId: LOCAL_ACTOR,
      ...channelsWith({ maxEntries: 2 }),
    });

    store.ingest(packet("a_alice", "doc_a", "cursor", cursor));
    await vi.advanceTimersByTimeAsync(10);
    store.ingest(packet("a_bob", "doc_a", "cursor", cursor));
    await vi.advanceTimersByTimeAsync(10);
    store.ingest(packet("a_carol", "doc_a", "cursor", cursor));

    expect([...store.forEntity("doc_a", "cursor").keys()]).toEqual(["a_bob", "a_carol"]);
    // The cap is per channel: another channel keeps its own entries.
    store.ingest(packet("a_alice", "doc_a", "camera", camera));
    expect(store.forEntity("doc_a", "camera").size).toBe(1);
  });

  it("drops every peer on clear and unsubscribes on close", () => {
    const store = createPresenceStore({ localActorId: LOCAL_ACTOR });
    const changes: PresenceChange[] = [];
    store.onUpdate((change) => changes.push(change));

    store.ingest(packet("a_alice", "doc_a", "cursor", cursor));
    store.ingest(packet("a_bob", "doc_a", "camera", camera));
    changes.length = 0;
    store.clear();

    expect(store.forEntity("doc_a", "cursor").size).toBe(0);
    expect(store.forEntity("doc_a", "camera").size).toBe(0);
    expect(changes).toEqual([
      { entityId: "doc_a", channel: "cursor" },
      { entityId: "doc_a", channel: "camera" },
    ]);

    store.close();
    store.ingest(packet("a_alice", "doc_a", "cursor", cursor));
    expect(store.forEntity("doc_a", "cursor").size).toBe(0);
  });

  it("ignores packets it cannot read", () => {
    const store = createPresenceStore({ localActorId: LOCAL_ACTOR });

    expect(() => {
      store.ingest(null);
      store.ingest("nope");
      store.ingest({ actor_id: "a_alice", entity_id: "doc_a", data: cursor });
      store.ingest({ actor_id: "a_alice", entity_id: "doc_a", data: { channel: "" } });
    }).not.toThrow();
    expect(store.forEntity("doc_a", "cursor").size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The client's live-stream wiring
// ---------------------------------------------------------------------------

describe("client presence on the live stream", () => {
  it("feeds the map from the live stream, excluding the local actor", async () => {
    const h = harness();
    const client = connectedClient(h);
    let updates = 0;
    client.presence.onUpdate(() => updates++);

    const unsubscribe = client.subscribe(["grp_1"], () => {});
    await waitFor(() => h.liveRequests() === 1);

    h.push(0, presenceChunk("a_alice", "doc_demo", "cursor", cursor));
    h.push(0, presenceChunk(LOCAL_ACTOR, "doc_demo", "cursor", cursor));
    h.push(0, presenceChunk("a_bob", "other_doc", "cursor", cursor));

    await waitFor(() => client.presence.forEntity("doc_demo", "cursor").has("a_alice"));
    const map = client.presence.forEntity("doc_demo", "cursor");
    expect([...map.keys()]).toEqual(["a_alice"]);
    expect(map.get("a_alice")!.data).toEqual(cursor);
    expect(updates).toBeGreaterThan(0);

    unsubscribe();
    client.close();
  });

  it("types the read path when the client has a registry", async () => {
    const h = harness();
    const client = createClient({
      serverUrl: SERVER_URL,
      actorId: LOCAL_ACTOR,
      fetchImpl: h.fetchImpl,
      presence: definePresence({ cursor: cursorSchema, camera: cameraSchema }),
    });

    const unsubscribe = client.subscribe(["grp_1"], () => {});
    await waitFor(() => h.liveRequests() === 1);

    h.push(0, presenceChunk("a_alice", "doc_demo", "cursor", cursor));
    h.push(0, presenceChunk("a_bob", "doc_demo", "camera", camera));

    await waitFor(() => client.presence.forEntity("doc_demo", "cursor").size === 1);
    const cursorPeers = client.presence.forEntity("doc_demo", "cursor");
    const cameraPeers = client.presence.forEntity("doc_demo", "camera");
    // The registry's `Static<>` types reach the read side.
    expect(cursorPeers.get("a_alice")!.data.anchorOffset).toBe(1);
    expect(cameraPeers.get("a_bob")!.data.zoom).toBe(1.5);

    unsubscribe();
    client.close();
  });

  it("keeps channels isolated when a peer clears one of them", async () => {
    const h = harness();
    const client = connectedClient(h);

    const unsubscribe = client.subscribe(["grp_1"], () => {});
    await waitFor(() => h.liveRequests() === 1);

    h.push(0, presenceChunk("a_alice", "doc_demo", "cursor", cursor));
    h.push(0, presenceChunk("a_alice", "doc_demo", "camera", camera));
    await waitFor(() => client.presence.forEntity("doc_demo", "camera").size === 1);

    h.push(0, presenceChunk("a_alice", "doc_demo", "camera", null));
    await waitFor(() => client.presence.forEntity("doc_demo", "camera").size === 0);

    expect([...client.presence.forEntity("doc_demo", "cursor").keys()]).toEqual(["a_alice"]);
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
      mapSizes.push(client.presence.forEntity("doc_demo", "cursor").size);
    });
    await waitFor(() => h.liveRequests() === 1);

    h.push(0, presenceChunk("a_alice", "doc_demo", "cursor", cursor));
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

    const unsubscribe = client.subscribe(["grp_1"], () => {});
    await waitFor(() => h.liveRequests() === 1);
    // Give a stray second stream time to appear.
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(h.liveRequests()).toBe(1);
    expect(h.calls.some((call) => call.url.includes("/sync/handshake"))).toBe(false);

    unsubscribe();
    client.close();
  });

  it("clears the map when the subscription closes", async () => {
    const h = harness();
    const client = connectedClient(h);

    const unsubscribe = client.subscribe(["grp_1"], () => {});
    await waitFor(() => h.liveRequests() === 1);
    h.push(0, presenceChunk("a_alice", "doc_demo", "cursor", cursor));
    await waitFor(() => client.presence.forEntity("doc_demo", "cursor").size === 1);

    unsubscribe();

    expect(client.presence.forEntity("doc_demo", "cursor").size).toBe(0);
    client.close();
  });

  it("clears the map when the client closes", async () => {
    const h = harness();
    const client = connectedClient(h);

    client.subscribe(["grp_1"], () => {});
    await waitFor(() => h.liveRequests() === 1);
    h.push(0, presenceChunk("a_alice", "doc_demo", "cursor", cursor));
    await waitFor(() => client.presence.forEntity("doc_demo", "cursor").size === 1);

    client.close();

    expect(client.presence.forEntity("doc_demo", "cursor").size).toBe(0);
  });

  it("does not carry stale peers across a reconnect", async () => {
    const h = harness();
    const client = connectedClient(h, { reconnectInitialMs: 1 });

    const unsubscribe = client.subscribe(["grp_1"], () => {});
    await waitFor(() => h.liveRequests() === 1);
    h.push(0, presenceChunk("a_alice", "doc_demo", "cursor", cursor));
    await waitFor(() => client.presence.forEntity("doc_demo", "cursor").size === 1);

    // The server reports our cursor is stale; the client drops the stream,
    // catches up, and re-opens it.
    h.push(0, reconnectChunk(5));
    await waitFor(() => h.liveRequests() === 2);

    expect(client.presence.forEntity("doc_demo", "cursor").size).toBe(0);

    h.push(1, presenceChunk("a_bob", "doc_demo", "cursor", cursor));
    await waitFor(() => client.presence.forEntity("doc_demo", "cursor").size === 1);
    expect([...client.presence.forEntity("doc_demo", "cursor").keys()]).toEqual(["a_bob"]);

    unsubscribe();
    client.close();
  });

  it("leaves one open stream across a StrictMode mount/unmount/remount", async () => {
    const h = harness();
    const client = connectedClient(h);

    const firstUnsubscribe = client.subscribe(["grp_1"], () => {});
    await waitFor(() => h.liveRequests() === 1);

    // StrictMode's immediate cleanup.
    firstUnsubscribe();

    // Remount.
    const secondUnsubscribe = client.subscribe(["grp_1"], () => {});
    await waitFor(() => h.liveRequests() === 2);
    await waitFor(() => h.openStreams() === 1);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(h.openStreams()).toBe(1);

    secondUnsubscribe();
    client.close();
  });
});

// ---------------------------------------------------------------------------
// Compile-time surface
// ---------------------------------------------------------------------------

describe("typed presence surface", () => {
  it("rejects an undeclared channel and a mistyped value at compile time", () => {
    const h = harness();
    const client = createClient({
      serverUrl: SERVER_URL,
      actorId: LOCAL_ACTOR,
      fetchImpl: h.fetchImpl,
      presence: definePresence({ cursor: cursorSchema }),
    });

    // Never called: this body exists so `tsc` checks the typed surface.
    const exercise = (typed: typeof client): void => {
      typed.presence.set("doc_demo", "cursor", cursor);
      typed.presence.clear("doc_demo", "cursor");
      const peers: ReadonlyMap<string, PeerPresence<typeof cursor>> = typed.presence.forEntity(
        "doc_demo",
        "cursor",
      );
      void peers;
      // @ts-expect-error — `tool` is not a declared channel.
      typed.presence.set("doc_demo", "tool", "pen");
      // @ts-expect-error — the cursor channel's schema requires a number offset.
      typed.presence.set("doc_demo", "cursor", { ...cursor, anchorOffset: "one" });
      // @ts-expect-error — an undeclared channel cannot be read.
      typed.presence.forEntity("doc_demo", "tool");
    };
    expect(exercise).toBeTypeOf("function");

    client.close();
  });
});
