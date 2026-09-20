/**
 * Shared fetch-mock helpers for sync-client unit tests.
 *
 * Two helpers live here:
 *
 * - `makeFetchMock(responses)` — records every call and returns canned
 *   `Response` objects from a FIFO queue. Models the ebb server's
 *   non-streaming HTTP endpoints (`/sync/handshake`, `/sync/actions`,
 *   `/entities/...`).
 *
 * - `makeStreamingFetch(chunks, options)` — returns the same streaming
 *   `Response` for every call, with the body built from pre-encoded SSE
 *   byte chunks. Models the `/sync/live` SSE endpoint.
 *
 * The mock functions are typed as `MockInstance<...>` rather than the
 * looser `vi.fn` default, so call sites can access `.mock.calls` without
 * an `as unknown as { mock: ... }` cast and IntelliJ navigates into the
 * mock object.
 */
import { vi, type MockInstance } from "vitest";

/** A non-streaming `Response` shape — body is a string or binary buffer. */
export interface FetchMockResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
}

/** A single recorded fetch call. */
export interface FetchCall {
  url: string;
  init: RequestInit;
}

/**
 * Build a `fetch` mock that records calls and returns canned responses
 * from a FIFO queue. The last entry is returned for any call after the
 * queue is drained (so a "default" response can be stashed at the end
 * of the array).
 */
export function makeFetchMock(responses: FetchMockResponse[]): {
  fn: MockInstance<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const queue = [...responses];
  const fn = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    const next = queue.shift() ?? queue[queue.length - 1];
    if (!next) {
      throw new Error("fetchMock: no more responses queued");
    }
    const headers = new Headers(next.headers ?? {});
    return new Response((next.body ?? "") as BodyInit, {
      status: next.status ?? 200,
      headers,
    });
  });
  return { fn, calls };
}

/**
 * Build a `fetch` mock that returns a streaming `Response` whose body is
 * the concatenation of the given pre-encoded SSE byte chunks.
 *
 * For mocks that need per-URL branching or a fully custom `ReadableStream`,
 * write an inline `vi.fn` instead — this helper covers the uniform case
 * used by `openSSEStream` integration tests.
 */
export function makeStreamingFetch(
  chunks: string[],
  options: { status?: number; headers?: Record<string, string> } = {},
): {
  fn: MockInstance<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>;
  calls: FetchCall[];
} {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });

  const calls: FetchCall[] = [];
  const fn = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    return new Response(body, {
      status: options.status ?? 200,
      headers: new Headers(options.headers ?? { "content-type": "text/event-stream" }),
    });
  });
  return { fn, calls };
}
