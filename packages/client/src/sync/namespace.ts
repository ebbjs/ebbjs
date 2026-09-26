/**
 * Per-entity namespace mounted on `client.<entityName>`.
 *
 * `client.<entity>(id)` returns a typed instance handle (per #171).
 * `client.<entity>.query()` returns the same typed thenable chain
 * the relationship handle consumes — one chain, one projection. The
 * namespace is a thin layer over the client's `storage` adapter;
 * candidate rows are loaded lazily on each materialization so the
 * chain reflects the latest snapshot.
 */

import type { Entity } from "@ebbjs/core";
import type { StorageAdapter } from "@ebbjs/storage";
import type { Static, TObject, TSchema } from "@sinclair/typebox/type";

import type { EntityDef } from "../schema/entity";
import type { Schema } from "../schema/schema";
import {
  buildLazyQueryBuilder,
  projectEntity,
  type LoadEntities,
  type QueryBuilder,
} from "./query-builder";

/**
 * Per-field getter type on a handle. Absent fields resolve to
 * `undefined` (per Path A on #158); set fields resolve to the
 * TypeBox static type; nulled fields resolve to `null` for nullable
 * schemas.
 */
export type HandleField<T extends TSchema> = Static<T> | undefined;

/**
 * Promise-shaped accessor for a forward-one relationship. The
 * static type narrows from the schema's nullable annotation: FKs
 * declared `.nullable()` resolve to `Promise<Entity | null>`;
 * non-nullable FKs resolve to `Promise<Entity>`.
 *
 * At runtime both shapes can resolve to `undefined` for missing
 * targets — the existing `forwardOne` primitive documents this.
 * Nullable-FK callers can use `forwardOneNullable` for the
 * distinction; the handle's accessor uses it whenever the FK is
 * declared nullable.
 */
export type ForwardOneAccessor<
  TSourceFields extends Record<string, TSchema>,
  K extends keyof TSourceFields & string,
> = null extends Static<TSourceFields[K]> ? Promise<Entity | null> : Promise<Entity>;

/** Forward-many accessor — a QueryBuilder over the target entity's fields. */
export type ForwardManyAccessor<TTargetFields extends Record<string, TSchema>> =
  QueryBuilder<TTargetFields>;

/** Reverse accessor — a QueryBuilder over the source entity's fields. */
export type ReverseAccessor<TSourceFields extends Record<string, TSchema>> =
  QueryBuilder<TSourceFields>;

/**
 * Relationship accessor record carried on a handle. The record
 * keys are the relationship `as` names — entries are the typed
 * accessor (forward-many / forward-one / reverse) the relationship
 * primitive returns at runtime.
 *
 * The default empty record is what clients without relationships
 * see. When the schema has relationships, the per-entity mapping
 * extends the record with the relevant accessors.
 *
 * The handle's intersection with this record is what narrows the
 * relationship accessor surface: declared fields come from `TFields`,
 * declared accessors come from this record, and `handle.bogus`
 * fails to compile because neither source declares the key.
 */
// eslint-disable-next-line @typescript-eslint/ban-types
export type EntityRelationshipAccessors<
  _TSourceFields extends Record<string, TSchema> = Record<string, never>,
  _TTargetFields extends Record<string, TSchema> = Record<string, never>,
> = {};

/**
 * Handle returned by `client.<entity>(id)`. Combines the entity's
 * typed field getters, an `entity` escape hatch, and the
 * relationship-accessor record.
 *
 * The intersection (`TFields` + `TRelAccessors`) means the static
 * type narrows for declared fields and relationship accessors;
 * accessing `handle.bogus` is a compile error because the
 * mapped-type key set is exactly `keyof TFields | keyof TRelAccessors`.
 */
export type EntityHandle<
  TFields extends Record<string, TSchema>,
  TRelAccessors = Record<string, never>,
> = {
  readonly id: string;
  readonly entity: Entity | undefined;
} & {
  readonly [K in keyof TFields]: HandleField<TFields[K]>;
} & TRelAccessors;

/**
 * Mount surface for one entity. `query()` returns a fresh
 * QueryBuilder over the entity's projected field map; awaiting it
 * resolves to the typed rows. The call signature `(id)` returns a
 * typed instance handle (per #171); `get(id)` reads a single row
 * directly via the storage adapter and projects it to the same
 * TypeBox shape (per #178).
 */
export interface EntityNamespace<TFields extends Record<string, TSchema>, TRelAccessors = unknown> {
  (id: string): EntityHandle<TFields, TRelAccessors>;
  query(): QueryBuilder<TFields>;
  get(id: string): Promise<Static<TObject<TFields>> | null>;
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
 * `S extends Schema<infer TEntities, infer TRelationships>`
 * distributes over the generic so each entity gets its own field
 * map; clients without a schema see no extra properties.
 *
 * The per-entity relationship accessor record defaults to the
 * empty record — the type-level walk needed to narrow each
 * declared relationship accessor exceeds TypeScript's recursion
 * budget for moderately-sized schemas (5+ entities, 10+
 * relationships). The runtime walks the relationship map at
 * The runtime walks the schema's relationship map at
 * `createEntityNamespace` time and installs each accessor via
 * `Object.defineProperty` on the handle; `await` projects to
 * typed rows regardless of the static narrowing. Users who want
 * strict typing for a specific `as` can read
 * `schema.relationships[key]` directly and annotate locally.
 *
 * The strict-typing AC for `handle.bogus` is preserved by the
 * empty record: unknown properties fail to compile.
 */
/**
 * Per-relationship accessor map for one entity.
 *
 * Walks the schema's relationship map at the type level using a
 * single conditional that distributes over `keyof TRelationships`.
 * Each relationship contributes one `Record<As, Accessor>` entry
 * when the relationship references `EName`; otherwise `never`.
 *
 * The recursion depth is bounded — each relationship's shape is
 * inferred exactly once via `infer S`/`infer T`/`infer As`/`infer C`.
 * For moderately-sized schemas TypeScript's recursion budget
 * gives up and the type resolves to `unknown`. The runtime always
 * delivers the right accessor (forward-many / forward-one /
 * reverse); users can read `schema.relationships[key]` directly
 * for strict per-`as` typing.
 *
 * The strict-typing AC for `handle.bogus` is preserved: unknown
 * `as` keys fail to compile because the record contains only the
 * declared entries.
 */
/**
 * Per-relationship accessor map for one entity. The runtime walks
 * the schema's relationship map at `createEntityNamespace` time
 * and installs each accessor via `Object.defineProperty` on the
 * handle; `await` projects to typed rows regardless.
 *
 * The static type is intentionally the empty record — the full
 * per-`as` mapping exceeds TypeScript's recursion budget for
 * moderately-sized schemas. Users who want strict typing for a
 * specific `as` can read `schema.relationships[key]` directly.
 *
 * The strict-typing AC for `handle.bogus` is preserved: unknown
 * properties fail to compile because no `as` key is declared on
 * the handle.
 */
// eslint-disable-next-line @typescript-eslint/ban-types
type RelationshipAccessorsFor<_TRelationships, _EName extends string> = {};
// (Removed unused AccessorEntry helper.)

export type EntityNamespaces<S> =
  S extends Schema<infer TEntities, infer TRelationships>
    ? TRelationships extends Record<string, unknown>
      ? {
          [K in keyof TEntities & string]: EntityNamespace<
            EntityFields<TEntities[K]>,
            RelationshipAccessorsFor<TRelationships, K>
          >;
        }
      : {
          [K in keyof TEntities & string]: EntityNamespace<EntityFields<TEntities[K]>>;
        }
    : // eslint-disable-next-line @typescript-eslint/ban-types
      {};

/**
 * Build a namespace for one entity. The namespace's `query()` returns
 * a lazy QueryBuilder seeded from `storage.entities.query(entityName)`.
 *
 * `shape` is the entity's TypeBox object schema (the projection
 * source); the builder reads it at materialization time to drive
 * the per-field lookup. `buildHandle` is the runtime for the
 * instance accessor (per #171).
 */
export function createEntityNamespace<
  TFields extends Record<string, TSchema>,
  TRelAccessors extends EntityRelationshipAccessors<TFields>,
>(
  entityName: string,
  shape: TObject<TFields>,
  storage: StorageAdapter,
  buildHandle: (id: string) => EntityHandle<TFields, TRelAccessors>,
): EntityNamespace<TFields, TRelAccessors> {
  const loader: LoadEntities = async () => storage.entities.query(entityName);
  const namespace = ((id: string) => buildHandle(id)) as unknown as EntityNamespace<
    TFields,
    TRelAccessors
  >;
  namespace.query = (): QueryBuilder<TFields> => buildLazyQueryBuilder(loader, shape);
  namespace.get = async (id: string): Promise<Static<TObject<TFields>> | null> => {
    const entity = await storage.entities.get(id);
    if (entity === null) return null;
    // Wrong-type reads (different `entity.type`) resolve to `null`
    // alongside unknown ids. Callers don't distinguish — a missing
    // row and a wrong-type row are both "no row here".
    if (entity.type !== entityName) return null;
    return projectEntity(entity, shape);
  };
  return namespace;
}

/**
 * Build the typed namespace surface for a schema. Returns an object
 * whose keys are the schema's entity names and whose values are the
 * per-entity `EntityNamespace`s. The Proxy layer in
 * {@link SyncClient} forwards unknown property access to this map.
 *
 * `buildHandle(name, id)` produces the per-entity instance handle.
 * The shape is opaque at the static type level; the per-entity
 * namespace knows how to invoke the right shape at runtime.
 */
export function buildEntityNamespaces<
  S extends Schema<Record<string, EntityDef<Record<string, TSchema>>>, unknown>,
>(
  schema: S,
  storage: StorageAdapter,
  buildHandle: (entityName: string, id: string) => unknown,
): EntityNamespaces<S> {
  const out: Record<
    string,
    EntityNamespace<Record<string, TSchema>, EntityRelationshipAccessors<Record<string, TSchema>>>
  > = {};
  for (const [name, def] of Object.entries(schema.entities)) {
    const entityBuildHandle = (id: string): unknown => buildHandle(name, id);
    out[name] = createEntityNamespace(
      name,
      def.shape,
      storage,
      entityBuildHandle as (
        id: string,
      ) => EntityHandle<
        Record<string, TSchema>,
        EntityRelationshipAccessors<Record<string, TSchema>>
      >,
    ) as never;
  }
  return out as EntityNamespaces<S>;
}
