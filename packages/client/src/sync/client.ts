/**
 * SyncClient — HTTP + SSE client for the ebb sync server.
 *
 * Responsibilities:
 * - `handshake()` — exchange actor identity and group membership
 * - `catchUp()` — paginated backfill of missed Actions
 * - `subscribe()` — open the SSE live stream and dispatch events to storage
 * - `write()` — submit locally-produced Actions
 * - `getEntity()` / `queryEntities()` — read materialized entities
 * - Manage connection state (`connecting` → `live` → `reconnecting` → `offline`)
 *
 * ## Usage
 *
 * ```ts
 * const client = createClient({ serverUrl, actorId });
 * const { groups } = await client.handshake();
 * for (const group of groups) {
 *   await client.catchUp(group.id, group.cursor);
 * }
 * const unsubscribe = client.subscribe(groups.map(g => g.id), group.cursor, (event) => {
 *   if (event.type === "data") applyToLocalState(event.action);
 * });
 * ```
 */

import { encodeSync, type Action, type Entity } from "@ebbjs/core";
import { createMemoryAdapter } from "@ebbjs/storage";
import type { StorageAdapter } from "@ebbjs/storage";

import { ConnectionStateMachine, type ConnectionState } from "./connection-state";
import { applyAction } from "./storage";
import { openSSEStream, type SSESubscription } from "./sse";
import type {
  CatchUpResponse,
  ControlEvent,
  EntityQueryResponse,
  EntityResponse,
  GroupInfo,
  HandshakeRequest,
  HandshakeResponse,
  Rejection,
  SSEEvent,
  SyncClientOptions,
  WriteResponse,
} from "./types";

const DEFAULT_RECONNECT_INITIAL_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 60_000;
const MAX_RECONNECT_ATTEMPTS = 10;

export class SyncClient {
  readonly serverUrl: string;
  readonly actorId: string;
  readonly storage: StorageAdapter;
  private readonly fetchImpl: typeof fetch;
  private readonly reconnectInitialMs: number;
  private readonly reconnectMaxMs: number;

  private readonly stateMachine = new ConnectionStateMachine();
  /** Active live subscriptions keyed by group-list hash. We allow at most one. */
  private activeSub: ActiveSubscription | null = null;
  /** Reconnect bookkeeping. */
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Latest handshake result, used by reconnect to re-establish subscriptions. */
  private lastHandshake: HandshakeResult | null = null;
  /** Latest per-group cursors, refreshed by `catchUp` and SSE receipt. */
  private groupCursors: Map<string, number> = new Map();

  constructor(opts: SyncClientOptions) {
    this.serverUrl = opts.serverUrl.replace(/\/$/, "");
    this.actorId = opts.actorId;
    this.storage = opts.storage ?? createMemoryAdapter();
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.reconnectInitialMs = opts.reconnectInitialMs ?? DEFAULT_RECONNECT_INITIAL_MS;
    this.reconnectMaxMs = opts.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /** Current connection state. Subscribe to changes via {@link onStateChange}. */
  get state(): ConnectionState {
    return this.stateMachine.state;
  }

  /** Subscribe to connection state transitions. Returns an unsubscribe fn. */
  onStateChange(cb: (state: ConnectionState, prev: ConnectionState) => void): () => void {
    return this.stateMachine.onChange(cb);
  }

  /**
   * Open the SSE live stream for the given groups.
   *
   * Returns an `unsubscribe` function that closes the stream. Internally
   * maintains connection state and reconnects on transient failures using
   * exponential backoff (capped at `reconnectMaxMs`).
   *
   * The `onEvent` callback fires for every data / control / presence event
   * the server emits. Data events are also appended to `storage.actions` so
   * the storage adapter stays in sync; callers that don't want this can
   * pass a different `storage` or use the raw event handler.
   */
  subscribe(
    groupIds: readonly string[],
    fromGsn: number,
    onEvent: (event: SSEEvent) => void,
  ): () => void {
    if (this.activeSub) {
      throw new Error(
        "subscribe: an active subscription already exists; call its unsubscribe first",
      );
    }

    const groups = [...groupIds];
    const initialCursor = fromGsn;
    const sub: ActiveSubscription = {
      groupIds: groups,
      onEvent,
      cancelled: false,
      stream: null,
      loopPromise: null,
      fromGsn: initialCursor,
    };
    this.activeSub = sub;

    // Transition to `connecting` if this is the first attempt.
    if (this.stateMachine.state === "live") {
      // Already live — leave it (e.g., re-subscribe during an existing live state).
    } else if (this.stateMachine.state !== "connecting") {
      this.stateMachine.transition("connecting");
    }

    sub.loopPromise = this.runSubscriptionLoop(sub);
    return () => this.cancelSubscription(sub);
  }

  /**
   * `POST /sync/handshake` — exchange identity and group membership.
   *
   * On success, the per-group cursors returned by the server are cached so
   * subsequent `catchUp` / `subscribe` calls can pick up where we left off.
   */
  async handshake(opts: HandshakeRequest = {}): Promise<HandshakeResult> {
    const path = "/sync/handshake";
    const url = `${this.serverUrl}${path}`;
    const headers = {
      "Content-Type": "application/json",
      "x-ebb-actor-id": this.actorId,
    };
    const body = JSON.stringify({
      cursors: opts.cursors ?? {},
      schema_version: opts.schema_version,
    });

    const response = await this.fetchImpl(url, {
      method: "POST",
      headers,
      body,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`handshake failed: ${response.status} ${text}`);
    }

    const data = (await response.json()) as HandshakeResponse;
    const result: HandshakeResult = {
      actorId: data.actor_id,
      groups: data.groups.map(toGroupInfo),
    };

    // Refresh the cursor cache from the server's authoritative cursors.
    this.groupCursors.clear();
    for (const g of result.groups) {
      this.groupCursors.set(g.id, g.cursor);
    }
    this.lastHandshake = result;
    return result;
  }

  /**
   * `GET /sync/groups/:group_id?offset=N` — paginated catch-up of missed Actions.
   *
   * If `fromGsn` is omitted, uses the last cached cursor for the group
   * (populated by `handshake` or a prior `subscribe` receipt).
   */
  async catchUp(groupId: string, fromGsn?: number): Promise<CatchUpResponse> {
    const offset = fromGsn ?? (await this.storage.cursors.get(groupId)) ?? 0;
    const url = `${this.serverUrl}/sync/groups/${encodeURIComponent(groupId)}?offset=${offset}`;
    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: {
        "x-ebb-actor-id": this.actorId,
      },
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      if (response.status === 403) {
        throw new Error(`catchUp: not a member of group ${groupId}`);
      }
      throw new Error(`catchUp failed: ${response.status} ${text}`);
    }

    const actions = (await response.json()) as CatchUpResponse["actions"];
    const nextOffsetHeader = response.headers.get("stream-next-offset");
    const upToDateHeader = response.headers.get("stream-up-to-date");
    const nextOffset = nextOffsetHeader !== null ? Number(nextOffsetHeader) : null;
    const upToDate = upToDateHeader === "true" || nextOffset === null;

    // Apply every action to local storage. We do this inline (rather than
    // waiting for `subscribe`) because catch-up happens before subscribing.
    let highestGsn = 0;
    for (const action of actions) {
      await applyAction(this.storage, action, groupId);
      if (action.gsn > highestGsn) highestGsn = action.gsn;
    }
    if (highestGsn > 0) {
      const prev = this.groupCursors.get(groupId) ?? 0;
      if (highestGsn > prev) {
        this.groupCursors.set(groupId, highestGsn);
      }
    }

    return { actions, nextOffset, upToDate };
  }

  /**
   * `POST /sync/actions` — submit a batch of locally-produced Actions.
   *
   * The server may reject some (permissions, HLC drift, dedup). Returns the
   * rejected list; the caller decides how to handle the failure (rollback,
   * retry, surface to UI).
   */
  async write(actions: readonly Action[]): Promise<WriteResponse> {
    if (actions.length === 0) {
      return { rejected: [] };
    }
    const body = encodeSync({ actions });
    const response = await this.fetchImpl(`${this.serverUrl}/sync/actions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/msgpack",
        "x-ebb-actor-id": this.actorId,
      },
      body: body as BodyInit,
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`write failed: ${response.status} ${text}`);
    }

    let parsed: { rejected?: Rejection[] } = {};
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`write: server returned non-JSON response: ${text}`);
    }

    const rejected = parsed.rejected ?? [];
    return { rejected };
  }

  /** `GET /entities/:id?actor_id=...` — read a materialized entity. */
  async getEntity(id: string): Promise<EntityResponse | null> {
    const url = `${this.serverUrl}/entities/${encodeURIComponent(id)}?actor_id=${encodeURIComponent(this.actorId)}`;
    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: {
        "x-ebb-actor-id": this.actorId,
      },
    });

    if (response.status === 404) return null;
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`getEntity failed: ${response.status} ${text}`);
    }
    return (await response.json()) as EntityResponse;
  }

  /** `POST /entities/query` — query entities by type. */
  async queryEntities(type: string, opts: QueryOptions = {}): Promise<EntityQueryResponse> {
    const response = await this.fetchImpl(`${this.serverUrl}/entities/query`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-ebb-actor-id": this.actorId,
      },
      body: JSON.stringify({
        type,
        filter: opts.filter,
        limit: opts.limit,
        offset: opts.offset,
      }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`queryEntities failed: ${response.status} ${text}`);
    }
    return (await response.json()) as EntityQueryResponse;
  }

  /**
   * Read a materialized entity from the local storage adapter.
   *
   * This is the read path the storage layer exposes — for client-driven
   * reads (e.g., rendering), prefer this over `getEntity` to avoid a
   * network round trip.
   */
  async readLocalEntity(id: string): Promise<Entity | null> {
    return this.storage.entities.get(id);
  }

  /**
   * Tear down all subscriptions and timers. After `close()` the client is
   * unusable; create a new one with `createClient`.
   */
  close(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.activeSub) {
      this.cancelSubscription(this.activeSub);
    }
    this.stateMachine.transition("offline");
  }

  // -------------------------------------------------------------------------
  // Subscription loop & reconnect
  // -------------------------------------------------------------------------

  private async runSubscriptionLoop(sub: ActiveSubscription): Promise<void> {
    while (!sub.cancelled) {
      const cursor = await this.computeResumeCursor(sub);
      try {
        const stream = openSSEStream({
          serverUrl: this.serverUrl,
          groupIds: sub.groupIds,
          cursor,
          headers: { actorId: this.actorId },
          fetchImpl: this.fetchImpl,
        });
        sub.stream = stream;

        // Reset backoff on successful open.
        this.reconnectAttempt = 0;
        this.stateMachine.transition("live");

        for await (const event of stream.events()) {
          if (sub.cancelled) break;
          await this.handleSSEEvent(event, sub);
        }

        // Stream ended without being cancelled → treat as a transient drop.
        if (!sub.cancelled) {
          this.scheduleReconnect(sub, "stream closed by server");
        }
      } catch (err) {
        if (sub.cancelled) return;
        this.scheduleReconnect(sub, errorMessage(err));
      } finally {
        if (sub.stream) {
          try {
            sub.stream.close();
          } catch {
            // ignore
          }
          sub.stream = null;
        }
      }
    }
  }

  private async handleSSEEvent(event: SSEEvent, sub: ActiveSubscription): Promise<void> {
    // All data events are appended to storage so dirty-tracker / materialization
    // works for callers (e.g., the causal tree in slice 2).
    if (event.type === "data") {
      // The server emits one SSE event per Action (push_action is per-action
      // in the GenServer cast), so each event carries exactly one action. Use
      // any group id from the subscription; storage cursors aren't
      // group-scoped but the SSE event doesn't carry the group id, so we
      // pick the first subscribed group.
      const groupId = sub.groupIds[0];
      await applyAction(this.storage, event.action, groupId);
      if (event.action.gsn > 0) {
        for (const gid of sub.groupIds) {
          const prev = this.groupCursors.get(gid) ?? 0;
          if (event.action.gsn > prev) this.groupCursors.set(gid, event.action.gsn);
        }
      }
    } else if (event.type === "control") {
      this.handleControlEvent(event.control, sub);
    }

    try {
      sub.onEvent(event);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[SyncClient] onEvent handler threw:", err);
    }
  }

  private handleControlEvent(control: ControlEvent, sub: ActiveSubscription): void {
    if (control.reconnect && typeof control.catchUpFrom === "number") {
      // Server told us our cursor is stale — close the current stream and
      // re-open after catching up.
      const from = control.catchUpFrom;
      // eslint-disable-next-line no-console
      console.warn(`[SyncClient] server reports stale cursor; catching up from GSN ${from}`);
      for (const gid of sub.groupIds) {
        this.groupCursors.set(gid, from);
      }
      // Force a stream restart by closing the current one; the loop will
      // pick the new cursor up on the next iteration.
      if (sub.stream) {
        try {
          sub.stream.close();
        } catch {
          // ignore
        }
      }
    }
  }

  private async computeResumeCursor(sub: ActiveSubscription): Promise<number> {
    // Prefer the per-group cursor cache (most recent from handshake /
    // catch-up / SSE receipt). Fall back to the subscription's initial
    // `fromGsn`.
    let max = 0;
    for (const gid of sub.groupIds) {
      const c = this.groupCursors.get(gid);
      if (c !== undefined && c > max) max = c;
    }
    if (max > 0) return max;
    return sub.fromGsn;
  }

  private scheduleReconnect(sub: ActiveSubscription, reason: string): void {
    if (sub.cancelled) return;
    if (this.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      // eslint-disable-next-line no-console
      console.error(`[SyncClient] giving up after ${MAX_RECONNECT_ATTEMPTS} reconnect attempts`);
      this.stateMachine.transition("offline");
      return;
    }
    const delay = Math.min(
      this.reconnectMaxMs,
      this.reconnectInitialMs * 2 ** this.reconnectAttempt,
    );
    this.reconnectAttempt += 1;
    this.stateMachine.transition("reconnecting");
    // eslint-disable-next-line no-console
    console.warn(
      `[SyncClient] SSE ${reason}; reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`,
    );
    // Close the current stream so the for-await loop exits and the outer
    // `while (!sub.cancelled)` re-enters to open a fresh stream.
    if (sub.stream) {
      try {
        sub.stream.close();
      } catch {
        // ignore
      }
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (sub.cancelled) return;
      this.stateMachine.transition("connecting");
    }, delay);
  }

  private cancelSubscription(sub: ActiveSubscription): void {
    sub.cancelled = true;
    if (sub.stream) {
      try {
        sub.stream.close();
      } catch {
        // ignore
      }
      sub.stream = null;
    }
    if (sub === this.activeSub) {
      this.activeSub = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stateMachine.transition("offline");
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ActiveSubscription {
  groupIds: string[];
  onEvent: (event: SSEEvent) => void;
  cancelled: boolean;
  stream: SSESubscription | null;
  loopPromise: Promise<void> | null;
  fromGsn: number;
}

const toGroupInfo = (raw: HandshakeResponse["groups"][number]): GroupInfo => ({
  id: raw.id,
  permissions: raw.permissions,
  cursorValid: raw.cursor_valid,
  reason: raw.reason ?? null,
  cursor: raw.cursor,
});

const errorMessage = (err: unknown): string => {
  if (err instanceof Error) return err.message;
  return String(err);
};

/** Returned by {@link SyncClient.handshake}. */
export interface HandshakeResult {
  actorId: string;
  groups: readonly GroupInfo[];
}

/** Options for {@link SyncClient.queryEntities}. */
export interface QueryOptions {
  filter?: Record<string, unknown>;
  limit?: number;
  offset?: number;
}

/**
 * Factory for {@link SyncClient}. Prefer this over `new SyncClient(...)`
 * so the import surface stays tidy.
 */
export function createClient(opts: SyncClientOptions): SyncClient {
  return new SyncClient(opts);
}
