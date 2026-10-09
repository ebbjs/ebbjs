/**
 * Per-entity namespace mounted on `client.<entityName>`.
 *
 * `client.<entity>.query()` returns the same typed thenable chain
 * the relationship accessors consume — one chain, one projection. The
 * namespace is a thin layer over the client's `storage` adapter;
 * candidate rows are loaded lazily on each materialization so the
 * chain reflects the latest snapshot.
 *
 * `client.<entity>.get(id)` returns the typed projection for a
 * single row with relationship accessors attached for every
 * declared relationship on the entity (forward-many,
 * forward-one, reverse). The accessor dispatch reuses the traversal
 * primitives in ./relationship.
 */

import type { Entity, Update } from "@ebbjs/core";
import { generateId } from "@ebbjs/core";
import type { WriteResponse } from "./types";
import type { StorageAdapter } from "@ebbjs/storage/types";
import type { Static, TObject, TSchema } from "@sinclair/typebox/type";

import type {
  EntityDef,
  DerivedAccessors,
  DerivedFieldDef,
  DerivedKeys,
  ShapeFields,
  WireFields,
} from "../schema/entity";
import { EntityValidationError, validatePayload } from "../schema/entity-registry";
import type { EntityRegistry } from "../schema/entity-registry";
import type { RelationshipDef } from "../schema/relationship";
import type { Schema } from "../schema/schema";
import type { GroupFields } from "../schema/system-entities";
import { GROUPS_ACCESSOR } from "../schema/system-entities";
import {
  DEFAULT_DOCUMENT_ENTITY,
  DOC_CONTENT_FIELD,
  isCollaborativeText,
} from "../fields/collaborative-text/schema";
import { buildInitialContentField } from "../fields/collaborative-text/wire";
import type { TextDocument, TextDocumentSubmit } from "../fields/collaborative-text/text-document";
import {
  buildLazyQueryBuilder,
  normalizePointer,
  projectEntity,
  type LoadEntities,
  type PointerValue,
  type QueryBuilder,
} from "./query-builder";
import {
  buildEntityGroupDelete,
  buildEntityGroupUpdates,
  buildRelationshipUpdate,
  forwardMany,
  forwardOne,
  membershipGroups,
  type ManyPointerValue,
  reverse as reverseTraversal,
} from "./relationship";
import { readEntityMemberships } from "./entity-group";

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
  | Promise<TextDocument | null>
  | QueryBuilder<Record<string, TSchema>>;

/** Empty per-`as` accessor record for entities with no relationships. */
type NoAccessors = Record<never, never>;

/** Literal entity name carried by an `EntityDef` (see `defineEntity`). */
type EntityNameOf<D> = D extends EntityDef<Record<string, TSchema>, infer N> ? N : never;

/** Erased relationship definition — the shape a schema's relationship map holds. */
type AnyRelationshipDef = RelationshipDef<
  EntityDef<Record<string, TSchema>>,
  EntityDef<Record<string, TSchema>>
>;

/** Which end of a relationship an accessor is derived from. */
type RelationshipEnd = "source" | "target";

/** `as` accessor name carried by a relationship. */
type AccessorKeyOf<R> =
  R extends RelationshipDef<infer _S, infer _T, infer A, infer _C> ? A : never;

/** The `EntityDef` on one end of a relationship. */
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
 * `defineEntity` / `defineRelationship`, so keys land exactly once.
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
 * Static value of an entity's *wire* fields. Derived bodies are not
 * wire fields, so they never appear here; the row adds them as
 * accessors via {@link DerivedAccessors}.
 */
export type WireStatic<TFields extends Record<string, TSchema>> = Static<
  TObject<ShapeFields<WireFields<TFields>>>
>;

/** Values accepted for derived bodies on `create`: the initial text. */
export type DerivedInputs<TFields extends Record<string, TSchema>> = {
  readonly [K in DerivedKeys<TFields>]?: string;
};

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
 * `TAccessors` defaults to an empty record so erased usages
 * (`EntityWithAccessors<TFields>`) surface only the projected
 * fields.
 */
export type EntityWithAccessors<
  TFields extends Record<string, TSchema>,
  TAccessors extends object = NoAccessors,
> = Omit<WireStatic<TFields>, keyof TAccessors> & TAccessors;

/**
 * Projection snapshot over a *wire* field map. Kept separate from
 * {@link EntitySnapshot} so the internal projection helpers can name
 * the shape's own field map without re-applying {@link WireFields}.
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
 * fires this shape on every materialization of the row. The
 * snapshot is data, not a handle: relationship accessors are async
 * and stay on the row, not in the snapshot.
 */
export type EntitySnapshot<TFields extends Record<string, TSchema>> = EntitySnapshotOf<
  WireFields<TFields>
>;

/**
 * Row returned by `client.<entity>.get(id)`: the projected fields,
 * the runtime relationship accessors, and the per-entity reactive
 * `subscribe(cb)`.
 *
 * `subscribe` fires an `EntitySnapshot<TFields>` on every
 * materialization of the row, and never on subscribe itself:
 * `get(id)` already materialized before the listener attaches.
 * Emits for a wrong-type row are skipped, mirroring `get`'s own
 * type guard. Adapters without an emitter surface a no-op
 * unsubscribe.
 */
export type EntityRow<
  TFields extends Record<string, TSchema>,
  TAccessors extends object = NoAccessors,
> = EntityWithAccessors<TFields, TAccessors> & {
  subscribe(cb: (snapshot: EntitySnapshot<TFields>) => void): () => void;
};

/**
 * Filter shape for `client.<entity>.subscribe(filter, cb)`.
 * Field-name → equality-value. Path C pins this exact shape (see
 * the design comment on #161).
 */
export type QueryFilter<TFields extends Record<string, TSchema>> = {
  [K in keyof WireFields<TFields>]?: Static<WireFields<TFields>[K]>;
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
 * storage adapter's change emitter. The callback fires whenever
 * the set of entities matching `filter` changes (referential
 * equality on the projected row list; deep-equal is over-engineered
 * per #161's body). Each fire carries a typed `CollectionSnapshot`
 * of the new matching set.
 *
 * `link` / `unlink` / `setLinks` build the wire Update(s) and
 * submit via the client's write path. Users never see wire-level
 * Update arrays; the runtime wraps them in `createAction` and
 * hands them to `client.submitRelationshipUpdates`.
 *
 * `TAccessors` is the per-`as` accessor record derived from the
 * schema's relationship map (see {@link RowAccessorRecord}). It is
 * threaded through `get(id)`'s {@link EntityRow} so each declared
 * relationship key carries its cardinality-specific value type.
 */
export interface EntityNamespace<
  TFields extends Record<string, TSchema>,
  TAccessors extends object = NoAccessors,
> {
  query(): QueryBuilder<WireFields<TFields>>;
  get(id: string): Promise<EntityRow<TFields, TAccessors> | null>;
  /**
   * Reactive subscribe on the matching set. Returns an
   * unsubscribe function. The callback fires when the set
   * changes, not on every storage emit — referential equality
   * on the projected row array is the no-op guard. The
   * underlying emitter is the storage adapter's per-type
   * observer; adapters that don't ship an emitter surface this
   * as a no-op (the listener never fires).
   */
  subscribe(
    filter: QueryFilter<TFields>,
    cb: (snapshot: CollectionSnapshot<TFields>) => void,
  ): () => void;
  /**
   * Create a new entity row. Non-conforming inputs throw
   * `EntityValidationError` before any network call. `subject_id`
   * is minted client-side; the wire Update is a `put`.
   *
   * `opts.groups` is required and non-empty: one `entityGroup`
   * membership row is emitted per group in the same Action as the
   * entity, so the row is indexed into each group atomically.
   *
   * A derived body passed as a string is created as a separate
   * document entity and linked in the same Action; the promise
   * resolves to the new entity's `id` alongside the wire response.
   */
  create(
    input: WireStatic<TFields> & DerivedInputs<TFields>,
    opts: CreateOptions,
  ): Promise<CreateResult>;
  /**
   * Patch an existing entity row, validated the same way as
   * `create`'s input. The wire Update is a `patch`.
   */
  update(
    id: string,
    patch: Partial<WireStatic<TFields>>,
    opts?: EntityWriteOptions,
  ): Promise<WriteResponse>;
  /**
   * Soft-delete an entity row. Ships a single `method: "delete"`
   * Update whose `data` is `null` — the server tombstones the row
   * rather than rewriting its fields. There's no payload to
   * validate, so this takes no `EntityWriteOptions`.
   */
  delete(id: string): Promise<WriteResponse>;
  /**
   * One-cardinality link. Emits a single Relationship Update and
   * submits. Throws `EntityValidationError` when `as` is not a
   * declared relationship on the entity or when the actor lacks
   * `<source_type>.update`.
   */
  link(id: string, as: string, targetId: PointerValue): Promise<WriteResponse>;
  /**
   * One-cardinality unlink. Emits a single Relationship Delete
   * Update and submits.
   */
  unlink(id: string, as: string): Promise<WriteResponse>;
  /**
   * Many-cardinality set. Emits one entity Update + N Relationship
   * Updates and submits. The canonical FK set lives on the source
   * entity's data field.
   */
  setLinks(id: string, as: string, patch: ManyPointerValue): Promise<WriteResponse>;
  /**
   * Add an existing entity to `groupId`. Emits one `entityGroup` put
   * in one Action; idempotent when a live local membership already
   * exists (no network call). Throws `EntityValidationError` only for
   * a malformed group ref. Offline-legal: the normal outbox path.
   */
  addToGroup(id: string, groupId: GroupRef): Promise<WriteResponse>;
  /**
   * Remove a non-last membership. Emits one `entityGroup` delete in
   * one Action. Throws `EntityValidationError` when no live local
   * membership row matches `(id, groupId)`. A last-membership removal
   * is refused by the server with reason `last_membership`; the local
   * view can be stale, so the client does not pre-block it.
   */
  removeFromGroup(id: string, groupId: GroupRef): Promise<WriteResponse>;
  /**
   * Replace the entity's membership set: `target − current` puts and
   * `current − target` deletes in ONE Action. Throws
   * `EntityValidationError` for an empty `groupIds` or a malformed
   * ref, before any network call. A target that nets to zero is
   * refused by the server with `last_membership`.
   */
  setGroups(id: string, groupIds: readonly GroupRef[]): Promise<WriteResponse>;
}

/**
 * Per-write options. `validate: false` skips the local `Value.Check`
 * pass — useful for tests / pre-validated upstream callers. The
 * registry's name-membership check at `client.write()` still runs.
 */
export interface EntityWriteOptions {
  validate?: boolean;
}

/** A group reference accepted by `create`: a group id or an entity-shape handle. */
export type GroupRef = string | { readonly id: string };

/**
 * Options for `client.<entity>.create(input, opts)`. `groups` is the
 * required, non-empty membership set; one `entityGroup` row is
 * emitted per group in the same Action as the entity.
 */
export interface CreateOptions extends EntityWriteOptions {
  readonly groups: readonly GroupRef[];
}

/**
 * Result of `client.<entity>.create(...)`: the wire response plus the
 * minted entity id, so the created row is immediately addressable.
 */
export type CreateResult = WriteResponse & { readonly id: string };

/**
 * Map a single entity definition to its field map. `EntityDef<TFields>`
 * carries `TFields` directly, so this is just `infer F`.
 */
export type EntityFields<D> = D extends EntityDef<infer F> ? F : never;

/**
 * Conditional typed-surface a `SyncClient` grows when constructed
 * with a `Schema`. Each schema-entity name becomes a property whose
 * value is an `EntityNamespace` over that entity's field map.
 *
 * `S extends Schema<infer TEntities, infer TRels>` distributes over
 * the generics so each entity gets its own field map and its own
 * per-`as` accessor record. A relationship's literal source/target
 * names and `as` key flow through `defineEntity` /
 * `defineRelationship`, so the walker matches relationships to the
 * entity by name without recursing through the entity map. Clients
 * without a schema see no extra properties.
 */
export type EntityNamespaces<S> =
  S extends Schema<infer TEntities, infer TRels>
    ? {
        [K in keyof TEntities & string]: EntityNamespace<
          EntityFields<TEntities[K]>,
          RowAccessorRecord<TRels, EntityNameOf<TEntities[K]>> &
            MembershipAccessors &
            DerivedAccessors<EntityFields<TEntities[K]>>
        >;
      }
    : NoAccessors;

/**
 * Resolve a collaborative-text body: follow the generated edge to the
 * document entity, hydrate a `TextDocument` from its `content` map, and
 * return it. `null` when no document is linked.
 */
const collaborativeTextForwardOne = (
  readLocalEntity: (id: string) => Promise<Entity | null>,
  queryEntitiesByType: (type: string) => Promise<readonly Entity[]>,
  sourceId: string,
  sourceName: string,
  field: string,
  type: string,
  openTextDocument: (docId: string, docType: string) => TextDocument,
): Promise<TextDocument | null> =>
  forwardOne(readLocalEntity, queryEntitiesByType, sourceId, sourceName, field, type).then(
    (entity) => {
      if (entity === null || entity === undefined) return null;
      const doc = openTextDocument(entity.id, entity.type);
      doc.hydrate(entity.data?.fields?.[DOC_CONTENT_FIELD]);
      return doc;
    },
  );

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
  registry: EntityRegistry,
  write: WriteCapability,
): Record<string, RowAccessor> {
  const out: Record<string, RowAccessor> = {};
  const readLocalEntity = (id: string): Promise<Entity | null> => storage.entities.get(id);
  const queryEntitiesByType = (type: string): Promise<readonly Entity[]> =>
    storage.entities.query(type);

  // Forward accessors — relationships where this entity is the source.
  for (const rel of registry.getRelationshipsForSource(entityName)) {
    const targetName = rel.target.name;
    const field = rel.as;
    const relType = rel.type;
    if (isCollaborativeText(rel)) {
      out[field] = collaborativeTextForwardOne(
        readLocalEntity,
        queryEntitiesByType,
        sourceId,
        entityName,
        field,
        relType,
        write.openTextDocument,
      );
      continue;
    }
    const targetShape = registry.get(targetName)?.shape;
    if (rel.sourceCardinality === "many") {
      // Defensive: `defineSchema` rejects an unregistered target, so a
      // schema-built registry always carries the shape.
      if (targetShape === undefined) continue;
      out[field] = forwardMany(
        readLocalEntity,
        queryEntitiesByType,
        sourceId,
        entityName,
        targetName,
        targetShape,
        field,
        relType,
      );
      continue;
    }
    out[field] = forwardOne(
      readLocalEntity,
      queryEntitiesByType,
      sourceId,
      entityName,
      field,
      relType,
    );
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
      queryEntitiesByType,
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
    out[GROUPS_ACCESSOR] = membershipGroups(queryEntitiesByType, sourceId, "group", groupShape);
  }

  return out;
}

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
 * Attach the per-entity reactive listener for `id`. Adapters without
 * an emitter have no reactive trigger, so the returned unsubscribe is
 * a no-op.
 *
 * A `null` emit (the interface's hard-removal signal) is dropped:
 * the pinned `EntitySnapshot` has no null variant, and both shipped
 * adapters emit the soft-deleted entity (`deleted_hlc` set) instead.
 */
const subscribeToEntity = <TWire extends Record<string, TSchema>>(
  storage: StorageAdapter,
  entityName: string,
  id: string,
  shape: TObject<TWire>,
  cb: (snapshot: EntitySnapshotOf<TWire>) => void,
): (() => void) => {
  const emitter = storage.changeEmitter;
  if (emitter === undefined) return () => {};
  return emitter.onEntityChange(id, (next) => {
    if (next === null || next.type !== entityName) return;
    cb(toEntitySnapshot(next, shape));
  });
};

/**
 * Capability the namespace consults for write-side operations. The
 * client supplies this at construction time so the namespace stays
 * free of the cyclic `client → namespace → client` reference. The
 * namespace delegates Action submission; HLC and clock management
 * stay inside the client.
 */
export interface WriteCapability {
  readonly registry: EntityRegistry;
  buildRelationshipWrite(
    opts: import("./relationship").BuildRelationshipWriteOptions,
  ): import("./relationship").BuildRelationshipWriteResult;
  submitRelationshipUpdates(
    updates: readonly import("@ebbjs/core").Update[],
  ): Promise<WriteResponse>;
  /** Mint a fresh local HLC and return the timestamp string. */
  freshHlc(): string;
  /** Mint a fresh Update id. */
  generateUpdateId(): string;
  /** Local actor id; collaborative-text run ids embed it. */
  readonly actorId: string;
  /**
   * Open (or get) the `TextDocument` for a linked document entity. The
   * client binds it to the write path so local edits self-flush.
   */
  openTextDocument(docId: string, docType: string): TextDocument;
}

/** Write path bound to a document for self-flushing locally-authored edits. */
export type { TextDocumentSubmit };

/**
 * Build a namespace for one entity. The namespace's `query()` returns
 * a lazy QueryBuilder seeded from `storage.entities.query(entityName)`.
 *
 * `shape` is the entity's TypeBox object schema (the projection
 * source); the builder reads it at materialization time to drive
 * the per-field lookup. `registry` and `write` supply the runtime
 * pieces the relationship-write surface (`link` / `unlink` /
 * `setLinks`) consults.
 */
export function createEntityNamespace<
  TFields extends Record<string, TSchema>,
  TAccessors extends object = NoAccessors,
>(
  entityName: string,
  shape: TObject<WireFields<TFields>>,
  storage: StorageAdapter,
  write: WriteCapability,
  derived: Record<string, DerivedFieldDef> = {},
): EntityNamespace<TFields, TAccessors> {
  const registry = write.registry;
  const loader: LoadEntities = async () => storage.entities.query(entityName);
  return {
    query(): QueryBuilder<WireFields<TFields>> {
      return buildLazyQueryBuilder(loader, shape, { entityName, registry, storage });
    },
    async get(id: string): Promise<EntityRow<TFields, TAccessors> | null> {
      const entity = await storage.entities.get(id);
      if (entity === null) return null;
      // Wrong-type reads (different `entity.type`) resolve to `null`
      // alongside unknown ids. Callers don't distinguish — a missing
      // row and a wrong-type row are both "no row here".
      if (entity.type !== entityName) return null;
      const projected = projectEntity(entity, shape);
      const accessors = buildRowAccessors(entityName, id, storage, registry, write);
      const subscribe = (cb: (snapshot: EntitySnapshot<TFields>) => void): (() => void) =>
        subscribeToEntity(storage, entityName, id, shape, cb);
      return { ...projected, ...accessors, subscribe } as unknown as EntityRow<TFields, TAccessors>;
    },
    subscribe(
      filter: QueryFilter<TFields>,
      cb: (snapshot: CollectionSnapshot<TFields>) => void,
    ): () => void {
      const emitter = storage.changeEmitter;
      if (emitter === undefined) {
        // No emitter → no reactive trigger. The snapshot can still
        // be polled via `client.<entity>.query()` for one-shot reads.
        return () => {
          // no-op
        };
      }
      const matching = new Map<string, Entity>();
      const matches = (entity: Entity): boolean => {
        // A soft-deleted row is not a member of the live collection,
        // so it drops out of the set and fires like any other removal.
        // `get(id)` still returns the tombstone for per-row inspection.
        if (entity.deleted_hlc !== null) return false;
        for (const [field, value] of Object.entries(filter)) {
          const fieldEntry = entity.data?.fields?.[field];
          const current = fieldEntry === undefined ? undefined : fieldEntry.value;
          if (current !== value) return false;
        }
        return true;
      };
      const buildSnapshot = (): CollectionSnapshot<TFields> => {
        const entities = [...matching.values()].map((entity) => toEntitySnapshot(entity, shape));
        return { entities, filter, count: entities.length };
      };
      const idSignature = (ids: Iterable<string>): string => [...ids].sort().join("\n");
      let prevIds = "";
      const update = (entity: Entity): void => {
        const wasIn = matching.has(entity.id);
        const matchesNow = matches(entity);
        if (matchesNow) {
          matching.set(entity.id, entity);
        } else {
          matching.delete(entity.id);
        }
        if (wasIn !== matchesNow) {
          const ids = idSignature(matching.keys());
          if (ids !== prevIds) {
            prevIds = ids;
            cb(buildSnapshot());
          }
        }
      };
      // Hydrate the matching set BEFORE the listener attaches so
      // the hydration's own re-materialization doesn't fire the
      // callback. Concurrent emits during the async hydration
      // window are buffered and replayed on attach.
      let hydrating = true;
      const buffered: Entity[] = [];
      const listener = (entity: Entity): void => {
        if (hydrating) {
          buffered.push(entity);
        } else {
          update(entity);
        }
      };
      let unsubEmitter: (() => void) | null = null;
      void (async (): Promise<void> => {
        const rows = await storage.entities.query(entityName);
        for (const row of rows) {
          if (matches(row)) matching.set(row.id, row);
        }
        prevIds = idSignature(matching.keys());
        unsubEmitter = emitter.onTypeChange(entityName, listener);
        hydrating = false;
        if (buffered.length > 0) {
          const replay = buffered.splice(0, buffered.length);
          for (const entity of replay) update(entity);
        }
      })();
      return () => {
        if (unsubEmitter !== null) unsubEmitter();
        matching.clear();
      };
    },
    async create(
      input: WireStatic<TFields> & DerivedInputs<TFields>,
      opts: CreateOptions,
    ): Promise<CreateResult> {
      const subjectId = generateId("e");
      const groupIds = resolveGroupIds(opts?.groups, entityName);
      const { wire, bodies } = splitDerivedInputs(
        entityName,
        input as Record<string, unknown>,
        derived,
      );
      const entityUpdate = buildEntityWriteUpdate(write, entityName, shape, {
        subjectId,
        payload: wire,
        partial: false,
        validate: opts?.validate,
      });
      const updates: Update[] = [
        entityUpdate,
        ...buildEntityGroupUpdates(subjectId, groupIds, () => write.generateUpdateId()),
      ];
      // Derived bodies ride in the same Action as the parent, so the
      // document, the edge, and both membership sets commit atomically
      // (and the #233 coherence rule holds by construction).
      for (const [field, text] of Object.entries(bodies)) {
        const marker = derived[field];
        if (marker === undefined || !isCollaborativeText(marker)) continue;
        const docId = generateId("e");
        const hlc = write.freshHlc();
        const docUpdateId = write.generateUpdateId();
        updates.push({
          id: docUpdateId,
          subject_id: docId,
          subject_type: marker.entity ?? DEFAULT_DOCUMENT_ENTITY,
          method: "put",
          data: {
            fields: {
              [DOC_CONTENT_FIELD]: buildInitialContentField(text, hlc, write.actorId, docUpdateId),
            },
          },
        });
        updates.push(
          buildRelationshipUpdate({
            relationshipId: generateId("rel"),
            sourceId: subjectId,
            targetId: docId,
            field,
            type: entityName,
            updateId: write.generateUpdateId(),
          }),
        );
        updates.push(...buildEntityGroupUpdates(docId, groupIds, () => write.generateUpdateId()));
      }
      const response = await write.submitRelationshipUpdates(updates);
      return { id: subjectId, ...response };
    },
    async update(
      id: string,
      patch: Partial<WireStatic<TFields>>,
      opts?: EntityWriteOptions,
    ): Promise<WriteResponse> {
      return submitEntityWrite(write, entityName, shape, {
        subjectId: id,
        payload: patch,
        partial: true,
        validate: opts?.validate,
      });
    },
    async delete(id: string): Promise<WriteResponse> {
      return submitEntityDelete(write, entityName, id);
    },
    async link(id: string, as: string, targetId: PointerValue): Promise<WriteResponse> {
      return submitRelationshipWrite(write, entityName, id, as, { targetId }, storage);
    },
    async unlink(id: string, as: string): Promise<WriteResponse> {
      return submitRelationshipWrite(write, entityName, id, as, { targetId: null }, storage);
    },
    async setLinks(id: string, as: string, patch: ManyPointerValue): Promise<WriteResponse> {
      return submitRelationshipWrite(write, entityName, id, as, { targetIds: patch }, storage);
    },
    // Membership mutations are offline-legal (#126) and go through the
    // normal outbox path. Their Actions are exempt from the #233
    // same-group-set rule: a membership delta touches the union of the
    // pre- and post-Action group sets by construction.
    async addToGroup(id: string, groupId: GroupRef): Promise<WriteResponse> {
      const target = resolveSingleGroupId(groupId, entityName, "addToGroup");
      const current = await readEntityMemberships(storage, id);
      if (current.some((membership) => membership.groupId === target)) {
        return { rejected: [] };
      }
      return write.submitRelationshipUpdates(
        buildEntityGroupUpdates(id, [target], () => write.generateUpdateId()),
      );
    },
    async removeFromGroup(id: string, groupId: GroupRef): Promise<WriteResponse> {
      const target = resolveSingleGroupId(groupId, entityName, "removeFromGroup");
      const current = await readEntityMemberships(storage, id);
      const row = current.find((membership) => membership.groupId === target);
      if (row === undefined) {
        throw new EntityValidationError([
          {
            entityName,
            message: `removeFromGroup: no entityGroup membership row for "${id}" in group "${target}"`,
          },
        ]);
      }
      return write.submitRelationshipUpdates([
        buildEntityGroupDelete({
          membershipId: row.membershipId,
          updateId: write.generateUpdateId(),
        }),
      ]);
    },
    async setGroups(id: string, groupIds: readonly GroupRef[]): Promise<WriteResponse> {
      const target = resolveGroupIds(groupIds, entityName, "setGroups", "groupIds");
      const current = await readEntityMemberships(storage, id);
      const currentIds = new Set(current.map((membership) => membership.groupId));
      const targetIds = new Set(target);
      const toAdd = target.filter((groupId) => !currentIds.has(groupId));
      const toRemove = current.filter((membership) => !targetIds.has(membership.groupId));
      // Adds before removes so an incremental observer never sees the
      // entity with an empty membership set mid-Action.
      return write.submitRelationshipUpdates([
        ...buildEntityGroupUpdates(id, toAdd, () => write.generateUpdateId()),
        ...toRemove.map((membership) =>
          buildEntityGroupDelete({
            membershipId: membership.membershipId,
            updateId: write.generateUpdateId(),
          }),
        ),
      ]);
    },
  };
}

/**
 * Internal options for {@link submitEntityWrite}. `partial=true`
 * flips the validator from full-shape to per-field and routes the
 * wire Update through `method: "patch"`.
 */
interface SubmitEntityWriteInput {
  subjectId: string;
  payload: unknown;
  partial: boolean;
  validate: boolean | undefined;
}

/**
 * Validate the payload against the entity shape and ship a single
 * entity Update. Throws `EntityValidationError` on shape mismatch
 * (or empty patch) when validation is on. The local validator is
 * the SDK's contract; the server may still reject the write for
 * permissions, conflicts, or schema drift.
 *
 * `update_id` is minted once per Update so concurrent writers
 * can't collide on the same id; `hlc` is the local clock so the
 * server can detect a causal-order inversion.
 */
async function submitEntityWrite<TFields extends Record<string, TSchema>>(
  write: WriteCapability,
  entityName: string,
  shape: TObject<TFields>,
  input: SubmitEntityWriteInput,
): Promise<WriteResponse> {
  return write.submitRelationshipUpdates([buildEntityWriteUpdate(write, entityName, shape, input)]);
}

/**
 * Validate the payload against the entity shape and build the single
 * entity Update. Throws `EntityValidationError` on shape mismatch
 * (or empty patch) when validation is on. Shared by `create`,
 * `update`, and the membership-emitting create path.
 */
function buildEntityWriteUpdate<TFields extends Record<string, TSchema>>(
  write: WriteCapability,
  entityName: string,
  shape: TObject<TFields>,
  input: SubmitEntityWriteInput,
): Update {
  if (input.validate !== false) {
    const violations = validatePayload(shape, input.payload, entityName, input.partial);
    if (violations.length > 0) {
      throw new EntityValidationError(violations);
    }
    if (input.partial && isEmptyPayload(input.payload)) {
      throw new EntityValidationError([
        {
          entityName,
          message: `update: patch must contain at least one field`,
        },
      ]);
    }
  }
  const hlc = write.freshHlc();
  const updateId = write.generateUpdateId();
  const fields = wrapFields(input.payload, updateId, hlc);
  return {
    id: updateId,
    subject_id: input.subjectId,
    subject_type: entityName,
    method: input.partial ? "patch" : "put",
    data: { fields },
  };
}

/**
 * Partition a create input into wire fields and derived bodies. A
 * derived key with a non-empty string becomes a document to create; a
 * missing / `null` / empty value leaves the body unlinked
 * (`row.<body>` resolves to `null`). A present-but-non-string value is
 * a programming error and is refused.
 */
function splitDerivedInputs(
  entityName: string,
  input: Record<string, unknown>,
  derived: Record<string, DerivedFieldDef>,
): { wire: Record<string, unknown>; bodies: Record<string, string> } {
  const derivedKeys = new Set(Object.keys(derived));
  if (derivedKeys.size === 0) return { wire: input, bodies: {} };
  const wire: Record<string, unknown> = {};
  const bodies: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!derivedKeys.has(key)) {
      wire[key] = value;
      continue;
    }
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") {
      throw new EntityValidationError([
        {
          entityName,
          field: key,
          message: `create: derived field "${key}" must be a string body`,
        },
      ]);
    }
    if (value.length > 0) bodies[key] = value;
  }
  return { wire, bodies };
}

/**
 * Normalize the `{ groups }` option into a de-duplicated, non-empty
 * id list. Throws `EntityValidationError` when the option is missing,
 * empty, or carries a malformed pointer. `operation`/`label` name the
 * caller in the message so `create` and `setGroups` read distinctly.
 */
export const resolveGroupIds = (
  groups: readonly GroupRef[] | undefined,
  entityName: string,
  operation = "create",
  label = "groups",
): readonly string[] => {
  const groupsRequired = (): EntityValidationError =>
    new EntityValidationError([
      {
        entityName,
        message: `${operation}: "${label}" is required and must contain at least one group id`,
      },
    ]);
  if (groups === undefined || groups.length === 0) {
    throw groupsRequired();
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    let id: string | null;
    try {
      id = normalizePointer(group, `${label} for "${entityName}"`);
    } catch (err) {
      throw new EntityValidationError([
        { entityName, message: err instanceof Error ? err.message : String(err) },
      ]);
    }
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  if (ids.length === 0) {
    throw groupsRequired();
  }
  return ids;
};

/**
 * Normalize a single group ref for `addToGroup` / `removeFromGroup`.
 * A malformed ref throws `EntityValidationError` naming the operation.
 */
const resolveSingleGroupId = (group: GroupRef, entityName: string, operation: string): string => {
  let id: string | null;
  try {
    id = normalizePointer(group, `group for "${entityName}"`);
  } catch (err) {
    throw new EntityValidationError([
      {
        entityName,
        message: `${operation}: ${err instanceof Error ? err.message : String(err)}`,
      },
    ]);
  }
  if (id === null) {
    throw new EntityValidationError([
      { entityName, message: `${operation}: group ref is missing an id` },
    ]);
  }
  return id;
};

/**
 * Build and submit the single `method: "delete"` Update for an
 * entity row. `data` is `null` per the wire convention; the
 * enclosing Action carries the HLC (see
 * `submitRelationshipUpdates`).
 */
async function submitEntityDelete(
  write: WriteCapability,
  entityName: string,
  id: string,
): Promise<WriteResponse> {
  const update: Update = {
    id: write.generateUpdateId(),
    subject_id: id,
    subject_type: entityName,
    method: "delete",
    data: null,
  };
  return write.submitRelationshipUpdates([update]);
}

/** True when the payload is `{}` or every field is `undefined` — a no-op the caller almost certainly didn't intend. */
const isEmptyPayload = (payload: unknown): boolean => {
  if (payload === null || typeof payload !== "object") return true;
  for (const value of Object.values(payload)) {
    if (value !== undefined) return false;
  }
  return true;
};

/**
 * Flatten a payload into the wire envelope. `undefined` fields are
 * dropped (the wire envelope is absent, not explicitly undefined);
 * `null` is preserved so nullable fields round-trip cleanly.
 */
export const wrapFields = (
  payload: unknown,
  updateId: string,
  hlc: string,
): Record<string, { value: unknown; update_id: string; hlc: string }> => {
  const out: Record<string, { value: unknown; update_id: string; hlc: string }> = {};
  if (payload === null || typeof payload !== "object") return out;
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined) continue;
    out[key] = { value, update_id: updateId, hlc };
  }
  return out;
};

/**
 * Look up the relationship by `(source, as)`, build the wire
 * Update(s), and submit. Throws `EntityValidationError` when `as`
 * is not a declared relationship on the entity.
 */
async function submitRelationshipWrite(
  write: WriteCapability,
  entityName: string,
  sourceId: string,
  as: string,
  pointer: { targetId?: PointerValue; targetIds?: ManyPointerValue },
  storage: StorageAdapter,
): Promise<WriteResponse> {
  if (as === GROUPS_ACCESSOR) {
    throw new EntityValidationError([
      {
        entityName,
        message: `link/unlink/setLinks: "${GROUPS_ACCESSOR}" is the built-in membership accessor; use addToGroup/removeFromGroup/setGroups instead`,
      },
    ]);
  }
  const rel = write.registry.getRelationship(entityName, as);
  if (rel === undefined) {
    const { EntityValidationError } = await import("../schema/entity-registry");
    throw new EntityValidationError([
      {
        entityName,
        message: `submitRelationshipWrite: relationship "${as}" is not declared on entity "${entityName}"`,
      },
    ]);
  }
  // Many-cardinality needs an entity Update carrying the canonical
  // FK set on `data.fields[as]`. The patch shape (`replace` /
  // `add`/`remove`) is collapsed to a flat id list and emitted as
  // the field's `value`. The wire-builder treats the canonical set
  // as the source of truth.
  const { buildManyEntityUpdate, collectManyTargetIds } = await import("./relationship");
  let entityUpdate: import("@ebbjs/core").Update | undefined;
  if (rel.sourceCardinality === "many" && pointer.targetIds !== undefined) {
    const ids = collectManyTargetIds(pointer.targetIds);
    const updateId = write.generateUpdateId();
    entityUpdate = buildManyEntityUpdate({
      sourceId,
      sourceEntityName: entityName,
      as,
      targetIds: ids,
      updateId,
      hlc: write.freshHlc(),
    });
  }
  // One-cardinality delete: the wire Update's `subject_id` must
  // match the existing relationship's id so the server's authorizer
  // can recover the group from the cache. Look the existing row up
  // by `(sourceId, as)` in the materialized Relationship cache;
  // throw a clear validation error when no such relationship exists
  // locally (the caller hasn't materialized the link yet, or the
  // link was created by another client that hasn't synced to us).
  let relationshipSubjectId: string | undefined;
  if (
    rel.sourceCardinality === "one" &&
    pointer.targetId === null &&
    pointer.targetIds === undefined
  ) {
    const all = await storage.entities.query("relationship");
    const wireType = rel.type ?? entityName;
    const match = all.find(
      (e) =>
        e.data?.fields?.["source_id"]?.value === sourceId &&
        e.data?.fields?.["field"]?.value === as &&
        e.data?.fields?.["type"]?.value === wireType,
    );
    if (match === undefined) {
      const { EntityValidationError } = await import("../schema/entity-registry");
      throw new EntityValidationError([
        {
          entityName,
          message: `unlink("${as}"): no relationship found for source "${sourceId}" in the materialized cache; did you link() first and wait for catchUp?`,
        },
      ]);
    }
    relationshipSubjectId = match.id;
  }
  const result = write.buildRelationshipWrite({
    source: { name: entityName },
    target: { name: rel.target.name },
    as,
    sourceId,
    entityUpdate,
    relationshipSubjectId,
    ...pointer,
  });
  const rels = Array.isArray(result.relationshipUpdate)
    ? result.relationshipUpdate
    : [result.relationshipUpdate];
  const updates: import("@ebbjs/core").Update[] = [];
  if (result.entityUpdate !== undefined) updates.push(result.entityUpdate);
  for (const r of rels) updates.push(r);
  return write.submitRelationshipUpdates(updates);
}

/**
 * Build the typed namespace surface for a schema. Returns an object
 * whose keys are the schema's entity names and whose values are the
 * per-entity `EntityNamespace`s. The Proxy layer in
 * {@link SyncClient} forwards unknown property access to this map.
 */
export function buildEntityNamespaces<
  S extends Schema<Record<string, EntityDef<Record<string, TSchema>>>, unknown>,
>(schema: S, storage: StorageAdapter, write: WriteCapability): EntityNamespaces<S> {
  const out: Record<string, EntityNamespace<Record<string, TSchema>>> = {};
  for (const [name, def] of Object.entries(schema.entities)) {
    // The static accessor record is derived by `EntityNamespaces<S>`
    // from the schema's relationship map; the registry is the runtime
    // authority for which accessors actually attach.
    out[name] = createEntityNamespace(def.name, def.shape, storage, write, def.derived);
  }
  return out as EntityNamespaces<S>;
}
