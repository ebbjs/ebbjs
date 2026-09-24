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

import { encodeSync, type Action, type Entity, type Update } from "@ebbjs/core";
import { createMemoryAdapter } from "@ebbjs/storage";
import type { StorageAdapter } from "@ebbjs/storage";

import { ConnectionStateMachine, type ConnectionState } from "./connection-state";
import { PresenceManager } from "../presence/presence";
import { openSSEStream, type SSESubscription } from "./sse";
import { TextDocument, TextDocumentRegistry } from "../fields/collaborative-text/text-document";
import {
  EntityRegistry,
  EntityValidationError,
  type ValidationViolation,
} from "../schema/entity-registry";
import type { RelationshipDef } from "../schema/relationship";
import {
  buildRelationshipUpdate,
  forwardMany,
  forwardOne,
  normalizeManyPointers,
  normalizePointer,
  resolveCardinality,
  reverse as reverseTraversal,
  type BuildRelationshipWriteOptions,
  type BuildRelationshipWriteResult,
  type RelationshipHandleInput,
} from "./relationship";
import { stripField } from "./entity-fields";
import type { PrimitiveQueryBuilder } from "./query-builder";
import { mountNamespace } from "./namespace";
import { generateId } from "@ebbjs/core";
import type { EntityDef, FieldMarker } from "../schema/entity";
import type { Schema } from "../schema/schema";

type AnyEntityDef = EntityDef<Record<string, FieldMarker>>;
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
   * Latest actor's group memberships with permissions, populated by
   * `handshake()`. The relationship write path uses this for the
   * client-side early permission check (the `<source_type>.update`
   * rule the server also enforces — see `permission_checker.ex`).
   */
  private actorGroups: { id: string; permissions: readonly string[] }[] = [];
  /** TextDocument registry (one document per docId, per actor). */
  private readonly textDocumentRegistry = new TextDocumentRegistry();
  /**
   * User-registered listeners for schema-registry violations. Fired
   * by `emitRegistryViolations`; replaces the default `console.warn`
   * on inbound violations when at least one listener is present.
   */
  private readonly registryViolationListeners = new Set<RegistryViolationListener>();
  /**
   * Synchronous snapshot of materialized entities. The handle's
   * field getters (`client.todo(id).title`) read from this map
   * rather than the storage adapter — the storage adapter's read
   * API is async, but JS property access is synchronous. The
   * snapshot is hydrated on every `readLocalEntity` call and on
   * every `_applyAction` receipt so the latest state is always
   * visible to the handle.
   */
  private readonly entitySnapshot = new Map<string, Entity>();

  constructor(opts: SyncClientOptions) {
    this.serverUrl = opts.serverUrl.replace(/\/$/, "");
    this.actorId = opts.actorId;
    this.storage = opts.storage ?? createMemoryAdapter();
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.reconnectInitialMs = opts.reconnectInitialMs ?? DEFAULT_RECONNECT_INITIAL_MS;
    this.reconnectMaxMs = opts.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;
    this.schema = opts.schema;
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
    // Mount the per-entity namespace when a schema is provided.
    // The runtime walks `schema.entities` once at construction
    // time and installs every accessor via Object.defineProperty,
    // matching design pin #1 in #158. When no schema is given, no
    // accessors are mounted and the developer uses the generic
    // `client.write` / `client.queryEntities` surface directly.
    if (this.schema !== undefined) {
      mountNamespace(this, this.schema as unknown as Parameters<typeof mountNamespace>[1]);
    }
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
   * `POST /sync/actions` — submit a batch of locally-produced Actions.
   *
   * The server may reject some (permissions, HLC drift, dedup). Returns the
   * rejected list; the caller decides how to handle the failure (rollback,
   * retry, surface to UI).
   *
   * Validates each action against the local `EntityRegistry` before any
   * network call. Schema violations throw `EntityValidationError`
   * aggregating every violation across the batch — matches the server's
   * `rejected[]` mental model so callers handle client-side and server-side
   * rejections uniformly.
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
   *
   * Side effect: hydrates the synchronous snapshot that
   * `readLocalEntitySync` reads from so subsequent handle
   * field-getter calls see the latest materialization without an
   * extra round trip.
   */
  async readLocalEntity(id: string): Promise<Entity | null> {
    const entity = await this.storage.entities.get(id);
    if (entity !== null) {
      this.entitySnapshot.set(id, entity);
    }
    return entity;
  }

  /**
   * Synchronous read against the snapshot the handle's getters use.
   * Returns `null` when the id isn't in the snapshot — callers can
   * call `readLocalEntity(id)` first to hydrate.
   *
   * The `expectedType` and `field` arguments are unused at runtime;
   * they exist so the handle's getter signature reads naturally at
   * the call site. The static types live on the handle's getter.
   *
   * Returns the field's value when `field` is provided and present
   * on the entity; returns the entity itself when only
   * `expectedType` is provided; returns `null` when the entity is
   * absent from the snapshot.
   */
  readLocalEntitySync(id: string, _expectedType?: string, field?: string): unknown {
    const entity = this.entitySnapshot.get(id);
    if (entity === undefined) return undefined;
    if (field === undefined) return entity;
    const fv = entity.data?.fields?.[field];
    if (fv === undefined) return undefined;
    return fv.value;
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

  // -------------------------------------------------------------------------
  // Relationship handle
  // -------------------------------------------------------------------------

  /**
   * Open a relationship handle. Returns an object with `forward(id)`
   * and `reverse(id)` accessors that operate against the client's
   * materialized cache.
   *
   * The handle looks the relationship up in the local
   * `EntityRegistry`; calling `relationship({...})` without first
   * registering the relationship (or without having passed a registry
   * to the client) is allowed but the traversal functions will
   * silently miss. `buildRelationshipWrite` is the safer path because
   * it validates the source name against the registry.
   *
   * The handle is namespace-independent: it works without an
   * `EntityRegistry` and across server-side scripts / Node SSR use
   * cases.
   */
  relationship(input: RelationshipHandleInput): RelationshipHandle {
    const registered = this.registry.getRelationship(input.source.name, input.as);
    const rel = registered ?? {
      source: { name: input.source.name, fields: {} },
      target: { name: input.target.name, fields: {} },
      as: input.as,
      sourceCardinality: "one" as const,
      type: input.source.name,
    };
    const sourceName = input.source.name;
    const targetName = input.target.name;
    const field = rel.as;
    const relType = rel.type;
    const cardinality = rel.sourceCardinality;

    const readLocalEntity = (id: string): Promise<Entity | null> => this.storage.entities.get(id);
    const queryEntitiesByType = (type: string): Promise<readonly Entity[]> =>
      this.storage.entities.query(type);

    const handle: RelationshipHandle = {
      forward: (sourceId: string): Promise<Entity | undefined> | Promise<PrimitiveQueryBuilder> => {
        if (cardinality === "one") {
          return forwardOne(readLocalEntity, sourceId, sourceName, field);
        }
        return forwardMany(
          readLocalEntity,
          queryEntitiesByType,
          sourceId,
          sourceName,
          targetName,
          field,
        );
      },
      reverse: (targetId: string): Promise<PrimitiveQueryBuilder> => {
        return reverseTraversal(
          readLocalEntity,
          queryEntitiesByType,
          targetId,
          sourceName,
          field,
          relType,
        );
      },
    };
    return handle;
  }

  /**
   * Build an `(entityUpdate, relationshipUpdate)` pair for a single
   * relationship write. Mirrors the existing wire shape the server's
   * `RelationshipCache` already accepts.
   *
   * Pointer values may be a string id or an entity-shape object
   * (anything with a string `.id`); both are normalized to the id at
   * write time. Anything else is rejected with `EntityValidationError`.
   *
   * For `sourceCardinality: "many"`, pass `targetIds` (not
   * `targetId`):
   *   - `{ replace: [...] }` — overwrite the source's FK set
   *   - `{ add: [...], remove: [...] }` — patch the set
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
    const { source, as, entityUpdate } = opts;
    const sourceName = source.name;

    // Validate that the source is a registered entity. An unknown
    // source name is the same class of error as an unknown
    // subject_type in `validateAction`; surface it as
    // `EntityValidationError` so callers handle the rejection the
    // same way.
    //
    // The target is treated as a wire-level id reference — the
    // server validates its existence at write time, and primitives
    // like the `ownedBy` pattern point the source at a group
    // (system entity), not at a user entity. The validation here
    // intentionally doesn't cover the target.
    this.checkEntityRegistered(sourceName, "source");

    const cardinality = resolveCardinality(this.registry, sourceName, as, opts.sourceCardinality);

    // Run the client-side permission early-check. Match the server's
    // intra-action rule: the actor needs `<source_type>.update` (or
    // `<source_type>.*`) somewhere in their known groups. When no
    // groups are known yet (handshake hasn't run), we don't error —
    // the server is the authority.
    this.checkRelationshipPermission(sourceName);

    // The relationship pointer field is carried on the entity Update
    // for `sourceCardinality: "many"` (the canonical set lives on
    // the source) and on the separate Relationship Update for
    // `sourceCardinality: "one"` (the relationship is the canonical
    // link). For "one", strip the field from the entity Update so
    // the wire doesn't carry the FK twice. For "many", leave the
    // field alone so the developer can carry the canonical set.
    const cleanEntityUpdate: Update =
      cardinality === "one" ? stripField(entityUpdate, as) : entityUpdate;

    const sourceId = entityUpdate.subject_id;

    if (cardinality === "one") {
      const targetId = normalizePointer(opts.targetId, `targetId for "${as}"`);
      const updateId = generateId("u");
      const relationshipId = generateId("rel");
      const relUpdate = buildRelationshipUpdate({
        relationshipId,
        sourceId,
        targetId,
        field: as,
        type: this.wireTypeFor(sourceName, as),
        updateId,
      });
      return { entityUpdate: cleanEntityUpdate, relationshipUpdate: relUpdate };
    }

    // sourceCardinality === "many"
    const targetIds = opts.targetIds;
    const wireType = this.wireTypeFor(sourceName, as);
    const updates: Update[] = [];
    if (targetIds === undefined) {
      // No-op: produce an empty relationship-update array. The
      // developer can still submit the entity update with no
      // relationship edges (matches `targetId: null` on the
      // one-cardinality side; the `many` side has no per-edge
      // delete in this primitive).
      return { entityUpdate: cleanEntityUpdate, relationshipUpdate: updates };
    }
    const normalized = normalizeManyPointers(targetIds, `targetIds for "${as}"`);
    // For replace: emit a PUT per target id; the source entity's array
    // field carries the canonical set, and these Relationship Updates
    // materialize the link edges.
    // For patch: same shape — PUT for adds, DELETE for removes.
    if ("replace" in targetIds) {
      for (const targetId of normalized) {
        const relId = generateId("rel");
        const updateId = generateId("u");
        updates.push(
          buildRelationshipUpdate({
            relationshipId: relId,
            sourceId,
            targetId,
            field: as,
            type: wireType,
            updateId,
          }),
        );
      }
    } else {
      for (const targetId of targetIds.add) {
        const id = normalizePointer(targetId, `targetIds.add for "${as}"`);
        if (id === null) continue;
        const relId = generateId("rel");
        const updateId = generateId("u");
        updates.push(
          buildRelationshipUpdate({
            relationshipId: relId,
            sourceId,
            targetId: id,
            field: as,
            type: wireType,
            updateId,
          }),
        );
      }
      for (const targetId of targetIds.remove) {
        const id = normalizePointer(targetId, `targetIds.remove for "${as}"`);
        if (id === null) continue;
        const relId = generateId("rel");
        const updateId = generateId("u");
        updates.push(
          buildRelationshipUpdate({
            relationshipId: relId,
            sourceId,
            targetId: id,
            field: as,
            type: wireType,
            updateId,
          }),
        );
      }
    }
    return { entityUpdate: cleanEntityUpdate, relationshipUpdate: updates };
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
   */
  private async _applyAction(
    action: Action,
    groupId?: string,
  ): Promise<{ entityId: string; entityType: string }[]> {
    const violations = this.registry.validateAction(action);
    if (violations.length > 0) {
      this.emitRegistryViolations(violations, { direction: "inbound" });
    }
    await this.storage.actions.append(action);
    // Invalidate the synchronous snapshot for every entity affected
    // by this action so the handle's getters re-read on their next
    // access. We deliberately avoid hydrating here: the in-memory
    // adapter's `entities.get` clears the dirty flag during
    // materialization, which would break the
    // `_applyAction` → `isDirty` invariant exercised by
    // `src/sync/sse.test.ts`. Snapshot hydration is lazy through
    // `readLocalEntity` instead.
    for (const u of action.updates) {
      this.entitySnapshot.delete(u.subject_id);
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
 * the same `schema` value.
 */
const buildRegistryFromSchema = (schema: AnySchema | undefined): EntityRegistry => {
  const registry = new EntityRegistry();
  if (schema === undefined) return registry;
  for (const entity of Object.values(schema.entities)) {
    registry.register(entity);
  }
  if (schema.relationships !== undefined) {
    for (const rel of Object.values(schema.relationships)) {
      registry.registerRelationship(rel);
    }
  }
  return registry;
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
 * Handle returned by {@link SyncClient.relationship}.
 *
 * `forward(sourceId)` returns `Promise<Entity | undefined>` for
 * `sourceCardinality: "one"` and `Promise<QueryBuilder<Entity>>` for
 * `sourceCardinality: "many"`. The runtime narrows on the registered
 * relationship's cardinality; the union here is the conservative
 * type the handle's storage layer can't disambiguate without the
 * registry entry.
 */
export interface RelationshipHandle {
  forward(sourceId: string): Promise<Entity | undefined> | Promise<PrimitiveQueryBuilder>;
  reverse(targetId: string): Promise<PrimitiveQueryBuilder>;
}

/**
 * Factory overload: when `opts.schema` is set, the returned client
 * carries the per-entity namespace from
 * `sync/namespace.ts`. The shape of `client.<entity>.<method>`
 * is derived from `schema.entities` so the static type narrows on
 * `eq` / `orderBy` / `create` / `update` against each declared
 * entity's field map.
 *
 * The runtime is identical to the un-overloaded version
 * (the namespace is mounted in `SyncClient`'s constructor). The
 * overload exists for the static type surface.
 */
export function createClient<TSchema extends import("./types").AnySchema>(
  opts: import("./types").CreateClientOptionsWithSchema<TSchema>,
): SyncClient & import("./namespace").NamespacedClient<TSchema["entities"]>;
/**
 * Factory overload: when `opts.schema` is omitted, the returned
 * client is a plain `SyncClient` with no per-entity namespace.
 * Useful for low-level consumers (e.g., the integration tests
 * that exercise the wire layer) that don't need the namespace.
 */
export function createClient(opts: SyncClientOptions): SyncClient;
export function createClient(opts: import("./types").SyncClientOptions): SyncClient {
  return new SyncClient(opts);
}
