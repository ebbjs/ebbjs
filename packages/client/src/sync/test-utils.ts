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
import { makeHlc, type Action, type Entity, type Update } from "@ebbjs/core";
import type { Replica } from "@ebbjs/storage/types";
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

let seedPosition = 0;

/**
 * Fold a seeded row into the replica through the same durable
 * Action / Update path the client uses. The replica is the client's
 * read path, so a row a test writes with `storage.entities.set` is
 * invisible to a query unless it is folded here too.
 *
 * Call this before the shim write: production ingests the Action (which
 * wakes the replica signal) before the shim is materialized.
 */
export const seedReplicaRow = (
  replica: Replica,
  row: Entity,
  method: "put" | "delete" = row.deleted_hlc === null ? "put" : "delete",
): void => {
  seedPosition += 1;
  const hlc = makeHlc(seedPosition);
  const update: Update =
    method === "put"
      ? {
          id: `u_seed_${seedPosition}`,
          subject_id: row.id,
          subject_type: row.type,
          method,
          data: { fields: row.data?.fields ?? {} },
        }
      : {
          id: `u_seed_${seedPosition}`,
          subject_id: row.id,
          subject_type: row.type,
          method: "delete",
          data: null,
        };
  const action: Action = {
    id: `a_seed_${seedPosition}`,
    actor_id: "seed",
    hlc,
    gsn: seedPosition,
    updates: [],
  };
  replica.ingest(action, [update], seedPosition);
};

/** A JSON `Response` carrying `body` and optional extra headers. */
export const jsonResponse = (body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });

/** Catch-up `GET /sync/groups/:id` response reporting nothing missed. */
export const emptyCatchUpResponse = (): Response =>
  jsonResponse([], { "stream-up-to-date": "true" });

/**
 * Whether `url` is the group listing (`GET /sync/groups/:id/entities`). The
 * listing and the catch-up share a path prefix, so a path-dispatching mock
 * has to tell them apart before it branches on `/sync/groups/`.
 */
export const isListingRequest = (url: string): boolean =>
  url.includes("/sync/groups/") && url.includes("/entities");

/**
 * A group listing page with no rows. Every cold bootstrap asks for one
 * before catch-up, so a path-dispatching mock serves this to stay on the
 * log path; `watermark` is the GSN the client then resumes from.
 */
export const emptyListingResponse = (watermark = 0, groupId = "grp_1"): Response =>
  jsonResponse({ group_id: groupId, watermark, cursor: null, has_more: false, entities: [] });

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

/**
 * Poll `predicate` until it holds, or throw after `timeoutMs`. Waiting on
 * the durable store beats a fixed sleep, which couples a test to
 * scheduler timing.
 */
export const waitFor = async (
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 2_000,
): Promise<void> => {
  const started = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - started > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};
