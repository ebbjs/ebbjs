/**
 * The receive half of presence: the peers observed on the client's live
 * stream, keyed by `(entityId, channel, actorId)`.
 *
 * Last-write-wins per key. The wire carries no timestamp, so `updatedAt` is
 * the local receive time and staleness is a purely local judgement: an entry
 * is swept once its channel's TTL has elapsed since the last packet. The sweep
 * runs lazily on every ingest and on a timer armed only while the map is
 * non-empty, so an idle client holds no timer and a read never waits on one.
 *
 * `SyncClient` owns one store per client and feeds it from `handleSSEEvent`.
 * The store outlives individual packets but not the connection: closing the
 * stream drops every peer, because a disconnected client cannot know its peer
 * set.
 */

import {
  DEFAULT_PRESENCE_MAX_ENTRIES,
  DEFAULT_PRESENCE_TTL_MS,
  type PresenceChannelConfig,
} from "./define";
import { entryKey, targetKey } from "./keys";
import { unrefTimer } from "./timers";

/** One observed peer on one channel of one entity. */
export interface PeerPresence<T = unknown> {
  /** The actor that sent the packet. Never the local actor. */
  readonly actorId: string;
  /** The entity the peer is present on. */
  readonly entityId: string;
  /** The channel the peer sent on. */
  readonly channel: string;
  /** The channel payload, as the peer sent it. */
  readonly data: T;
  /** Local receive time, in epoch ms. Replaced by every fresher packet. */
  readonly updatedAt: number;
}

/** Which `(entity, channel)` pair changed; what `onUpdate` reports. */
export interface PresenceChange {
  readonly entityId: string;
  readonly channel: string;
}

/** The normalized channel declarations a store reads its TTLs and caps from. */
export type PresenceChannelConfigs = Readonly<Record<string, PresenceChannelConfig>>;

export interface PresenceStoreOptions {
  readonly localActorId: string;
  /** Undeclared channels (an untyped client's dynamic ones) use the defaults. */
  readonly channels?: PresenceChannelConfigs;
  /** Injection point for the receive clock, so tests can advance it. */
  readonly now?: () => number;
}

export interface PresenceStore {
  /**
   * Fold one server `presence` packet — `{actor_id, entity_id, data:
   * {channel, value}}` — into the map. A `null` value removes just that
   * actor's entry for that `(entity, channel)`; the local actor and payloads
   * we cannot read are ignored.
   */
  ingest(payload: unknown): void;
  /**
   * The live entries for one `(entity, channel)`, keyed by actor. A fresh map
   * per call, so callers cannot mutate the store.
   */
  forEntity<T = unknown>(entityId: string, channel: string): ReadonlyMap<string, PeerPresence<T>>;
  /** Fires per changed `(entity, channel)`. Returns an unsubscribe function. */
  onUpdate(callback: (change: PresenceChange) => void): () => void;
  /** Drop every peer: the connection they were observed on is gone. */
  clear(): void;
  /** Drop every peer, cancel the sweep timer, and stop accepting packets. */
  close(): void;
}

type PresenceListener = (change: PresenceChange) => void;

export function createPresenceStore(opts: PresenceStoreOptions): PresenceStore {
  const localActorId = opts.localActorId;
  const channels = opts.channels;
  const now = opts.now ?? Date.now;
  const entries = new Map<string, PeerPresence>();
  const listeners = new Set<PresenceListener>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const ttlOf = (channel: string): number => channels?.[channel]?.ttlMs ?? DEFAULT_PRESENCE_TTL_MS;
  const capOf = (channel: string): number =>
    channels?.[channel]?.maxEntries ?? DEFAULT_PRESENCE_MAX_ENTRIES;

  const notify = (change: PresenceChange): void => {
    // Snapshot: a listener that subscribes or unsubscribes during this pass
    // must not change who else receives it.
    for (const listener of new Set(listeners)) {
      try {
        listener(change);
      } catch {
        // One listener's error must not starve the others.
      }
    }
  };

  const notifyEach = (changes: Iterable<PresenceChange>): void => {
    for (const change of changes) notify(change);
  };

  const releaseTimer = (): void => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };

  /** Arm one timer for the earliest expiry; only while entries are live. */
  const armTimer = (): void => {
    releaseTimer();
    if (closed || entries.size === 0) return;
    let earliest = Number.POSITIVE_INFINITY;
    for (const entry of entries.values()) {
      const ttl = ttlOf(entry.channel);
      if (Number.isFinite(ttl)) earliest = Math.min(earliest, entry.updatedAt + ttl);
    }
    if (!Number.isFinite(earliest)) return;
    timer = setTimeout(sweep, Math.max(0, earliest - now()));
    unrefTimer(timer);
  };

  /** Drop every entry past its channel's TTL at `cutoff`, by changed target. */
  const expireAt = (cutoff: number): Map<string, PresenceChange> => {
    const changed = new Map<string, PresenceChange>();
    for (const [key, entry] of entries) {
      const ttl = ttlOf(entry.channel);
      if (!Number.isFinite(ttl) || entry.updatedAt + ttl > cutoff) continue;
      entries.delete(key);
      changed.set(targetKey(entry.entityId, entry.channel), {
        entityId: entry.entityId,
        channel: entry.channel,
      });
    }
    return changed;
  };

  const sweep = (): void => {
    timer = null;
    const expired = expireAt(now());
    armTimer();
    notifyEach(expired.values());
  };

  /** Evict the least-recently-updated entries past the channel's cap. */
  const enforceCap = (entityId: string, channel: string): void => {
    const cap = capOf(channel);
    if (!Number.isFinite(cap) || cap <= 0) return;
    const scoped: { key: string; updatedAt: number }[] = [];
    for (const [key, entry] of entries) {
      if (entry.entityId === entityId && entry.channel === channel) {
        scoped.push({ key, updatedAt: entry.updatedAt });
      }
    }
    if (scoped.length <= cap) return;
    scoped.sort((a, b) => a.updatedAt - b.updatedAt);
    for (const { key } of scoped.slice(0, scoped.length - cap)) entries.delete(key);
  };

  return {
    ingest(payload) {
      if (closed) return;
      const event = parsePresenceEvent(payload);
      if (event === null || event.actorId === localActorId) return;
      const receivedAt = now();
      // Lazy half of the sweep: a packet is evidence the stream is live, so
      // age out anything the timer could not reach (a throttled tab).
      const changes = expireAt(receivedAt);
      const key = entryKey(event.entityId, event.channel, event.actorId);
      if (event.value === null) {
        if (entries.delete(key)) {
          changes.set(targetKey(event.entityId, event.channel), {
            entityId: event.entityId,
            channel: event.channel,
          });
        }
      } else {
        entries.set(key, {
          actorId: event.actorId,
          entityId: event.entityId,
          channel: event.channel,
          data: event.value,
          updatedAt: receivedAt,
        });
        enforceCap(event.entityId, event.channel);
        changes.set(targetKey(event.entityId, event.channel), {
          entityId: event.entityId,
          channel: event.channel,
        });
      }
      armTimer();
      notifyEach(changes.values());
    },

    forEntity<T>(entityId: string, channel: string): ReadonlyMap<string, PeerPresence<T>> {
      const out = new Map<string, PeerPresence<T>>();
      for (const entry of entries.values()) {
        if (entry.entityId !== entityId || entry.channel !== channel) continue;
        out.set(entry.actorId, entry as PeerPresence<T>);
      }
      return out;
    },

    onUpdate(callback) {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },

    clear() {
      releaseTimer();
      if (entries.size === 0) return;
      const changed = new Map<string, PresenceChange>();
      for (const entry of entries.values()) {
        changed.set(targetKey(entry.entityId, entry.channel), {
          entityId: entry.entityId,
          channel: entry.channel,
        });
      }
      entries.clear();
      notifyEach(changed.values());
    },

    close() {
      closed = true;
      releaseTimer();
      entries.clear();
      listeners.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ParsedPresenceEvent {
  readonly actorId: string;
  readonly entityId: string;
  readonly channel: string;
  readonly value: unknown;
}

/**
 * The server forwards whatever the sender POSTed, so a malformed or
 * non-channel payload is treated as absent rather than throwing. A packet
 * without a `channel` predates the channel envelope and cannot be placed.
 */
function parsePresenceEvent(payload: unknown): ParsedPresenceEvent | null {
  if (typeof payload !== "object" || payload === null) return null;
  const event = payload as Record<string, unknown>;
  const actorId = event["actor_id"];
  const entityId = event["entity_id"];
  const data = event["data"];
  if (typeof actorId !== "string" || actorId.length === 0) return null;
  if (typeof entityId !== "string" || entityId.length === 0) return null;
  if (typeof data !== "object" || data === null) return null;
  const envelope = data as Record<string, unknown>;
  const channel = envelope["channel"];
  if (typeof channel !== "string" || channel.length === 0) return null;
  if (!("value" in envelope)) return null;
  return { actorId, entityId, channel, value: envelope["value"] };
}
