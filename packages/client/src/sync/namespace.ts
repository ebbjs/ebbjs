/**
 * Per-entity namespace mounted on `client.<entityName>`.
 *
 * `client.<entity>.query()` returns the same typed thenable chain
 * the relationship accessors consume — one chain, one projection. The
 * namespace is a thin layer over the client's `storage` adapter and
 * `replica`; a query lowers to a serializable value, is planned, and
 * executes synchronously over the replica (hydrated first).
 *
 * `client.<entity>.get(id)` returns the typed projection for a
 * single row with relationship accessors attached for every
 * declared relationship on the entity (forward-many,
 * forward-one, reverse). The accessor dispatch reuses the traversal
 * primitives in ./relationship.
 */

import type { Entity, Unset } from "@ebbjs/core";
import type { Replica, StorageAdapter } from "@ebbjs/storage/types";
import type { Static, TObject, TRecord, TSchema, TString } from "@sinclair/typebox/type";

import type {
  ModelDef,
  ModelRegistry,
  GroupFields,
  GroupMemberFields,
  CreateShapeFields,
  RelationshipDef,
  Schema,
  ShapeFields,
} from "@ebbjs/schema";
import { GROUPS_ACCESSOR, groupMemberSystemEntity, groupSystemEntity } from "@ebbjs/schema";
import type { AccessorKeyOf, AnyRelationshipDef, EntityNameOf, FieldsOf } from "./definition-types";
import {
  buildReplicaQueryBuilder,
  projectEntity,
  projectRow,
  projectedFieldValue,
  type JoinRecord,
  type JoinedRow,
  type MembershipJoin,
  type NoJoins,
  type QueryBuilder,
  type QueryRow,
} from "./query-builder";
import { emptyQuery, type Predicate, type Query } from "./query";
import { planQuery } from "./query-plan";
import { createReplicaExecutor, executePlan } from "./query-execute";
import type { QueryCache } from "./query-cache";
import { createEntityWatcher, type EntityWatcher, type ReplicaSignal } from "./replica-signal";
import {
  type AdjacencyReader,
  forwardMany,
  forwardOne,
  membershipGroups,
  reverse as reverseTraversal,
} from "./relationship";

/**
 * Runtime shape of a single relationship accessor on a row. The
 * union covers every cardinality the relationship primitive
 * dispatches, and is the shape `buildRowAccessors` produces. The
 * static surface does not use this union — each `as` slot is typed
 * per cardinality via {@link RowAccessorRecord}.
 *
 * The forward-one branch accepts `Entity | null | undefined` —
 * `null` when no Relationship edge exists, `undefined` when the
 * edge exists but the target is missing, `Entity` when both
 * resolve.
 */
export type RowAccessor =
  | Promise<Entity | null | undefined>
  | QueryBuilder<Record<string, TSchema>>;

/** Empty per-`as` accessor record for entities with no relationships. */
type NoAccessors = Record<never, never>;

/** Which end of a relationship an accessor is derived from. */
type RelationshipEnd = "source" | "target";

/** The `ModelDef` on one end of a relationship. */
type EntityAt<R, TEnd extends RelationshipEnd> =
  R extends RelationshipDef<infer S, infer T, infer _A, infer _C>
    ? TEnd extends "source"
      ? S
      : T
    : never;

/** Accessor key contributed by a relationship whose `TEnd` entity is `TName`. */
type AccessorKeyAt<R, TEnd extends RelationshipEnd, TName extends string> =
  EntityNameOf<EntityAt<R, TEnd>> extends TName ? AccessorKeyOf<R> : never;

/**
 * Value type of one accessor slot. A forward-many relationship resolves
 * to a `QueryBuilder` over the other end's field map; a forward-one to
 * the resolved target or `null` / `undefined`; a reverse accessor (the
 * entity is the target) always to a `QueryBuilder`.
 */
type AccessorValueAt<R, TEnd extends RelationshipEnd> = TEnd extends "target"
  ? QueryBuilder<EntityFields<EntityAt<R, "source">>>
  : R extends RelationshipDef<infer _S, infer T, infer _A, infer C>
    ? [C] extends ["many"]
      ? QueryBuilder<EntityFields<T>>
      : Promise<Entity | null | undefined>
    : never;

type AccessorsAt<TRels, TEnd extends RelationshipEnd, TName extends string> = {
  [K in keyof TRels as AccessorKeyAt<TRels[K], TEnd, TName>]: AccessorValueAt<TRels[K], TEnd>;
};

/**
 * Built-in membership accessor carried by every projected row.
 * `doc.groups` is a forward-many {@link QueryBuilder} over the
 * `group` system entity, resolved from the row's `entityGroup`
 * membership rows. There is no built-in reverse accessor in v1.
 */
export type MembershipAccessors = { readonly groups: QueryBuilder<GroupFields> };

/**
 * Per-`as` accessor record for the entity named `TName`, derived from
 * the schema's relationship map. Forward relationships (entity is the
 * source) contribute a `QueryBuilder` or `Promise` per their
 * cardinality; reverse relationships (entity is the target)
 * contribute a `QueryBuilder` over the source's field map. Entity
 * names and accessor names stay literal through
 * `defineModel` / `defineRelationship`, so keys land exactly once.
 *
 * A reverse accessor shadows a forward accessor on the same `as` key
 * (a self-referential relationship, say), mirroring the runtime's
 * forward-then-reverse attach order.
 *
 * `TRels` is `undefined` for schemas declared without relationships;
 * those entities carry an empty record.
 */
export type RowAccessorRecord<TRels, TName extends string> = [TRels] extends [undefined]
  ? NoAccessors
  : TRels extends Record<string, AnyRelationshipDef>
    ? Omit<AccessorsAt<TRels, "source", TName>, keyof AccessorsAt<TRels, "target", TName>> &
        AccessorsAt<TRels, "target", TName>
    : NoAccessors;

/**
 * Static value of an entity's fields: the read shape of its rows.
 */
export type WireStatic<TFields extends Record<string, TSchema>> = Static<
  TObject<ShapeFields<TFields>>
>;

/**
 * Static value a create accepts: a defaulted field may be omitted (the
 * default fills it), a field without one is required. The inverse of
 * {@link WireStatic}, which is the read type.
 */
export type WireCreateStatic<TFields extends Record<string, TSchema>> = Static<
  TObject<CreateShapeFields<TFields>>
>;

/**
 * The value shape of an entity's fields: what a draft `create` takes
 * (before relationship pointers) and what `update` patches, keyed by field
 * name. Names the type an app's patch object would otherwise restate by
 * hand, so a schema change flows through:
 *
 * ```ts
 * type IssuePatch = Partial<EntityValues<typeof issue>>;
 * ```
 */
export type EntityValues<TEntityDef> = WireStatic<EntityFields<TEntityDef>>;

/**
 * What an update patch accepts: each field's value, or `unset` to assert it
 * absent. `unset` is a value-shaped marker, not row data; it compiles to the
 * tombstone the merge rule already understands.
 */
export type EntityPatch<TFields extends Record<string, TSchema>> = Partial<{
  [K in keyof TFields]: PatchValue<TFields[K]>;
}>;

/**
 * One field's patch value: the declared value or `unset`, and for a map
 * field each entry may be `unset` on its own so one key can be cleared
 * without touching its siblings.
 */
export type PatchValue<T extends TSchema> =
  T extends TRecord<TString, infer V>
    ? Record<string, Static<V> | Unset> | Unset
    : Static<T> | Unset;

/**
 * Row with attached relationship accessors. The projected TypeBox
 * shape (the entity's field map) is the base; the per-`as` accessor
 * record derived from the schema's relationship map is intersected
 * on top, so each declared relationship key carries the value type
 * its cardinality implies:
 *
 * - forward-many → `QueryBuilder<TargetFields>`
 * - forward-one → `Promise<Entity | null | undefined>`
 * - reverse → `QueryBuilder<SourceFields>`
 *
 * Accessor keys win over same-named fields (the runtime overwrites
 * the projected value with the accessor), which is what
 * `Omit<...> & TAccessors` expresses. Keys declared on neither the
 * field map nor the relationship map (`row.bogus`) stay a compile
 * error.
 *
 * @internal The async row accessors are not part of the public read
 * surface. Reads go through `client.<entity>.query()` and `useQuery`;
 * the engine keeps `get()` and these accessors for internal callers.
 *
 * `TAccessors` defaults to an empty record so erased usages
 * (`EntityWithAccessors<TFields>`) surface only the projected
 * fields.
 */
export type EntityWithAccessors<
  TFields extends Record<string, TSchema>,
  TAccessors extends object = NoAccessors,
> = Omit<WireStatic<TFields>, keyof TAccessors> & TAccessors;

/**
 * Projection snapshot over a field map. Kept separate from
 * {@link EntitySnapshot} so the internal projection helpers can name the
 * shape's own field map directly.
 */
export type EntitySnapshotOf<TWire extends Record<string, TSchema>> = Static<
  TObject<ShapeFields<TWire>>
> & {
  readonly id: string;
  readonly entity: Entity;
};

/**
 * Per-entity snapshot for reactive subscribe. Path C pins this
 * shape (#161's design comment): the projected row fields plus
 * an `id` and an `entity` escape hatch so subscribers can pull
 * the wire envelope (`deleted_hlc`, HLC timestamps, etc.) without
 * losing the strict per-field typing.
 *
 * `client.<entity>.get(id)`'s row carries `subscribe(cb)` and
 * fires this shape on every materialization of the row — including a
 * relationship / membership write, which re-reads the row. The
 * snapshot is data, not a handle: relationship accessors are async
 * and stay on the row, not in the snapshot. Because an accessor-only
 * change leaves the projected fields identical, a consumer that
 * suppresses no-op snapshots uses the row's `subscribeAccessors` to
 * force a re-read.
 */
export type EntitySnapshot<TFields extends Record<string, TSchema>> = EntitySnapshotOf<TFields>;

/**
 * Row returned by `client.<entity>.get(id)`.
 *
 * @internal `get()` is the engine's single-row read, not a public read
 * path. Applications query through `client.<entity>.query()` /
 * `useQuery`; `get()` and the async relationship accessors stay
 * internal / undocumented (epic decision 5).
 *
 * `id` is the entity's addressing key, not a wire-envelope passthrough:
 * `data` / `type` / HLC stamps stay off the row. The injected `id`
 * always wins — over both a field named `id` and a relationship
 * accessor named `id`.
 *
 * `subscribe` fires an `EntitySnapshot<TFields>` on every
 * materialization of the row, and never on subscribe itself:
 * `get(id)` already materialized before the listener attaches.
 * Emits for a wrong-type row are skipped, mirroring `get`'s own
 * type guard. The trigger is the replica's change signal, not the
 * storage adapter's write path.
 */
export type EntityRow<
  TFields extends Record<string, TSchema>,
  TAccessors extends object = NoAccessors,
> = Omit<EntityWithAccessors<TFields, TAccessors>, "id"> & {
  readonly id: string;
  subscribe(cb: (snapshot: EntitySnapshot<TFields>) => void): () => void;
  /**
   * Subscribe to a change in one of the row's relationship / membership
   * accessors. The row's own fields are usually unchanged, so a consumer
   * must re-read the row rather than diff its projected fields.
   */
  subscribeAccessors(cb: () => void): () => void;
};

/**
 * Filter shape for `client.<entity>.subscribe(filter, cb)`.
 * Field-name → equality-value. Path C pins this exact shape (see
 * the design comment on #161).
 */
export type QueryFilter<TFields extends Record<string, TSchema>> = {
  [K in keyof TFields]?: Static<TFields[K]> | null;
};

/**
 * Snapshot passed to a collection subscribe listener on each fired event.
 * Carries the typed projected row snapshots, the active filter, and
 * a count. Each row in `entities` is an `EntitySnapshot<TFields>`
 * so consumers can read the per-field projection AND the wire
 * envelope (`row.id`, `row.entity`) from the same shape.
 */
export type CollectionSnapshot<TFields extends Record<string, TSchema>> = {
  readonly entities: readonly EntitySnapshot<TFields>[];
  readonly filter: QueryFilter<TFields>;
  readonly count: number;
};

/**
 * Mount surface for one entity. `query()` returns a fresh
 * QueryBuilder over the entity's projected field map; awaiting it
 * resolves to the typed rows. `get(id)` reads a single row directly
 * via the storage adapter, projects it to the same TypeBox shape,
 * and attaches relationship accessors plus the per-entity
 * `subscribe(cb)` for every declared relationship on the entity.
 *
 * `subscribe(filter, cb)` registers a reactive listener on the
 * engine's query cache. The callback fires whenever the set of
 * matching entity ids changes, so a field edit on a row that
 * already matches is not a collection change. Each fire carries a
 * typed `CollectionSnapshot` of the current matching set.
 *
 * `client.<entity>` is read-only: every write goes through
 * `defineAction` and the draft surface in `./drafts`.
 *
 * `TAccessors` is the per-`as` accessor record derived from the
 * schema's relationship map (see {@link RowAccessorRecord}). It is
 * threaded through `get(id)`'s {@link EntityRow} so each declared
 * relationship key carries its cardinality-specific value type.
 */
export interface EntityNamespace<
  TFields extends Record<string, TSchema>,
  TAccessors extends object = NoAccessors,
  TJoins extends object = NoJoins,
> {
  /** The public read root: a typed chain over the entity's fields and joins. */
  query(): QueryBuilder<TFields, TJoins, NoJoins, QueryRow<TFields>>;
  /**
   * Single-row read with relationship accessors attached.
   *
   * @internal Reads go through {@link EntityNamespace.query} and
   * `useQuery`; this stays for the engine's own callers.
   */
  get(id: string): Promise<EntityRow<TFields, TAccessors> | null>;
  /**
   * Reactive subscribe on the matching set. Returns an
   * unsubscribe function. The callback fires when the matching id
   * set changes, not on every storage write; the cached result is
   * the id list, so a field edit on an already-matching row is a
   * no-op. The trigger is the replica's change signal via the
   * client's query cache (#512).
   *
   * @internal Query results are the public reactive read; this
   * collection signal stays internal / undocumented.
   */
  subscribe(
    filter: QueryFilter<TFields>,
    cb: (snapshot: CollectionSnapshot<TFields>) => void,
  ): () => void;
}

/**
 * Map a single entity definition to its field map. `ModelDef<TFields>`
 * carries `TFields` directly, so this is just `infer F`.
 */
export type EntityFields<D> = FieldsOf<D>;

/** `client.group`: the read-only namespace over the `group` system entity. */
export type GroupNamespace = EntityNamespace<GroupFields, MembershipAccessors>;

/** `client.membership`: the read-only namespace over the `groupMember` system entity. */
export type MembershipNamespace = EntityNamespace<GroupMemberFields, MembershipAccessors>;

/** The system-entity namespaces every schema-bound client carries. */
export type SystemNamespaces = {
  readonly group: GroupNamespace;
  readonly membership: MembershipNamespace;
};

/**
 * Conditional typed-surface a `SyncClient` grows when constructed
 * with a `Schema`. Each schema-entity name becomes a property whose
 * value is an `EntityNamespace` over that entity's field map.
 *
 * `S extends Schema<infer TEntities, infer TRels>` distributes over
 * the generics so each entity gets its own field map and its own
 * per-`as` accessor record. A relationship's literal source/target
 * names and `as` key flow through `defineModel` /
 * `defineRelationship`, so the walker matches relationships to the
 * entity by name without recursing through the entity map. Clients
 * without a schema see no extra properties.
 */
export type EntityNamespaces<S> =
  S extends Schema<infer TEntities, infer TRels>
    ? {
        [K in keyof TEntities & string]: EntityNamespace<
          EntityFields<TEntities[K]>,
          RowAccessorRecord<TRels, EntityNameOf<TEntities[K]>> & MembershipAccessors,
          JoinRecord<TRels, EntityNameOf<TEntities[K]>> & MembershipJoin
        >;
      } & SystemNamespaces
    : NoAccessors;

/**
 * The read root `useQuery` hands its callback: every entity namespace
 * narrowed to its `query()` method. It is the client's own namespaces
 * object at runtime, so `q.issue.query` and `client.issue.query` are the
 * same method and hook and imperative callers cannot drift (epic
 * decision 15). Mutations stay off `q` — write through `useClient()`.
 */
export type QueryRoot<S> = {
  readonly [K in keyof EntityNamespaces<S>]: EntityNamespaces<S>[K] extends {
    readonly query: infer TQuery;
  }
    ? { readonly query: TQuery }
    : never;
};

/** The schema's entity map; `never` for a value that is not a schema. */
type SchemaEntities<S> = S extends Schema<infer TEntities, infer _TRels> ? TEntities : never;

/** The schema's relationship map, or `undefined` when it declares none. */
type SchemaRelationships<S> = S extends Schema<infer _TEntities, infer TRels> ? TRels : undefined;

/** The fields of the schema entity named `TName`. */
type FieldsFor<S, TName extends keyof SchemaEntities<S> & string> = EntityFields<
  SchemaEntities<S>[TName]
>;

/** The joins a query over `TName` exposes: its relationships plus `groups`. */
type JoinsFor<S, TName extends string> = JoinRecord<SchemaRelationships<S>, TName> & MembershipJoin;

/**
 * The row a replica-backed query over one schema entity resolves to.
 *
 * `TJoinKeys` names the `with(...)` joins to project, so a view can share
 * the exact row shape its query returns without restating the query
 * builder's type arguments:
 *
 * ```ts
 * type IssueRow = QueryRowOf<Schema, "issue", "assignee">;
 * const issues = await client.issue.query().with({ assignee: true });
 * ```
 *
 * A join key comes from the schema's relationship map (or the built-in
 * `groups` join); selecting a key the entity does not expose is a
 * compile error.
 */
export type QueryRowOf<
  S,
  TName extends keyof SchemaEntities<S> & string,
  TJoinKeys extends keyof JoinsFor<S, TName> & string = never,
> = JoinedRow<
  FieldsFor<S, TName>,
  Pick<JoinsFor<S, TName>, TJoinKeys>,
  QueryRow<FieldsFor<S, TName>>
>;

/**
 * The replica binding the namespace reads adjacency through. The
 * client supplies its live {@link Replica} plus a memoized hydration
 * thunk, so the namespace can bring the replica up to date before the
 * first accessor read without importing the client (avoiding the
 * `client → namespace → client` cycle).
 */
export interface ReplicaAccess {
  readonly replica: Replica;
  /** The reactive query-result cache every chain and collection subscribe shares. */
  readonly queries: QueryCache;
  /** The engine signal behind the row-level watchers. */
  readonly signal: ReplicaSignal;
  /** Whether the replica is hydrated, so a query can run synchronously. */
  hydrated(): boolean;
  hydrate(): Promise<void>;
}

/**
 * Wrap the replica's synchronous adjacency reads in the async
 * {@link AdjacencyReader} the traversal helpers consume. The replica is
 * the materialized read path after #496, so its indices replace the
 * storage adapter's async index reads.
 */
function replicaAdjacency(access: ReplicaAccess): AdjacencyReader {
  return {
    forwardLinks: async (query) => access.replica.relationshipLinks(query),
    reverseSourceIds: async (query) =>
      access.replica.relationships({ as: query.as, type: query.type, targetId: query.targetId }),
    membershipsOf: async (entityId) => access.replica.membershipLinks(entityId),
  };
}

/**
 * Build the runtime accessor record for a single row. Walks the
 * registry for relationships where the entity is the source (forward)
 * or the target (reverse) and dispatches per cardinality:
 *
 * - forward-many → `QueryBuilder<TargetFields>` (thenable to
 *   `readonly TargetShape[]`). The FK set lives on the materialized
 *   `Relationship` entities, not the source's data fields.
 * - forward-one → `Promise<Entity | null | undefined>`. Distinguishes
 *   "no Relationship edge" (null), "edge exists but target missing"
 *   (undefined), and "edge + target both resolve" (Entity).
 * - reverse → `QueryBuilder<SourceFields>` (thenable).
 *
 * Forward accessors are looked up via
 * `getRelationshipsForSource(entityName)`; reverse accessors via
 * `getRelationshipsForTarget`. The `as` name is the accessor key
 * for both directions — a relationship declared with `as: "x"` is
 * reachable as `<source>.x` (forward) and `<target>.x` (reverse).
 *
 * The accessor functions close over `storage` and resolve ids
 * lazily; awaiting them hits the cache on demand.
 */
function buildRowAccessors(
  entityName: string,
  sourceId: string,
  storage: StorageAdapter,
  registry: ModelRegistry,
  replica?: ReplicaAccess,
): Record<string, RowAccessor> {
  const out: Record<string, RowAccessor> = {};
  const readLocalEntity = (id: string): Promise<Entity | null> => storage.entities.get(id);
  // Traversals read the adjacency index rather than scanning the
  // `relationship` / `entityGroup` type, so their cost tracks the
  // source row's degree. The replica owns the index once supplied;
  // otherwise the storage adapter's async index stays the default.
  const adjacency: AdjacencyReader =
    replica !== undefined
      ? replicaAdjacency(replica)
      : {
          forwardLinks: (query) => storage.entities.queryByRelationshipSource(query),
          reverseSourceIds: (query) => storage.entities.queryByRelationship(query),
          membershipsOf: (entityId) => storage.entities.queryByMembershipEntity(entityId),
        };

  // Forward accessors — relationships where this entity is the source.
  for (const rel of registry.getRelationshipsForSource(entityName)) {
    const targetName = rel.target.name;
    const field = rel.as;
    const relType = rel.type;
    const targetShape = registry.get(targetName)?.shape;
    if (rel.sourceCardinality === "many") {
      // Defensive: `defineSchema` rejects an unregistered target, so a
      // schema-built registry always carries the shape.
      if (targetShape === undefined) continue;
      out[field] = forwardMany(
        readLocalEntity,
        adjacency,
        sourceId,
        entityName,
        targetName,
        targetShape,
        field,
        relType,
      );
      continue;
    }
    out[field] = forwardOne(readLocalEntity, adjacency, sourceId, entityName, field, relType);
  }

  // Reverse accessors — relationships where this entity is the target.
  for (const rel of registry.getRelationshipsForTarget(entityName)) {
    const sourceName = rel.source.name;
    const field = rel.as;
    const relType = rel.type;
    const sourceShape = registry.get(sourceName)?.shape;
    // Defensive: `defineSchema` rejects an unregistered source.
    if (sourceShape === undefined) continue;
    out[field] = reverseTraversal(
      readLocalEntity,
      adjacency,
      sourceId,
      sourceName,
      sourceShape,
      field,
      relType,
    );
  }

  // Built-in membership accessor — reads the row's `entityGroup`
  // rows and projects their `group` targets. Present on every row
  // regardless of declared relationships.
  const groupShape = registry.get("group")?.shape;
  // Defensive: `group` is always a registered system entity.
  if (groupShape !== undefined) {
    out[GROUPS_ACCESSOR] = membershipGroups(
      readLocalEntity,
      adjacency,
      sourceId,
      "group",
      groupShape,
    );
  }

  return out;
}

/**
 * Lower a collection filter to a query over the source type. `subscribe`'s
 * filter shape is field equality only, so every entry is one field predicate
 * in a single AND-group (an empty filter is the unfiltered type scan).
 */
const queryForFilter = <TFields extends Record<string, TSchema>>(
  entityName: string,
  filter: QueryFilter<TFields>,
): Query => {
  const predicates: Predicate[] = [];
  for (const [field, value] of Object.entries(filter)) {
    predicates.push({ kind: "field", field, value });
  }
  return { ...emptyQuery(entityName), groups: predicates.length === 0 ? [] : [predicates] };
};

/**
 * Project a materialized entity into the subscribe snapshot shape:
 * the typed field projection plus the `id` and `entity` escape
 * hatches. Shared by the per-collection and per-entity subscribe
 * paths so the snapshot shape has one definition.
 */
const toEntitySnapshot = <TWire extends Record<string, TSchema>>(
  entity: Entity,
  shape: TObject<TWire>,
): EntitySnapshotOf<TWire> => ({
  ...projectEntity(entity, shape),
  id: entity.id,
  entity,
});

/**
 * Attach the per-entity reactive listener for `id` to the replica's
 * signal. A namespace built without a replica binding has no trigger, so
 * the returned unsubscribe is a no-op.
 *
 * A row that left the replica entirely is dropped: the pinned
 * `EntitySnapshot` has no null variant; a soft delete stays a row with
 * `deleted_hlc` set and is delivered normally.
 */
const subscribeToEntity = <TWire extends Record<string, TSchema>>(
  watcher: EntityWatcher | null,
  entityName: string,
  id: string,
  shape: TObject<TWire>,
  cb: (snapshot: EntitySnapshotOf<TWire>) => void,
): (() => void) => {
  if (watcher === null) return () => {};
  const fire = (row: Entity | undefined): void => {
    if (row === undefined || row.type !== entityName) return;
    cb(toEntitySnapshot(row, shape));
  };
  const unsubscribeEntity = watcher.entity(id, fire);
  // A relationship / membership write leaves the row's own fields untouched
  // but changes its accessors; fire the same snapshot contract a field change
  // would, so a consumer that compares projected fields still sees the row.
  const unsubscribeAccessors = watcher.accessors(id, fire);
  return () => {
    unsubscribeEntity();
    unsubscribeAccessors();
  };
};

/**
 * Capabilities the read path consults. The client supplies this at
 * construction time so the namespace stays free of the cyclic
 * `client → namespace → client` reference. Writes do not run through
 * here: they live on the action runtime's own capability in `./drafts`.
 */
export interface ReadCapability {
  readonly registry: ModelRegistry;
}

/**
 * Build a namespace for one entity. The namespace's `query()` returns
 * a replica-backed QueryBuilder: the chain lowers to a serializable
 * query, is planned, and executes synchronously over the client's
 * replica.
 *
 * `shape` is the entity's TypeBox object schema (the projection
 * source); the builder reads it at materialization time to drive
 * the per-field lookup. `read` supplies the registry the row's
 * relationship accessors resolve against.
 */
export function createEntityNamespace<
  TFields extends Record<string, TSchema>,
  TAccessors extends object = NoAccessors,
  TJoins extends object = NoJoins,
>(
  entityName: string,
  shape: TObject<ShapeFields<TFields>>,
  storage: StorageAdapter,
  read: ReadCapability,
  replica?: ReplicaAccess,
): EntityNamespace<TFields, TAccessors, TJoins> {
  const registry = read.registry;
  const watcher =
    replica === undefined ? null : createEntityWatcher(replica.replica, replica.signal);

  /** Project one replica row and attach its accessors plus signal handles. */
  const buildRow = (entity: Entity): EntityRow<TFields, TAccessors> | null => {
    // Wrong-type reads (different `entity.type`) resolve to `null`
    // alongside unknown ids. Callers don't distinguish — a missing
    // row and a wrong-type row are both "no row here".
    if (entity.type !== entityName) return null;
    const accessors = buildRowAccessors(entityName, entity.id, storage, registry, replica);
    const subscribe = (cb: (snapshot: EntitySnapshot<TFields>) => void): (() => void) =>
      subscribeToEntity(
        watcher,
        entityName,
        entity.id,
        shape,
        cb as unknown as (snapshot: EntitySnapshotOf<ShapeFields<TFields>>) => void,
      );
    const subscribeAccessors = (cb: () => void): (() => void) =>
      watcher === null ? () => {} : watcher.accessors(entity.id, cb);
    // Accessors spread last so a declared relationship shadows a
    // same-named field; the entity id spreads after them so it wins
    // over both.
    return {
      ...projectRow(entity, shape),
      ...accessors,
      id: entity.id,
      subscribe,
      subscribeAccessors,
    } as unknown as EntityRow<TFields, TAccessors>;
  };

  return {
    query(): QueryBuilder<TFields, TJoins, NoJoins, QueryRow<TFields>> {
      // Only a directly-constructed namespace can lack the binding;
      // `createClient` always supplies one. Falling back to the storage
      // shim here would silently read a stale, scan-based path.
      if (replica === undefined) {
        throw new Error(
          `client.${entityName}.query(): no replica binding — build the namespace through createClient (or pass a ReplicaAccess)`,
        );
      }
      return buildReplicaQueryBuilder<ShapeFields<TFields>, TJoins>(entityName, shape, {
        entityName,
        registry,
        replica: replica.replica,
        queries: replica.queries,
        hydrated: () => replica.hydrated(),
        hydrate: () => replica.hydrate(),
      }) as unknown as QueryBuilder<TFields, TJoins, NoJoins, QueryRow<TFields>>; // ShapeFields is idempotent at the type level; the runtime shape is the read shape.
    },
    async get(id: string): Promise<EntityRow<TFields, TAccessors> | null> {
      // The accessors read the replica's adjacency, so bring it up to
      // date before building them. Memoized on the client, so this is
      // one real await per client.
      if (replica === undefined) {
        const entity = await storage.entities.get(id);
        return entity === null ? null : buildRow(entity);
      }
      await replica.hydrate();
      // Held rows keep their durable read: a conflicted Action's optimistic
      // overlay stays on the replica until resolution. An on-demand row is
      // read through `open` so it lands and pins.
      const entity = await storage.entities.get(id);
      if (entity === null) return null;
      if (replica.replica.isHeld(entity.type)) return buildRow(entity);
      const opened = await replica.replica.open(id);
      return opened === null ? null : buildRow(opened);
    },
    subscribe(
      filter: QueryFilter<TFields>,
      cb: (snapshot: CollectionSnapshot<TFields>) => void,
    ): () => void {
      if (replica === undefined) {
        // No replica binding → no engine signal. A one-shot read is still
        // available through `client.<entity>.query()`.
        return () => {
          // no-op
        };
      }
      const query = queryForFilter(entityName, filter);
      // The cached result is the matching id list, so a field edit on a row
      // that already matches is not a collection change (the pinned contract)
      // while a join, delete, or insert is.
      const store = replica.queries.watch<string>("collection", query, {
        ready: () => replica.hydrate(),
        isReady: () => replica.hydrated(),
        execute: () => {
          const executor = createReplicaExecutor(replica.replica);
          return executePlan(planQuery(query), executor, (entity, field) =>
            projectedFieldValue(entity, field, shape),
          )
            .filter((row) => row.type === entityName)
            .map((row) => row.id);
        },
      });
      return store.subscribe(
        () => {
          // The cache holds ids; the rows are read from the replica as this
          // callback runs, after the change that could alter the set has
          // settled that entry.
          const ids = store.getSnapshot().data;
          if (ids === undefined) return;
          const entities = ids.flatMap((id) => {
            const row = replica.replica.get(id);
            return row === undefined
              ? []
              : [toEntitySnapshot(row, shape) as unknown as EntitySnapshot<TFields>];
          });
          cb({ entities, filter, count: entities.length });
        },
        // A collection subscribe never fires on subscribe itself; the first
        // run primes the cache silently and later membership changes fire.
        { initial: false },
      );
    },
  };
}

/** `client.group`: the read-only namespace over the `group` system entity. */
function createGroupNamespace(
  storage: StorageAdapter,
  read: ReadCapability,
  replica?: ReplicaAccess,
): GroupNamespace {
  return createEntityNamespace<GroupFields, MembershipAccessors>(
    "group",
    groupSystemEntity.shape,
    storage,
    read,
    replica,
  );
}

/** `client.membership`: the read-only namespace over the `groupMember` system entity. */
function createMembershipNamespace(
  storage: StorageAdapter,
  read: ReadCapability,
  replica?: ReplicaAccess,
): MembershipNamespace {
  return createEntityNamespace<GroupMemberFields, MembershipAccessors>(
    "groupMember",
    groupMemberSystemEntity.shape,
    storage,
    read,
    replica,
  );
}

/**
 * Build the typed namespace surface for a schema. Returns an object
 * whose keys are the schema's entity names plus the system `group` /
 * `membership` namespaces, and whose values are the per-entity
 * `EntityNamespace`s. The Proxy layer in {@link SyncClient} forwards
 * unknown property access to this map.
 */
export function buildEntityNamespaces<
  S extends Schema<Record<string, ModelDef<Record<string, TSchema>>>, unknown>,
>(
  schema: S,
  storage: StorageAdapter,
  read: ReadCapability,
  replica?: ReplicaAccess,
): EntityNamespaces<S> {
  const out: Record<string, EntityNamespace<Record<string, TSchema>>> = {};
  for (const [name, def] of Object.entries(schema.models)) {
    // The static accessor record is derived by `EntityNamespaces<S>`
    // from the schema's relationship map; the registry is the runtime
    // authority for which accessors actually attach.
    out[name] = createEntityNamespace(def.name, def.shape, storage, read, replica);
  }
  out["group"] = createGroupNamespace(storage, read, replica) as unknown as EntityNamespace<
    Record<string, TSchema>
  >;
  out["membership"] = createMembershipNamespace(
    storage,
    read,
    replica,
  ) as unknown as EntityNamespace<Record<string, TSchema>>;
  return out as EntityNamespaces<S>;
}
