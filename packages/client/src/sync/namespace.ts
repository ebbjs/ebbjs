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

import type { Entity } from "@ebbjs/core";
import type { StorageAdapter } from "@ebbjs/storage";
import type { Static, TObject, TSchema } from "@sinclair/typebox/type";

import type { EntityDef } from "../schema/entity";
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
  forwardOneNullable,
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
 * The forward-one branch accepts `Entity | null | undefined` to
 * match {@link forwardOneNullable}'s return shape; callers narrow
 * at the call site. The collapsed `Entity | undefined` from
 * {@link forwardOne} fits inside the same union.
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
 * `TAs` is reserved for future per-entity accessor key typing;
 * today every namespace carries `TAs = never` and the static type
 * surfaces only the projected fields. See {@link EntityNamespaces}
 * for why the relationship map isn't walked at the type level.
 */
export interface EntityNamespace<
  TFields extends Record<string, TSchema>,
  TAs extends string = never,
> {
  query(): QueryBuilder<TFields>;
  get(id: string): Promise<EntityWithAccessors<TFields, TAs> | null>;
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
 * - forward-many → `QueryBuilder<TargetFields>` (thenable)
 * - forward-one → `Promise<Entity | null>` (collapses null/absent
 *   to `undefined`; nullable FKs distinguish explicit `null` from
 *   absent/missing)
 * - reverse → `QueryBuilder<SourceFields>` (thenable)
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
  shape: TObject<Record<string, TSchema>>,
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
      );
      continue;
    }
    // forward-one: branch on FK nullability. The source entity's
    // TypeBox shape tells us whether the field was declared
    // `e.string().nullable()` — TypeBox represents it as a union
    // `anyOf: [<inner>, {type: "null"}]`. Anything else collapses
    // to `undefined` semantics.
    const fieldSchema = shape.properties?.[field];
    const nullable = isNullableSchema(fieldSchema);
    if (nullable) {
      out[field] = forwardOneNullable(readLocalEntity, sourceId, entityName, field);
    } else {
      out[field] = forwardOne(readLocalEntity, sourceId, entityName, field);
    }
  }

  // Reverse accessors — relationships where this entity is the target.
  for (const rel of registry.getRelationshipsForTarget(entityName)) {
    const sourceName = rel.source.name;
    const field = rel.as;
    const type = rel.type;
    const sourceShape = registry.get(sourceName)?.shape;
    if (sourceShape === undefined) continue;
    out[field] = reverseTraversal(
      readLocalEntity,
      queryEntitiesByType,
      sourceId,
      sourceName,
      sourceShape,
      field,
      type,
    );
  }

  return out;
}

/**
 * Detect the `e.string().nullable()` chain — TypeBox emits a
 * `Type.Union([<inner>, Type.Null()])` shape, so we look for an
 * `anyOf` array whose last element is the `null` literal. Used by
 * the row-accessor forward-one dispatch to pick
 * {@link forwardOneNullable} over {@link forwardOne}.
 */
function isNullableSchema(schema: unknown): boolean {
  if (schema === null || typeof schema !== "object") return false;
  const s = schema as { anyOf?: unknown };
  if (!Array.isArray(s.anyOf)) return false;
  const last = s.anyOf[s.anyOf.length - 1];
  if (last === null || typeof last !== "object") return false;
  const t = (last as { type?: unknown }).type;
  return t === "null";
}

/**
 * Build a namespace for one entity. The namespace's `query()` returns
 * a lazy QueryBuilder seeded from `storage.entities.query(entityName)`.
 *
 * `shape` is the entity's TypeBox object schema (the projection
 * source); the builder reads it at materialization time to drive
 * the per-field lookup. `registry` supplies the relationship
 * declarations the row-with-accessors consult at `get(id)` time.
 */
export function createEntityNamespace<
  TFields extends Record<string, TSchema>,
  TAs extends string = never,
>(
  entityName: string,
  shape: TObject<TFields>,
  storage: StorageAdapter,
  registry: EntityRegistry,
): EntityNamespace<TFields, TAs> {
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
      const accessors = buildRowAccessors(
        entityName,
        id,
        shape as unknown as TObject<Record<string, TSchema>>,
        storage,
        registry,
      );
      return { ...projected, ...accessors } as EntityWithAccessors<TFields, TAs>;
    },
  };
}

/**
 * Build the typed namespace surface for a schema. Returns an object
 * whose keys are the schema's entity names and whose values are the
 * per-entity `EntityNamespace`s. The Proxy layer in
 * {@link SyncClient} forwards unknown property access to this map.
 */
export function buildEntityNamespaces<
  S extends Schema<Record<string, EntityDef<Record<string, TSchema>>>, unknown>,
>(schema: S, storage: StorageAdapter, registry: EntityRegistry): EntityNamespaces<S> {
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
      registry,
    );
  }
  return out as EntityNamespaces<S>;
}
