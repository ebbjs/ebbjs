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

import type { Entity, FieldValue, Update } from "@ebbjs/core";
import { generateId, isFieldMap } from "@ebbjs/core";
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
import type { GroupFields, GroupMemberFields } from "../schema/system-entities";
import {
  groupMemberSystemEntity,
  groupSystemEntity,
  GROUPS_ACCESSOR,
} from "../schema/system-entities";
import { DOC_CONTENT_FIELD, isCollaborativeText } from "../fields/collaborative-text/schema";
import type { TextDocument, TextDocumentSubmit } from "../fields/collaborative-text/text-document";
import {
  buildLazyQueryBuilder,
  normalizePointer,
  projectEntity,
  projectFieldValue,
  projectRow,
  type LoadEntities,
  type PointerValue,
  type QueryBuilder,
} from "./query-builder";
import {
  buildEntityGroupUpdates,
  forwardMany,
  forwardOne,
  membershipGroups,
  type ManyPointerValue,
  reverse as reverseTraversal,
} from "./relationship";
import { readEntityMemberships, type LiveMembership } from "./entity-group";
import {
  call,
  changeGroups,
  createEntity,
  createSystemEntity,
  deleteEntity,
  groupBootstrap,
  patchEntity,
  writeRelationship,
  type RelationshipPointer,
} from "./operations";
import { commit } from "./committer";

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
 * `id` is the entity's addressing key, not a wire-envelope passthrough:
 * `data` / `type` / HLC stamps stay off the row. The injected `id`
 * always wins — over both a field named `id` and a relationship
 * accessor named `id`.
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
> = Omit<EntityWithAccessors<TFields, TAccessors>, "id"> & {
  readonly id: string;
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
   * Copy an existing row to a fresh id, carrying its field values
   * verbatim — nested `update_id` / `hlc` stamps included, so a
   * collaborative-text `content` map survives as a reference snapshot
   * that later document edits re-mint. `opts.at` picks the live row
   * (`"current"`, the default) or, for `"preSync"`, the entity's
   * earliest unresolved conflict's `before` row (#395). The copy lands in
   * `opts.groups`, or the source's live groups when omitted, and is
   * validated against the schema like `create`. A soft-deleted source
   * row is copied like any other; the copy is live.
   *
   * `at: "preSync"` requires an unresolved conflict referencing the
   * entity and throws `no unresolved conflict for "<id>"` when there is
   * none.
   *
   * Only this row's own wire fields are copied. A derived
   * collaborative-text body lives on its own generated document
   * entity, so back one up through that entity's namespace.
   */
  duplicate(id: string, opts?: DuplicateOptions): Promise<CreateResult>;
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
   * membership row matches `(id, groupId)`. When the local view shows
   * the removal would leave the entity unowned, the committer refuses
   * it with `last_membership` before any network call; an empty local
   * view defers to the server's authoritative check.
   */
  removeFromGroup(id: string, groupId: GroupRef): Promise<WriteResponse>;
  /**
   * Replace the entity's membership set: `target − current` puts and
   * `current − target` deletes in ONE Action. Throws
   * `EntityValidationError` for an empty `groupIds` or a malformed
   * ref, before any network call. When the local view shows the delta
   * would leave the entity unowned, the committer refuses it with
   * `last_membership` before any network call.
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

/** Point in time a `duplicate` copies from. */
export type DuplicateAt = "current" | "preSync";

/**
 * Options for `client.<entity>.duplicate(id, opts)`.
 */
export interface DuplicateOptions extends EntityWriteOptions {
  /** Source of the copy: the live row (`"current"`, default) or the entity's earliest unresolved conflict's `before` row (`"preSync"`). */
  readonly at?: DuplicateAt;
  /** Membership set for the copy; defaults to the source's live groups. */
  readonly groups?: readonly GroupRef[];
}

/**
 * Map a single entity definition to its field map. `EntityDef<TFields>`
 * carries `TFields` directly, so this is just `infer F`.
 */
export type EntityFields<D> = D extends EntityDef<infer F> ? F : never;

/**
 * `client.group`: the generic namespace with a bootstrap `create` that
 * commits the group put and the acting actor's own membership in one
 * Action. Membership verbs are not part of the surface.
 */
export type GroupNamespace = Omit<
  EntityNamespace<GroupFields, MembershipAccessors>,
  "create" | "addToGroup" | "removeFromGroup" | "setGroups"
> & {
  create(input: WireStatic<GroupFields>, opts?: EntityWriteOptions): Promise<CreateResult>;
};

/**
 * `client.groupMember`: the generic namespace with a plain system put
 * and no membership verbs — an `entityGroup` row for a member is
 * meaningless.
 */
export type GroupMemberNamespace = Omit<
  EntityNamespace<GroupMemberFields, MembershipAccessors>,
  "create" | "addToGroup" | "removeFromGroup" | "setGroups"
> & {
  create(input: WireStatic<GroupMemberFields>, opts?: EntityWriteOptions): Promise<CreateResult>;
};

/** The system-entity namespaces every schema-bound client carries. */
export type SystemNamespaces = {
  readonly group: GroupNamespace;
  readonly groupMember: GroupMemberNamespace;
};

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
      } & SystemNamespaces
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
 * Capabilities the namespace consults. The client supplies this at
 * construction time so the namespace stays free of the cyclic
 * `client → namespace → client` reference; the namespace delegates
 * Action submission, HLC and clock management, document opening, and
 * the conflict read that backs `duplicate({ at: "preSync" })`.
 */
export interface WriteCapability {
  readonly registry: EntityRegistry;
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
  /**
   * Read the `before` row of the entity's earliest unresolved conflict,
   * or `null` when no unresolved conflict references it. Backs
   * `duplicate({ at: "preSync" })`.
   */
  readPreSyncRow(entityId: string): Promise<Entity | null>;
  /** Live `entityGroup` rows for an entity id, from the local cache. */
  readMemberships(entityId: string): Promise<readonly LiveMembership[]>;
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
      const accessors = buildRowAccessors(entityName, id, storage, registry, write);
      const subscribe = (cb: (snapshot: EntitySnapshot<TFields>) => void): (() => void) =>
        subscribeToEntity(storage, entityName, id, shape, cb);
      // Accessors spread last so a declared relationship shadows a
      // same-named field; the entity id spreads after them so it wins
      // over both.
      return {
        ...projectRow(entity, shape),
        ...accessors,
        id: entity.id,
        subscribe,
      } as unknown as EntityRow<TFields, TAccessors>;
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
      const id = generateId("e");
      const groups = resolveGroupIds(opts?.groups, entityName);
      const { wire, bodies } = splitDerivedInputs(
        entityName,
        input as Record<string, unknown>,
        derived,
      );
      const { response } = await commit(
        [
          call(createEntity, {
            entity: entityName,
            id,
            fields: wire,
            bodies,
            groups,
            validate: opts?.validate,
          }),
        ],
        write,
      );
      return { id, ...response };
    },
    async duplicate(id: string, opts?: DuplicateOptions): Promise<CreateResult> {
      const at = opts?.at ?? "current";
      const source = await readDuplicateSource(storage, write, entityName, id, at);
      const groupIds =
        opts?.groups !== undefined
          ? resolveGroupIds(opts.groups, entityName, "duplicate")
          : resolveGroupIds(
              (await readEntityMemberships(storage, id)).map((membership) => membership.groupId),
              entityName,
              "duplicate",
            );
      const subjectId = generateId("e");
      const entityUpdate = buildDuplicateUpdate(write, entityName, shape, {
        subjectId,
        source,
        validate: opts?.validate,
      });
      const updates: Update[] = [
        entityUpdate,
        ...buildEntityGroupUpdates(subjectId, groupIds, () => write.generateUpdateId()),
      ];
      const response = await write.submitRelationshipUpdates(updates);
      return { id: subjectId, ...response };
    },
    async update(
      id: string,
      patch: Partial<WireStatic<TFields>>,
      opts?: EntityWriteOptions,
    ): Promise<WriteResponse> {
      const groups = await readLiveGroupIds(storage, id);
      const { response } = await commit(
        [
          call(patchEntity, {
            entity: entityName,
            id,
            payload: patch,
            groups,
            validate: opts?.validate,
          }),
        ],
        write,
      );
      return response;
    },
    async delete(id: string): Promise<WriteResponse> {
      const groups = await readLiveGroupIds(storage, id);
      const { response } = await commit(
        [call(deleteEntity, { entity: entityName, id, groups })],
        write,
      );
      return response;
    },
    async link(id: string, as: string, targetId: PointerValue): Promise<WriteResponse> {
      return submitRelationshipWrite(write, storage, entityName, id, as, { targetId });
    },
    async unlink(id: string, as: string): Promise<WriteResponse> {
      return submitRelationshipWrite(write, storage, entityName, id, as, { targetId: null });
    },
    async setLinks(id: string, as: string, patch: ManyPointerValue): Promise<WriteResponse> {
      return submitRelationshipWrite(write, storage, entityName, id, as, { targetIds: patch });
    },
    // Membership mutations are offline-legal (#126) and go through the
    // normal outbox path as one `changeGroups` operation. Their Actions
    // are system-only, so the committer lets them span the union of the
    // pre- and post-Action group sets (#464).
    async addToGroup(id: string, groupId: GroupRef): Promise<WriteResponse> {
      const target = resolveSingleGroupId(groupId, entityName, "addToGroup");
      const current = await readEntityMemberships(storage, id);
      const currentGroups = current.map((membership) => membership.groupId);
      if (currentGroups.includes(target)) {
        return { rejected: [] };
      }
      const { response } = await commit(
        [call(changeGroups, { entity: entityName, entityId: id, puts: [target], currentGroups })],
        write,
      );
      return response;
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
      const { response } = await commit(
        [
          call(changeGroups, {
            entity: entityName,
            entityId: id,
            removes: [{ membershipId: row.membershipId, groupId: target }],
            currentGroups: current.map((membership) => membership.groupId),
          }),
        ],
        write,
      );
      return response;
    },
    async setGroups(id: string, groupIds: readonly GroupRef[]): Promise<WriteResponse> {
      const target = resolveGroupIds(groupIds, entityName, "setGroups", "groupIds");
      const current = await readEntityMemberships(storage, id);
      const currentIds = new Set(current.map((membership) => membership.groupId));
      const targetIds = new Set(target);
      const puts = target.filter((groupId) => !currentIds.has(groupId));
      const removes = current
        .filter((membership) => !targetIds.has(membership.groupId))
        .map((membership) => ({
          membershipId: membership.membershipId,
          groupId: membership.groupId,
        }));
      // Adds precede removes so an incremental observer never sees the
      // entity with an empty membership set mid-Action.
      const { response } = await commit(
        [
          call(changeGroups, {
            entity: entityName,
            entityId: id,
            puts,
            removes,
            currentGroups: current.map((membership) => membership.groupId),
          }),
        ],
        write,
      );
      return response;
    },
  };
}

/**
 * The entity's live membership group ids, read from the local
 * `entityGroup` rows. `create` asks for groups explicitly; `update` /
 * `delete` / relationship writes carry whatever the local view knows,
 * which may be empty when the row predates this client's cache.
 */
async function readLiveGroupIds(storage: StorageAdapter, entityId: string): Promise<string[]> {
  const memberships = await readEntityMemberships(storage, entityId);
  return memberships.map((membership) => membership.groupId);
}

/**
 * Read the row a `duplicate` copies from: the live cache row, or the
 * `before` row of the entity's earliest unresolved conflict when `at` is
 * `"preSync"`. A missing (or wrong-type) source throws, because there
 * is nothing to copy.
 */
async function readDuplicateSource(
  storage: StorageAdapter,
  write: WriteCapability,
  entityName: string,
  id: string,
  at: DuplicateAt,
): Promise<Entity> {
  const source = at === "preSync" ? await write.readPreSyncRow(id) : await storage.entities.get(id);
  if (source === null || source.type !== entityName) {
    throw new EntityValidationError([
      {
        entityName,
        message:
          at === "preSync"
            ? `duplicate: no unresolved conflict for "${id}"`
            : `duplicate: no ${entityName} row for id "${id}"`,
      },
    ]);
  }
  return source;
}

/** Options for {@link buildDuplicateUpdate}. */
interface DuplicateWriteInput {
  subjectId: string;
  source: Entity;
  validate: boolean | undefined;
}

/**
 * Validate a source row's field values and build the single `put`
 * Update that copies them. The field map is cloned verbatim — leaf and
 * nested `update_id` / `hlc` stamps included — so the copy is a
 * reference snapshot of the source's merge state, not a re-stamped
 * write. The new entity id and the enclosing Action are fresh.
 */
function buildDuplicateUpdate<TFields extends Record<string, TSchema>>(
  write: WriteCapability,
  entityName: string,
  shape: TObject<TFields>,
  input: DuplicateWriteInput,
): Update {
  const fields = input.source.data?.fields ?? {};
  if (input.validate !== false) {
    const violations = validatePayload(shape, projectFieldValues(fields), entityName, false);
    if (violations.length > 0) {
      throw new EntityValidationError(violations);
    }
  }
  return {
    id: write.generateUpdateId(),
    subject_id: input.subjectId,
    subject_type: entityName,
    method: "put",
    data: { fields: cloneFields(fields) },
  };
}

/** Project a wire field map to the plain values the schema validator checks. */
const projectFieldValues = (fields: Record<string, FieldValue>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(fields)) {
    out[key] = projectFieldValue(field);
  }
  return out;
};

/** Deep-clone a wire field value so the copy never aliases the source's objects. */
const cloneValue = (value: unknown): unknown => {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(cloneValue);
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) out[key] = cloneValue(entry);
  return out;
};

const cloneFieldValue = (field: FieldValue): FieldValue =>
  isFieldMap(field)
    ? {
        map: Object.fromEntries(Object.entries(field.map).map(([k, v]) => [k, cloneFieldValue(v)])),
      }
    : { ...field, value: cloneValue(field.value) };

const cloneFields = (fields: Record<string, FieldValue>): Record<string, FieldValue> =>
  Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, cloneFieldValue(v)]));

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
export const resolveSingleGroupId = (
  group: GroupRef,
  entityName: string,
  operation: string,
): string => {
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
 * Look up the relationship by `(source, as)`, resolve the one-cardinality
 * unlink's existing row id (a storage read the pure operation cannot do),
 * and commit the `writeRelationship` operation. The operation itself owns
 * the GROUPS_ACCESSOR and undeclared-relationship refusals.
 */
async function submitRelationshipWrite(
  write: WriteCapability,
  storage: StorageAdapter,
  entityName: string,
  sourceId: string,
  as: string,
  pointer: RelationshipPointer,
): Promise<WriteResponse> {
  const relationshipSubjectId = await resolveUnlinkRelationshipId(
    write,
    storage,
    entityName,
    sourceId,
    as,
    pointer,
  );
  const groups = await readLiveGroupIds(storage, sourceId);
  const { response } = await commit(
    [
      call(writeRelationship, {
        entity: entityName,
        sourceId,
        as,
        pointer,
        relationshipSubjectId,
        groups,
      }),
    ],
    write,
  );
  return response;
}

/**
 * The one-cardinality unlink's existing relationship row id. The wire
 * delete must name the row's id so the server's authorizer can recover its
 * group. The lookup is skipped for link/setLinks and for refusals the
 * operation owns (the built-in membership accessor, an undeclared
 * relationship), so the operation's error is the one the caller sees.
 */
async function resolveUnlinkRelationshipId(
  write: WriteCapability,
  storage: StorageAdapter,
  entityName: string,
  sourceId: string,
  as: string,
  pointer: RelationshipPointer,
): Promise<string | undefined> {
  if (pointer.targetId !== null || pointer.targetIds !== undefined) return undefined;
  if (as === GROUPS_ACCESSOR) return undefined;
  const rel = write.registry.getRelationship(entityName, as);
  if (rel === undefined || rel.sourceCardinality !== "one") return undefined;
  const all = await storage.entities.query("relationship");
  const wireType = rel.type ?? entityName;
  const match = all.find(
    (e) =>
      e.data?.fields?.["source_id"]?.value === sourceId &&
      e.data?.fields?.["field"]?.value === as &&
      e.data?.fields?.["type"]?.value === wireType,
  );
  if (match === undefined) {
    throw new EntityValidationError([
      {
        entityName,
        message: `unlink("${as}"): no relationship found for source "${sourceId}" in the materialized cache; did you link() first and wait for catchUp?`,
      },
    ]);
  }
  return match.id;
}

/**
 * `client.group`: the generic read/write surface with the bootstrap
 * `create`. Membership verbs are dropped — a group is its own group,
 * and `entityGroup` rows stay internal.
 */
function createGroupNamespace(storage: StorageAdapter, write: WriteCapability): GroupNamespace {
  const base = createEntityNamespace<GroupFields, MembershipAccessors>(
    "group",
    groupSystemEntity.shape,
    storage,
    write,
  );
  return {
    query: base.query,
    get: base.get,
    subscribe: base.subscribe,
    duplicate: base.duplicate,
    update: base.update,
    delete: base.delete,
    link: base.link,
    unlink: base.unlink,
    setLinks: base.setLinks,
    async create(input, opts) {
      const bootstrap = groupBootstrap(write.registry, input.name, opts?.validate);
      const { response } = await commit([bootstrap.call], write);
      return { id: bootstrap.groupId, ...response };
    },
  };
}

/**
 * `client.groupMember`: the generic read/write surface with a plain
 * system put. Membership verbs are dropped — a member's scope is its
 * own `group_id`, so an `entityGroup` row for it has no meaning.
 */
function createGroupMemberNamespace(
  storage: StorageAdapter,
  write: WriteCapability,
): GroupMemberNamespace {
  const base = createEntityNamespace<GroupMemberFields, MembershipAccessors>(
    "groupMember",
    groupMemberSystemEntity.shape,
    storage,
    write,
  );
  return {
    query: base.query,
    get: base.get,
    subscribe: base.subscribe,
    duplicate: base.duplicate,
    update: base.update,
    delete: base.delete,
    link: base.link,
    unlink: base.unlink,
    setLinks: base.setLinks,
    async create(input, opts) {
      const id = generateId("e");
      const { response } = await commit(
        [
          call(createSystemEntity, {
            entity: "groupMember",
            id,
            fields: input as Record<string, unknown>,
            validate: opts?.validate,
          }),
        ],
        write,
      );
      return { id, ...response };
    },
  };
}

/**
 * Build the typed namespace surface for a schema. Returns an object
 * whose keys are the schema's entity names plus the system `group` /
 * `groupMember` namespaces, and whose values are the per-entity
 * `EntityNamespace`s. The Proxy layer in {@link SyncClient} forwards
 * unknown property access to this map.
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
  out["group"] = createGroupNamespace(storage, write) as unknown as EntityNamespace<
    Record<string, TSchema>
  >;
  out["groupMember"] = createGroupMemberNamespace(storage, write) as unknown as EntityNamespace<
    Record<string, TSchema>
  >;
  return out as EntityNamespaces<S>;
}
