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
 * // `subscribe` pulls the missed window for each group, runs the
 * // conflict sweep, and only then opens the live stream. The cursor
 * // is inferred from storage / `handshake()`.
 * const unsubscribe = client.subscribe(groups.map(g => g.id), (event) => {
 *   if (event.type === "data") applyToLocalState(event.action);
 * });
 * ```
 */

import {
  encodeSync,
  type Action,
  createAction,
  createClock,
  type Entity,
  type HLCState,
  localEvent,
  receiveRemoteHLC,
  type Update,
} from "@ebbjs/core";
import { createMemoryAdapter } from "@ebbjs/storage/memory";
import {
  applyUpdate,
  createReplica,
  DEFAULT_PINNED_CAPACITY,
  DEFAULT_PINNED_TTL_MS,
  type MaterializationPolicy,
  type Replica,
  type ReplicaStats,
} from "@ebbjs/storage/replica";
import type { ReplicaRecord, StorageAdapter } from "@ebbjs/storage/types";

import { ConnectionStateMachine, type ConnectionState } from "./connection-state";
import { PresenceManager } from "../presence/presence";
import { openSSEStream, type SSESubscription } from "./sse";
import { createOutbox, type Outbox } from "./outbox";
import {
  createConflicts,
  findPreSyncRow,
  type ConflictSnapshot,
  type Conflicts,
} from "./conflicts";
import { subjectIds } from "./action-subjects";
import type { ReadonlyObservable } from "./observable";
import { createFlushScheduler, type FlushScheduler } from "./flush-scheduler";
import { createOutboxObserver, type OutboxObserver } from "./outbox-observer";
import { createClientStatus, type ClientStatus, type ClientStatusController } from "./status";
import { createQueryCache, type QueryCache } from "./query-cache";
import { evictableRowIds, scopeEvictedGroupIds } from "./scope-eviction";
import { createReplicaSignal, type ReplicaSignal } from "./replica-signal";
import { backoffDelayMs } from "./backoff";
import { TextDocument, TextDocumentRegistry } from "../fields/collaborative-text/text-document";
import {
  EntityRegistry,
  EntityValidationError,
  type ValidationViolation,
} from "../schema/entity-registry";
import type { RelationshipDef } from "../schema/relationship";
import {
  buildRelationshipWrite as buildRelationshipWriteFree,
  type BuildRelationshipWriteOptions,
  type BuildRelationshipWriteResult,
} from "./relationship";
import { buildEntityNamespaces, type EntityNamespaces } from "./namespace";
import { readEntityMemberships } from "./entity-group";
import { readGeneratedParts } from "./generated-parts";
import { createBackfill, type Backfill } from "./backfill";
import { createGroupListing, LISTING_SEED_ACTOR_ID, type GroupListing } from "./group-listing";
import { createAtomicRuntime, type AtomicClient } from "./atomic";
import {
  PermissionError,
  collectPermissionViolations,
  queryActorPermission,
  queryEntityPermission,
  type CanResult,
  type CanSubject,
  type PermissionQuery,
  type PermissionVerb,
} from "./permission";
import {
  ActionDefinitionError,
  RUN,
  type Action as BoundAction,
  type ActionDef,
  type AnyActionDef,
} from "../schema/action";
import { generateId } from "@ebbjs/core";
import type { EntityDef } from "../schema/entity";
import { seedRegistry, type Schema } from "../schema/schema";
import { assertSeedAccepted, buildSeedAction, type SeedData } from "@ebbjs/core/seed";
import type { TSchema } from "@sinclair/typebox/type";

type AnyEntityDef = EntityDef<Record<string, TSchema>>;
type AnyRelationshipDef = RelationshipDef<AnyEntityDef, AnyEntityDef>;
type AnySchema = Schema<
  Record<string, AnyEntityDef>,
  Record<string, AnyRelationshipDef> | undefined
>;
import type {
  CatchUpResponse,
  ControlEvent,
  EntityQueryResponse,
  EntityResponse,
  GroupInfo,
  HandshakeRequest,
  HandshakeResponse,
  RegistryViolationContext,
  RegistryViolationListener,
  Rejection,
  SSEEvent,
  SyncClientOptions,
  WriteResponse,
} from "./types";

const DEFAULT_RECONNECT_INITIAL_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 60_000;
const MAX_RECONNECT_ATTEMPTS = 10;
const DEFAULT_REPLICA_SAVE_EVERY = 100;
const DEFAULT_REPLICA_SAVE_INTERVAL_MS = 5_000;

/** What the last replica hydration read and how long it took (#499). */
export interface ReplicaLoadReport {
  /** Wall-clock time from store load through the outbox overlay, in ms. */
  readonly durationMs: number;
  /** Rows restored from the persisted replica record. */
  readonly recordEntities: number;
  /** Log entries replayed after the record's position. */
  readonly tailEntries: number;
  /** Updates folded from those entries. */
  readonly tailActions: number;
  /** Durable outbox entries overlaid on the hydrated base. */
  readonly outboxEntries: number;
  /** The record's/log's append position after hydration. */
  readonly position: number;
  /** The replica revision after hydration. */
  readonly revision: number;
}

/**
 * Read-only observables over the client's sync state, mounted as
 * `client.sync`. Each is a synchronous `get()` plus a `subscribe(cb)`
 * that fires on change, so application UI can read them without polling
 * and without reaching into internals.
 *
 * Resolution / mutation stays on the owning surface (`client.conflicts`,
 * the outbox writer): `sync` never exposes a write path.
 */
export interface SyncObservables {
  /** Unresolved LWW conflicts awaiting an application decision. */
  readonly conflicts: ReadonlyObservable<ConflictSnapshot>;
  /** Write-buffer depth + last flush latency (#369). */
  readonly outbox: OutboxObserver;
  /**
   * Entity ids whose content is being backfilled from the server because
   * a membership row names an entity the local cache lacks (#475). Read
   * synchronously so a UI can render a pending row rather than an empty
   * one while the read is in flight.
   */
  readonly backfill: ReadonlyObservable<readonly string[]>;
}

export class SyncClient implements PermissionQuery {
  readonly serverUrl: string;
  readonly actorId: string;
  readonly storage: StorageAdapter;
  /**
   * The engine's materialized read model (#496): a mutable set of rows with
   * a per-type index, a monotonic revision, and a change journal. Reads are
   * synchronous and return shared rows. Hydrated by {@link hydrateReplica};
   * the async `storage.entities` shim keeps non-engine callers working until
   * the engine signal re-homes them (#512/#520).
   */
  readonly replica: Replica;
  /**
   * The engine signal over {@link replica} and its reactive query result
   * cache (#512). Namespaces and hooks read query results through it, so a
   * remount gets the cached result and every subscriber sees one invalidation
   * stream. Hydrated with the replica.
   */
  readonly queries: QueryCache;
  /** The shared per-revision notification stream the cache and watchers read. */
  readonly replicaSignal: ReplicaSignal;
  readonly presence: PresenceManager;
  readonly registry: EntityRegistry;
  readonly schema?: AnySchema;
  /**
   * Local write buffer. Every locally-authored Action passes through
   * here — `write()` enqueues (optimistically applying it) and flushes
   * — so entry lifecycle (pending / acknowledged / error) and depth
   * counters are observable, and the sync-echo receipt hook
   * (`_applyAction`) can retire an entry once it returns over the
   * stream.
   */
  readonly outbox: Outbox;
  /**
   * Owns *when* the outbox flushes: debounces a burst of `write()` calls
   * into one batched POST and retries an `unreachable` flush with bounded
   * backoff on its own attempt counter. `flushNow()`, `flushLatency`, and
   * `close()`'s teardown all live here. The connection loop holds the gate
   * through catch-up and releases it at the rebase checkpoint (#309).
   */
  readonly flushScheduler: FlushScheduler;
  /**
   * Application-facing conflict surface: the losing Actions LWW detection
   * moved off the pending write path, plus their resolution. `count()` is
   * #125's conflict-count source.
   */
  readonly conflicts: Conflicts;
  /**
   * Read-only sync observables. `client.sync.conflicts`,
   * `client.sync.outbox`, and `client.sync.backfill` each publish a
   * synchronous `get()` plus a `subscribe(cb)` that fires on change, so
   * application UI can render conflict / pending depth / in-flight
   * backfill without polling or reaching into internals.
   */
  readonly sync: SyncObservables;
  /**
   * Aggregate read-only status (#371): the connection phase, `lastSyncedAt`,
   * and the `client.sync.outbox` / `client.sync.conflicts` snapshots in one
   * place, so a framework binding subscribes once. `lastSyncedAt` is the
   * epoch-ms wall time of the last applied remote Action or completed
   * catch-up, or `null` before the first sync.
   */
  readonly status: ReadonlyObservable<ClientStatus>;
  /** The status observable's write side (`markSynced`), private to the client. */
  private readonly statusController: ClientStatusController;
  private readonly fetchImpl: typeof fetch;
  private readonly reconnectInitialMs: number;
  private readonly reconnectMaxMs: number;

  private readonly stateMachine = new ConnectionStateMachine();
  /** Active live subscriptions keyed by group-list hash. We allow at most one. */
  private activeSub: ActiveSubscription | null = null;
  /** Reconnect bookkeeping. */
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Resolver invoked when the reconnect timer fires or is cleared. */
  private reconnectTimerResolve: (() => void) | null = null;
  /** Latest per-group cursors, refreshed by `catchUp` and SSE receipt. */
  private groupCursors: Map<string, number> = new Map();
  /**
   * Deterministic content hash of the composed schema. Computed
   * once at construction and advertised as `schema_hash` on every
   * handshake. `undefined` when no schema was configured.
   */
  private readonly schemaHash: string | undefined;
  /**
   * Latest actor's group memberships with permissions, populated by
   * `handshake()`. The write path's local permission pass
   * ({@link collectPermissionViolations}) reads this to fast-fail an
   * Update the actor lacks `<type>.<verb>` for, before it is enqueued.
   * Empty until the first `handshake()`; the pass is skipped then and
   * the server stays the authority.
   */
  private actorGroups: { id: string; permissions: readonly string[] }[] = [];
  /**
   * Whether `handshake()` has completed at least once. Distinguishes the
   * genuinely unknown pre-handshake state from a handshake that reported
   * zero groups — the latter is a known "holds nothing". Read by the
   * `client.can(...)` query.
   */
  private handshakeRan = false;
  /**
   * Per-client HLC clock. Advanced on every local event by
   * {@link submitRelationshipUpdates}; remote HLCs flow in via
   * `_applyAction`. The clock is per-client so writes stay
   * monotonic against the client's own catch-up window.
   */
  private readonly clock: HLCState = createClock();
  /** TextDocument registry (one document per docId, per actor). */
  private readonly textDocumentRegistry = new TextDocumentRegistry();
  /**
   * Pre-sync captures for the in-flight catch-up pass, keyed by
   * `catchUpId`: the cached row behind every at-risk buffered write,
   * read before the missed window is applied. Detection consumes the
   * pass's captures and copies them onto the conflict payload; the pass
   * releases them when it ends, so nothing outlives detection.
   */
  private readonly preSyncCaptures = new Map<string, Map<string, Entity>>();
  /**
   * User-registered listeners for schema-registry violations. Fired
   * by `emitRegistryViolations`; replaces the default `console.warn`
   * on inbound violations when at least one listener is present.
   */
  private readonly registryViolationListeners = new Set<RegistryViolationListener>();
  /**
   * Content backfill for membership rows naming unknown entities (#475):
   * reconciles the local `entityGroup` rows against the cache and reads
   * the missing entities from the server into the action log.
   */
  private readonly backfillRunner: Backfill;
  /**
   * Cold bootstrap from the group-scoped entity listing (#476): seeds a
   * group whose view the local log cannot describe, and pins the seed's
   * watermark so a crash redoes the same listing.
   */
  private readonly groupListing: GroupListing;
  /**
   * How far each group's seeded base folded, by group id. A delivered Action
   * above every group's bound cannot have been folded by a listing seed, so
   * the per-row guard can skip the provenance lookup.
   */
  private readonly seededThrough = new Map<string, number>();
  /**
   * Highest listing-seed position folded into each row, by entity id. A row
   * is only protected from a re-delivered `put`/`delete` when its own seed
   * folded that position; the delivering group's bound is not enough, because
   * a shared row can be seeded by a different group's listing.
   */
  private readonly seededEntityThrough = new Map<string, number>();
  /** Memoized hydration of {@link replica}; see {@link hydrateReplica}. */
  private replicaHydration: Promise<void> | null = null;
  /** True once {@link loadReplica} completed, so synchronous readers can run. */
  private replicaHydrated = false;
  /** Durable Actions folded since the last persisted-replica save. */
  private replicaActionsSinceSave = 0;
  /** Periodic save timer; armed by the first unsaved Action. */
  private replicaSaveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Serializes record writes so a slow IndexedDB save cannot interleave. */
  private replicaSaveChain: Promise<void> = Promise.resolve();
  /** True while a coalesced automatic save is running. */
  private replicaSaveInFlight = false;
  /** Another automatic save was requested while one was running. */
  private replicaSavePending = false;
  /** Full record captured before a scope eviction; merged until the next save. */
  private evictedBackup: ReplicaRecord | null = null;
  /** Groups whose rows are expected to be resident right now. */
  private replicaScope: Set<string> = new Set();
  /** Groups whose rows were evicted and need restoring before a rejoin. */
  private evictedGroupIds: Set<string> = new Set();
  /** Serializes asynchronous scope restores. */
  private replicaScopeChain: Promise<void> = Promise.resolve();
  /** The last hydration's bounded-load report. */
  private replicaLoadReport: ReplicaLoadReport | null = null;
  private readonly replicaSaveEvery: number;
  private readonly replicaSaveIntervalMs: number;

  constructor(opts: SyncClientOptions) {
    this.serverUrl = opts.serverUrl.replace(/\/$/, "");
    this.actorId = opts.actorId;
    this.storage = opts.storage ?? createMemoryAdapter();
    this.schema = opts.schema;
    this.schemaHash = opts.schema === undefined ? undefined : computeSchemaHash(opts.schema);
    // Empty registry makes validation a no-op.
    this.registry = opts.registry ?? buildRegistryFromSchema(opts.schema);
    if (opts.onRegistryViolation !== undefined) {
      this.registryViolationListeners.add(opts.onRegistryViolation);
    }
    this.replica = createReplica({
      materialization: residencyFromRegistry(this.registry),
      readEntity: (id) => this.storage.entities.get(id),
      pinnedCapacity: opts.pinnedCapacity ?? DEFAULT_PINNED_CAPACITY,
      pinnedTtlMs: opts.pinnedTtlMs ?? DEFAULT_PINNED_TTL_MS,
    });
    this.replicaSignal = createReplicaSignal(this.replica);
    this.queries = createQueryCache(this.replica, this.replicaSignal, {
      ttlMs: opts.queryTtlMs,
    });
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.reconnectInitialMs = opts.reconnectInitialMs ?? DEFAULT_RECONNECT_INITIAL_MS;
    this.reconnectMaxMs = opts.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;
    this.replicaSaveEvery = opts.replicaSaveEvery ?? DEFAULT_REPLICA_SAVE_EVERY;
    this.replicaSaveIntervalMs = opts.replicaSaveIntervalMs ?? DEFAULT_REPLICA_SAVE_INTERVAL_MS;
    // PresenceManager wires itself to the SSE stream; the `presence`
    // field on the client is the public API for sending local
    // cursors and reading the map of remote ones. The manager lives
    // for the lifetime of the client; consumers should call
    // `client.close()` (already wired in the existing close path)
    // when tearing down.
    this.presence = new PresenceManager(this);
    // The outbox owns the whole write lifecycle, including a detected
    // conflict: a loser is a status + payload on its own row, so detection
    // is one durable write and the flush path holds it structurally.
    this.outbox = createOutbox({
      applyOptimistic: (action) => this.applyLocalAction(action),
      submit: (actions) => this.submitActions(actions),
      store: this.storage.outbox,
      // Field markers are the schema's word on merge semantics. A client
      // without a schema has no markers, so every non-structural field is
      // treated as LWW (the conservative default for conflict detection).
      // A document's `content` map merges per key, so concurrent edits to
      // different runs never conflict and a same-run race does — see the
      // outbox's recursive slot comparison.
      isLwwField: (subjectType, field) => this.registry.isLwwField(subjectType, field),
      // Scope is declared on the entity; an unknown entity defaults to
      // `"field"`, matching a client without a schema.
      conflictScope: (subjectType) => this.registry.getConflictScope(subjectType),
      baseGsn: () => this.appliedBaseGsn(),
      hlc: () => this.freshHlc(),
      conflictId: () => generateId("c"),
      preSyncRow: (catchUpId, subjectId) =>
        this.preSyncCaptures.get(catchUpId)?.get(subjectId) ?? null,
      readEntity: (subjectId) => this.storage.entities.get(subjectId),
    });
    // The view projects the outbox's conflicted rows; resolution moves
    // them back through the same outbox transition it reads.
    const { conflicts, observable: conflictsObservable } = createConflicts({
      outbox: this.outbox,
      retry: (originalId, action) => this.retryConflicted(originalId, action),
      reMaterialize: (action) => this.reMaterializeFromLog(action),
      stampAction: (updates) =>
        createAction({ actorId: this.actorId, updates: [...updates], clock: this.clock }).action,
      hlc: () => this.freshHlc(),
      generateUpdateId: () => this.generateUpdateId(),
    });
    this.conflicts = conflicts;
    // The retry loop reuses the SSE reconnect bounds but keeps its own
    // attempt counter inside the scheduler, so an unreachable write can
    // neither reset nor be reset by the SSE backoff.
    this.flushScheduler = createFlushScheduler({
      outbox: this.outbox,
      initialMs: this.reconnectInitialMs,
      maxMs: this.reconnectMaxMs,
    });
    this.backfillRunner = createBackfill({
      storage: this.storage,
      fetchEntity: (entityId) => this.getEntity(entityId),
      onAppended: (entry) => {
        this.replica.ingest(entry.action, entry.added, entry.position);
        this.noteReplicaMutation();
      },
    });
    this.groupListing = createGroupListing({
      serverUrl: this.serverUrl,
      actorId: this.actorId,
      fetchImpl: this.fetchImpl,
      storage: this.storage,
      onAppended: (entries) => {
        for (const entry of entries) {
          this.noteSeededAction(entry.action);
          this.replica.ingest(entry.action, entry.added, entry.position);
        }
        this.noteReplicaMutation();
      },
    });
    this.sync = {
      conflicts: conflictsObservable,
      outbox: createOutboxObserver({
        outbox: this.outbox,
        flushLatency: () => this.flushScheduler.flushLatency,
        onFlushLatency: (listener) => this.flushScheduler.onLatencyChange(listener),
      }),
      backfill: this.backfillRunner.pending,
    };
    // Built after `sync` so the aggregate composes the fully-wired
    // child observables.
    this.statusController = createClientStatus({
      connection: this.stateMachine,
      outbox: this.sync.outbox,
      conflicts: this.sync.conflicts,
    });
    this.status = this.statusController.status;
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
   * Force a connection-state transition. Useful for non-SSE consumers
   * (e.g., a polling-only client that wants the state machine to
   * reflect "we're connected" without opening an SSE stream). The
   * state machine otherwise only advances when `subscribe()` opens
   * or fails.
   */
  setState(state: ConnectionState): void {
    this.stateMachine.transition(state);
  }

  /**
   * Register an additional listener for schema-registry violations.
   * Returns an unsubscribe function. Multiple listeners are
   * supported; a throwing listener is isolated and does not affect
   * the others. Listeners fire for both outbound (immediately
   * before `client.write()` / `client.queryEntities()` throw
   * `EntityValidationError`) and inbound (replacing the default
   * `console.warn` on `_applyAction`) directions.
   */
  onRegistryViolation(cb: RegistryViolationListener): () => void {
    this.registryViolationListeners.add(cb);
    return () => {
      this.registryViolationListeners.delete(cb);
    };
  }

  /**
   * Build an outbound HTTP header bag carrying the actor identity.
   * All request paths funnel through this so the `x-ebb-actor-id`
   * header (and any future shared headers) live in one place.
   */
  private authHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return { "x-ebb-actor-id": this.actorId, ...extra };
  }

  /**
   * Close the active SSE stream and clear the field. Swallows errors
   * because a half-closed stream is fine when we're tearing down.
   */
  private closeStream(sub: ActiveSubscription): void {
    if (!sub.stream) return;
    try {
      sub.stream.close();
    } catch {
      // ignore
    }
    sub.stream = null;
  }

  /**
   * Open the SSE live stream for the given groups.
   *
   * Returns an `unsubscribe` function that closes the stream. Internally
   * maintains connection state and reconnects on transient failures using
   * exponential backoff (capped at `reconnectMaxMs`).
   *
   * Before opening (or re-opening) the stream, every subscribed group is
   * caught up from its stored cursor and the Outbox's inbound conflict
   * sweep runs. Pending writes are held from the wire until that rebase
   * phase completes, so a local Action can never be posted before it has
   * been checked against the missed window (#309).
   *
   * The `onEvent` callback fires for every data / control / presence event
   * the server emits, and for each Action replayed by the catch-up phase.
   * Data events are also appended to `storage.actions` so the storage
   * adapter stays in sync; callers that don't want this can pass a
   * different `storage` or use the raw event handler.
   *
   * Calling `subscribe` again replaces the active subscription: the
   * previous stream and callback are torn down, and the previous
   * `unsubscribe` becomes inert. Only the latest call's `unsubscribe`
   * stops the stream.
   *
   * The two-argument form infers its resume point the way
   * `catchUp(groupId)` does — the durable storage cursor, then the
   * cursors cached by `handshake()`. `fromGsn` in the three-argument form
   * is only a fallback for when nothing is cached.
   */
  subscribe(groupIds: readonly string[], onEvent: (event: SSEEvent) => void): () => void;
  subscribe(
    groupIds: readonly string[],
    fromGsn: number,
    onEvent: (event: SSEEvent) => void,
  ): () => void;
  subscribe(
    groupIds: readonly string[],
    fromGsnOrOnEvent: number | ((event: SSEEvent) => void),
    onEvent?: (event: SSEEvent) => void,
  ): () => void {
    const isCallbackForm = typeof fromGsnOrOnEvent === "function";
    const callback = isCallbackForm ? fromGsnOrOnEvent : onEvent;
    if (typeof callback !== "function") {
      throw new TypeError("subscribe: an event callback is required");
    }
    const fromGsn = isCallbackForm ? 0 : fromGsnOrOnEvent;

    if (this.activeSub !== null) {
      // The new call takes over the session. Hold the flush gate through
      // the handover so a write parked by the old rebase cannot reach the
      // wire before the new catch-up sweep (#309).
      this.cancelSubscription(this.activeSub, true);
    }

    const sub: ActiveSubscription = {
      groupIds: [...groupIds],
      onEvent: callback,
      cancelled: false,
      stream: null,
      fromGsn,
    };
    this.activeSub = sub;
    this.applyReplicaScope(sub.groupIds);

    // Transition to `connecting` unless already there or live.
    const s = this.stateMachine.state;
    if (s !== "live" && s !== "connecting") {
      this.stateMachine.transition("connecting");
    }

    this.runSubscriptionLoop(sub);
    // A plain unsubscribe ends the session; it is not a group leaving the
    // subscription. Residency follows the explicit group set, so the caller
    // can tear down and re-open the stream without wiping the replica.
    return () => this.cancelSubscription(sub);
  }

  /**
   * `POST /sync/handshake` — exchange identity and group membership.
   *
   * On success, the per-group cursors returned by the server are cached so
   * subsequent `catchUp` / `subscribe` calls can pick up where we left off.
   */
  async handshake(opts: HandshakeRequest = {}): Promise<HandshakeResult> {
    await this.hydrateReplica();
    const url = `${this.serverUrl}/sync/handshake`;
    const body = JSON.stringify({
      // The server validates these against its watermark and answers
      // `cursor_valid: false` when it has lost state below them, so it must
      // see what the client actually has rather than an empty map.
      cursors: opts.cursors ?? (await this.persistedCursors()),
      schema_version: opts.schema_version ?? this.schema?.version,
      min_supported_version: opts.min_supported_version ?? this.schema?.minSupportedVersion,
      schema_hash: opts.schema_hash ?? this.schemaHash,
    });

    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: this.authHeaders({ "Content-Type": "application/json" }),
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

    // A rejected cursor means the server's log no longer holds a window the
    // client's bases folded, so every group's base is suspect: reset the
    // local sync state (keeping the outbox) and let each subscribed group
    // re-seed. Every group is reset, not just the rejected one, because the
    // append-only log cannot forget one group's seeded rows.
    if (result.groups.some((group) => !group.cursorValid)) {
      await this.resetSyncState();
    }

    // Refresh the cursor cache from the server's authoritative cursors. An
    // invalidated group starts from nothing so its bootstrap seeds it: a
    // cursor restored from the server would claim a view the local reset
    // just dropped.
    this.groupCursors.clear();
    this.actorGroups = result.groups.map((g) => ({ id: g.id, permissions: g.permissions }));
    this.handshakeRan = true;
    for (const g of result.groups) {
      if (g.cursorValid) this.groupCursors.set(g.id, g.cursor);
    }
    return result;
  }

  /**
   * The cursors the client actually holds, as the handshake request's map.
   * A group mid-seed has no cursor yet, so it is omitted rather than sent
   * as `0`: the server would validate a claim the client never made.
   */
  private async persistedCursors(): Promise<Record<string, number>> {
    const records = await this.storage.cursors.records();
    const cursors: Record<string, number> = {};
    for (const [groupId, record] of records) {
      if (record.cursor !== undefined) cursors[groupId] = record.cursor;
    }
    return cursors;
  }

  /**
   * Drop every local sync base: the action log (with the entity cache and
   * persisted replica it feeds), the group cursors, and the materialized
   * rows. The outbox survives — those Actions are the user's writes, and
   * their echo re-establishes them on the freshly seeded base.
   */
  private async resetSyncState(): Promise<void> {
    await this.hydrateReplica();
    await this.storage.reset();
    this.replica.load({ ...this.replica.toRecord(), position: 0, revision: 0, entities: [] });
    this.groupCursors.clear();
    this.seededThrough.clear();
    this.seededEntityThrough.clear();
    this.replicaActionsSinceSave = 0;
    this.evictedBackup = null;
    this.evictedGroupIds.clear();
  }

  /**
   * Seed one group from the listing when its view is not complete yet,
   * then restore the optimistic rows the seed's full-replacement `put`s
   * would otherwise hide from the async `entities` shim.
   *
   * Runs inside the rebase phase, before the flush gate releases: a pending
   * write is stamped with the base GSN, so it must not be posted while the
   * base it was authored against is still changing.
   */
  private async bootstrapGroupListing(groupId: string): Promise<void> {
    const result = await this.groupListing.bootstrap(groupId);
    if (result.through > 0) {
      this.seededThrough.set(
        groupId,
        Math.max(result.through, this.seededThrough.get(groupId) ?? 0),
      );
    }
    if (result.seeded) {
      await this.reapplyOutbox();
      await this.persistReplica();
    }
    if (result.cursor !== null && result.cursor > (this.groupCursors.get(groupId) ?? 0)) {
      this.groupCursors.set(groupId, result.cursor);
    }
  }

  /**
   * Re-place every live outbox Action on top of a freshly seeded base.
   *
   * The composed replica already stacks its optimistic overlay over the
   * seeded rows, but an overlay `put` was authored against the previous
   * base and the seed's full-replacement `put` lands under it either way —
   * so the overlay is rebuilt and mirrored into the shim, which has no
   * overlay of its own.
   */
  private async reapplyOutbox(): Promise<void> {
    for (const entry of await this.storage.outbox.list()) {
      this.replica.discard(entry.action.id);
      this.replica.optimistic(entry.action);
      await this.mirrorReplicaRows(entry.action);
    }
  }

  /**
   * `GET /sync/groups/:group_id?offset=N` — paginated catch-up of missed Actions.
   *
   * If `fromGsn` is omitted, uses the last cached cursor for the group
   * (populated by `handshake`, `catchUp`, or a server-requested reconnect).
   */
  async catchUp(groupId: string, fromGsn?: number): Promise<CatchUpResponse> {
    await this.hydrateReplica();
    const offset =
      fromGsn ?? (await this.storage.cursors.get(groupId)) ?? this.groupCursors.get(groupId) ?? 0;
    const url = `${this.serverUrl}/sync/groups/${encodeURIComponent(groupId)}?offset=${offset}`;
    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: this.authHeaders(),
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

    // Apply every action to the storage adapter inline (rather than
    // waiting for `subscribe`) because catch-up happens before subscribing.
    // `_applyAction` validates against the registry (warn-and-log on
    // incoming violations) and advances `storage.cursors[groupId]` to the
    // max GSN it sees, so we read it back once instead of re-aggregating.
    for (const action of actions) {
      await this._applyAction(action, groupId);
    }
    const stored = await this.storage.cursors.get(groupId);
    if (stored !== null) {
      const prev = this.groupCursors.get(groupId) ?? 0;
      if (stored > prev) {
        this.groupCursors.set(groupId, stored);
      }
    }

    // A catch-up that reached the head is a sync point even when it
    // carried no Actions. A further page is still behind, so stamping
    // now would overstate freshness.
    if (upToDate) {
      this.statusController.markSynced();
      await this.persistReplica();
    }

    return { actions, nextOffset, upToDate };
  }

  /**
   * `POST /sync/actions` — submit a batch of locally-produced Actions
   * via the {@link Outbox}.
   *
   * Validates each action against the local `EntityRegistry`, then
   * enqueues it (optimistically applying its Updates to the local
   * cache) and flushes the buffer. Returns the server's response; the
   * server may reject some actions (permissions, HLC drift) and the
   * caller decides how to handle them. Re-submitting an Action the
   * server has already committed (same `action_id`) is an idempotent
   * no-op: it returns success with no `rejected[]` entry. Accepted
   * actions stay in the outbox as `acknowledged` until their sync echo
   * arrives.
   *
   * Schema violations throw `EntityValidationError` aggregating every
   * violation across the batch before anything is enqueued — matches
   * the server's `rejected[]` mental model so callers handle
   * client-side and server-side rejections uniformly. A locally-known
   * permission refusal throws `PermissionError` (also before any
   * enqueue) once `handshake()` has populated the actor's groups.
   */
  async write(actions: readonly Action[]): Promise<WriteResponse> {
    if (actions.length === 0) {
      return { rejected: [] };
    }
    const violations = collectViolations(actions, this.registry);
    if (violations.length > 0) {
      this.emitRegistryViolations(violations, { direction: "outbound" });
      throw new EntityValidationError(violations);
    }
    const permissionViolations = await collectPermissionViolations(actions, {
      actorId: this.actorId,
      actorGroups: this.actorGroups,
      storage: this.storage,
    });
    if (permissionViolations.length > 0) {
      throw new PermissionError(permissionViolations);
    }
    for (const action of actions) {
      await this.outbox.enqueue(action);
    }
    // The outbox owns entry state; this legacy return shape reports only
    // the server's per-Action rejections. The scheduler owns *when* the
    // flush happens and retries an unreachable submit in the background,
    // so a throw here is the first attempt's failure, not a give-up.
    const outcome = await this.flushScheduler.schedule();
    if (outcome.kind === "unreachable") throw outcome.error;
    if (outcome.kind === "partial") return { rejected: outcome.rejected };
    return { rejected: [] };
  }

  /**
   * Seed plain-data rows through the public write path as one Action,
   * applying the shared rejection-tolerance policy
   * ({@link assertSeedAccepted}): duplicate / already-exists rejections
   * are ignored, anything else throws `SeedRejectedError`.
   *
   * Schema-less: the rows carry their own field envelopes and ids, so a
   * client without a schema can still seed fixture data.
   */
  async seed(data: SeedData): Promise<void> {
    const response = await this.write([buildSeedAction(this.actorId, data)]);
    assertSeedAccepted(response.rejected);
  }

  /**
   * Read-only permission query (#322): ask the same `<type>.<verb>`
   * question the write-path pre-check answers, so an app can hide or
   * disable a control instead of catching {@link PermissionError}.
   *
   * The global form asks whether the actor holds the permission in any
   * of its groups. The per-entity form resolves the entity's group set
   * and union-matches it. The result is a discriminated union: `denied`
   * carries the same {@link PermissionViolation} the write path throws —
   * the missing permission, plus the consulted groups — and `unknown`
   * (no handshake, an unresolvable entity, or an entity with no local
   * owner) means the server remains the authority — it is never reported
   * as `denied`. The query reflects committed state, so it does not see
   * an Action's in-flight group bootstrap; the write path is the
   * authority on that.
   */
  can(permission: string): Promise<CanResult>;
  can(subject: CanSubject, verb: PermissionVerb): Promise<CanResult>;
  async can(first: string | CanSubject, verb?: PermissionVerb): Promise<CanResult> {
    const ctx = {
      actorId: this.actorId,
      actorGroups: this.actorGroups,
      storage: this.storage,
      handshaken: this.handshakeRan,
    };
    if (verb === undefined) {
      if (typeof first !== "string") {
        throw new TypeError("can(): the global form takes a permission string");
      }
      return queryActorPermission(first, ctx);
    }
    return queryEntityPermission(first, verb, ctx);
  }

  /**
   * The network leg of the write path. Called by the Outbox's
   * `flush()`; callers go through `write()` so validation and
   * optimistic apply happen first.
   */
  private async submitActions(actions: readonly Action[]): Promise<WriteResponse> {
    const body = encodeSync({ actions });
    const response = await this.fetchImpl(`${this.serverUrl}/sync/actions`, {
      method: "POST",
      headers: this.authHeaders({ "Content-Type": "application/msgpack" }),
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

  /**
   * Wrap a batch of pre-built Updates in a single Action and submit
   * via `write`. The namespace's `link` / `unlink` / `setLinks`
   * methods use this to ship wire Updates without the caller
   * hand-rolling `createAction` calls.
   *
   * HLC ordering: the Action's HLC is minted from the client's
   * internal clock. Remote HLCs received on the SSE stream merge
   * into the same clock via {@link receiveRemoteHLC} so subsequent
   * local events stay monotonic.
   */
  async submitRelationshipUpdates(updates: readonly Update[]): Promise<WriteResponse> {
    if (updates.length === 0) {
      return { rejected: [] };
    }
    const { createAction } = await import("@ebbjs/core");
    // Advance the clock for the local event so the Action's HLC
    // is monotonically greater than any prior local / remote HLC.
    this.freshHlc();
    const { action } = createAction({
      actorId: this.actorId,
      updates: [...updates],
      clock: this.clock,
    });
    const response = await this.write([action]);
    // `flush()` submits every buffered Action, so the server's `rejected[]`
    // can name Actions other than the one minted here. Report only this
    // Action's refusal to the caller — the outbox records every rejection
    // as an errored entry, so the rest are not lost.
    return { rejected: response.rejected.filter((rejection) => rejection.id === action.id) };
  }

  /**
   * Advance the client's HLC clock for a local event and return
   * the freshly-minted HLC string. Used by the namespace's
   * `setLinks` path to stamp the entity Update it constructs.
   */
  freshHlc(): string {
    return localEvent(this.clock);
  }

  /** Mint a fresh Update id. Used by the namespace's `setLinks` path. */
  generateUpdateId(): string {
    return generateId("u");
  }

  /**
   * Merge a remote HLC into the client's clock. Called from the
   * inbound-Action path so the next local event is guaranteed
   * monotonic against the server's authoritative HLC. Best-effort:
   * any failure (malformed, or more than 120s ahead) is swallowed so
   * the storage materialization still happens. Only the Action HLC is
   * merged; leaves come from this client's own clock (at or below the
   * Action HLC) and `duplicate()` copies them verbatim.
   */
  private mergeRemoteHLC(remoteHlc: string): void {
    try {
      receiveRemoteHLC(this.clock, remoteHlc);
    } catch {
      // ignore — see comment above
    }
  }

  /** `GET /entities/:id` — read a materialized entity. */
  async getEntity(id: string): Promise<EntityResponse | null> {
    const url = `${this.serverUrl}/entities/${encodeURIComponent(id)}`;
    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: this.authHeaders(),
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
    if (opts.filter !== undefined) {
      const violations = this.registry.validateFilter(type, opts.filter);
      if (violations.length > 0) {
        this.emitRegistryViolations(violations, { direction: "outbound" });
        throw new EntityValidationError(violations);
      }
    }
    const response = await this.fetchImpl(`${this.serverUrl}/entities/query`, {
      method: "POST",
      headers: this.authHeaders({ "Content-Type": "application/json" }),
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
   * Reconcile the local `entityGroup` rows against the cache and read
   * every referenced entity the client lacks from the server (#475).
   * Runs automatically after catch-up and on a live membership put; this
   * surface exposes it for callers that want to await or force a pass.
   * Concurrent calls coalesce into one pass plus one queued re-check.
   */
  async backfill(): Promise<void> {
    await this.hydrateReplica();
    await this.backfillRunner.run();
    await this.persistReplica();
  }

  /**
   * Bring {@link replica} up to date: the persisted record, the action-log
   * tail after its watermark, and the durable outbox overlay. Idempotent and
   * safe to await from any caller; the sync lifecycle hydrates lazily, so an
   * engine reading the replica directly should await this first.
   */
  async hydrateReplica(): Promise<void> {
    this.replicaHydration ??= this.loadReplica();
    return this.replicaHydration;
  }

  /** Whether {@link hydrateReplica} has completed; a synchronous read may run. */
  isReplicaHydrated(): boolean {
    return this.replicaHydrated;
  }

  /** What the last hydration read, and how long it took; `null` before it runs. */
  get replicaLoad(): ReplicaLoadReport | null {
    return this.replicaLoadReport;
  }

  /** The materialized set's size, type counts, journal depth, and position. */
  get replicaStats(): ReplicaStats {
    return this.replica.stats();
  }

  /**
   * Persist {@link replica}'s record as the durable fast path for hydration.
   * Saves are serialized. While a scope eviction is in flight the durable
   * base is the union of the resident rows and the captured full record, so
   * leaving a group frees memory without losing the rows from the durable
   * fast path.
   */
  async persistReplica(): Promise<void> {
    const save = this.replicaSaveChain.then(() => this.writeReplicaRecord());
    // A failed save must not poison the chain; the caller still sees the error.
    this.replicaSaveChain = save.catch(() => {});
    return save;
  }

  private async writeReplicaRecord(): Promise<void> {
    const savedActions = this.replicaActionsSinceSave;
    let record = this.replica.toRecord();
    if (this.evictedGroupIds.size > 0 || this.evictedBackup !== null) {
      const durable = this.evictedBackup ?? (await this.storage.replica.load());
      if (durable !== null) record = withRetainedRows(record, durable);
    }
    await this.storage.replica.save(record);
    this.replicaActionsSinceSave -= savedActions;
    this.evictedBackup = null;
  }

  /**
   * A durable Action landed: count it toward the next save and arm the
   * interval. A burst saves at the count boundary; an idle client saves at
   * the interval, so the log tail stays bounded without a write per Action.
   */
  private noteReplicaMutation(): void {
    this.replicaActionsSinceSave += 1;
    if (this.replicaSaveEvery > 0 && this.replicaActionsSinceSave >= this.replicaSaveEvery) {
      this.clearReplicaSaveTimer();
      this.requestReplicaSave();
      return;
    }
    this.armReplicaSaveTimer();
  }

  /**
   * Coalesce automatic saves: a burst past the action threshold queues one
   * follow-up, never one full-record write per Action.
   */
  private requestReplicaSave(): void {
    if (this.replicaSaveInFlight) {
      this.replicaSavePending = true;
      return;
    }
    this.replicaSaveInFlight = true;
    void this.persistReplica()
      .catch(logReplicaSaveError)
      .finally(() => {
        this.replicaSaveInFlight = false;
        if (!this.replicaSavePending) return;
        this.replicaSavePending = false;
        this.requestReplicaSave();
      });
  }

  private armReplicaSaveTimer(): void {
    if (
      !Number.isFinite(this.replicaSaveIntervalMs) ||
      this.replicaSaveIntervalMs <= 0 ||
      this.replicaSaveTimer !== null
    ) {
      return;
    }
    this.replicaSaveTimer = setTimeout(() => {
      this.replicaSaveTimer = null;
      if (this.replicaActionsSinceSave === 0) return;
      this.requestReplicaSave();
    }, this.replicaSaveIntervalMs);
    (this.replicaSaveTimer as { unref?: () => void }).unref?.();
  }

  private clearReplicaSaveTimer(): void {
    if (this.replicaSaveTimer === null) return;
    clearTimeout(this.replicaSaveTimer);
    this.replicaSaveTimer = null;
  }

  private async loadReplica(): Promise<void> {
    const started = performance.now();
    const record = await this.storage.replica.load();
    if (record !== null) this.replica.load(record);
    const tail = await this.storage.actions.readTail(record?.position ?? 0);
    for (const entry of tail) {
      this.noteSeededAction(entry.action);
      this.replica.ingest(entry.action, entry.added, entry.position);
    }
    const outbox = await this.storage.outbox.list();
    let outboxEntries = 0;
    for (const entry of outbox) {
      if (entry.status === "pending" || entry.status === "acknowledged") {
        this.replica.optimistic(entry.action);
        outboxEntries += 1;
      }
    }
    this.replicaHydrated = true;
    this.evictedGroupIds.clear();
    this.evictedBackup = null;
    // A seeded base outlives the session: without its bound, a restart would
    // let a re-delivered `put` inside the seed's window regress the row.
    for (const [groupId, cursor] of await this.storage.cursors.records()) {
      if (cursor.through !== undefined) this.seededThrough.set(groupId, cursor.through);
    }
    const stats = this.replica.stats();
    this.replicaLoadReport = {
      durationMs: performance.now() - started,
      recordEntities: record?.entities.length ?? 0,
      tailEntries: tail.length,
      tailActions: tail.reduce((count, entry) => count + entry.added.length, 0),
      outboxEntries,
      position: stats.position,
      revision: stats.revision,
    };
  }

  /**
   * Re-read the durable base after scope eviction removed rows the new scope
   * wants back. The captured full record (or the persisted one) carries the
   * evicted rows; the tail after its position brings it current.
   */
  private async restoreEvictedReplica(): Promise<void> {
    await this.persistReplica();
    const record = await this.storage.replica.load();
    if (record !== null) {
      this.replica.load(record);
      for (const entry of await this.storage.actions.readTail(record.position)) {
        this.replica.ingest(entry.action, entry.added, entry.position);
      }
    } else {
      this.replica.load({ ...this.replica.toRecord(), position: 0, revision: 0, entities: [] });
      for (const entry of await this.storage.actions.readTail(0)) {
        this.replica.ingest(entry.action, entry.added, entry.position);
      }
    }
    for (const entry of await this.storage.outbox.list()) {
      if (entry.status === "pending" || entry.status === "acknowledged") {
        this.replica.optimistic(entry.action);
      }
    }
    this.evictedGroupIds.clear();
    this.evictedBackup = null;
  }

  /** Apply the subscription's group scope to the materialized set. */
  private applyReplicaScope(groupIds: readonly string[]): void {
    const next = new Set(groupIds);
    for (const previous of this.replicaScope) {
      if (!next.has(previous)) this.evictedGroupIds.add(previous);
    }
    const rejoining = [...next].some((groupId) => this.evictedGroupIds.has(groupId));
    this.replicaScope = next;

    if (!this.replicaHydrated) {
      void this.hydrateReplica().then(() => this.applyReplicaScope([...this.replicaScope]));
      return;
    }
    if (rejoining) {
      const restore = this.replicaScopeChain
        .then(() => this.restoreEvictedReplica())
        .then(() => this.evictUnsubscribedRows())
        .catch(logReplicaSaveError);
      this.replicaScopeChain = restore;
      return;
    }
    this.evictUnsubscribedRows();
  }

  /**
   * Drop resident rows no subscribed group can reach. The full record is
   * captured first so the next save keeps the durable base complete.
   */
  private evictUnsubscribedRows(): void {
    const groups = [...this.replicaScope];
    const ids = evictableRowIds(this.replica, groups);
    if (ids.length === 0) return;
    for (const groupId of scopeEvictedGroupIds(this.replica, groups)) {
      this.evictedGroupIds.add(groupId);
    }
    this.evictedBackup = mergeReplicaRecords(this.evictedBackup, this.replica.toRecord());
    this.replica.evict(ids);
    this.requestReplicaSave();
  }

  /**
   * Tear down all subscriptions and timers. After `close()` the client is
   * unusable; create a new one with `createClient`.
   */
  close(): void {
    // Stop timers and in-flight retries first: no flush should start while
    // the rest of the client is tearing down.
    this.flushScheduler.stop();
    this.clearReplicaSaveTimer();
    if (this.replicaHydrated && this.replicaActionsSinceSave > 0) this.requestReplicaSave();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      const resolve = this.reconnectTimerResolve;
      this.reconnectTimerResolve = null;
      if (resolve) resolve();
    }
    if (this.activeSub) {
      this.cancelSubscription(this.activeSub);
    }
    this.stateMachine.transition("offline");
    this.presence.dispose();
  }

  // -------------------------------------------------------------------------
  // TextDocument (causal-tree field type)
  // -------------------------------------------------------------------------

  /**
   * Open (or get) the TextDocument for a given entity id.
   *
   * The TextDocument is a per-(docId, actor) singleton. Calling `open`
   * twice with the same args returns the same instance; the document's
   * DocState, pendingActions queue, and event listeners all persist.
   *
   * The returned TextDocument is NOT auto-wired to the SSE stream. To
   * pipe incoming Actions into the document, call `doc.applyActions()`
   * from your own SSE/catchUp handler:
   *
   * ```ts
   * const doc = client.textDocument('doc_demo');
   * client.subscribe(groupIds, (ev) => {
   *   if (ev.type === 'data') doc.applyActions([ev.action]);
   * });
   * ```
   *
   * `docType` is the document entity's wire `subject_type`. Omit it for a
   * raw document (`text_document`); pass the generated name when opening a
   * schema-derived body by hand. The derived-body accessor resolves it for
   * you.
   */
  textDocument(docId: string, docType?: string): TextDocument {
    return this.textDocumentRegistry.open({ docId, actorId: this.actorId, docType });
  }

  /**
   * Open (or get) the TextDocument for a derived body, bound to the
   * client's write path so local edits self-flush. `docType` is the
   * generated document entity's name; the derived-body accessor passes
   * the type it resolved from the relationship so a custom `entity`
   * option works.
   *
   * Deliberately separate from {@link textDocument}: the low-level API
   * keeps its manual `client.write(doc.pendingActions())` contract
   * (which also leaves the 250ms pending window the conflict sweep
   * needs), while a derived body flushes itself.
   */
  openDerivedTextDocument(docId: string, docType: string): TextDocument {
    const doc = this.textDocumentRegistry.open({ docId, actorId: this.actorId, docType });
    doc.setSubmit((action) => this.write([action]));
    return doc;
  }

  /**
   * Build the wire Update(s) for a single relationship write.
   *
   * One-cardinality: a single Relationship Update. The caller
   * supplies `sourceId` and `targetId` (string id or entity-shape;
   * `null` for unlink). The source's data fields don't carry the FK.
   *
   * Many-cardinality: one entity Update + N Relationship Updates.
   * The caller supplies `entityUpdate` (carrying the canonical FK
   * set on `data.fields[as]`) and a `targetIds` patch.
   *
   * Pointer values may be a string id or an entity-shape object
   * (anything with a string `.id`); both are normalized to the id at
   * write time. Anything else is rejected with `EntityValidationError`.
   *
   * Permission enforcement does not happen here: `write()` runs the
   * shared local permission pass ({@link collectPermissionViolations})
   * over every Update before enqueuing, and the server remains the
   * trust boundary.
   */
  buildRelationshipWrite(opts: BuildRelationshipWriteOptions): BuildRelationshipWriteResult {
    return buildRelationshipWriteFree(this.registry, opts);
  }

  // -------------------------------------------------------------------------
  // Subscription loop & reconnect
  // -------------------------------------------------------------------------

  private async runSubscriptionLoop(sub: ActiveSubscription): Promise<void> {
    while (!sub.cancelled) {
      const reason = await this.connectAndDrain(sub);
      if (sub.cancelled) return;
      // Hand off to the backoff state machine. The loop only re-enters
      // after `scheduleReconnect`'s timer fires (or never, if we've
      // exceeded the attempt cap). This prevents the previous bug where
      // `while (!sub.cancelled)` re-iterated synchronously after
      // `closeStream`, hammering the server instead of waiting out the
      // intended backoff.
      const result = this.scheduleReconnect(sub, reason);
      if (result === "giveup" || result === "cancelled") {
        // No later connect will run the checkpoint; let pending writes
        // reach the wire (and fail on their own) instead of hanging held.
        this.flushScheduler.release();
        return;
      }
      // Wait for the timer (resolved by the setTimeout callback, or
      // rejected by `cancelSubscription` clearing the timer).
      await this.waitForReconnectTimer();
    }
  }

  /**
   * Open the SSE stream, drain events until the stream closes or errors,
   * and return a short reason string for logging. The stream is always
   * closed in `finally`. Does NOT schedule a reconnect — that's the
   * caller's responsibility.
   */
  private async connectAndDrain(sub: ActiveSubscription): Promise<string> {
    try {
      // The rebase phase gates the wire so a pending Action cannot post
      // before it has been swept against the missed window (#309). The
      // pre-sync capture is taken first: once the window is applied the
      // optimistic rows the buffered writes produced are gone. The pass
      // id threads both the capture and the detection, so a second
      // reconnect captures afresh and its conflict pairs with its own
      // window's row.
      this.flushScheduler.hold();
      const catchUpId = generateId("cu");
      try {
        await this.capturePreSyncSnapshots(catchUpId);
        await this.catchUpSubscribed(sub, catchUpId);
      } finally {
        // Detection has copied the pass's rows onto the conflict payload,
        // so the in-memory captures go as soon as the pass ends — even a
        // thrown pass drops them.
        this.preSyncCaptures.delete(catchUpId);
      }
      if (sub.cancelled) return "cancelled";
      // A missed window can carry a membership row whose entity content
      // lives in another group's history, so reconcile before going live.
      void this.backfill();
      // Readiness checkpoint: catch-up is done and the conflict detection
      // pass has run, so pending entries may flush.
      this.flushScheduler.release();

      const cursor = await this.computeResumeCursor(sub);
      const stream = openSSEStream({
        serverUrl: this.serverUrl,
        groupIds: sub.groupIds,
        cursor,
        actorId: this.actorId,
        fetchImpl: this.fetchImpl,
      });
      sub.stream = stream;
      this.stateMachine.transition("live");

      // Reset backoff only after we've successfully received at least
      // one event from the server — opening the stream object is not
      // proof of a healthy connection (the fetch can resolve 5xx and
      // `openSSEStream` will still return; the error surfaces only
      // when the iterator drains). Resetting on `transition("live")`
      // used to defeat the attempt cap (every iteration reset to 0
      // before `scheduleReconnect` could increment past 1).
      let sawEvent = false;
      for await (const event of stream.events()) {
        if (sub.cancelled) break;
        if (!sawEvent) {
          this.reconnectAttempt = 0;
          sawEvent = true;
        }
        await this.handleSSEEvent(event, sub);
      }
      return sub.cancelled ? "cancelled" : "stream closed by server";
    } catch (err) {
      return errorMessage(err);
    } finally {
      this.closeStream(sub);
    }
  }

  /**
   * Wait for the pending reconnect timer (if any) to fire or be cleared.
   * Resolves immediately if no timer is pending.
   */
  private waitForReconnectTimer(): Promise<void> {
    if (!this.reconnectTimer) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.reconnectTimerResolve = resolve;
    });
  }

  /**
   * Pull every missed Action for each subscribed group before the live
   * stream opens, and surface each to the subscription's `onEvent` so a
   * consumer (e.g. a causal-tree document) observes the same events it
   * would have live. `_applyAction` removes this client's own echoes as
   * usual; once the window has drained, one `detectConflicts` pass moves
   * every concurrent buffered write to Conflicts — before the checkpoint
   * releases the flush.
   */
  private async catchUpSubscribed(sub: ActiveSubscription, catchUpId: string): Promise<void> {
    const missed: Action[] = [];
    // Seed the groups whose view the log cannot describe before any page is
    // requested: the seed publishes `cursor(G) = W`, which is exactly where
    // the catch-up below then starts.
    for (const groupId of sub.groupIds) {
      await this.bootstrapGroupListing(groupId);
    }
    for (const groupId of sub.groupIds) {
      // First page: let `catchUp` pick up from the durable cursor.
      let offset: number | undefined;
      for (;;) {
        const result = await this.catchUp(groupId, offset);
        for (const action of result.actions) {
          missed.push(action);
          this.emitToSubscriber(sub, { type: "data", action });
        }
        if (result.upToDate || result.nextOffset === null) break;
        // Never re-request the same page: a server that reports progress
        // it did not make must not spin the reconnect loop.
        if (offset !== undefined && result.nextOffset <= offset) break;
        offset = result.nextOffset;
      }
    }
    // Detection runs once over the whole missed window, after every page
    // has drained. An entry that arrived mid-pagination is still buffered
    // (the gate holds it), so one pass covers it; a `write()` after this
    // point is live and converges without detection.
    await this.outbox.detectConflicts(missed, catchUpId);
  }

  /**
   * The highest server sequence the client can claim to have applied,
   * stamped as a buffered write's `basedOnGsn`.
   *
   * The minimum non-zero applied cursor across the subscribed groups:
   * the client does not know which group carries a subject, and too low a
   * base only surfaces extra conflicts. A subscribed group with no cursor
   * yet contributes nothing, so the base is `0` until the first cursor
   * lands. With no group subscribed, fall back to the global maximum so a
   * write authored before subscribing is not spuriously concurrent.
   */
  private appliedBaseGsn(): number {
    const sub = this.activeSub;
    if (sub !== null && sub.groupIds.length > 0) {
      const cursors = sub.groupIds
        .map((groupId) => this.groupCursors.get(groupId) ?? 0)
        .filter((cursor) => cursor > 0);
      return cursors.length === 0 ? 0 : Math.min(...cursors);
    }
    return Math.max(0, ...this.groupCursors.values());
  }

  /**
   * Capture the row behind every buffered local write before the missed
   * window is applied, under this pass's `catchUpId`. Only `pending` /
   * `acknowledged` / `conflicted` entries are at risk — a rejected entry
   * never reaches the wire. Best-effort: a store read failure captures
   * nothing rather than breaking the loop.
   */
  private async capturePreSyncSnapshots(catchUpId: string): Promise<void> {
    try {
      await this.outbox.rehydrate();
    } catch {
      return;
    }
    const atRisk = new Set<string>();
    for (const entry of this.outbox.unrejected()) {
      for (const entityId of subjectIds(entry.action)) atRisk.add(entityId);
    }
    const captured = new Map<string, Entity>();
    for (const entityId of atRisk) {
      const row = await this.storage.entities.get(entityId);
      if (row !== null) captured.set(entityId, row);
    }
    this.preSyncCaptures.set(catchUpId, captured);
  }

  /**
   * Invoke the subscription's `onEvent` with error isolation, so one
   * throwing handler cannot break the read loop.
   */
  private emitToSubscriber(sub: ActiveSubscription, event: SSEEvent): void {
    try {
      sub.onEvent(event);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[SyncClient] onEvent handler threw:", err);
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
      await this._applyAction(event.action, groupId);
      if (isMembershipPut(event.action)) void this.backfill();
      if (event.action.gsn > 0) {
        for (const gid of sub.groupIds) {
          const prev = this.groupCursors.get(gid) ?? 0;
          if (event.action.gsn > prev) this.groupCursors.set(gid, event.action.gsn);
        }
      }
    } else if (event.type === "control") {
      await this.handleControlEvent(event.control, sub);
    }

    this.emitToSubscriber(sub, event);
  }

  private async handleControlEvent(control: ControlEvent, sub: ActiveSubscription): Promise<void> {
    if (!control.reconnect) return;
    const from = control.catchUpFrom;
    if (from === undefined) return;
    // Server told us our cursor is stale — close the current stream and
    // re-open after catching up.
    // eslint-disable-next-line no-console
    console.warn(`[SyncClient] server reports stale cursor; catching up from GSN ${from}`);
    for (const gid of sub.groupIds) {
      this.groupCursors.set(gid, from);
      // Persist the server's resume point too: the reconnect catch-up
      // reads the durable cursor first, and a client cursor ahead of the
      // server's must not shadow the window the server asked us to pull.
      await this.storage.cursors.set(gid, from);
    }
    // Force a stream restart by closing the current one; the loop will
    // pick the new cursor up on the next iteration.
    this.closeStream(sub);
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

  /**
   * Compute the next backoff delay and arm a timer. The result tells
   * the caller what to do next:
   *   - `"wait"`: timer armed, caller should `await` it before retrying
   *   - `"giveup"`: max attempts exceeded, caller should exit the loop
   *   - `"cancelled"`: subscription was cancelled, caller should exit
   *
   * This no longer closes the stream itself — `connectAndDrain` does
   * that in its `finally` block. The state transition to `"live"` is
   * already done by `connectAndDrain` after a successful open.
   */
  private scheduleReconnect(
    sub: ActiveSubscription,
    reason: string,
  ): "wait" | "giveup" | "cancelled" {
    if (sub.cancelled) return "cancelled";
    if (this.reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
      // eslint-disable-next-line no-console
      console.error(`[SyncClient] giving up after ${MAX_RECONNECT_ATTEMPTS} reconnect attempts`);
      this.stateMachine.transition("offline");
      return "giveup";
    }
    const delay = backoffDelayMs(
      this.reconnectAttempt,
      this.reconnectInitialMs,
      this.reconnectMaxMs,
    );
    this.reconnectAttempt += 1;
    this.stateMachine.transition("reconnecting");
    // eslint-disable-next-line no-console
    console.warn(
      `[SyncClient] SSE ${reason}; reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      const resolve = this.reconnectTimerResolve;
      this.reconnectTimerResolve = null;
      if (resolve) resolve();
      if (!sub.cancelled) {
        this.stateMachine.transition("connecting");
      }
    }, delay);
    return "wait";
  }

  /**
   * Stop a subscription. A stale `sub` — one already replaced — is inert:
   * only the current active sub owns the shared reconnect timer, flush
   * gate, and connection state.
   *
   * `preserveSession` leaves the flush gate and connection state for the
   * replacement about to take over. Releasing the gate here would flush a
   * write parked by the old rebase before the new catch-up sweep (#309).
   */
  private cancelSubscription(sub: ActiveSubscription, preserveSession = false): void {
    sub.cancelled = true;
    this.closeStream(sub);
    if (sub !== this.activeSub) return;
    this.activeSub = null;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      // Wake up `runSubscriptionLoop` so it observes `sub.cancelled`
      // and exits, instead of waiting on a dead timer.
      const resolve = this.reconnectTimerResolve;
      this.reconnectTimerResolve = null;
      if (resolve) resolve();
    }
    if (preserveSession) return;
    // A plain unsubscribe ends the connection lifecycle: no catch-up is
    // coming, so pending writes may flush again.
    this.flushScheduler.release();
    this.stateMachine.transition("offline");
  }

  // -------------------------------------------------------------------------
  // Incoming action application
  // -------------------------------------------------------------------------

  /**
   * Materialize a received Action in the storage adapter, validating
   * against the schema registry first. The single funnel for all
   * incoming actions (SSE and catch-up).
   *
   * Incoming violations default to **warn-and-log** rather than throw:
   * the server is the trust boundary, and forward-compat with peers
   * that may have fields the local schema doesn't know about is the
   * common case. The action still materializes regardless.
   *
   * After the action lands in the action log it is folded into the
   * replica, whose change signal wakes the query cache and row watchers
   * (#512). The `storage.entities` shim keeps its materialize-on-read
   * contract for the remaining internal readers.
   */
  private async _applyAction(
    action: Action,
    groupId?: string,
  ): Promise<{ entityId: string; entityType: string }[]> {
    await this.hydrateReplica();
    const violations = this.registry.validateAction(action);
    if (violations.length > 0) {
      this.emitRegistryViolations(violations, { direction: "inbound" });
    }
    if (action.hlc !== undefined) {
      this.mergeRemoteHLC(action.hlc);
    }
    const delivered = await this.withoutFoldedUpdates(action);
    if (delivered.updates.length > 0) {
      const logged = await this.storage.actions.append(delivered);
      this.replica.ingest(logged.action, logged.added, logged.position);
      this.noteReplicaMutation();
    }
    // The single inbound receipt hook: an Action that matches a buffered
    // Outbox entry (with a server GSN) is this client's own echo, so the
    // entry is now proven canonical and can be removed. Runs after the
    // append so an outbox removal never outruns the action log.
    await this.outbox.matchEcho(action);
    // A server-accepted Action (`gsn > 0`) is proof the client is in sync
    // as of now; a local-only Action has no GSN and says nothing about the
    // server's view.
    if (action.gsn > 0) {
      this.statusController.markSynced();
    }
    const affected = action.updates.map((u) => ({
      entityId: u.subject_id,
      entityType: u.subject_type,
    }));
    if (groupId !== undefined && action.gsn > 0) {
      const prev = await this.storage.cursors.get(groupId);
      if (prev === null || action.gsn > prev) {
        await this.storage.cursors.set(groupId, action.gsn);
      }
    }
    return affected;
  }

  /**
   * Drop the Updates of a delivered Action that its target row already
   * folded.
   *
   * A listing seed stamps each base `put` with the entity's true log
   * position, so the tail then re-delivers Actions at or below it. Folding
   * one would rewrite the row with an older state — a full-replacement
   * `put` above all — until (or unless) the Action that produced the newer
   * state arrives again. `patch` is left alone: it merges field by field by
   * HLC, so folding an older one cannot regress the row and can supply
   * content another group's stream never carried (#473).
   *
   * The guard is row-relative and requires seed provenance: a row's
   * `last_gsn` only means "everything at or below this is folded" when a
   * listing seed produced it. A log-derived row's `last_gsn` is the max of
   * this group's partial history, so an older Action from another group can
   * still carry content it lacks (#473/#475). The delivering group's bound is
   * not enough: a shared row can be seeded by a different group's listing.
   *
   * This guard sits on the delivery seam only. Log replay is exempt: it
   * rebuilds a row from whatever the log holds, in log order, and must not
   * second-guess it.
   */
  private async withoutFoldedUpdates(action: Action): Promise<Action> {
    if (action.gsn <= 0) return action;
    if (action.gsn > this.maxSeededThrough()) return action;

    const kept: Action["updates"][number][] = [];
    for (const update of action.updates) {
      // A patch merges field by field by HLC, so an older one cannot regress
      // the row and can supply content another group's stream never carried
      // (#473). A `put` is a full replacement, so it can.
      if (update.method === "patch") {
        kept.push(update);
        continue;
      }
      const row = this.replica.base(update.subject_id);
      if (row === undefined || action.gsn > row.last_gsn) {
        kept.push(update);
        continue;
      }
      // The row's position is only trustworthy as "already folded" when a
      // listing seed put it there: a log-derived row's `last_gsn` is the max
      // of this group's partial history, not the entity's global position.
      if (action.gsn <= (await this.seededThroughForEntity(update.subject_id))) continue;
      kept.push(update);
    }

    return kept.length === action.updates.length ? action : { ...action, updates: kept };
  }

  private maxSeededThrough(): number {
    let max = 0;
    for (const through of this.seededThrough.values()) max = Math.max(max, through);
    return max;
  }

  private noteSeededAction(action: Action): void {
    if (action.actor_id !== LISTING_SEED_ACTOR_ID) return;
    for (const update of action.updates) {
      const folded = this.seededEntityThrough.get(update.subject_id) ?? 0;
      this.seededEntityThrough.set(update.subject_id, Math.max(folded, action.gsn));
    }
  }

  /**
   * The highest position a listing seed folded into `entityId`.
   *
   * In-session seeds populate this directly. After a restart the seed Actions
   * are already in the log, so the first guarded delivery reads the row's own
   * Actions once rather than persisting an entity-indexed watermark.
   */
  private async seededThroughForEntity(entityId: string): Promise<number> {
    const cached = this.seededEntityThrough.get(entityId);
    if (cached !== undefined) return cached;

    let folded = 0;
    for (const candidate of await this.storage.actions.getForEntity(entityId)) {
      if (candidate.actor_id === LISTING_SEED_ACTOR_ID) {
        folded = Math.max(folded, candidate.gsn);
      }
    }
    this.seededEntityThrough.set(entityId, folded);
    return folded;
  }

  /**
   * Optimistically apply a locally-authored Action to the replica and
   * mirror the composed rows into the `storage.entities` shim, so local
   * reads and replica subscribers reflect the write before the server echo. The Action is not
   * appended to the action log: the log is the replay source the
   * materializer orders by GSN, and an unacknowledged Action has no
   * GSN to order by. The echo — appended with its server GSN — is what
   * eventually lands in the log, and re-deriving from it converges on
   * the same state.
   *
   * A patch or delete whose base row is not cached has nothing to
   * apply to; it is skipped and the echo (or a later catch-up)
   * supplies the base.
   */
  private async applyLocalAction(action: Action): Promise<void> {
    await this.hydrateReplica();
    this.replica.optimistic(action);
    await this.mirrorReplicaRows(action);
  }

  /**
   * Replace the durable rows in the `storage.entities` shim with the
   * replica's composed view, clearing the dirty flag so a later read does
   * not replay the log over them.
   *
   * An on-demand type has no composed replica row to mirror: the replica
   * drops it unless it is open. The store is that type's read source, so the
   * update is applied to the stored row directly. A later `open` then installs
   * and pins it, exactly as it would a row read back from the server.
   *
   * A subject the replica drops is normally left untouched — the shim
   * cannot represent absence, and the echo corrects it. A `delete` is the
   * exception: the shim *can* represent a tombstone, and leaving the row
   * live keeps local membership checks seeing a row the server no longer
   * has (a re-share then silently no-ops against a stale row, #623). A
   * revert deliberately keeps the old behaviour: the row the revert
   * converges on is the one the replica restored.
   */
  private async mirrorReplicaRows(
    action: Action,
    options: { readonly revert?: boolean } = {},
  ): Promise<void> {
    for (const update of action.updates) {
      let row = this.replica.get(update.subject_id);
      if (row === undefined && !this.replica.isHeld(update.subject_type)) {
        const base = await this.storage.entities.get(update.subject_id);
        row = applyUpdate(base, update, 0, action.hlc) ?? undefined;
      }
      if (row === undefined) {
        if (options.revert !== true && update.method === "delete") {
          const base = await this.storage.entities.get(update.subject_id);
          const tombstone = applyUpdate(base, update, 0, action.hlc);
          if (tombstone !== null) {
            await this.storage.dirtyTracker.clear(update.subject_id);
            await this.storage.entities.set(tombstone);
          }
        }
        continue;
      }
      await this.storage.dirtyTracker.clear(update.subject_id);
      await this.storage.entities.set(row);
    }
  }

  /**
   * Replace a losing Action's conflicted row with its freshly-stamped
   * re-assert in one durable store write, then schedule the flush.
   * Validation is skipped — the Action was already accepted into the
   * Outbox before detection, so a schema drift since then is not a reason
   * to refuse the application's explicit retry. An `unreachable` first
   * attempt is not surfaced: the entry is durable, and the scheduler owns
   * the retry.
   */
  private async retryConflicted(originalId: string, action: Action): Promise<void> {
    await this.outbox.retryConflicted(originalId, action);
    await this.flushScheduler.schedule();
  }

  /**
   * Drop a losing Action's optimistic writes, converging the replica on the
   * durable base, and mirror the reverted rows into the async
   * `storage.entities` shim. An entity the server never echoed has no base
   * row: the replica drops it, but the shim cannot represent absence and
   * keeps the stale optimistic row until a durable touch.
   */
  private async reMaterializeFromLog(action: Action): Promise<void> {
    this.replica.discard(action.id);
    await this.mirrorReplicaRows(action, { revert: true });
  }

  /**
   * Forward a batch of registry violations to every registered
   * listener, with the same error-isolation guarantees as
   * `TextDocument.onUpdate`. When no listener is
   * registered and the direction is `inbound`, falls back to
   * `console.warn` so apps that don't opt in keep the pre-hook
   * behavior.
   */
  private emitRegistryViolations(
    violations: readonly ValidationViolation[],
    context: RegistryViolationContext,
  ): void {
    emitRegistryViolations(this.registryViolationListeners, violations, context);
  }
}

/**
 * Fold `extra`'s rows into `base` by id, with `base` winning an overlap. A
 * full record captured before eviction is the source of the rows currently
 * absent from the resident set.
 */
const mergeReplicaRecords = (extra: ReplicaRecord | null, base: ReplicaRecord): ReplicaRecord => {
  if (extra === null) return base;
  const rows = new Map(base.entities.map((entity) => [entity.id, entity]));
  for (const entity of extra.entities) {
    if (!rows.has(entity.id)) rows.set(entity.id, entity);
  }
  return { ...base, entities: [...rows.values()] };
};

/** Keep the rows the resident record no longer carries, preferring its current row. */
const withRetainedRows = (record: ReplicaRecord, durable: ReplicaRecord): ReplicaRecord => {
  const current = new Set(record.entities.map((entity) => entity.id));
  const retained = durable.entities.filter((entity) => !current.has(entity.id));
  return retained.length === 0
    ? record
    : { ...record, entities: [...record.entities, ...retained] };
};

const logReplicaSaveError = (thrown: unknown): void => {
  // eslint-disable-next-line no-console
  console.error("[SyncClient] replica save failed:", thrown);
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a fresh per-client `EntityRegistry` from a `Schema`. We
 * re-register every entity and relationship on a new registry rather
 * than sharing `schema._registry` so a client can mutate its own
 * registry at runtime without bleeding across clients that share
 * the same `schema` value. The `Relationship` system entity is
 * seeded so the public relationship-write path (`link` / `unlink` /
 * `setLinks`) can submit Relationship Updates.
 */
const buildRegistryFromSchema = (schema: AnySchema | undefined): EntityRegistry => {
  const registry = new EntityRegistry();
  if (schema === undefined) return registry;
  seedRegistry(registry, schema.entities, schema.relationships);
  return registry;
};

/**
 * Replica residency declared by the entity registry. A type marked
 * `on-demand` is materialized only while open; anything else — including a
 * type the registry does not declare — stays held.
 */
const residencyFromRegistry = (registry: EntityRegistry): MaterializationPolicy => ({
  holds: (type) => registry.get(type)?.materialization !== "on-demand",
});

/**
 * Deterministic content hash of a composed schema. The 64-bit FNV-1a
 * digest of a JSON canonical form (object keys sorted at every
 * level) is enough for the server-side drift check; the hash is not
 * a security primitive.
 *
 * Entity and relationship records are walked by value — the schema
 * itself is frozen, but TypeBox shapes carry non-enumerable
 * `nullable` chains and other helpers that `JSON.stringify` ignores
 * by default, so two schemas that differ only in those helpers hash
 * the same.
 */
const computeSchemaHash = (schema: AnySchema): string => fnv1a64(stableStringify(schema));

/** JSON.stringify with object keys sorted at every level. Arrays keep insertion order. */
const stableStringify = (value: unknown): string => {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "undefined" || typeof value === "function") return "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
  }
  return "null";
};

const FNV_OFFSET_64 = 0xcbf29ce484222325n;
const FNV_PRIME_64 = 0x100000001b3n;

/** 64-bit FNV-1a, returned as a 16-char lowercase hex string. */
const fnv1a64 = (input: string): string => {
  let hash = FNV_OFFSET_64;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * FNV_PRIME_64);
  }
  return hash.toString(16).padStart(16, "0");
};

/**
 * Aggregate `validateAction` violations across a write batch. The
 * registry validates one action at a time; `write` calls this once per
 * batch to mirror the server's `rejected[]` mental model.
 */
const collectViolations = (
  actions: readonly Action[],
  registry: EntityRegistry,
): ValidationViolation[] => {
  const out: ValidationViolation[] = [];
  for (const action of actions) {
    out.push(...registry.validateAction(action));
  }
  return out;
};

/**
 * Fire `onRegistryViolation` for every registered listener. Throws
 * from a listener are isolated (logged, not propagated) so one bad
 * handler can't break the others — matches the existing
 * `onUpdate` error-isolation pattern on
 * `TextDocument`. When no listener is registered and the direction is
 * `inbound`, falls back to `console.warn` so apps that don't opt in
 * keep the pre-hook behavior.
 */
const emitRegistryViolations = (
  listeners: ReadonlySet<RegistryViolationListener>,
  violations: readonly ValidationViolation[],
  context: RegistryViolationContext,
): void => {
  if (listeners.size === 0) {
    if (context.direction === "inbound") {
      for (const v of violations) {
        // eslint-disable-next-line no-console
        console.warn("[EntityRegistry] incoming action violation:", v);
      }
    }
    return;
  }
  for (const cb of listeners) {
    try {
      cb(violations, context);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[SyncClient] onRegistryViolation handler threw:", err);
    }
  }
};

interface ActiveSubscription {
  groupIds: string[];
  onEvent: (event: SSEEvent) => void;
  cancelled: boolean;
  stream: SSESubscription | null;
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

/**
 * The wake-up for backfill (#475): an `entityGroup` put is the delivery
 * that can name an entity the client cannot materialize.
 */
const isMembershipPut = (action: Action): boolean =>
  action.updates.some((update) => update.subject_type === "entityGroup" && update.method === "put");

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
 * Params declared by a definition, or `never` when it can't be read.
 */
type ParamsOf<D> = D extends ActionDef<infer _S, infer P, infer _R> ? P : never;

/** Return value declared by a definition. */
type ResultOf<D> = D extends ActionDef<infer _S, infer _P, infer R> ? R : never;

/**
 * `client.actions` surface, keyed by the names in `actions`. Present
 * only when the client was built with a `Schema`; empty when no
 * actions were passed.
 */
export type ActionNamespaces<
  S,
  TActions extends Record<string, AnyActionDef> = Record<string, never>,
> =
  S extends Schema<Record<string, AnyEntityDef>, unknown>
    ? {
        readonly actions: {
          [K in keyof TActions]: BoundAction<S, ParamsOf<TActions[K]>, ResultOf<TActions[K]>>;
        };
      }
    : // eslint-disable-next-line @typescript-eslint/ban-types
      {};

/**
 * Returned by {@link createClient}: the standard `SyncClient` surface
 * plus typed entity namespaces, `atomic(...)`, and `actions`.
 */
export type NamespacedClient<
  S,
  TActions extends Record<string, AnyActionDef> = Record<string, never>,
> = SyncClient & EntityNamespaces<S> & AtomicClient<S> & ActionNamespaces<S, TActions>;

/**
 * Factory for {@link SyncClient}. Prefer this over `new SyncClient(...)`
 * so the import surface stays tidy.
 *
 * When `opts.schema` is a `Schema`, the returned client is a Proxy
 * that exposes `client.<entityName>.query()` — the typed thenable
 * chain — for every entity declared on the schema, plus `client.atomic`
 * and `client.actions`. The Proxy binds every method to the underlying
 * `SyncClient` so private-field access inside the SDK still resolves
 * correctly.
 */
export function createClient<
  S extends AnySchema | undefined = undefined,
  TActions extends Record<string, AnyActionDef> = Record<string, never>,
>(opts: SyncClientOptions & { schema?: S; actions?: TActions }): NamespacedClient<S, TActions> {
  if (opts.actions !== undefined && opts.schema === undefined) {
    throw new ActionDefinitionError([{ message: "createClient: `actions` requires a `schema`" }]);
  }
  const client = new SyncClient(opts);
  if (opts.schema === undefined) {
    return client as NamespacedClient<S, TActions>;
  }
  // Narrow capability the namespace consults for write-side
  // operations. Keeps the namespace free of the cyclic
  // `client → namespace → client` reference.
  const writeCap = {
    registry: client.registry,
    submitRelationshipUpdates: client.submitRelationshipUpdates.bind(client),
    freshHlc: () => client.freshHlc(),
    generateUpdateId: () => client.generateUpdateId(),
    actorId: client.actorId,
    openTextDocument: (docId: string, docType: string) =>
      client.openDerivedTextDocument(docId, docType),
    // `findPreSyncRow` reads the entity's earliest unresolved conflict's
    // `before` row (the conflicts view owns the detection-HLC ordering).
    readPreSyncRow: (entityId: string) => findPreSyncRow(client.conflicts, entityId),
    // The atomic membership drafts resolve a removal against the local
    // cache after the synchronous callback returns.
    readMemberships: (entityId: string) => readEntityMemberships(client.storage, entityId),
    // A membership change carries the entity's generated documents and
    // their edges, resolved from the local cache after the callback.
    readGeneratedParts: (entityType: string, entityId: string) =>
      readGeneratedParts(client.storage, client.registry, entityType, entityId),
  };
  const namespaces = buildEntityNamespaces(opts.schema, client.storage, writeCap, {
    replica: client.replica,
    queries: client.queries,
    signal: client.replicaSignal,
    hydrated: () => client.isReplicaHydrated(),
    // Arrow over the public method keeps the namespace free of the
    // `client → namespace → client` import cycle.
    hydrate: () => client.hydrateReplica(),
  });
  // `client.atomic` needs the same write capability the namespace
  // uses. Defining it on the instance keeps the typed surface on
  // `NamespacedClient` while leaving bare `SyncClient` without it
  // (the resolver requires a schema).
  const atomicRuntime = createAtomicRuntime(opts.schema, writeCap);
  Object.defineProperty(client, "atomic", {
    value: atomicRuntime,
    enumerable: false,
    configurable: true,
  });
  // Each action mounts as a fresh wrapper so one definition can be
  // reused across clients; `.name` carries the map key.
  const actionNamespaces: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(opts.actions ?? {})) {
    if (raw.schema !== opts.schema) {
      throw new ActionDefinitionError([
        { actionName: key, message: "action was defined against a different schema" },
      ]);
    }
    // The descriptor's erased view; Params / Result are restored on
    // `client.actions` via the `TActions` generic.
    const run = (
      raw as unknown as { readonly [RUN]: (drafts: unknown, params: unknown) => unknown }
    )[RUN];
    const wrapper = (params: unknown): Promise<unknown> =>
      atomicRuntime((drafts) => run(drafts, params));
    Object.defineProperty(wrapper, "name", { value: key, configurable: true });
    actionNamespaces[key] = wrapper;
  }
  Object.defineProperty(client, "actions", {
    value: actionNamespaces,
    enumerable: false,
    configurable: true,
  });
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (typeof prop === "string") {
        const ns = (namespaces as Record<string, unknown>)[prop];
        if (ns !== undefined) return ns;
      }
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function") {
        return value.bind(target);
      }
      return value;
    },
  }) as NamespacedClient<S, TActions>;
}
