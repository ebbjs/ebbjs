/**
 * Ephemeral presence — cursors and selections from other actors on the
 * same doc. The server's `/sync/presence` endpoint broadcasts whatever
 * payload we POST to every SSE subscriber for the same entity.
 *
 * This module is transport-only (no CodeMirror dependency). The CM6
 * cursor widget/selection decoration lives in
 * `@ebbjs/codemirror/src/presence/cursor-decoration` and reads the
 * same `forEntity()` map.
 *
 * Shape:
 *   - `setLocalCursor(entityId, cursor)` → POSTs to `/sync/presence`,
 *     debounced to avoid spamming on every keystroke
 *   - `forEntity(entityId)` → Map<actorId, Cursor> for the entity,
 *     excluding the local actor
 *   - `onUpdate(cb)` → fires whenever the map changes (local send or
 *     remote event)
 *
 * ## Scope: the groups you subscribe to
 *
 * Presence rides the client's live SSE stream. `SyncClient` folds every
 * `presence` packet from that stream into its map before the subscriber's
 * `onEvent` sees the same packet, so presence covers exactly **the groups
 * you `subscribe()` to**. Earlier versions opened a stream of their own and
 * covered every group the actor's handshake returned; a second connection
 * made the server fan each packet out to the client twice and pushed action
 * batches into a stream that discarded them.
 *
 * While disconnected the peer set is unknown, so closing the live stream
 * clears the map: peers reappear only when they send presence again.
 *
 * Network model:
 *   - Outgoing: `POST /sync/presence` with `{entity_id, data}` body
 *   - Incoming: `presence` events on the `/sync/live` stream that
 *     `subscribe()` already holds open
 */

import type { SyncClient } from "../sync/client";

/** A local cursor/selection position expressed in run-id coordinates. */
export interface CursorPresence {
  /** Run id at the selection anchor. */
  readonly anchorId: string;
  /** Offset within the anchor run (0-based). */
  readonly anchorOffset: number;
  /** Run id at the selection head. Equal to anchorId if no selection. */
  readonly headId: string;
  /** Offset within the head run (0-based). */
  readonly headOffset: number;
}

/** A presence entry for one actor on one entity. */
export interface PresenceEntry {
  /** The actor this entry is for. */
  readonly actorId: string;
  /** The entity (document) the cursor/selection is on. */
  readonly entityId: string;
  /** The cursor/selection position in run-id coordinates. */
  readonly cursor: CursorPresence;
}

const SEND_DEBOUNCE_MS = 100;

/**
 * The peers observed on the live stream. `SyncClient` owns one instance per
 * client and feeds it from `handleSSEEvent`, so the map's lifetime is the
 * connection's lifetime.
 */
export interface PresenceMap {
  /**
   * Fold one server `presence` packet into the map. The local actor and
   * payload shapes we cannot read are ignored.
   */
  ingest(payload: unknown): void;
  /**
   * Read the entries for one entity, keyed by actor. Excludes the local
   * actor (you would not want to render your own cursor back to yourself).
   */
  forEntity(entityId: string): Map<string, PresenceEntry>;
  /** Fires whenever the map changes. Returns an unsubscribe function. */
  onUpdate(callback: () => void): () => void;
  /** Drop every peer: the connection they were observed on is gone. */
  clear(): void;
}

export function createPresenceMap(localActorId: string): PresenceMap {
  /** Keyed by `${entityId}::${actorId}` for fast lookup. */
  const entries = new Map<string, PresenceEntry>();
  const listeners = new Set<() => void>();

  const notify = (): void => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // Don't let one listener's error break the others.
      }
    }
  };

  return {
    ingest(payload) {
      const entry = serverEventToEntry(payload);
      if (entry === null || entry.actorId === localActorId) return;
      entries.set(mapKey(entry.entityId, entry.actorId), entry);
      notify();
    },
    forEntity(entityId) {
      const out = new Map<string, PresenceEntry>();
      for (const entry of entries.values()) {
        if (entry.entityId === entityId && entry.actorId !== localActorId) {
          out.set(entry.actorId, entry);
        }
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
      if (entries.size === 0) return;
      entries.clear();
      notify();
    },
  };
}

/**
 * The client's presence surface: debounced local cursor sends plus reads
 * over the map `SyncClient` feeds from its live stream.
 */
export class PresenceManager {
  private readonly client: SyncClient;
  private readonly localActorId: string;
  private readonly map: PresenceMap;
  private pending: ReturnType<typeof setTimeout> | null = null;

  constructor(client: SyncClient, map: PresenceMap) {
    this.client = client;
    this.localActorId = client.actorId;
    this.map = map;
  }

  /**
   * @deprecated Presence needs no start-up: it rides the live stream that
   * `subscribe()` opens. This is a no-op and is removed in #677.
   */
  start(): void {}

  /**
   * @deprecated The connection owns the presence map, so `SyncClient.close()`
   * is the teardown path. This only cancels a debounced local send, and is
   * removed in #677.
   */
  dispose(): void {
    if (this.pending === null) return;
    clearTimeout(this.pending);
    this.pending = null;
  }

  /**
   * Update the local cursor/selection. Debounced — repeated calls
   * within `SEND_DEBOUNCE_MS` collapse to a single POST.
   */
  setLocalCursor(entityId: string, cursor: CursorPresence): void {
    if (this.pending !== null) clearTimeout(this.pending);
    this.pending = setTimeout(() => {
      this.pending = null;
      void this.sendNow(entityId, cursor).catch(() => {
        // Send failures are non-fatal — next cursor move will retry.
      });
    }, SEND_DEBOUNCE_MS);
  }

  /**
   * Force an immediate POST (bypassing the debounce). Mostly useful for
   * tests; production code should use `setLocalCursor` so rapid moves
   * don't spam the server.
   */
  async sendNow(entityId: string, cursor: CursorPresence): Promise<void> {
    const url = `${this.client.serverUrl}/sync/presence`;
    const body = JSON.stringify({ entity_id: entityId, data: cursor });
    const res = await this.client["fetchImpl"](url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-ebb-actor-id": this.localActorId,
      },
      body,
    });
    if (!res.ok && res.status !== 204) {
      throw new Error(`presence send failed: ${res.status} ${await res.text().catch(() => "")}`);
    }
  }

  /**
   * Read the current presence map for an entity. Returns a fresh Map each
   * call so callers can't mutate our state.
   */
  forEntity(entityId: string): Map<string, PresenceEntry> {
    return this.map.forEntity(entityId);
  }

  /**
   * Subscribe to map changes. Fires whenever a remote presence event is
   * received and when the map is cleared on disconnect.
   */
  onUpdate(callback: () => void): () => void {
    return this.map.onUpdate(callback);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapKey(entityId: string, actorId: string): string {
  return `${entityId}::${actorId}`;
}

/**
 * The server's `/sync/presence` endpoint forwards a generic JSON
 * payload. We expect the payload to look like `CursorPresence` (the
 * shape we POST), but treat unknown shapes as missing fields rather
 * than throwing — the demo is the only caller and we want a flaky
 * payload to degrade gracefully, not break the map.
 */
function serverEventToEntry(presence: unknown): PresenceEntry | null {
  if (typeof presence !== "object" || presence === null) return null;
  const e = presence as Record<string, unknown>;
  const actorId = typeof e["actor_id"] === "string" ? e["actor_id"] : null;
  const entityId = typeof e["entity_id"] === "string" ? e["entity_id"] : null;
  const data =
    typeof e["data"] === "object" && e["data"] !== null
      ? (e["data"] as Record<string, unknown>)
      : null;
  if (!actorId || !entityId || !data) return null;
  const cursor = extractCursor(data);
  if (!cursor) return null;
  return { actorId, entityId, cursor };
}

function extractCursor(data: Record<string, unknown>): CursorPresence | null {
  const anchorId = typeof data["anchorId"] === "string" ? data["anchorId"] : null;
  const headId = typeof data["headId"] === "string" ? data["headId"] : null;
  const anchorOffset = typeof data["anchorOffset"] === "number" ? data["anchorOffset"] : null;
  const headOffset = typeof data["headOffset"] === "number" ? data["headOffset"] : null;
  if (!anchorId || !headId || anchorOffset === null || headOffset === null) {
    return null;
  }
  return { anchorId, anchorOffset, headOffset, headId };
}
