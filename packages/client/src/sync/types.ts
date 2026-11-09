import { Type, Static } from "@sinclair/typebox";
export type { Action } from "@ebbjs/core";
// Bring `Action` into local scope so the interfaces below can use it.
type Action = import("@ebbjs/core").Action;
import type { ModelDef } from "@ebbjs/schema";
import type { RelationshipDef } from "@ebbjs/schema";
import type { Schema } from "@ebbjs/schema";
import type { AnyActionDef } from "../schema/action";
import type { TSchema } from "@sinclair/typebox/type";

type AnyModelDef = ModelDef<Record<string, TSchema>>;
type AnyRelationshipDef = RelationshipDef<AnyModelDef, AnyModelDef>;
type AnySchema = Schema<
  Record<string, AnyModelDef>,
  Record<string, AnyRelationshipDef> | undefined
>;

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
  /**
   * App scope as the projected truthy keys. Optional because older
   * servers do not send it; absent means unscoped (every app).
   */
  apps: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
  permissions: Type.Array(Type.String()),
  cursor_valid: Type.Boolean(),
  reason: Type.Union([Type.String(), Type.Null()]),
  cursor: Type.Number({ minimum: 0 }),
});

/** Public-facing group descriptor (camelCase). */
export interface GroupInfo {
  id: string;
  /** App ids the group is in scope for; `null` means unscoped (every app). */
  apps: readonly string[] | null;
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
  /**
   * Optional floor of acceptable server-compatibility versions.
   * When the server's stored schema is older than this, the server
   * can reject the handshake with an "update required" error.
   * When omitted, the client only advertises `schema_version`.
   */
  min_supported_version?: number;
  /**
   * Optional content hash of the composed schema. The server uses
   * this to detect drift between the client's view and any stored
   * schema. Derived from `schema` when not set explicitly.
   */
  schema_hash?: string;
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

export { RejectionSchema, type Rejection, type WriteResponse } from "@ebbjs/write";

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

/**
 * Response shape for `GET /sync/groups/:group_id/entities`.
 *
 * A page of the group's current row set — the `group` row, its `groupMember`
 * rows, its live `entityGroup` rows, and the entities those name — taken at
 * `watermark`, plus the opaque token for the next page. `cursor` is `null`
 * on the last page. Partial-index keyset pagination on the membership row id,
 * so a page is not an offset into a shifting list. See
 * `docs/research/476-group-scoped-listing.md` §5.
 */
export const GroupListingResponseSchema = Type.Object({
  group_id: Type.String(),
  watermark: Type.Number(),
  cursor: Type.Union([Type.String(), Type.Null()]),
  has_more: Type.Boolean(),
  entities: Type.Array(EntityResponseSchema),
});
export type GroupListingResponse = Static<typeof GroupListingResponseSchema>;

/** Response shape for `POST /entities/query`. */
export type EntityQueryResponse = readonly EntityResponse[];

/**
 * Discriminated union of all events the SSE stream can emit.
 *
 * - `data` — server pushed an Action; client appends to storage
 * - `control` — server sent a control event (stale cursor, or a live
 *   membership change)
 * - `presence` — server forwarded another actor's presence payload
 */
export type SSEEvent =
  | { type: "data"; action: Action }
  | { type: "control"; control: ControlEvent }
  | { type: "presence"; presence: PresenceEvent };

/**
 * Control event payload. The server emits two:
 *
 * - the stale-cursor restart, `{ reconnect: true, reason: "behind_watermark",
 *   catchUpFrom: <gsn> }`, which rewrites the client's cursors and closes the
 *   stream so reconnect catches up from the server's point;
 * - the membership wake-up (#734), `{ groups_changed: true, reason:
 *   "membership" }`, which carries no delta: the client re-handshakes for the
 *   authoritative group set and reconciles its live subscription.
 *
 * Keys are read as they arrive on the wire; the SSE parser does not
 * transform them, so `groups_changed` stays snake_case here and in
 * {@link ControlEvent}. Future events may carry `group` / `nextOffset`.
 * Unknown keys are dropped at parse time.
 */
export const ControlEventSchema = Type.Object({
  reconnect: Type.Optional(Type.Boolean()),
  reason: Type.Optional(Type.String()),
  catchUpFrom: Type.Optional(Type.Number()),
  /** The actor's group set changed; re-handshake and reconcile (#734). */
  groups_changed: Type.Optional(Type.Boolean()),
  group: Type.Optional(Type.String()),
  nextOffset: Type.Optional(Type.Number()),
});
export type ControlEvent = Static<typeof ControlEventSchema>;

/** Presence event payload as forwarded by the server. */
export interface PresenceEvent {
  actor_id: string;
  entity_id: string;
  data: Record<string, unknown>;
}

/**
 * Direction a registry violation came from. Lets a single observer
 * distinguish outbound (the local app typed a bad field) from inbound
 * (the wire carried a field this client doesn't recognize).
 */
export type RegistryViolationContext = { direction: "outbound" } | { direction: "inbound" };

/** Observer for schema-registry violations. */
export type RegistryViolationListener = (
  violations: readonly import("@ebbjs/schema").ValidationViolation[],
  context: RegistryViolationContext,
) => void;

/** Options for `createClient`. */
export interface SyncClientOptions<
  R extends import("../presence/presence").AnyPresenceRegistry | undefined =
    | import("../presence/presence").AnyPresenceRegistry
    | undefined,
> {
  /** Base URL of the ebb server (no trailing slash). */
  serverUrl: string;
  /** Actor identity for bypass auth (`x-ebb-actor-id`). */
  actorId: string;
  /**
   * Local app label (#732). When set, `handshake()` keeps only groups
   * whose app scope includes it, and `seed()` / `group.create` write it
   * as the new group's scope. It is a sync filter, not authority: the
   * actor's grants remain the only boundary.
   */
  appId?: string;
  /** Storage adapter for received actions. Defaults to in-memory adapter. */
  storage?: import("@ebbjs/storage/types").StorageAdapter;
  /** Custom fetch implementation (for tests / non-Node runtimes). */
  fetchImpl?: typeof fetch;
  /** Initial reconnect backoff in ms. Defaults to 1000. */
  reconnectInitialMs?: number;
  /** Maximum reconnect backoff in ms. Defaults to 60000. */
  reconnectMaxMs?: number;
  /**
   * Number of durable Actions folded between persisted-replica saves.
   * Defaults to 100. A non-positive value disables the count trigger; the
   * interval below still bounds the log tail.
   */
  replicaSaveEvery?: number;
  /**
   * Maximum wall-clock time between persisted-replica saves, in ms.
   * Defaults to 5000. A non-positive or non-finite value disables the
   * interval trigger.
   */
  replicaSaveIntervalMs?: number;
  /**
   * How long an inactive query result stays cached, in ms. Defaults to
   * `DEFAULT_QUERY_TTL_MS` (five minutes). A non-positive or non-finite
   * value keeps inactive results forever.
   */
  queryTtlMs?: number;
  /**
   * Maximum resident on-demand entity rows. Defaults to 16. Opening past the
   * window releases the least recently opened row; a non-positive or
   * non-finite value keeps every opened row resident.
   */
  pinnedCapacity?: number;
  /**
   * How long a closed on-demand row stays cached, in ms. Defaults to 30_000.
   * A non-positive or non-finite value releases it on close; an open row is
   * never released by the TTL.
   */
  pinnedTtlMs?: number;
  /**
   * Schema-layer entity registry. When provided, `client.write()` and
   * `client.queryEntities()` validate against it before any network
   * call, and incoming actions via SSE / catchUp warn-and-log
   * violations. When omitted, an empty registry is constructed and
   * validation is a no-op (matching how `storage?`, `fetchImpl?` work).
   */
  registry?: import("@ebbjs/schema").ModelRegistry;
  /**
   * Observer fired for every batch of registry violations, both
   * outbound (immediately before `client.write()` /
   * `client.queryEntities()` throw `EntityValidationError`) and
   * inbound (replacing the default `console.warn` on
   * `_applyAction`). Multiple listeners are supported; a throwing
   * listener is isolated and does not affect the others. When
   * omitted and no listeners are registered, inbound violations
   * fall back to `console.warn` for forward-compat with the
   * pre-hook behavior.
   */
  onRegistryViolation?: RegistryViolationListener;
  /**
   * Composed schema (`defineSchema({ ... })`). When provided, the
   * client builds a per-client `ModelRegistry` seeded from
   * `schema._registry` (so runtime mutations don't bleed across
   * clients sharing the same `schema` value) and advertises
   * `schema.version` (and `minSupportedVersion` when set) and a
   * deterministic `schema_hash` in the handshake body. Mutually
   * compatible with `registry?`: an explicit `registry` wins if
   * both are passed.
   */
  schema?: AnySchema;
  /**
   * Schema-bound actions to mount as `client.actions.<name>`. Requires
   * a `schema`, and every definition must be built against that same
   * schema (strict reference equality).
   */
  actions?: Record<string, AnyActionDef>;
  /**
   * Declared ephemeral presence channels (`definePresence(...)`). The
   * registry types `client.presence` and validates outgoing values; without
   * one, presence channels are dynamic strings and values are unvalidated.
   */
  presence?: R;
}
