/**
 * Per-entity namespace mounted on `client.<entityName>`.
 *
 * `client.<entity>.query()` returns the same typed thenable chain
 * the relationship handle consumes — one chain, one projection. The
 * namespace is a thin layer over the client's `storage` adapter;
 * candidate rows are loaded lazily on each materialization so the
 * chain reflects the latest snapshot.
 */

import type { StorageAdapter } from "@ebbjs/storage";
import type { TObject, TSchema } from "@sinclair/typebox/type";

import type { EntityDef } from "../schema/entity";
import type { Schema } from "../schema/schema";
import { buildLazyQueryBuilder, type LoadEntities, type QueryBuilder } from "./query-builder";

/**
 * Mount surface for one entity. `query()` returns a fresh
 * QueryBuilder over the entity's projected field map; awaiting it
 * resolves to the typed rows.
 */
export interface EntityNamespace<TFields extends Record<string, TSchema>> {
  query(): QueryBuilder<TFields>;
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
 */
export type EntityNamespaces<S> =
  S extends Schema<infer TEntities, unknown>
    ? { [K in keyof TEntities & string]: EntityNamespace<EntityFields<TEntities[K]>> }
    : // eslint-disable-next-line @typescript-eslint/ban-types
      {};

/**
 * Build a namespace for one entity. The namespace's `query()` returns
 * a lazy QueryBuilder seeded from `storage.entities.query(entityName)`.
 *
 * `shape` is the entity's TypeBox object schema (the projection
 * source); the builder reads it at materialization time to drive
 * the per-field lookup.
 */
export function createEntityNamespace<TFields extends Record<string, TSchema>>(
  entityName: string,
  shape: TObject<TFields>,
  storage: StorageAdapter,
): EntityNamespace<TFields> {
  const loader: LoadEntities = async () => storage.entities.query(entityName);
  return {
    query(): QueryBuilder<TFields> {
      return buildLazyQueryBuilder(loader, shape);
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
>(schema: S, storage: StorageAdapter): EntityNamespaces<S> {
  const out: Record<string, EntityNamespace<Record<string, TSchema>>> = {};
  for (const [name, def] of Object.entries(schema.entities)) {
    out[name] = createEntityNamespace(name, def.shape, storage);
  }
  return out as EntityNamespaces<S>;
}
