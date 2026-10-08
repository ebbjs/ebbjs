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
import type { Action } from "@ebbjs/core";
import type { createClient } from "./client";

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
 * Drive the private `_applyAction` method on a SyncClient.
 *
 * Tests that need to seed storage state without driving the full SSE /
 * HTTP path call this through the test-only cast pattern. The two-arg
 * shape (`groupId?`) matches the production method so callers can
 * omit the group when irrelevant.
 */
export const callApplyAction = (
  client: ReturnType<typeof createClient>,
  action: Action,
  groupId?: string,
): Promise<{ entityId: string; entityType: string }[]> =>
  (
    client as unknown as {
      _applyAction: (a: Action, g?: string) => Promise<{ entityId: string; entityType: string }[]>;
    }
  )._applyAction.call(client, action, groupId);

/** A JSON `Response` carrying `body` and optional extra headers. */
export const jsonResponse = (body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });

/** Catch-up `GET /sync/groups/:id` response reporting nothing missed. */
export const emptyCatchUpResponse = (): Response =>
  jsonResponse([], { "stream-up-to-date": "true" });

/** An SSE `Response` whose body never ends, keeping a subscription live. */
export const openSseResponse = (): Response =>
  new Response(new ReadableStream<Uint8Array>({ start() {} }), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });

/** An SSE `Response` that emits pre-encoded `chunks` and then closes. */
export const closingSseResponse = (chunks: readonly string[]): Response => {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
};

/**
 * Build a `fetch` mock that records calls and returns canned responses
 * from a FIFO queue. The last entry is returned for any call after the
 * queue is drained (so a "default" response can be stashed at the end
 * of the array).
 */
export function makeFetchMock(responses: FetchMockResponse[]): {
  fn: MockInstance<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>> &
    typeof fetch;
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
  }) as unknown as MockInstance<
    (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  > &
    typeof fetch;
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
  fn: MockInstance<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>> &
    typeof fetch;
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
  }) as unknown as MockInstance<
    (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  > &
    typeof fetch;
  return { fn, calls };
}
