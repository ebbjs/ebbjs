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

import type { EntityDef } from "../schema/entity";
import { EntityValidationError, validatePayload } from "../schema/entity-registry";
import type { EntityRegistry } from "../schema/entity-registry";
import type { Schema } from "../schema/schema";
import {
  buildLazyQueryBuilder,
  projectEntity,
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
> = [TAs] extends [never] ? Static<TObject<TFields>> : never;

/**
 * Mount surface for one entity. `query()` returns a fresh
 * QueryBuilder over the entity's projected field map; awaiting it
 * resolves to the typed rows. `get(id)` reads a single row directly
 * via the storage adapter, projects it to the same TypeBox shape,
 * and attaches relationship accessors for every declared
 * relationship on the entity.
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
   * Create a new entity row. The input is the typed
   * `Static<TObject<TFields>>` projection — fields are checked
   * against the entity's TypeBox shape via `Value.Check` *before*
   * any network call, and a non-conforming payload throws
   * `EntityValidationError` with one violation per bad field.
   *
   * A fresh `subject_id` is minted client-side; the wire Update
   * carries `method: "put"`. Pass `{ validate: false }` to skip the
   * local check (useful for tests or pre-validated inputs).
   */
  create(input: Static<TObject<TFields>>, opts?: EntityWriteOptions): Promise<WriteResponse>;
  /**
   * Patch an existing entity row. The patch is
   * `Partial<Static<TObject<TFields>>>` — keys are checked for
   * membership and values for type conformance against the
   * entity's TypeBox shape, same as `create`. The wire Update
   * carries `method: "patch"`. Pass `{ validate: false }` to skip
   * the local check.
   */
  update(
    id: string,
    patch: Partial<Static<TObject<TFields>>>,
    opts?: EntityWriteOptions,
  ): Promise<WriteResponse>;
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
 * Per-write options consumed by `EntityNamespace.create` and
 * `EntityNamespace.update`. Validation is on by default; pass
 * `validate: false` to opt out (useful for tests / pre-validated
 * upstream callers). The opt-out doesn't bypass the server — it
 * just skips the local `Value.Check` pass.
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
    async create(
      input: Static<TObject<TFields>>,
      opts?: EntityWriteOptions,
    ): Promise<WriteResponse> {
      return submitEntityWrite(write, entityName, shape, {
        method: "put",
        subjectId: generateId("e"),
        payload: input,
        partial: false,
        validate: opts?.validate,
      });
    },
    async update(
      id: string,
      patch: Partial<Static<TObject<TFields>>>,
      opts?: EntityWriteOptions,
    ): Promise<WriteResponse> {
      return submitEntityWrite(write, entityName, shape, {
        method: "patch",
        subjectId: id,
        payload: patch,
        partial: true,
        validate: opts?.validate,
      });
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
 * Options for {@link submitEntityWrite}. `method` selects put vs
 * patch; `subjectId` is the entity id (caller-minted for `create`,
 * caller-supplied for `update`); `payload` is the typed field map
 * the user passed in; `partial` flips the validator from full-shape
 * (create) to per-field (update); `validate` defaults to on.
 */
interface SubmitEntityWriteInput {
  method: "put" | "patch";
  subjectId: string;
  payload: unknown;
  partial: boolean;
  validate: boolean | undefined;
}

/**
 * Run `Value.Check` against the entity shape and submit a single
 * entity Update. Throws `EntityValidationError` when the payload
 * doesn't conform and validation is on. The validation result is
 * the SDK's local contract — the server may still reject the
 * write for other reasons (permissions, conflicts).
 *
 * Each field value is wrapped into the `{ value, update_id, hlc }`
 * envelope the wire Update carries. `update_id` reuses the
 * namespace's freshly-minted id (one id per Update); `hlc` is the
 * local clock so concurrent writers can detect a causal-order
 * inversion on the server.
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
  }
  const hlc = write.freshHlc();
  const updateId = write.generateUpdateId();
  const fields = wrapFields(input.payload, updateId, hlc);
  const update: Update = {
    id: updateId,
    subject_id: input.subjectId,
    subject_type: entityName,
    method: input.method,
    data: { fields },
  };
  return write.submitRelationshipUpdates([update]);
}

/**
 * Wrap a flat `{ fieldName: value }` payload into the wire
 * envelope `{ fields: { fieldName: { value, update_id, hlc } } }`.
 * `undefined` fields are dropped (the wire envelope is absent, not
 * explicitly `undefined`). `null` is preserved as the field's value
 * so nullable fields round-trip cleanly.
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
