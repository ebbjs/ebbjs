import { describe, it, expect, vi } from "vitest";
import { ClientClosedError, createClient } from "./client";
import { createMemoryAdapter } from "@ebbjs/storage/memory";
import {
  emptyCatchUpResponse,
  emptyListingResponse,
  isListingRequest,
  jsonResponse,
  localPut as put,
  openSseResponse,
  pendingUntilAborted,
  requestUrl,
  waitFor,
} from "./test-utils";

const SERVER_URL = "http://localhost:4000";
const ACTOR_ID = "a_bob";

const localPut = (id: string) => put(id, ACTOR_ID);

describe("SyncClient.close with requests in flight", () => {
  it("aborts an in-flight catch-up and does not reconnect", async () => {
    const urls: string[] = [];
    const catchUpSignals: AbortSignal[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = requestUrl(input);
      urls.push(url);
      if (isListingRequest(url)) return emptyListingResponse(0, "grp_1");
      if (url.includes("/sync/groups/")) {
        if (init.signal) catchUpSignals.push(init.signal);
        return pendingUntilAborted(init);
      }
      return openSseResponse();
    }) as unknown as typeof fetch;

    const client = createClient({
      serverUrl: SERVER_URL,
      actorId: ACTOR_ID,
      fetchImpl,
      // A reconnect the aborted pass might arm would fire inside the window
      // this test checks.
      reconnectInitialMs: 5,
      reconnectMaxMs: 5,
    });

    client.subscribe(["grp_1"], 0, () => {});
    await waitFor(() => catchUpSignals.length === 1);

    const urlsAtClose = urls.length;
    client.close();

    expect(catchUpSignals[0].aborted).toBe(true);
    // The abort rejects on a microtask; give the loop the turns it would need
    // to schedule and run a reconnect.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(urls).toHaveLength(urlsAtClose);
    // `scheduleReconnect` would move to "reconnecting" before any fetch, so
    // this is what catches a reconnect that was armed but never fired.
    expect(client.state).toBe("offline");
  });

  it("aborts an in-flight flush and leaves the entry pending", async () => {
    const storage = createMemoryAdapter();
    const postSignals: AbortSignal[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = requestUrl(input);
      if (url.includes("/sync/actions")) {
        if (init.signal) postSignals.push(init.signal);
        return pendingUntilAborted(init);
      }
      return jsonResponse({});
    }) as unknown as typeof fetch;

    const client = createClient({
      serverUrl: SERVER_URL,
      actorId: ACTOR_ID,
      fetchImpl,
      storage,
    });
    // Attached up front so the rejection is never unhandled while the test
    // waits for the POST to be on the wire.
    const writeResult = client.write([localPut("act_inflight")]).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await waitFor(() => postSignals.length === 1);

    client.close();

    const result = await writeResult;
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toBeInstanceOf(ClientClosedError);

    // The submit threw, which the Outbox classifies as `unreachable`: the
    // entry is still flushable, not an errored one, and none of it was
    // rewritten as acknowledged after teardown.
    const stored = await storage.outbox.list();
    expect(stored.map((entry) => [entry.action.id, entry.status])).toEqual([
      ["act_inflight", "pending"],
    ]);
  });

  it("does not abort an in-flight presence leave with keepalive", async () => {
    let settled = false;
    let resolveLeave: ((response: Response) => void) | null = null;
    const keepaliveFlags: boolean[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      if (!requestUrl(input).includes("/sync/presence")) return jsonResponse({});
      keepaliveFlags.push(init.keepalive === true);
      const signal = init.signal;
      return new Promise<Response>((resolve, reject) => {
        resolveLeave = resolve;
        // A real fetch rejects from the signal; the transport swallows it.
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      }).finally(() => {
        settled = true;
      });
    }) as unknown as typeof fetch;

    const client = createClient({ serverUrl: SERVER_URL, actorId: ACTOR_ID, fetchImpl });

    client.presence.set("e1", "cursor", { anchor: 0 });
    const leave = client.presence.leave({ keepalive: true });
    // The leave's null supersedes the pending `set` for the same target, so
    // one POST is on the wire.
    await waitFor(() => resolveLeave !== null);

    client.close();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The tab-unload pattern: this POST outlives the client it came from.
    expect(keepaliveFlags).toEqual([true]);
    expect(settled).toBe(false);

    resolveLeave!(new Response(null, { status: 204 }));
    await expect(leave).resolves.toBeUndefined();
  });

  it("aborts an in-flight presence send that is not a keepalive leave", async () => {
    let aborted = false;
    let resolveSend: ((response: Response) => void) | null = null;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      if (!requestUrl(input).includes("/sync/presence")) return jsonResponse({});
      const signal = init.signal;
      signal?.addEventListener("abort", () => {
        aborted = true;
      });
      return new Promise<Response>((resolve, reject) => {
        resolveSend = resolve;
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }) as unknown as typeof fetch;

    const client = createClient({ serverUrl: SERVER_URL, actorId: ACTOR_ID, fetchImpl });

    client.presence.set("e1", "cursor", { anchor: 0 });
    const leave = client.presence.leave();
    await waitFor(() => resolveSend !== null);

    client.close();

    // The exemption is the `keepalive` flag, not presence: an ordinary send is
    // teardown-scoped like every other request.
    expect(aborted).toBe(true);
    await expect(leave).resolves.toBeUndefined();
  });

  it("does not abort an in-flight write when the session is replaced", async () => {
    let resolvePost: ((response: Response) => void) | null = null;
    let liveRequests = 0;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.includes("/sync/actions")) {
        return new Promise<Response>((resolve) => {
          resolvePost = resolve;
        });
      }
      if (isListingRequest(url)) return emptyListingResponse(0, "grp_1");
      if (url.includes("/sync/groups/")) return emptyCatchUpResponse();
      if (url.includes("/sync/live")) {
        liveRequests += 1;
        return openSseResponse();
      }
      return jsonResponse({});
    }) as unknown as typeof fetch;

    const client = createClient({ serverUrl: SERVER_URL, actorId: ACTOR_ID, fetchImpl });
    const firstUnsubscribe = client.subscribe(["grp_1"], 0, () => {});
    await waitFor(() => liveRequests === 1);

    const writing = client.write([localPut("act_inflight")]);
    await waitFor(() => resolvePost !== null);

    // A React StrictMode remount replaces the session, not the client.
    const secondUnsubscribe = client.subscribe(["grp_1"], 0, () => {});
    await waitFor(() => liveRequests === 2);

    resolvePost!(jsonResponse({ rejected: [] }));
    await expect(writing).resolves.toEqual({ rejected: [] });
    expect(client.outbox.size("acknowledged")).toBe(1);

    firstUnsubscribe();
    secondUnsubscribe();
    client.close();
  });

  it("is safe to call twice, and a request after it rejects as aborted", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init: RequestInit = {}) =>
      pendingUntilAborted(init),
    ) as unknown as typeof fetch;
    const storage = createMemoryAdapter();
    const client = createClient({
      serverUrl: SERVER_URL,
      actorId: ACTOR_ID,
      fetchImpl,
      storage,
    });

    client.close();
    expect(() => client.close()).not.toThrow();
    expect(client.state).toBe("offline");

    const error = await client.getEntity("todo_1").catch((thrown: unknown) => thrown);
    expect((error as Error).name).toBe("AbortError");

    // A write is refused before it reaches the outbox, so a closed client
    // cannot leave a pending entry behind on the way out.
    await expect(client.write([localPut("act_after_close")])).rejects.toBeInstanceOf(
      ClientClosedError,
    );
    await expect(storage.outbox.list()).resolves.toEqual([]);
  });

  it("rejects a function call whose body was still arriving at close", async () => {
    let bodyStarted = false;
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init: RequestInit = {}) => {
      const signal = init.signal;
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          bodyStarted = true;
          // Headers, and half a JSON body: the parse would succeed against an
          // empty read and report a void result.
          controller.enqueue(encoder.encode('{"result":'));
          signal?.addEventListener("abort", () => controller.error(signal.reason), { once: true });
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const client = createClient({ serverUrl: SERVER_URL, actorId: ACTOR_ID, fetchImpl });
    const call = client.invokeFunction("echo").then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await waitFor(() => bodyStarted);

    client.close();

    // A truncated body must not read as a void success.
    const result = await call;
    expect(result.ok).toBe(false);
  });

  it("makes backfill a no-op after close", async () => {
    const storage = createMemoryAdapter();
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, _init: RequestInit = {}) =>
      jsonResponse({}),
    ) as unknown as typeof fetch;
    const saved = vi.spyOn(storage.replica, "save");

    const client = createClient({ serverUrl: SERVER_URL, actorId: ACTOR_ID, fetchImpl, storage });
    client.close();
    const savesAtClose = saved.mock.calls.length;

    // A pass entered after teardown can only write through a closed adapter.
    await client.backfill();

    expect(saved.mock.calls.length).toBe(savesAtClose);
  });
});
