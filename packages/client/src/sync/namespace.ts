/**
 * Per-entity namespace mounted on `client.<entityName>`.
 *
 * `client.<entity>.query()` returns the same typed thenable chain
 * the relationship handle consumes — one chain, one projection. The
 * namespace is a thin layer over the client's `storage` adapter;
 * candidate rows are loaded lazily on each materialization so the
 * chain reflects the latest snapshot.
 *
 * `client.<entity>.get(id)` returns the typed projection for a
 * single row with relationship accessors attached for every
 * declared relationship on the entity (forward-many,
 * forward-one, reverse). The accessor dispatch reuses the same
 * primitives `client.relationship({...})` already consumes.
 */

import type { Entity, Update } from "@ebbjs/core";
import { generateId } from "@ebbjs/core";
import type { WriteResponse } from "./types";
import type { StorageAdapter } from "@ebbjs/storage/types";
import type { Static, TObject, TSchema } from "@sinclair/typebox/type";

import type { EntityDef, ShapeFields } from "../schema/entity";
import { EntityValidationError, validatePayload } from "../schema/entity-registry";
import type { EntityRegistry } from "../schema/entity-registry";
import type { Schema } from "../schema/schema";
import {
  buildLazyQueryBuilder,
  projectEntity,
  projectRows,
  type LoadEntities,
  type QueryBuilder,
} from "./query-builder";
import {
  forwardMany,
  forwardOne,
  type ManyPointerValue,
  type PointerValue,
  reverse as reverseTraversal,
} from "./relationship";

/**
 * Runtime shape of a single relationship accessor on a row. The
 * union covers every cardinality the relationship primitive
 * dispatches; the runtime picks the right path based on the
 * registered relationship, not the static type. Per-accessor
 * narrowing is a type-level follow-up (TS recursion limits bite
 * when walking the schema's relationship map).
 *
 * The forward-one branch accepts `Entity | null | undefined` —
 * `null` when no Relationship edge exists, `undefined` when the
 * edge exists but the target is missing, `Entity` when both
 * resolve.
 */
export type RowAccessor =
  | Promise<Entity | null | undefined>
  | QueryBuilder<Record<string, TSchema>>;

/**
 * Row with attached relationship accessors. The projected TypeBox
 * shape (the entity's field map) is the static type the user sees;
 * relationship accessors are attached at runtime and overwrite the
 * matching field's value (the field name and the relationship's
 * `as` name are the same key, by design).
 *
 * The accessor record's value type is the loose `RowAccessor` union
 * — per-accessor narrowing (forward-many → `QueryBuilder`,
 * forward-one → `Promise<Entity | null>`, reverse → `QueryBuilder`)
 * is a follow-up because TS recursion limits bite when walking the
 * schema's relationship map at the type level.
 *
 * `TAs` is a string-literal union of declared relationship names
 * on the entity. Today it's `never` for every namespace — see
 * {@link EntityNamespaces} for why a per-entity walker isn't
 * threaded through. The runtime attaches one accessor for each
 * declared `as` key; the static type intentionally keeps the
 * projected fields without an explicit accessor record, so unknown
 * `as` names that don't overlap with a field (`row.bogus` on an
 * entity where `bogus` isn't a field) are a compile error.
 *
 * Forward accessors that overlap with a field key (e.g.,
 * `row.tags` where `tags` is both a field and a relationship)
 * resolve at runtime to the accessor value, but the static type
 * still surfaces the field's value type — tests that need to read
 * the accessor's resolved value cast through `unknown`.
 */
export type EntityWithAccessors<
  TFields extends Record<string, TSchema>,
  TAs extends string = never,
> = [TAs] extends [never] ? Static<TObject<ShapeFields<TFields>>> : never;

/**
 * Per-entity snapshot for reactive subscribe. Path C pins this
 * shape (#161's design comment): the projected row fields plus
 * an `id` and an `entity` escape hatch so subscribers can pull
 * the wire envelope (`deleted_hlc`, HLC timestamps, etc.) without
 * losing the strict per-field typing.
 *
 * The per-entity instance handle's `subscribe(cb)` uses the same
 * shape (#171 follow-up). Defining it here means the per-entity
 * subscribe that lands with #171 reuses this type verbatim — no
 * migration when #171 merges.
 */
export type EntitySnapshot<TFields extends Record<string, TSchema>> = Static<
  TObject<ShapeFields<TFields>>
> & {
  readonly id: string;
  readonly entity: Entity;
};

/**
 * Filter shape for `client.<entity>.subscribe(filter, cb)`.
 * Field-name → equality-value. Path C pins this exact shape (see
 * the design comment on #161).
 */
export type QueryFilter<TFields extends Record<string, TSchema>> = {
  [K in keyof TFields]?: Static<TFields[K]>;
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
 * and attaches relationship accessors for every declared
 * relationship on the entity.
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
 * `TAs` is reserved for per-entity accessor key typing; today
 * every namespace carries `TAs = never` and the static type
 * surfaces only the projected fields. See {@link EntityNamespaces}
 * for why the relationship map isn't walked at the type level.
 */
export interface EntityNamespace<
  TFields extends Record<string, TSchema>,
  TAs extends string = never,
> {
  query(): QueryBuilder<TFields>;
  get(id: string): Promise<EntityWithAccessors<TFields, TAs> | null>;
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
   */
  create(
    input: Static<TObject<ShapeFields<TFields>>>,
    opts?: EntityWriteOptions,
  ): Promise<WriteResponse>;
  /**
   * Patch an existing entity row, validated the same way as
   * `create`'s input. The wire Update is a `patch`.
   */
  update(
    id: string,
    patch: Partial<Static<TObject<ShapeFields<TFields>>>>,
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
}

/**
 * Per-write options. `validate: false` skips the local `Value.Check`
 * pass — useful for tests / pre-validated upstream callers. The
 * registry's name-membership check at `client.write()` still runs.
 */
export interface EntityWriteOptions {
  validate?: boolean;
}

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
 * `S extends Schema<infer TEntities, ...>` distributes over the
 * generic so each entity gets its own field map; clients without
 * a schema see no extra properties.
 *
 * The `TAs` parameter defaults to `never` and isn't threaded from
 * the schema's relationship map — `RelationshipDef`'s source/target
 * types are generic `EntityDef<...>` parameters with `name: string`
 * (not literal names), so a type-level walker can't recover the
 * per-entity accessor key set without coupling to the schema's
 * relationship-record key naming convention. The runtime walks the
 * `EntityRegistry` and attaches one accessor per declared `as` name;
 * the static type carries `TAs = never` for every entity, meaning
 * `row.bogus` fails to compile because it's not in the projected
 * row's keys (forward overlap) or only fails when the entity has no
 * field with that name (reverse accessors stay type-loose).
 */
export type EntityNamespaces<S> =
  S extends Schema<infer TEntities, unknown>
    ? {
        [K in keyof TEntities & string]: EntityNamespace<EntityFields<TEntities[K]>>;
      }
    : // eslint-disable-next-line @typescript-eslint/ban-types
      {};

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
    const targetShape = registry.get(targetName)?.shape;
    if (rel.sourceCardinality === "many") {
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

  return out;
}

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
}

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
  TAs extends string = never,
>(
  entityName: string,
  shape: TObject<TFields>,
  storage: StorageAdapter,
  write: WriteCapability,
): EntityNamespace<TFields, TAs> {
  const registry = write.registry;
  const loader: LoadEntities = async () => storage.entities.query(entityName);
  return {
    query(): QueryBuilder<TFields> {
      return buildLazyQueryBuilder(loader, shape);
    },
    async get(id: string): Promise<EntityWithAccessors<TFields, TAs> | null> {
      const entity = await storage.entities.get(id);
      if (entity === null) return null;
      // Wrong-type reads (different `entity.type`) resolve to `null`
      // alongside unknown ids. Callers don't distinguish — a missing
      // row and a wrong-type row are both "no row here".
      if (entity.type !== entityName) return null;
      const projected = projectEntity(entity, shape);
      const accessors = buildRowAccessors(entityName, id, storage, registry);
      return { ...projected, ...accessors } as EntityWithAccessors<TFields, TAs>;
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
        for (const [field, value] of Object.entries(filter)) {
          const fieldEntry = entity.data?.fields?.[field];
          const current = fieldEntry === undefined ? undefined : fieldEntry.value;
          if (current !== value) return false;
        }
        return true;
      };
      const buildSnapshot = (): CollectionSnapshot<TFields> => {
        const rows = [...matching.values()];
        const projected = projectRows(rows, shape) as Static<TObject<ShapeFields<TFields>>>[];
        const entities: EntitySnapshot<TFields>[] = projected.map((row, i) => ({
          ...row,
          id: rows[i]!.id,
          entity: rows[i]!,
        }));
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
      input: Static<TObject<ShapeFields<TFields>>>,
      opts?: EntityWriteOptions,
    ): Promise<WriteResponse> {
      return submitEntityWrite(write, entityName, shape, {
        subjectId: generateId("e"),
        payload: input,
        partial: false,
        validate: opts?.validate,
      });
    },
    async update(
      id: string,
      patch: Partial<Static<TObject<ShapeFields<TFields>>>>,
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
  const update: Update = {
    id: updateId,
    subject_id: input.subjectId,
    subject_type: entityName,
    method: input.partial ? "patch" : "put",
    data: { fields },
  };
  return write.submitRelationshipUpdates([update]);
}

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
const wrapFields = (
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
    // Per-entity `TAs` stays at the default `never` (see
    // {@link EntityNamespaces} for why); the runtime registry is the
    // authority for accessor dispatch, and the static type surfaces
    // only the projected fields.
    out[name] = createEntityNamespace<Record<string, TSchema>, never>(
      name,
      def.shape,
      storage,
      write,
    );
  }
  return out as EntityNamespaces<S>;
}
