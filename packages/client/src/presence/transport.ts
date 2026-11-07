/**
 * The send half of presence: a keyed trailing debounce in front of
 * `POST /sync/presence`.
 *
 * Coalescing is per `(entityId, channel)`. One shared timer would drop a send
 * on entity A whenever entity B sent inside the same window — the bug this
 * keying fixes — and a channel's `debounceMs` is its own declaration.
 *
 * Presence writes are never queued, retried, or routed through the Outbox: the
 * next write of the same channel carries newer state, so a failed send is
 * dropped. The one failure that is not silent is an oversized body, which is
 * rejected at the call site where the app can react to it.
 */

import {
  DEFAULT_PRESENCE_DEBOUNCE_MS,
  MAX_PRESENCE_PAYLOAD_BYTES,
  PresencePayloadTooLargeError,
  type PresenceChannelConfig,
} from "./define";
import { targetKey } from "./keys";
import { unrefTimer } from "./timers";

export interface PresenceTransportOptions {
  readonly serverUrl: string;
  readonly actorId: string;
  readonly fetchImpl: typeof fetch;
  /** Undeclared channels (an untyped client's dynamic ones) use the defaults. */
  readonly channels?: Readonly<Record<string, PresenceChannelConfig>>;
}

export interface PresenceSendOptions {
  /**
   * Mark the POST `keepalive` so it outlives the document: the send still
   * goes out when the page is being torn down (`pagehide`).
   */
  readonly keepalive?: boolean;
}

export interface PresenceTransport {
  /**
   * Coalesce one channel write behind the channel's debounce. Throws
   * {@link PresencePayloadTooLargeError} synchronously when the serialized
   * body exceeds the limit.
   */
  send(entityId: string, channel: string, value: unknown, options?: PresenceSendOptions): void;
  /** Send everything pending now and resolve once those requests settle. */
  flush(): Promise<void>;
  /** Drop everything pending without sending it. */
  cancel(): void;
}

interface PendingSend {
  readonly entityId: string;
  readonly channel: string;
  readonly body: string;
  readonly keepalive: boolean;
  timer: ReturnType<typeof setTimeout>;
}

export function createPresenceTransport(opts: PresenceTransportOptions): PresenceTransport {
  const pending = new Map<string, PendingSend>();
  const inFlight = new Set<Promise<void>>();

  const post = (send: { entityId: string; body: string; keepalive: boolean }): Promise<void> => {
    const request: RequestInit = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-ebb-actor-id": opts.actorId,
      },
      body: send.body,
    };
    // Only when asked: the browser keeps a `keepalive` request alive after the
    // document is gone, which an ordinary write does not need.
    const init = send.keepalive ? { ...request, keepalive: true } : request;
    const attempt = (async (): Promise<void> => {
      try {
        const response = await opts.fetchImpl(`${opts.serverUrl}/sync/presence`, init);
        if (!response.ok && response.status !== 204) {
          await response.text().catch(() => "");
        }
      } catch {
        // Dropped on purpose: presence is lossy, and the next write of this
        // channel supersedes this one.
      }
    })();
    inFlight.add(attempt);
    void attempt.then(() => inFlight.delete(attempt));
    return attempt;
  };

  const takePending = (): PendingSend[] => {
    const taken = [...pending.values()];
    pending.clear();
    for (const entry of taken) clearTimeout(entry.timer);
    return taken;
  };

  return {
    send(entityId, channel, value, options) {
      const keepalive = options?.keepalive === true;
      const body = JSON.stringify({ entity_id: entityId, data: { channel, value } });
      const bytes = byteLength(body);
      if (bytes > MAX_PRESENCE_PAYLOAD_BYTES) {
        throw new PresencePayloadTooLargeError({
          entityId,
          channel,
          bytes,
          limit: MAX_PRESENCE_PAYLOAD_BYTES,
        });
      }
      const key = targetKey(entityId, channel);
      const previous = pending.get(key);
      if (previous !== undefined) clearTimeout(previous.timer);
      const debounceMs = opts.channels?.[channel]?.debounceMs ?? DEFAULT_PRESENCE_DEBOUNCE_MS;
      const timer = setTimeout(() => {
        pending.delete(key);
        void post({ entityId, body, keepalive });
      }, debounceMs);
      unrefTimer(timer);
      pending.set(key, { entityId, channel, body, keepalive, timer });
    },

    async flush() {
      const started = takePending().map((entry) => post(entry));
      await Promise.all([...inFlight, ...started]);
    },

    cancel() {
      takePending();
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

const byteLength = (text: string): number => encoder.encode(text).length;
