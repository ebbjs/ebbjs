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
 * Network model:
 *   - Outgoing: `POST /sync/presence` with `{entity_id, data}` body
 *   - Incoming: opens a dedicated SSE stream filtered to `presence`
 *     events (the existing `subscribe` for action events is kept
 *     separate). Two SSE connections per client is wasteful but
 *     simpler than coordinating a shared connection. For a demo with
 *     2 actors it's fine; if this becomes a hot spot, the next
 *     iteration can multiplex over a single stream.
 */

import type { SyncClient } from "../sync/client";
import { openSSEStream } from "../sync/sse";

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
 * Owns the presence map for the current client. Subscribes to a
 * dedicated SSE stream filtered to `presence` events; debounces local
 * cursor sends to the server.
 *
 * One instance per `SyncClient`. Reach it via
 * `client.presence` (exposed by `createClient`).
 */
export class PresenceManager {
  private readonly client: SyncClient;
  private readonly localActorId: string;

  /** Keyed by `${entityId}::${actorId}` for fast lookup. */
  private readonly map = new Map<string, PresenceEntry>();
  private readonly listeners = new Set<() => void>();
  private pending: ReturnType<typeof setTimeout> | null = null;
  private unsubscribed = false;
  private streamUnsub: (() => void) | null = null;

  constructor(client: SyncClient) {
    this.client = client;
    this.localActorId = client.actorId;
    // Don't auto-open the SSE stream here — the SyncClient tests
    // construct clients without a real network, and a stray fetch
    // would log unhandled rejections. The stream is opened lazily on
    // the first `start()` call (typically from Editor.tsx after
    // bootstrap completes) or the first `setLocalCursor()`.
  }

  /**
   * Open the SSE stream and start receiving remote presence events.
   * Idempotent — safe to call multiple times. Typically called from
   * the editor once bootstrap is done.
   */
  start(): void {
    if (this.unsubscribed) return;
    if (this.streamUnsub) return;
    void this.openStream();
  }

  /**
   * Detach the SSE listener and flush any pending send. Call from
   * `SyncClient.close()` paths.
   */
  dispose(): void {
    if (this.unsubscribed) return;
    this.unsubscribed = true;
    if (this.pending !== null) {
      clearTimeout(this.pending);
      this.pending = null;
    }
    this.streamUnsub?.();
    this.streamUnsub = null;
    this.listeners.clear();
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
   * Read the current presence map for an entity. Excludes the local
   * actor (you wouldn't want to render your own cursor back to
   * yourself).
   *
   * Returns a fresh Map each call so callers can't mutate our state.
   */
  forEntity(entityId: string): Map<string, PresenceEntry> {
    const out = new Map<string, PresenceEntry>();
    for (const [key, entry] of this.map) {
      if (key.startsWith(`${entityId}::`) && entry.actorId !== this.localActorId) {
        out.set(entry.actorId, entry);
      }
    }
    return out;
  }

  /**
   * Test seam: inject a presence payload directly into the map as if
   * it had arrived over the SSE stream. Production code should never
   * call this; tests use it to avoid the async dance of opening an
   * EventSource just to assert "if X arrives, the map contains X".
   */
  __testInjectEntry__(entry: PresenceEntry): void {
    if (entry.actorId === this.localActorId) return;
    const key = mapKey(entry.entityId, entry.actorId);
    this.map.set(key, entry);
    this.notify();
  }

  /**
   * Subscribe to map changes. Fires whenever a remote presence event
   * is received.
   */
  onUpdate(callback: () => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async openStream(): Promise<void> {
    // We don't know which group(s) to subscribe to at construction
    // time — groups are configured later via `subscribe()` in Editor.
    // For the demo there's exactly one group (`grp_demo`), so we pass
    // it explicitly via a query param when the caller adds us to a
    // group. We start by subscribing to ALL groups we know about
    // (currently none) — the demo wires `subscribe` after this and
    // we piggyback via the same query.
    //
    // For simplicity right now: open an EventSource filtered to
    // presence events. The server doesn't filter by group on the
    // presence endpoint, so this just dumps every presence event
    // for any group the actor belongs to. Good enough for a 2-actor
    // demo.
    try {
      // The actor must be a member of at least one group for the SSE
      // endpoint to open. If not yet, wait briefly and retry.
      const groups = await this.knownGroups();
      if (groups.length === 0) {
        setTimeout(() => {
          if (!this.unsubscribed) void this.openStream();
        }, 500);
        return;
      }

      const sub = openSSEStream({
        serverUrl: this.client.serverUrl,
        groupIds: groups,
        cursor: 0,
        actorId: this.localActorId,
      });

      (async () => {
        for await (const event of sub.events()) {
          if (this.unsubscribed) break;
          if (event.type !== "presence") continue;
          const entry = serverEventToEntry(event.presence);
          if (!entry) continue;
          const key = mapKey(entry.entityId, entry.actorId);
          this.map.set(key, entry);
          this.notify();
        }
      })().catch(() => {
        // SSE failure — retry after a short delay.
        if (!this.unsubscribed) {
          setTimeout(() => {
            if (!this.unsubscribed) void this.openStream();
          }, 2000);
        }
      });

      this.streamUnsub = () => sub.close();
    } catch {
      // Initial open failed — retry.
      if (!this.unsubscribed) {
        setTimeout(() => {
          if (!this.unsubscribed) void this.openStream();
        }, 2000);
      }
    }
  }

  /** Read the actor's known groups from a handshake. */
  private async knownGroups(): Promise<readonly string[]> {
    try {
      const res = await this.client["fetchImpl"](`${this.client.serverUrl}/sync/handshake`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-ebb-actor-id": this.localActorId,
        },
        body: "{}",
      });
      if (!res.ok) return [];
      const json = (await res.json()) as { groups?: Array<{ id: string }> };
      return (json.groups ?? []).map((g) => g.id);
    } catch {
      return [];
    }
  }

  private notify(): void {
    for (const cb of this.listeners) {
      try {
        cb();
      } catch {
        // Don't let one listener's error break the others.
      }
    }
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
