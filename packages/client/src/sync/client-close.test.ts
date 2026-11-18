import { describe, it, expect, vi } from "vitest";
import { createClient } from "./client";
import { createMemoryAdapter } from "@ebbjs/storage/memory";
import { makeHlc, type Action } from "@ebbjs/core";
import {
  emptyCatchUpResponse,
  emptyListingResponse,
  isListingRequest,
  jsonResponse,
  openSseResponse,
  waitFor,
} from "./test-utils";

const SERVER_URL = "http://localhost:4000";
const ACTOR_ID = "a_bob";

/**
 * A request that stays in flight until it is aborted, the way a real fetch
 * behaves against a server that has not answered yet. Rejecting with the
 * signal's own reason keeps the error shape undici produces. Answering a
 * request that carried no signal with an error rather than a hang makes a
 * broken wiring fail the test instead of timing it out.
 */
const pendingUntilAborted = (init: RequestInit | undefined): Promise<Response> =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (signal === undefined || signal === null) {
      reject(new Error("test fetch: request carried no abort signal"));
      return;
    }
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });

const requestUrl = (input: RequestInfo | URL): string =>
  typeof input === "string" ? input : input.toString();

/** A locally-authored put the Outbox will try to post. */
const localPut = (id: string): Action => {
  const hlc = makeHlc(1711036800000);
  return {
    id,
    actor_id: ACTOR_ID,
    hlc,
    gsn: 0,
    updates: [
      {
        id: `u_${id}_0`,
        subject_id: "todo_1",
        component: "todo/title",
        method: "replace",
        data: { value: "parked", update_id: `u_${id}`, hlc },
      },
    ],
  };
};

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
    expect(client.state).toBe("offline");
  });

  it("aborts an in-flight flush, leaves the entry pending, and writes no outbox status", async () => {
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
    const putSpy = vi.spyOn(storage.outbox, "put");

    // Attached up front so the rejection is never unhandled while the test
    // waits for the POST to be on the wire.
    const writeResult = client.write([localPut("act_inflight")]).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await waitFor(() => postSignals.length === 1);

    const putsAtClose = putSpy.mock.calls.length;
    client.close();

    const result = await writeResult;
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).name).toBe("AbortError");

    // The submit threw, which the Outbox classifies as `unreachable`: the
    // entry is still flushable, not an errored one.
    const stored = await storage.outbox.list();
    expect(stored.map((entry) => [entry.action.id, entry.status])).toEqual([
      ["act_inflight", "pending"],
    ]);
    expect(client.outbox.size("pending")).toBe(1);
    expect(client.outbox.size("acknowledged")).toBe(0);

    // Nothing acknowledged the aborted batch: no outbox row changed after
    // close(), and the stopped scheduler armed no retry POST.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(postSignals).toHaveLength(1);
    expect(putSpy.mock.calls.length).toBe(putsAtClose);
  });

  it("does not abort an in-flight presence leave with keepalive", async () => {
    const presenceRequests: { keepalive: boolean; signal: AbortSignal | null }[] = [];
    const presenceResolvers: Array<(response: Response) => void> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = requestUrl(input);
      if (url.includes("/sync/presence")) {
        presenceRequests.push({ keepalive: init.keepalive === true, signal: init.signal ?? null });
        return new Promise<Response>((resolve) => presenceResolvers.push(resolve));
      }
      return jsonResponse({});
    }) as unknown as typeof fetch;

    const client = createClient({
      serverUrl: SERVER_URL,
      actorId: ACTOR_ID,
      fetchImpl,
    });

    client.presence.set("e1", "cursor", { anchor: 0 });
    const leave = client.presence.leave({ keepalive: true });
    // The leave's null supersedes the pending `set` for the same target, so
    // one POST is on the wire.
    await waitFor(() => presenceRequests.length === 1);

    const keepalive = presenceRequests.find((request) => request.keepalive);
    expect(keepalive).toBeDefined();

    client.close();
    // The tab-unload pattern: this POST must outlive the client it came from.
    expect(keepalive?.signal ?? null).toBeNull();

    // It still reaches the wire after teardown.
    for (const resolve of presenceResolvers) resolve(new Response(null, { status: 204 }));
    await expect(leave).resolves.toBeUndefined();
  });

  it("keeps the client alive across a replaced session and a plain unsubscribe", async () => {
    let liveRequests = 0;
    let handshakes = 0;
    const catchUpSignals: AbortSignal[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = requestUrl(input);
      if (isListingRequest(url)) return emptyListingResponse(0, "grp_1");
      if (url.includes("/sync/groups/")) {
        if (init.signal) catchUpSignals.push(init.signal);
        return emptyCatchUpResponse();
      }
      if (url.includes("/sync/live")) {
        liveRequests += 1;
        return openSseResponse();
      }
      if (url.includes("/sync/handshake")) {
        handshakes += 1;
        return jsonResponse({ actor_id: ACTOR_ID, groups: [] });
      }
      return jsonResponse({});
    }) as unknown as typeof fetch;

    const client = createClient({
      serverUrl: SERVER_URL,
      actorId: ACTOR_ID,
      fetchImpl,
    });

    const firstUnsubscribe = client.subscribe(["grp_1"], 0, () => {});
    await waitFor(() => liveRequests === 1);

    // Replacing a session tears down the old one, not the client.
    const secondUnsubscribe = client.subscribe(["grp_1"], 0, () => {});
    await waitFor(() => liveRequests === 2);
    secondUnsubscribe();
    expect(client.state).toBe("offline");

    // The client still issues requests, so nothing was aborted along the way.
    await client.handshake();
    expect(handshakes).toBe(1);
    expect(catchUpSignals.length).toBeGreaterThan(0);
    expect(catchUpSignals.every((signal) => !signal.aborted)).toBe(true);

    firstUnsubscribe();
    client.close();
  });

  it("ends a live stream body on close", async () => {
    let streamOpened = false;
    let bodyEnded = false;
    const events: unknown[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = requestUrl(input);
      if (isListingRequest(url)) return emptyListingResponse(0, "grp_1");
      if (url.includes("/sync/groups/")) return emptyCatchUpResponse();
      if (url.includes("/sync/live")) {
        streamOpened = true;
        const signal = init.signal;
        // A body that ends the way a real one does: only when its request is
        // aborted. Deliberately not a `test-utils` response, because the point
        // of this case is the cancellation path itself.
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            const end = (): void => {
              bodyEnded = true;
              try {
                controller.error(signal?.reason);
              } catch {
                // Already ended.
              }
            };
            if (signal?.aborted === true) end();
            else signal?.addEventListener("abort", end, { once: true });
          },
        });
        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return jsonResponse({});
    }) as unknown as typeof fetch;

    const client = createClient({ serverUrl: SERVER_URL, actorId: ACTOR_ID, fetchImpl });
    client.subscribe(["grp_1"], 0, (event) => events.push(event));
    await waitFor(() => streamOpened);

    client.close();

    // `close()` → `cancelSubscription` → `closeStream` → `stream.close()` is
    // what ends a body: the client's own signal detached at the response
    // headers, so this fails if that call is dropped or reordered.
    await waitFor(() => bodyEnded);
    expect(events).toHaveLength(0);
    expect(client.state).toBe("offline");
  });

  it("is safe to call twice, and a request after it rejects as aborted", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init: RequestInit = {}) =>
      pendingUntilAborted(init),
    ) as unknown as typeof fetch;

    const client = createClient({
      serverUrl: SERVER_URL,
      actorId: ACTOR_ID,
      fetchImpl,
    });

    client.close();
    expect(() => client.close()).not.toThrow();
    expect(client.state).toBe("offline");

    const error = await client.getEntity("todo_1").catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("AbortError");
  });
});
