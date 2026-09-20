import { Type, Static } from "@sinclair/typebox";
export type { Action } from "@ebbjs/core";
// Bring `Action` into local scope so the interfaces below can use it.
type Action = import("@ebbjs/core").Action;

/**
 * Wire-level types for the ebb sync protocol.
 *
 * These mirror the Elixir server's router schemas in
 * `ebb_server/lib/ebb_server/sync/router.ex`. They describe the *shape* of
 * JSON payloads exchanged over HTTP — not the Action/Update structures used
 * at runtime by the storage adapter (see `@ebbjs/core/types/action.ts`).
 *
 * The server returns HLCs as JSON integers. Packed HLCs are 64-bit
 * (`(logical_time << 16) | counter`) and therefore exceed `Number.MAX_SAFE_INTEGER`
 * (~9e15) for any timestamp after 1970-01-15. JSON serialization truncates
 * these to doubles, so the client treats incoming `hlc` as `number | string`
 * and relies on the storage adapter's lexicographic `update_id` tiebreaker
 * to keep merge semantics deterministic when precision is lost.
 */

/**
 * Wire schema for one entry of `handshake().groups[]`.
 *
 * The server returns snake_case keys. The client converts these to the
 * camelCase {@link GroupInfo} shape on its public surface.
 */
export const GroupInfoSchema = Type.Object({
  id: Type.String(),
  permissions: Type.Array(Type.String()),
  cursor_valid: Type.Boolean(),
  reason: Type.Union([Type.String(), Type.Null()]),
  cursor: Type.Number({ minimum: 0 }),
});

/** Public-facing group descriptor (camelCase). */
export interface GroupInfo {
  id: string;
  permissions: readonly string[];
  /** `false` when the server has already pruned past the client's cursor. */
  cursorValid: boolean;
  /** Reason the cursor was invalidated (e.g., `"behind_watermark"`). */
  reason: string | null;
  /** The server-authoritative cursor to resume from. */
  cursor: number;
}

/** Response shape for `POST /sync/handshake`. */
export const HandshakeResponseSchema = Type.Object({
  actor_id: Type.String(),
  groups: Type.Array(GroupInfoSchema),
});
export type HandshakeResponse = Static<typeof HandshakeResponseSchema>;

/** Request body for `POST /sync/handshake`. */
export interface HandshakeRequest {
  /** Optional map of group_id → GSN cursor; server validates against watermark. */
  cursors?: Record<string, number>;
  /** Optional schema version; opaque to the server today. */
  schema_version?: number;
}

/**
 * Response shape for `GET /sync/groups/:group_id?offset=N`.
 *
 * Actions are returned in JSON body, pagination metadata in response headers.
 */
export interface CatchUpResponse {
  actions: readonly Action[];
  /** Next GSN to request, or `null` when fully caught up. */
  nextOffset: number | null;
  /** `true` when the server has no more actions past this page. */
  upToDate: boolean;
}

/** Per-action rejection from `POST /sync/actions`. */
export const RejectionSchema = Type.Object({
  id: Type.String(),
  reason: Type.String(),
  details: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});
export type Rejection = Static<typeof RejectionSchema>;

/** Response shape for `POST /sync/actions`. */
export interface WriteResponse {
  rejected: readonly Rejection[];
}

/** Response shape for `GET /entities/:id`. */
export const EntityResponseSchema = Type.Object({
  id: Type.String(),
  type: Type.String(),
  data: Type.Object({ fields: Type.Record(Type.String(), Type.Unknown()) }),
  created_hlc: Type.Union([Type.Number(), Type.String()]),
  updated_hlc: Type.Union([Type.Number(), Type.String()]),
  deleted_hlc: Type.Union([Type.Number(), Type.String(), Type.Null()]),
  last_gsn: Type.Number(),
});
export type EntityResponse = Static<typeof EntityResponseSchema>;

/** Response shape for `POST /entities/query`. */
export type EntityQueryResponse = readonly EntityResponse[];

/**
 * Discriminated union of all events the SSE stream can emit.
 *
 * - `data` — server pushed an Action; client appends to storage
 * - `control` — server sent a control event (today: stale cursor)
 * - `presence` — server forwarded another actor's presence payload
 */
export type SSEEvent =
  | { type: "data"; action: Action }
  | { type: "control"; control: ControlEvent }
  | { type: "presence"; presence: PresenceEvent };

/**
 * Control event payload. Today the server only emits one control event:
 * `{ reconnect: true, reason: "behind_watermark", catchUpFrom: <gsn> }`.
 * Future events may carry `group` / `nextOffset`.
 */
export type ControlEvent = {
  reconnect?: boolean;
  reason?: string;
  catchUpFrom?: number;
  group?: string;
  nextOffset?: number;
  [key: string]: unknown;
};

/** Presence event payload as forwarded by the server. */
export interface PresenceEvent {
  actor_id: string;
  entity_id: string;
  data: Record<string, unknown>;
}

/** Options for `createClient`. */
export interface SyncClientOptions {
  /** Base URL of the ebb server (no trailing slash). */
  serverUrl: string;
  /** Actor identity for bypass auth (`x-ebb-actor-id`). */
  actorId: string;
  /** Storage adapter for received actions. Defaults to in-memory adapter. */
  storage?: import("@ebbjs/storage").StorageAdapter;
  /** Custom fetch implementation (for tests / non-Node runtimes). */
  fetchImpl?: typeof fetch;
  /** Initial reconnect backoff in ms. Defaults to 1000. */
  reconnectInitialMs?: number;
  /** Maximum reconnect backoff in ms. Defaults to 60000. */
  reconnectMaxMs?: number;
}
