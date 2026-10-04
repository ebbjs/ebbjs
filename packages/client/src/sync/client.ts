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

import {
  encodeSync,
  type Action,
  createClock,
  type Entity,
  type HLCState,
  localEvent,
  receiveRemoteHLC,
  type Update,
} from "@ebbjs/core";
import { createMemoryAdapter } from "@ebbjs/storage/memory";
import type { StorageAdapter } from "@ebbjs/storage/types";

import { ConnectionStateMachine, type ConnectionState } from "./connection-state";
import { PresenceManager } from "../presence/presence";
import { openSSEStream, type SSESubscription } from "./sse";
import { createOutbox, type Outbox } from "./outbox";
import { TextDocument, TextDocumentRegistry } from "../fields/collaborative-text/text-document";
import {
  EntityRegistry,
  EntityValidationError,
  type ValidationViolation,
} from "../schema/entity-registry";
import type { RelationshipDef } from "../schema/relationship";
import {
  buildRelationshipUpdate,
  normalizeManyPointers,
  normalizePointer,
  resolveCardinality,
  type BuildRelationshipWriteOptions,
  type BuildRelationshipWriteResult,
} from "./relationship";
import { buildEntityNamespaces, type EntityNamespaces } from "./namespace";
import { createAtomicRuntime, type AtomicClient } from "./atomic";
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

export class SyncClient {
  readonly serverUrl: string;
  readonly actorId: string;
  readonly storage: StorageAdapter;
  readonly presence: PresenceManager;
  readonly registry: EntityRegistry;
  readonly schema?: AnySchema;
  /**
   * Local write buffer. Every locally-authored Action passes through
   * here — `write()` enqueues (optimistically applying it) and flushes
   * — so the pending list is observable and later stages can add
   * durability and retry without touching write callers.
   */
  readonly outbox: Outbox;
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
   * `handshake()`. The relationship write path uses this for the
   * client-side early permission check (the `<source_type>.update`
   * rule the server also enforces — see `permission_checker.ex`).
   */
  private actorGroups: { id: string; permissions: readonly string[] }[] = [];
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
   * User-registered listeners for schema-registry violations. Fired
   * by `emitRegistryViolations`; replaces the default `console.warn`
   * on inbound violations when at least one listener is present.
   */
  private readonly registryViolationListeners = new Set<RegistryViolationListener>();

  constructor(opts: SyncClientOptions) {
    this.serverUrl = opts.serverUrl.replace(/\/$/, "");
    this.actorId = opts.actorId;
    this.storage = opts.storage ?? createMemoryAdapter();
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.reconnectInitialMs = opts.reconnectInitialMs ?? DEFAULT_RECONNECT_INITIAL_MS;
    this.reconnectMaxMs = opts.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;
    this.schema = opts.schema;
    this.schemaHash = opts.schema === undefined ? undefined : computeSchemaHash(opts.schema);
    // Empty registry makes validation a no-op.
    this.registry = opts.registry ?? buildRegistryFromSchema(opts.schema);
    if (opts.onRegistryViolation !== undefined) {
      this.registryViolationListeners.add(opts.onRegistryViolation);
    }
    // PresenceManager wires itself to the SSE stream; the `presence`
    // field on the client is the public API for sending local
    // cursors and reading the map of remote ones. The manager lives
    // for the lifetime of the client; consumers should call
    // `client.close()` (already wired in the existing close path)
    // when tearing down.
    this.presence = new PresenceManager(this);
    this.outbox = createOutbox({
      applyOptimistic: (action) => this.applyLocalAction(action),
      submit: (actions) => this.submitActions(actions),
    });
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

    const sub: ActiveSubscription = {
      groupIds: [...groupIds],
      onEvent,
      cancelled: false,
      stream: null,
      fromGsn,
    };
    this.activeSub = sub;

    // Transition to `connecting` unless we're already there or live
    // (e.g., a second subscribe call while one is already streaming).
    const s = this.stateMachine.state;
    if (s !== "live" && s !== "connecting") {
      this.stateMachine.transition("connecting");
    }

    this.runSubscriptionLoop(sub);
    return () => this.cancelSubscription(sub);
  }

  /**
   * `POST /sync/handshake` — exchange identity and group membership.
   *
   * On success, the per-group cursors returned by the server are cached so
   * subsequent `catchUp` / `subscribe` calls can pick up where we left off.
   */
  async handshake(opts: HandshakeRequest = {}): Promise<HandshakeResult> {
    const url = `${this.serverUrl}/sync/handshake`;
    const body = JSON.stringify({
      cursors: opts.cursors ?? {},
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

    // Refresh the cursor cache from the server's authoritative cursors.
    this.groupCursors.clear();
    this.actorGroups = result.groups.map((g) => ({ id: g.id, permissions: g.permissions }));
    for (const g of result.groups) {
      this.groupCursors.set(g.id, g.cursor);
    }
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

    return { actions, nextOffset, upToDate };
  }

  /**
   * `POST /sync/actions` — submit a batch of locally-produced Actions
   * via the {@link Outbox}.
   *
   * Validates each action against the local `EntityRegistry`, then
   * enqueues it (optimistically applying its Updates to the local
   * cache) and flushes the buffer. Returns the server's response; the
   * server may reject some actions (permissions, HLC drift, dedup) and
   * the caller decides how to handle them.
   *
   * Schema violations throw `EntityValidationError` aggregating every
   * violation across the batch before anything is enqueued — matches
   * the server's `rejected[]` mental model so callers handle
   * client-side and server-side rejections uniformly.
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
    for (const action of actions) {
      await this.outbox.enqueue(action);
    }
    return this.outbox.flush();
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
   * local events stay monotonic. The clock is best-effort — a
   * malformed or drift-exceeding remote HLC is logged and ignored
   * rather than rejecting the inbound Action.
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
    // Action's refusal — rejections are a per-call return, not outbox state.
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
   * a malformed or drift-exceeding HLC is swallowed so the storage
   * materialization still happens.
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
   * Tear down all subscriptions and timers. After `close()` the client is
   * unusable; create a new one with `createClient`.
   */
  close(): void {
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
   * client.subscribe(groupIds, cursor, (ev) => {
   *   if (ev.type === 'data') doc.applyActions([ev.action]);
   * });
   * ```
   */
  textDocument(docId: string): TextDocument {
    return this.textDocumentRegistry.open({ docId, actorId: this.actorId });
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
   * The early client-side permission check runs by default: if the
   * actor's known groups do not include `<source_type>.update` (or
   * `<source_type>.*`), the write is rejected with
   * `EntityValidationError` before it reaches the outbox. The server
   * remains the trust boundary; this is fast-feedback UX. The check
   * is best-effort — when `handshake()` hasn't been called yet, the
   * actor has no cached groups, the check is skipped, and the server
   * remains the final authority.
   */
  buildRelationshipWrite(opts: BuildRelationshipWriteOptions): BuildRelationshipWriteResult {
    const { source, as } = opts;
    const sourceName = source.name;

    // An unknown source name is the same class of error as an unknown
    // subject_type in `validateAction`. The target is treated as a
    // wire-level id reference — the server validates its existence
    // at write time, and primitives like `ownedBy` point the source
    // at a group (system entity), not at a user entity.
    this.checkEntityRegistered(sourceName, "source");

    const cardinality = resolveCardinality(this.registry, sourceName, as, opts.sourceCardinality);

    this.checkRelationshipPermission(sourceName);

    if (cardinality === "one") {
      const sourceId = requireSourceId(opts, as);
      const targetId = normalizePointer(opts.targetId, `targetId for "${as}"`);
      const updateId = generateId("u");
      const relationshipId = opts.relationshipSubjectId ?? generateId("rel");
      const relUpdate = buildRelationshipUpdate({
        relationshipId,
        sourceId,
        targetId,
        field: as,
        type: this.wireTypeFor(sourceName, as),
        updateId,
      });
      return { relationshipUpdate: relUpdate };
    }

    // Many-cardinality.
    const entityUpdate = requireEntityUpdate(opts, as);
    const sourceId = entityUpdate.subject_id;
    const targetIds = opts.targetIds;
    const wireType = this.wireTypeFor(sourceName, as);
    const updates: Update[] = [];
    if (targetIds === undefined) {
      // No `targetIds` — emit the entity Update with no relationship
      // edges. Matches `targetId: null` on the one-cardinality side;
      // the `many` side has no per-edge delete in this primitive.
      return { entityUpdate, relationshipUpdate: updates };
    }
    if ("replace" in targetIds) {
      const normalized = normalizeManyPointers(targetIds, `targetIds for "${as}"`);
      for (const targetId of normalized) {
        updates.push(this.makeManyRelationshipUpdate(sourceId, as, wireType, targetId));
      }
    } else {
      for (const targetId of targetIds.add) {
        const id = normalizePointer(targetId, `targetIds.add for "${as}"`);
        if (id === null) continue;
        updates.push(this.makeManyRelationshipUpdate(sourceId, as, wireType, id));
      }
      for (const targetId of targetIds.remove) {
        const id = normalizePointer(targetId, `targetIds.remove for "${as}"`);
        if (id === null) continue;
        updates.push(this.makeManyRelationshipUpdate(sourceId, as, wireType, id));
      }
    }
    return { entityUpdate, relationshipUpdate: updates };
  }

  private makeManyRelationshipUpdate(
    sourceId: string,
    as: string,
    wireType: string,
    targetId: string,
  ): Update {
    return buildRelationshipUpdate({
      relationshipId: generateId("rel"),
      sourceId,
      targetId,
      field: as,
      type: wireType,
      updateId: generateId("u"),
    });
  }

  /**
   * Resolve the wire-level `type` string for a relationship: prefer
   * the registry's stored `type` override; fall back to the source
   * entity name. Matches `defineRelationship`'s default.
   */
  private wireTypeFor(sourceName: string, as: string): string {
    const rel = this.registry.getRelationship(sourceName, as);
    return rel?.type ?? sourceName;
  }

  /**
   * Early client-side permission check. The default rule mirrors the
   * server's intra-action rule: the actor must have
   * `<source_type>.update` (or `<source_type>.*`) in some group they
   * belong to. Best-effort: when `handshake()` hasn't populated the
   * group cache, the check is skipped.
   */
  private checkRelationshipPermission(sourceType: string): void {
    if (this.actorGroups.length === 0) return;
    const required = `${sourceType}.update`;
    const wildcard = `${sourceType}.*`;
    const allowed = this.actorGroups.some(
      (g) => g.permissions.includes(required) || g.permissions.includes(wildcard),
    );
    if (!allowed) {
      throw new EntityValidationError([
        {
          entityName: sourceType,
          message: `buildRelationshipWrite: actor lacks "${required}" permission in any known group`,
        },
      ]);
    }
  }

  /**
   * Surface unknown source/target entity names as a typed
   * `EntityValidationError`. When no entities are registered at all
   * (validation is a no-op across the SDK) the call is skipped —
   * the server is the authority in that case.
   */
  private checkEntityRegistered(name: string, role: "source" | "target"): void {
    if (this.registry.isEmpty()) return;
    if (this.registry.has(name)) return;
    throw new EntityValidationError([
      {
        entityName: name,
        message: `buildRelationshipWrite: ${role} entity "${name}" is not registered in the EntityRegistry`,
      },
    ]);
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
      if (result === "giveup" || result === "cancelled") return;
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
    if (!control.reconnect) return;
    const from = control.catchUpFrom;
    if (from === undefined) return;
    // Server told us our cursor is stale — close the current stream and
    // re-open after catching up.
    // eslint-disable-next-line no-console
    console.warn(`[SyncClient] server reports stale cursor; catching up from GSN ${from}`);
    for (const gid of sub.groupIds) {
      this.groupCursors.set(gid, from);
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

  private cancelSubscription(sub: ActiveSubscription): void {
    sub.cancelled = true;
    this.closeStream(sub);
    if (sub === this.activeSub) {
      this.activeSub = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      // Wake up `runSubscriptionLoop` so it observes `sub.cancelled`
      // and exits, instead of waiting on a dead timer.
      const resolve = this.reconnectTimerResolve;
      this.reconnectTimerResolve = null;
      if (resolve) resolve();
    }
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
   * After the action lands in the action log and the affected
   * entities are marked dirty, this method force-materializes each
   * affected entity so subscribers on the storage adapter's change
   * emitter observe the new state immediately. The materialize-on-
   * read contract would otherwise require every consumer to issue
   * a read first — not viable for per-collection subscribe, which
   * must surface changes without a forced read.
   */
  private async _applyAction(
    action: Action,
    groupId?: string,
  ): Promise<{ entityId: string; entityType: string }[]> {
    const violations = this.registry.validateAction(action);
    if (violations.length > 0) {
      this.emitRegistryViolations(violations, { direction: "inbound" });
    }
    if (action.hlc !== undefined) {
      this.mergeRemoteHLC(action.hlc);
    }
    await this.storage.actions.append(action);
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
    if (this.storage.changeEmitter !== undefined) {
      const keepDirty = this.storage.materializeKeepDirty;
      for (const { entityId } of affected) {
        if (keepDirty !== undefined) {
          await keepDirty(entityId);
        } else {
          await this.storage.entities.get(entityId);
        }
      }
    }
    return affected;
  }

  /**
   * Optimistically apply a locally-authored Action to the cached
   * entities, firing the change emitter so local reads and subscribers
   * reflect the write before the server echo. The Action is not
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
    for (const update of action.updates) {
      const current = await this.storage.entities.get(update.subject_id);
      const next = applyLocalUpdate(current, update, action.hlc);
      if (next === null) continue;
      await this.storage.entities.set(next);
    }
  }

  /**
   * Forward a batch of registry violations to every registered
   * listener, with the same error-isolation guarantees as
   * `TextDocument.onUpdate` / `onConflict`. When no listener is
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
 * Project a locally-authored Update onto the cached Entity for the
 * optimistic apply. Returns `null` when a patch or delete has no base
 * row to apply to — the server echo (or a later catch-up) supplies it.
 *
 * Unlike the storage materializer's full LWW merge, a field-level
 * spread is enough: the Update was stamped from this client's HLC
 * clock after every HLC the cache has seen, so each patched field is
 * newer than the cached one and wins outright.
 */
const applyLocalUpdate = (current: Entity | null, update: Update, hlc: string): Entity | null => {
  const fields = update.data?.fields ?? {};
  switch (update.method) {
    case "put":
      return {
        id: update.subject_id,
        type: update.subject_type,
        data: { fields },
        created_hlc: hlc,
        updated_hlc: hlc,
        deleted_hlc: null,
        last_gsn: 0,
      };
    case "patch":
      if (current === null) return null;
      if (current.deleted_hlc) return current;
      return {
        ...current,
        data: { fields: { ...current.data.fields, ...fields } },
        // `applyUpdate` keeps the existing `updated_hlc` on a patch, so
        // the optimistic entity carries it too and the post-echo replay
        // lands on an identical entity.
      };
    case "delete":
      if (current === null) return null;
      return { ...current, deleted_hlc: hlc, updated_hlc: hlc };
  }
};

/**
 * Fire `onRegistryViolation` for every registered listener. Throws
 * from a listener are isolated (logged, not propagated) so one bad
 * handler can't break the others — matches the existing
 * `onUpdate` / `onConflict` error-isolation pattern on
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
 * Resolve the `sourceId` from `BuildRelationshipWriteOptions`. The
 * one-cardinality wire doesn't carry an entity Update, so the
 * caller supplies `sourceId` directly.
 */
function requireSourceId(opts: BuildRelationshipWriteOptions, as: string): string {
  if (opts.sourceId !== undefined && opts.sourceId.length > 0) return opts.sourceId;
  throw new EntityValidationError([
    {
      entityName: opts.source.name,
      message: `buildRelationshipWrite: sourceId is required for one-cardinality relationship "${as}"`,
    },
  ]);
}

/**
 * Resolve the entity Update from `BuildRelationshipWriteOptions`.
 * The many-cardinality wire carries the canonical FK set on the
 * source entity's data field, so the entity Update is required.
 */
function requireEntityUpdate(opts: BuildRelationshipWriteOptions, as: string): Update {
  if (opts.entityUpdate !== undefined) return opts.entityUpdate;
  throw new EntityValidationError([
    {
      entityName: opts.source.name,
      message: `buildRelationshipWrite: entityUpdate is required for many-cardinality relationship "${as}"`,
    },
  ]);
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
    buildRelationshipWrite: client.buildRelationshipWrite.bind(client),
    submitRelationshipUpdates: client.submitRelationshipUpdates.bind(client),
    freshHlc: () => client.freshHlc(),
    generateUpdateId: () => client.generateUpdateId(),
  };
  const namespaces = buildEntityNamespaces(opts.schema, client.storage, writeCap);
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
