import { describe, expect, it } from "vitest";
import { readBody, withAbortSignal } from "./http";
import { pendingUntilAborted } from "./test-utils";

/** A request that never answers, so only the abort can settle it. */
const neverSettles: typeof fetch = (_input, init) => pendingUntilAborted(init);

/** A body that errors only when its request is aborted. */
const abortableBody: typeof fetch = async (_input, init) => {
  const signal = init?.signal;
  if (signal === undefined || signal === null) throw new Error("no signal");
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
};

describe("withAbortSignal", () => {
  it("cancels a request that supplied no signal of its own", async () => {
    const client = new AbortController();
    const wrapped = withAbortSignal(neverSettles, client.signal);

    const request = wrapped("http://localhost/sync/handshake").catch((error: unknown) => error);
    const stop = new Error("client closed");
    client.abort(stop);

    expect(await request).toBe(stop);
  });

  it("rejects with the caller's reason when only the caller aborts", async () => {
    const client = new AbortController();
    const caller = new AbortController();
    const wrapped = withAbortSignal(neverSettles, client.signal);

    const request = wrapped("http://localhost/sync/live", { signal: caller.signal }).catch(
      (error: unknown) => error,
    );
    const stop = new Error("caller closed");
    caller.abort(stop);

    expect(await request).toBe(stop);
  });

  it("rejects with the client's reason when the client aborts before the response", async () => {
    const client = new AbortController();
    const caller = new AbortController();
    const wrapped = withAbortSignal(neverSettles, client.signal);

    const request = wrapped("http://localhost/sync/live", { signal: caller.signal }).catch(
      (error: unknown) => error,
    );
    const stop = new Error("client closed");
    client.abort(stop);

    expect(await request).toBe(stop);
  });

  it("forwards an already-aborted caller signal without waiting for an event", async () => {
    const client = new AbortController();
    const caller = new AbortController();
    const stop = new Error("already gone");
    caller.abort(stop);
    const wrapped = withAbortSignal(neverSettles, client.signal);

    // No event will ever fire on `caller`, so this settles only because the
    // wrapper forwards the existing abort before the request goes out.
    await expect(wrapped("http://localhost/sync/live", { signal: caller.signal })).rejects.toBe(
      stop,
    );
  });

  it("lets a caller abort reach the body after the response has settled", async () => {
    const client = new AbortController();
    const caller = new AbortController();
    const wrapped = withAbortSignal(abortableBody, client.signal);

    // Headers arrive here; the body is still open.
    const response = await wrapped("http://localhost/sync/live", { signal: caller.signal });
    const body = response.text();

    const stop = new Error("caller closed");
    caller.abort(stop);

    // The transport that opened a stream ends it through its own signal, so a
    // cancel issued after the headers still has to reach the body.
    await expect(body).rejects.toBeDefined();
  });

  it("leaves a keepalive request alone", async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const base: typeof fetch = async (_input, init) => {
      seen.push(init?.signal ?? undefined);
      return new Response(null, { status: 204 });
    };
    const wrapped = withAbortSignal(base, new AbortController().signal);

    await wrapped("http://localhost/sync/presence", { method: "POST", keepalive: true });

    // An unload handler's leave has to outlive the document, so teardown must
    // not be able to reach it.
    expect(seen).toEqual([undefined]);
  });
});

describe("readBody", () => {
  const failing = (error: unknown): Response =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(error);
        },
      }),
    );

  it("rethrows a read its request cancelled instead of reporting an empty body", async () => {
    const stop = AbortSignal.abort().reason;

    await expect(readBody(failing(stop))).rejects.toBe(stop);
  });

  it("still answers an empty body for a read that failed on its own", async () => {
    await expect(readBody(failing(new Error("connection reset")))).resolves.toBe("");
  });
});
