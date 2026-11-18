import { describe, expect, it } from "vitest";
import { withAbortSignal } from "./http";

/**
 * A fetch that records the signal it was handed and stays in flight until that
 * signal aborts, rejecting with the signal's own reason the way a real fetch
 * does. Answering a signal-less call with an error rather than a hang makes a
 * missing signal fail the test instead of timing it out.
 */
const recordingFetch = (): { base: typeof fetch; seen: AbortSignal[] } => {
  const seen: AbortSignal[] = [];
  const base: typeof fetch = (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal === undefined || signal === null) {
        reject(new Error("withAbortSignal: request carried no abort signal"));
        return;
      }
      seen.push(signal);
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  return { base, seen };
};

describe("withAbortSignal", () => {
  it("hands the client signal to a call site that supplied none", async () => {
    const { base, seen } = recordingFetch();
    const client = new AbortController();
    const wrapped = withAbortSignal(base, client.signal);

    const request = wrapped("http://localhost/sync/handshake").catch((error: unknown) => error);
    const stop = new Error("client closed");
    client.abort(stop);

    expect(await request).toBe(stop);
    // The same signal, not a wrapper: the whole response, body included, is
    // cancellable and no per-request listener was registered.
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(client.signal);
  });

  it("rejects with the caller's reason when only the caller aborts", async () => {
    const { base, seen } = recordingFetch();
    const client = new AbortController();
    const caller = new AbortController();
    const wrapped = withAbortSignal(base, client.signal);

    const request = wrapped("http://localhost/sync/live", { signal: caller.signal }).catch(
      (error: unknown) => error,
    );
    const stop = new Error("caller closed");
    caller.abort(stop);

    expect(await request).toBe(stop);
    expect(seen[0]).not.toBe(client.signal);
  });

  it("rejects with the client's reason when the client aborts before the response", async () => {
    const { base } = recordingFetch();
    const client = new AbortController();
    const caller = new AbortController();
    const wrapped = withAbortSignal(base, client.signal);

    const request = wrapped("http://localhost/sync/live", { signal: caller.signal }).catch(
      (error: unknown) => error,
    );
    const stop = new Error("client closed");
    client.abort(stop);

    expect(await request).toBe(stop);
  });

  it("forwards an already-aborted caller signal without waiting for an event", async () => {
    const { base } = recordingFetch();
    const client = new AbortController();
    const caller = new AbortController();
    const stop = new Error("already gone");
    caller.abort(stop);
    const wrapped = withAbortSignal(base, client.signal);

    // No event will ever fire on `caller`, so this settles only because the
    // wrapper forwards the existing abort before the request goes out.
    await expect(wrapped("http://localhost/sync/live", { signal: caller.signal })).rejects.toBe(
      stop,
    );
  });

  it("leaves the body to the caller once the response has settled", async () => {
    const seen: AbortSignal[] = [];
    const base: typeof fetch = async (_input, init) => {
      const signal = init?.signal;
      if (signal === undefined || signal === null) throw new Error("no signal");
      seen.push(signal);
      return new Response("ok");
    };
    const client = new AbortController();
    const caller = new AbortController();
    const wrapped = withAbortSignal(base, client.signal);

    await wrapped("http://localhost/sync/live", { signal: caller.signal });

    // The client signal is session-long, so its listener detaches at the
    // headers; a body still streaming is the caller's to end. This is the
    // contract the SSE transport relies on: `source.close()` aborts its own
    // controller, and that — not `clientSignal` — ends a live stream.
    client.abort(new Error("client closed"));
    expect(seen[0].aborted).toBe(false);
    caller.abort(new Error("caller closed"));
    expect(seen[0].aborted).toBe(true);
  });
});
