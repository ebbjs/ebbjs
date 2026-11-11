import { describe, it, expect, vi } from "vitest";
import { createClient } from "./client";
import { createMemoryAdapter } from "@ebbjs/storage/memory";
import { makeHlc, type Action } from "@ebbjs/core";
import type { SSEEvent } from "./types";
import {
  emptyCatchUpResponse,
  emptyListingResponse,
  isListingRequest,
  jsonResponse,
  openSseResponse,
  waitFor,
} from "./test-utils";

const chunkEncoder = new TextEncoder();

/** An SSE `presence` block; handleSSEEvent forwards it without storage work. */
const presenceChunk = (actorId: string): string =>
  `event: presence\ndata: ${JSON.stringify({
    actor_id: actorId,
    entity_id: "e1",
    data: {},
  })}\n\n`;

/**
 * A fetch mock whose live responses are open streams the test can push
 * into, one per `subscribe` call.
 */
const controllableLiveFetch = (): {
  fetchImpl: typeof fetch;
  controllers: ReadableStreamDefaultController<Uint8Array>[];
} => {
  const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
  const fetchImpl = vi.fn(async (url: string) => {
    if (typeof url === "string" && url.includes("/sync/groups/")) {
      return emptyCatchUpResponse();
    }
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controllers.push(controller);
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  }) as unknown as typeof fetch;
  return { fetchImpl, controllers };
};

/** A locally-authored put the Outbox will try to post. */
const localPut = (id: string): Action => {
  const hlc = makeHlc(1711036800000);
  return {
    id,
    actor_id: "a_bob",
    hlc,
    gsn: 0,
    updates: [
      {
        id: `${`u_${id}`}_0`,
        subject_id: "todo_1",
        component: "todo/title",
        method: "replace",
        data: { value: "parked", update_id: `u_${id}`, hlc },
      },
    ],
  };
};

/**
 * SSE-driven subscribe test.
 *
 * Uses fetch mocks with controlled streaming bodies. Verifies the read path:
 * action receipt → storage append → onEvent callback, plus the connection
 * state transitions, reconnect / cancellation logic, and the cursor the
 * two-argument overload infers.
 */
describe("SyncClient.subscribe (SSE)", () => {
  it("opens SSE, applies action to storage, fires callback", async () => {
    const encoder = new TextEncoder();
    const action: Action = {
      id: "act_1",
      actor_id: "a_alice",
      hlc: "112134507724800000",
      gsn: 1,
      updates: [
        {
          id: "u_1_0",
          subject_id: "todo_1",
          component: "todo/title",
          method: "replace",
          data: { value: "Live", update_id: "u_1", hlc: "112134507724800000" },
        },
      ],
    };
    const makeBody = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`event: data\ndata: ${JSON.stringify(action)}\n\n`));
          controller.close();
        },
      });

    const fetchImpl = vi.fn(async (url: string) => {
      if (typeof url === "string" && url.includes("/sync/live")) {
        return new Response(makeBody(), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      // Catch-up runs before the live stream; nothing is missed here.
      return emptyCatchUpResponse();
    }) as unknown as typeof fetch;

    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "a_bob",
      fetchImpl,
    });

    let resolveEvent!: (ev: SSEEvent) => void;
    const eventPromise = new Promise<SSEEvent>((resolve) => {
      resolveEvent = resolve;
    });
    const unsubscribe = client.subscribe(["grp_1"], 0, (ev) => {
      if (ev.type === "data") resolveEvent(ev);
    });

    const received = await eventPromise;
    expect(received.type).toBe("data");

    // The action should now be in storage.
    const entity = await client.readLocalEntity("todo_1");
    expect(entity).not.toBeNull();
    expect(entity!.data.fields.title).toMatchObject({ value: "Live" });

    unsubscribe();
  });

  it("replaces the active subscription instead of throwing", async () => {
    const { fetchImpl, controllers } = controllableLiveFetch();
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "a_bob",
      fetchImpl,
    });

    const firstEvents: SSEEvent[] = [];
    const secondEvents: SSEEvent[] = [];
    client.subscribe(["grp_1"], 0, (ev) => firstEvents.push(ev));
    await waitFor(() => controllers.length === 1);
    controllers[0].enqueue(chunkEncoder.encode(presenceChunk("a_first")));
    await waitFor(() => firstEvents.length === 1);

    const secondUnsubscribe = client.subscribe(["grp_1"], 0, (ev) => secondEvents.push(ev));
    await waitFor(() => controllers.length === 2);

    controllers[1].enqueue(chunkEncoder.encode(presenceChunk("a_second")));
    await waitFor(() => secondEvents.length === 1);
    expect(secondEvents).toHaveLength(1);

    // The replacement owns the stream now; the stale callback stays silent.
    controllers[0].enqueue(chunkEncoder.encode(presenceChunk("a_stale")));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(firstEvents).toHaveLength(1);

    secondUnsubscribe();
    client.close();
  });

  it("holds the flush gate across a replacement until the new catch-up lands", async () => {
    const catchUpResolvers: Array<(response: Response) => void> = [];
    const actionPosts: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      if (typeof url === "string" && isListingRequest(url)) return emptyListingResponse(0, "grp_1");
      if (typeof url === "string" && url.includes("/sync/groups/")) {
        return new Promise<Response>((resolve) => catchUpResolvers.push(resolve));
      }
      if (typeof url === "string" && url.includes("/sync/actions")) {
        actionPosts.push(url);
        return jsonResponse({ accepted: [] });
      }
      return new Response(new ReadableStream({ start() {} }), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;

    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "a_bob",
      fetchImpl,
    });

    client.subscribe(["grp_1"], 0, () => {});
    await waitFor(() => catchUpResolvers.length === 1);

    // A write during the held rebase parks in the Outbox; `write` reports the
    // deferral rather than claiming success.
    await expect(client.write([localPut("act_parked")])).rejects.toThrow(/flush held/);

    // Replacing mid-rebase must not open the gate before the new sweep.
    client.subscribe(["grp_1"], 0, () => {});
    await waitFor(() => catchUpResolvers.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(actionPosts).toHaveLength(0);

    for (const resolve of catchUpResolvers) resolve(emptyCatchUpResponse());
    await waitFor(() => actionPosts.length === 1);

    client.close();
  });

  it("a stale unsubscribe does not tear down the replacement subscription", async () => {
    const { fetchImpl, controllers } = controllableLiveFetch();
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "a_bob",
      fetchImpl,
    });

    const firstUnsubscribe = client.subscribe(["grp_1"], 0, () => {});
    await waitFor(() => controllers.length === 1);

    const secondEvents: SSEEvent[] = [];
    const secondUnsubscribe = client.subscribe(["grp_1"], 0, (ev) => secondEvents.push(ev));
    await waitFor(() => controllers.length === 2);
    await waitFor(() => client.state === "live");

    // The replaced subscription's unsubscribe must not touch the shared
    // reconnect timer / flush gate / connection state.
    firstUnsubscribe();
    expect(client.state).toBe("live");

    controllers[1].enqueue(chunkEncoder.encode(presenceChunk("a_after_stale")));
    await waitFor(() => secondEvents.length === 1);

    secondUnsubscribe();
    client.close();
  });

  it("appends actions from SSE to the storage adapter", async () => {
    const storage = createMemoryAdapter();
    const encoder = new TextEncoder();
    const action: Action = {
      id: "act_sse",
      actor_id: "a_other",
      hlc: "112134507724800000",
      gsn: 5,
      updates: [
        {
          id: "u_sse",
          subject_id: "doc_1",
          component: "doc/x",
          method: "replace",
          data: { value: 1, update_id: "u_sse", hlc: "112134507724800000" },
        },
      ],
    };
    const sseBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`event: data\ndata: ${JSON.stringify(action)}\n\n`));
        controller.close();
      },
    });
    const fetchImpl = vi.fn(async (url: string) => {
      if (typeof url === "string" && url.includes("/sync/groups/")) {
        return emptyCatchUpResponse();
      }
      return new Response(sseBody, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;

    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "a_self",
      fetchImpl,
      storage,
    });

    let resolveEvent!: () => void;
    const eventPromise = new Promise<void>((resolve) => {
      resolveEvent = resolve;
    });
    const unsubscribe = client.subscribe(["grp_1"], 0, (ev) => {
      if (ev.type === "data") resolveEvent();
    });

    await eventPromise;

    // Poll briefly to allow storage append to settle.
    for (let i = 0; i < 50 && !(await storage.isDirty("doc_1")); i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(await storage.isDirty("doc_1")).toBe(true);
    expect(await storage.cursors.get("grp_1")).toBe(5);

    unsubscribe();
  });

  it("fires onEvent for control events", async () => {
    const encoder = new TextEncoder();
    const sseBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'event: control\ndata: {"reconnect":true,"reason":"behind_watermark","catchUpFrom":42}\n\n',
          ),
        );
        controller.close();
      },
    });
    const fetchImpl = vi.fn(async (url: string) => {
      if (typeof url === "string" && url.includes("/sync/groups/")) {
        return emptyCatchUpResponse();
      }
      return new Response(sseBody, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as unknown as typeof fetch;

    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "a_bob",
      fetchImpl,
    });

    let resolveControl!: (ev: SSEEvent) => void;
    const controlPromise = new Promise<SSEEvent>((resolve) => {
      resolveControl = resolve;
    });
    const unsubscribe = client.subscribe(["grp_1"], 0, (ev) => {
      if (ev.type === "control") resolveControl(ev);
    });

    const received = await controlPromise;
    if (received.type !== "control") throw new Error("expected control");
    expect(received.control.reconnect).toBe(true);
    expect(received.control.catchUpFrom).toBe(42);

    unsubscribe();
  });
});

/**
 * Cursor inference for the two-argument `subscribe(groupIds, onEvent)`
 * overload. The caller should not have to thread a cursor: the durable
 * storage cursor and the cursors cached by `handshake()` / `catchUp()`
 * already say where to resume, mirroring `catchUp(groupId)`.
 */
describe("SyncClient.subscribe inferred cursor", () => {
  /**
   * The catch-up request, not the listing one: both live under
   * `/sync/groups/`, and the listing runs first.
   */
  const catchUpCall = (calls: readonly string[]): string =>
    calls.find((url) => url.includes("/sync/groups/") && !isListingRequest(url)) ?? "";

  const handshakeResponse = (groupId: string, cursor: number): Response =>
    jsonResponse({
      actor_id: "a_self",
      groups: [
        {
          id: groupId,
          permissions: ["read", "write"],
          cursor_valid: true,
          reason: null,
          cursor,
        },
      ],
    });

  it("resumes from the cursor cached by handshake", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes("/sync/handshake")) return handshakeResponse("grp_1", 7);
      if (isListingRequest(url)) return emptyListingResponse(7, "grp_1");
      if (url.includes("/sync/groups/")) return emptyCatchUpResponse();
      if (url.includes("/sync/live")) return openSseResponse();
      return jsonResponse({});
    }) as unknown as typeof fetch;

    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "a_self",
      fetchImpl,
    });

    await client.handshake();
    const unsubscribe = client.subscribe(["grp_1"], () => {});

    await waitFor(() => calls.some((url) => url.includes("/sync/live")));

    expect(catchUpCall(calls)).toContain("offset=7");
    expect(calls.find((url) => url.includes("/sync/live"))).toContain("cursor=7");

    unsubscribe();
  });

  it("resumes from the durable storage cursor when nothing is cached", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      if (isListingRequest(url)) return emptyListingResponse(0, "grp_1");
      if (url.includes("/sync/groups/")) return emptyCatchUpResponse();
      if (url.includes("/sync/live")) return openSseResponse();
      return jsonResponse({});
    }) as unknown as typeof fetch;

    const storage = createMemoryAdapter();
    await storage.cursors.set("grp_1", 12);

    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "a_self",
      fetchImpl,
      storage,
    });

    const unsubscribe = client.subscribe(["grp_1"], () => {});

    await waitFor(() => calls.some((url) => url.includes("/sync/live")));

    expect(catchUpCall(calls)).toContain("offset=12");
    expect(calls.find((url) => url.includes("/sync/live"))).toContain("cursor=12");

    unsubscribe();
  });

  it("starts from cursor 0 when no cursor is known", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      if (isListingRequest(url)) return emptyListingResponse(0, "grp_1");
      if (url.includes("/sync/groups/")) return emptyCatchUpResponse();
      if (url.includes("/sync/live")) return openSseResponse();
      return jsonResponse({});
    }) as unknown as typeof fetch;

    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "a_self",
      fetchImpl,
    });

    const unsubscribe = client.subscribe(["grp_1"], () => {});

    await waitFor(() => calls.some((url) => url.includes("/sync/live")));

    expect(catchUpCall(calls)).toContain("offset=0");
    expect(calls.find((url) => url.includes("/sync/live"))).toContain("cursor=0");

    unsubscribe();
  });

  it("throws a TypeError when no event callback is supplied", () => {
    const client = createClient({
      serverUrl: "http://localhost:4000",
      actorId: "a_self",
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });

    expect(() => (client.subscribe as unknown as (groupIds: string[]) => void)(["grp_1"])).toThrow(
      TypeError,
    );

    client.close();
  });
});
