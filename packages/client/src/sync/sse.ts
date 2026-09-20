/**
 * SSE parser for the ebb sync live stream.
 *
 * Single implementation: hands off to [`eventsource-client`][1], which is
 * fetch + ReadableStream based and works identically in browsers (no
 * dependency on the native `EventSource` constructor and therefore no
 * header-set workaround), Node 18+, Bun, and Deno.
 *
 * `openSSEStream` returns an {@link SSESubscription} with `events()`
 * (async iterable), `close()`, and a `closed` promise that resolves when
 * the stream ends.
 *
 * [1]: https://github.com/rexxars/eventsource-client
 *
 * ## Server event format
 *
 * Per `ebb_server/lib/ebb_server/sync/sse_connection.ex`, events are:
 *
 *     event: data
 *     data: {"id":"act_abc","gsn":501,...}
 *
 *     event: control
 *     data: {"reconnect":true,"reason":"behind_watermark"}
 *
 *     event: presence
 *     data: {"actor_id":"a1","entity_id":"e1","data":{...}}
 *
 *     : keepalive
 *
 * Comments (`:` prefixed) are silently dropped. The rexxars parser joins
 * multi-line `data:` fields with `\n`, matching the SSE spec.
 */

import { createEventSource, type EventSourceOptions } from "eventsource-client";
import type { SSEEvent } from "./types";

const KNOWN_EVENT_TYPES = ["data", "control", "presence"] as const;

/** URL/options for opening an SSE stream. */
export interface SSEOpenOptions {
  /** Server base URL (e.g., "http://localhost:4000"). */
  serverUrl: string;
  /** Group IDs to subscribe to. */
  groupIds: readonly string[];
  /** Cursor (GSN) to resume from. */
  cursor: number;
  /**
   * Actor ID for bypass auth (sent as the `x-ebb-actor-id` header).
   *
   * Required for now; if cookie-based auth lands, this can become optional
   * without a breaking change.
   */
  actorId: string;
  /**
   * Fetch implementation. Defaults to `globalThis.fetch`. Must support
   * streaming response bodies (WHATWG `ReadableStream`). Both the browser
   * and Node 18+ globals qualify.
   */
  fetchImpl?: typeof fetch;
}

export interface SSESubscription {
  /** Async iterator over events from the stream. */
  events(): AsyncIterableIterator<SSEEvent>;
  /** Stop the stream and release resources. */
  close(): void;
  /** Resolves when the stream ends (after `close()` was called). */
  closed: Promise<void>;
}

export function openSSEStream(opts: SSEOpenOptions): SSESubscription {
  const baseFetch = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  // Wrap fetch so non-2xx responses surface as a deterministic
  // stream-level error rather than eventsource-client's default retry loop
  // (the library reconnects on fetch rejection or stream errors, which is
  // wrong for a 4xx auth failure that won't recover on its own).
  //
  // Strategy: capture the error up front, then return a 204 response body
  // that signals "close cleanly" to the rexxars lib. We surface the
  // captured error via surfaceError() when the iterator drains.
  let capturedOpenError: Error | null = null;
  const fetchImpl: typeof fetch = async (input, init) => {
    const response = await baseFetch(input as Request | string | URL, init);
    if (response.ok) return response;
    const body = await response.text().catch(() => "");
    capturedOpenError = new Error(`SSE open failed: ${response.status} ${body}`.trim());
    // Return a 204 so eventsource-client closes the iterator cleanly
    // (it special-cases 204 as a graceful server-initiated close).
    return new Response(null, { status: 204 });
  };
  const url = buildSSEUrl(opts.serverUrl, opts.groupIds, opts.cursor);

  const source = createEventSource({
    url,
    // The library's `FetchLike` type is a strict subset of DOM `fetch`
    // — cast through unknown because TS can't bridge the variance.
    fetch: fetchImpl as unknown as EventSourceOptions["fetch"],
    headers: {
      Accept: "text/event-stream",
      "x-ebb-actor-id": opts.actorId,
      "Cache-Control": "no-cache",
    },
  } as never);

  const queue: SSEEvent[] = [];
  const waiters: Array<{
    resolve: (v: IteratorResult<SSEEvent>) => void;
    reject: (err: unknown) => void;
  }> = [];
  const closedResolvers: Array<() => void> = [];
  let closed = false;
  let pendingError: unknown = null;
  let hasPendingError = false;

  const push = (event: SSEEvent): void => {
    if (waiters.length > 0) {
      const w = waiters.shift();
      if (w) w.resolve({ value: event, done: false });
    } else {
      queue.push(event);
    }
  };

  const surfaceError = (err: unknown): void => {
    if (closed) return;
    pendingError = err;
    hasPendingError = true;
    while (waiters.length > 0) {
      const w = waiters.shift();
      if (w) w.reject(err);
    }
  };

  const finish = (): void => {
    if (closed) return;
    closed = true;
    try {
      source.close();
    } catch {
      // already closed
    }
    while (waiters.length > 0) {
      const w = waiters.shift();
      if (w) w.resolve({ value: undefined, done: true });
    }
    for (const r of closedResolvers) r();
  };

  // Adapt the rexxars iterator's payload to our `SSEEvent` shape, then
  // forward to the consumer's iterator. The rexxars lib already drops
  // keepalive comments and joins multi-line `data:` fields with `\n`,
  // so we don't need our own chunk parser here.
  //
  // Note: eventsource-client's async iterator terminates cleanly when
  // `source.close()` is called — it returns `{done: true}`. Any other
  // completion (network failure, non-2xx response thrown by our fetch
  // wrapper) is treated as an error condition.
  void (async () => {
    try {
      for await (const msg of source) {
        if (closed) break;
        const name = msg.event ?? "";
        if (!KNOWN_EVENT_TYPES.includes(name as (typeof KNOWN_EVENT_TYPES)[number])) {
          continue;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(msg.data);
        } catch {
          // Skip malformed JSON — never crash the stream.
          continue;
        }
        const next = makeEvent(name, parsed);
        if (next) push(next);
      }
      // Iterator drained. Two reasons this happens:
      //   1. Consumer called .close() (clean close).
      //   2. Our fetch wrapper captured an open error (returns 204 to
      //      signal graceful close) — surface it.
      if (capturedOpenError) {
        const err = capturedOpenError;
        capturedOpenError = null;
        surfaceError(err);
      }
      finish();
    } catch (err) {
      if (closed) return;
      if (capturedOpenError) {
        const openErr = capturedOpenError;
        capturedOpenError = null;
        surfaceError(openErr);
      } else {
        surfaceError(err);
      }
      finish();
    }
  })();

  const iterator: AsyncIterableIterator<SSEEvent> = {
    next(): Promise<IteratorResult<SSEEvent>> {
      if (hasPendingError) {
        const err = pendingError;
        pendingError = null;
        hasPendingError = false;
        return Promise.reject(err);
      }
      if (queue.length > 0) {
        const value = queue.shift();
        if (value !== undefined) {
          return Promise.resolve({ value, done: false });
        }
      }
      if (closed) return Promise.resolve({ value: undefined, done: true });
      return new Promise((resolve, reject) => {
        waiters.push({ resolve, reject });
      });
    },
    return(): Promise<IteratorResult<SSEEvent>> {
      finish();
      return Promise.resolve({ value: undefined, done: true });
    },
    throw(err: unknown): Promise<IteratorResult<SSEEvent>> {
      finish();
      return Promise.reject(err);
    },
    [Symbol.asyncIterator]() {
      return iterator;
    },
  };

  return {
    events: () => iterator,
    close: () => finish(),
    closed: new Promise<void>((resolve) => closedResolvers.push(resolve)),
  };
}

function makeEvent(name: string, parsed: unknown): SSEEvent | null {
  switch (name) {
    case "data":
      return { type: "data", action: parsed as Extract<SSEEvent, { type: "data" }>["action"] };
    case "control":
      return {
        type: "control",
        control: parsed as Extract<SSEEvent, { type: "control" }>["control"],
      };
    case "presence":
      return {
        type: "presence",
        presence: parsed as Extract<SSEEvent, { type: "presence" }>["presence"],
      };
    default:
      return null;
  }
}

/**
 * Build the SSE endpoint URL with required query params.
 *
 * Note: there is intentionally NO `actor_id=` query param here. Auth is
 * always via the `x-ebb-actor-id` header. Past versions appended
 * `?actor_id=` to work around the native browser EventSource not
 * accepting custom headers; switching to fetch-based consumers (via
 * eventsource-client) removed that requirement.
 */
function buildSSEUrl(serverUrl: string, groupIds: readonly string[], cursor: number): string {
  const base = serverUrl.replace(/\/$/, "");
  const params = new URLSearchParams({ groups: groupIds.join(","), cursor: String(cursor) });
  return `${base}/sync/live?${params.toString()}`;
}

/**
 * Parse a single SSE block (everything between blank lines) into an
 * `SSEEvent`, or `null` if the block is empty / a comment.
 *
 * Exported for unit-testing the JSON parsing shape directly without going
 * through the transport layer. `openSSEStream` delegates to
 * `eventsource-client` for actual chunk parsing.
 *
 * Per the SSE spec, `data:` lines are joined with `\n`. We only support
 * the single-line `data:` form the server emits.
 */
export function parseSSEBlock(block: string): SSEEvent | null {
  let eventName = "message";
  let dataStr = "";

  for (const line of block.split("\n")) {
    if (line.startsWith(":")) {
      // Comment / keepalive.
      continue;
    }
    if (line.startsWith("event:")) {
      eventName = line.slice("event:".length).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataStr += line.slice("data:".length).trim();
      continue;
    }
    // Ignore id:, retry:, and any other fields.
  }

  if (!dataStr) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(dataStr);
  } catch {
    // Malformed JSON; skip silently rather than crash the stream.
    return null;
  }

  return makeEvent(eventName, parsed);
}
