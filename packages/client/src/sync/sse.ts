/**
 * SSE parser for the ebb sync live stream.
 *
 * Two implementations:
 * - **Node**: parses a `fetch` response body byte-by-byte using the WHATWG
 *   ReadableStream API. Avoids an `eventsource` dependency (none of the
 *   popular SSE polyfills work in Node 22's native fetch).
 * - **Browser**: wraps the native `EventSource` constructor.
 *
 * Both expose the same surface: {@link openSSEStream} returns an
 * {@link SSESubscription} with `events()` (async iterable), `close()`, and a
 * `closed` promise that resolves when the stream ends.
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
 *     : keepalive
 *
 * Comments start with `:` and are silently dropped. Fields are `event:`
 * (event type) and `data:` (one or more lines, joined with `\n`). Events
 * are separated by a blank line.
 */

import type { SSEEvent } from "./types";

const DEFAULT_BROWSER_EVENT_TYPES = ["data", "control", "presence"] as const;

/** HTTP headers that must be sent to open an SSE connection. */
export interface SSEHeaders {
  /** Actor ID for bypass auth. */
  actorId: string;
}

/** URL/options for opening an SSE stream. */
export interface SSEOpenOptions {
  /** Server base URL (e.g., "http://localhost:4000"). */
  serverUrl: string;
  /** Group IDs to subscribe to. */
  groupIds: readonly string[];
  /** Cursor (GSN) to resume from. */
  cursor: number;
  /** Headers to include (e.g., bypass auth). */
  headers: SSEHeaders;
  /** Fetch implementation (Node only; defaults to global `fetch`). */
  fetchImpl?: typeof fetch;
}

export interface SSESubscription {
  /** Async iterator over events from the stream. */
  events(): AsyncIterableIterator<SSEEvent>;
  /** Stop the stream and release resources. */
  close(): void;
  /** Resolves when the stream ends (normal or error). */
  closed: Promise<void>;
}

export function openSSEStream(opts: SSEOpenOptions): SSESubscription {
  // Detect runtime. `EventSource` is a global in browsers; in Node 22 it's
  // undefined unless the user polyfills it.
  const isBrowser = typeof (globalThis as { EventSource?: unknown }).EventSource !== "undefined";

  if (isBrowser) {
    return openBrowserSSE(opts);
  }
  return openNodeSSE(opts);
}

// ---------------------------------------------------------------------------
// Node implementation — parses the chunked HTTP response body ourselves.
// ---------------------------------------------------------------------------

interface NodeStreamState {
  queue: SSEEvent[];
  waiters: Array<(v: IteratorResult<SSEEvent>) => void>;
  done: boolean;
  error: unknown;
  closedResolvers: Array<() => void>;
  controller: AbortController | null;
  /** Set after the response arrives so `close()` can cancel it. */
  responseBody: ReadableStream<Uint8Array> | null;
  /** Held by the read loop; close() cancels via this so we don't trip
   *  "ReadableStream is locked" when there's an active reader. */
  reader: ReadableStreamDefaultReader<Uint8Array> | null;
}

function openNodeSSE(opts: SSEOpenOptions): SSESubscription {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const url = buildSSEUrl(opts.serverUrl, opts.groupIds, opts.cursor);

  const state: NodeStreamState = {
    queue: [],
    waiters: [],
    done: false,
    error: null,
    closedResolvers: [],
    controller: new AbortController(),
    responseBody: null,
    reader: null,
  };

  const closed = new Promise<void>((resolve) => {
    state.closedResolvers.push(resolve);
  });

  const close = (): void => {
    if (state.done) return;
    state.done = true;
    if (state.controller) {
      state.controller.abort();
      state.controller = null;
    }
    // If there's an active reader, cancel via the reader (cancel() on a
    // locked stream throws). The reader's read() will throw an AbortError,
    // the read loop's catch block will swallow it as a clean close.
    if (state.reader) {
      const reader = state.reader;
      state.reader = null;
      reader.cancel().catch(() => {
        // ignore
      });
    } else if (state.responseBody) {
      // No reader attached yet — the body is unlocked, cancel directly.
      const body = state.responseBody;
      state.responseBody = null;
      body.cancel().catch(() => {
        // ignore
      });
    }
    drainWaiters(state);
    for (const r of state.closedResolvers) r();
  };

  const fail = (err: unknown): void => {
    if (state.done) return;
    state.error = err;
    state.done = true;
    drainWaiters(state);
    for (const r of state.closedResolvers) r();
  };

  // Kick off the request asynchronously so the caller can wire up `events()`
  // before the first chunk arrives.
  void (async () => {
    try {
      const controller = state.controller;
      if (!controller) return;
      const response = await fetchImpl(url, {
        method: "GET",
        headers: {
          Accept: "text/event-stream",
          "x-ebb-actor-id": opts.headers.actorId,
          "Cache-Control": "no-cache",
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        fail(new Error(`SSE open failed: ${response.status} ${body}`));
        return;
      }

      if (!response.body) {
        fail(new Error("SSE response has no body"));
        return;
      }
      state.responseBody = response.body;

      await readStreamBody(state.responseBody, state, pushEvent);
      if (!state.done) close();
    } catch (err) {
      // AbortError means we closed; treat as a clean close, not a failure.
      if ((err as { name?: string })?.name === "AbortError") {
        close();
      } else {
        fail(err);
      }
    }
  })();

  return makeSubscription(state, close, closed);
}

async function readStreamBody(
  body: ReadableStream<Uint8Array>,
  state: NodeStreamState,
  pushEvent: (event: SSEEvent, state: NodeStreamState) => void,
): Promise<void> {
  const reader = body.getReader();
  state.reader = reader;
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  try {
    while (true) {
      const { value, done: streamDone } = await reader.read();
      if (streamDone) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by a blank line. Process all complete
      // events in the buffer, leaving any partial trailing line behind.
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const event = parseSSEBlock(raw);
        if (event) {
          pushEvent(event, state);
        }
      }
    }

    // Flush remaining bytes (server may end without trailing blank line).
    buffer += decoder.decode();
    if (buffer.trim()) {
      const event = parseSSEBlock(buffer);
      if (event) {
        pushEvent(event, state);
      }
    }
  } finally {
    if (state.reader === reader) {
      state.reader = null;
    }
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }
}

function pushEvent(event: SSEEvent, state: NodeStreamState): void {
  if (state.waiters.length > 0) {
    const w = state.waiters.shift();
    if (w) w({ value: event, done: false });
  } else {
    state.queue.push(event);
  }
}

function drainWaiters(state: NodeStreamState): void {
  for (const w of state.waiters) {
    w({ value: undefined, done: true });
  }
  state.waiters.length = 0;
  state.queue.length = 0;
}

function makeSubscription(
  state: NodeStreamState,
  close: () => void,
  closed: Promise<void>,
): SSESubscription {
  const events = (): AsyncIterableIterator<SSEEvent> => {
    const iterator: AsyncIterableIterator<SSEEvent> = {
      next(): Promise<IteratorResult<SSEEvent>> {
        if (state.error) {
          return Promise.reject(state.error);
        }
        if (state.queue.length > 0) {
          const value = state.queue.shift();
          if (value !== undefined) {
            return Promise.resolve({ value, done: false });
          }
        }
        if (state.done) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => state.waiters.push(resolve));
      },
      return(): Promise<IteratorResult<SSEEvent>> {
        close();
        return Promise.resolve({ value: undefined, done: true });
      },
      throw(err: unknown): Promise<IteratorResult<SSEEvent>> {
        if (!state.done) {
          state.error = err;
          state.done = true;
          drainWaiters(state);
        }
        return Promise.resolve({ value: undefined, done: true });
      },
      [Symbol.asyncIterator]() {
        return iterator;
      },
    };
    return iterator;
  };

  return { events, close, closed };
}

/**
 * Parse a single SSE block (everything between blank lines) into an
 * `SSEEvent`, or `null` if the block is empty / a comment.
 *
 * Per the SSE spec, `data:` lines are joined with `\n`. We only support the
 * single-line `data:` form the server emits.
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

  switch (eventName) {
    case "data": {
      const action = parsed as Extract<SSEEvent, { type: "data" }>["action"];
      return { type: "data", action };
    }
    case "control": {
      const control = parsed as Extract<SSEEvent, { type: "control" }>["control"];
      return { type: "control", control };
    }
    case "presence": {
      const presence = parsed as Extract<SSEEvent, { type: "presence" }>["presence"];
      return { type: "presence", presence };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Browser implementation — wraps native EventSource.
// ---------------------------------------------------------------------------

interface BrowserEventSourceConstructor {
  new (url: string, init?: { withCredentials?: boolean }): BrowserEventSourceInstance;
}
interface BrowserEventSourceInstance {
  addEventListener(type: string, listener: (ev: { data: string }) => void): void;
  close(): void;
}

function openBrowserSSE(opts: SSEOpenOptions): SSESubscription {
  const ES = (globalThis as { EventSource: BrowserEventSourceConstructor }).EventSource;
  // Browser EventSource cannot set custom request headers. We pass the
  // actor id via a query parameter; the server's bypass-auth plug
  // accepts it as a fallback to the header.
  const url = buildSSEUrl(opts.serverUrl, opts.groupIds, opts.cursor, {
    actorId: opts.headers.actorId,
  });

  const state: NodeStreamState = {
    queue: [],
    waiters: [],
    done: false,
    error: null,
    closedResolvers: [],
    controller: null,
    responseBody: null,
    reader: null,
  };
  let source: BrowserEventSourceInstance | null = null;

  const closed = new Promise<void>((resolve) => {
    state.closedResolvers.push(resolve);
  });

  const push = (event: SSEEvent): void => {
    if (state.waiters.length > 0) {
      const w = state.waiters.shift();
      if (w) w({ value: event, done: false });
    } else {
      state.queue.push(event);
    }
  };

  const finish = (err?: unknown): void => {
    if (state.done) return;
    state.done = true;
    if (err) state.error = err;
    if (source) {
      try {
        source.close();
      } catch {
        // ignore
      }
      source = null;
    }
    drainWaiters(state);
    for (const r of state.closedResolvers) r();
  };

  try {
    source = new ES(url);
  } catch (err) {
    finish(err);
    return makeSubscription(state, () => finish(), closed);
  }

  // Browser EventSource cannot set custom request headers. We pass the
  // actor id via a query parameter above; the server's bypass-auth plug
  // accepts it as a fallback to the header.

  for (const eventType of DEFAULT_BROWSER_EVENT_TYPES) {
    source.addEventListener(eventType, (ev) => {
      try {
        const parsed = JSON.parse(ev.data);
        if (eventType === "data") {
          push({ type: "data", action: parsed });
        } else if (eventType === "control") {
          push({ type: "control", control: parsed });
        } else {
          push({ type: "presence", presence: parsed });
        }
      } catch {
        // skip malformed events
      }
    });
  }

  source.addEventListener("error", () => {
    finish(new Error("EventSource error"));
  });

  return makeSubscription(state, () => finish(), closed);
}

// ---------------------------------------------------------------------------
// Shared URL builder.
// ---------------------------------------------------------------------------

function buildSSEUrl(
  serverUrl: string,
  groupIds: readonly string[],
  cursor: number,
  opts?: { actorId?: string },
): string {
  const base = serverUrl.replace(/\/$/, "");
  const params = new URLSearchParams({ groups: groupIds.join(","), cursor: String(cursor) });
  // Browser EventSource can't set custom headers; pass the actor id via
  // query parameter as a fallback. The server's bypass-auth plug accepts
  // either source.
  if (opts?.actorId) params.set("actor_id", opts.actorId);
  return `${base}/sync/live?${params.toString()}`;
}
