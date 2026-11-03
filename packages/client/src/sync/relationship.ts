/**
 * Storage-backed relationship traversal for the client's materialized
 * cache.
 *
 * The public read surface is the row-with-accessors returned by
 * `client.<entity>.get(id)`; the namespace dispatches into the
 * `forwardOne` / `forwardMany` / `reverse` helpers below. They stay
 * SDK-internal so the traversal has one entry point.
 *
 * The pure wire builders live in `@ebbjs/write` and are re-exported here so
 * existing imports from this module keep resolving.
 */

import type { Entity } from "@ebbjs/core";
import type {
  MembershipLink,
  RelationshipIndexQuery,
  RelationshipLink,
  RelationshipSourceQuery,
} from "@ebbjs/storage/types";
import type { TObject, TSchema } from "@sinclair/typebox/type";

import { type LoadEntities, type QueryBuilder, buildLazyQueryBuilder } from "./query-builder";
import { recordTraversalRows } from "./traversal-counter";

export {
  buildEntityGroupDelete,
  buildEntityGroupUpdate,
  buildEntityGroupUpdates,
  buildManyEntityUpdate,
  buildRelationshipUpdate,
  buildRelationshipWrite,
  collectManyTargetIds,
  normalizeManyPointers,
  resolveCardinality,
  type BuildRelationshipWriteOptions,
  type BuildRelationshipWriteResult,
  type ManyPointerValue,
} from "@ebbjs/write";

export { buildQueryBuilder, normalizePointer } from "./query-builder";
export type { PointerValue } from "./query-builder";

/**
 * The index reads a traversal needs. Reading through this interface —
 * rather than scanning the whole `relationship` / `entityGroup` type —
 * is what keeps a traversal proportional to the degree of the row it
 * starts from. The client binds it to the storage layer's adjacency
 * index in `buildRowAccessors`.
 */
export interface AdjacencyReader {
  /** Live edges out of the query's source under `(as, type)`, ascending by target id. */
  forwardLinks(query: RelationshipSourceQuery): Promise<readonly RelationshipLink[]>;
  /** Distinct live source ids pointing at the query's target, ascending. */
  reverseSourceIds(query: RelationshipIndexQuery): Promise<readonly string[]>;
  /** Live membership rows of the member entity, ascending by group id. */
  membershipsOf(entityId: string): Promise<readonly MembershipLink[]>;
}

/**
 * Build a forward-singular accessor result. For
 * `sourceCardinality: "one"` the canonical FK lives on a materialized
 * `Relationship` entity, read through the forward index by `source_id
 * + field + type`; it is not a field on the source entity, so users
 * don't have to declare one — `defineRelationship({source, target,
 * as})` alone wires the link.
 *
 * Returns:
 * - `null` when no Relationship record exists for `(sourceId, field,
 *   type)` — the link was cleared or never set
 * - `undefined` when an edge exists in metadata but the target id is
 *   dangling (target missing from the cache)
 * - `Entity` when both the edge and target resolve
 *
 * Source-mismatch (`source.type !== sourceName`) and missing-source
 * also return `undefined` to keep the surface uniform with the other
 * accessors.
 */
export async function forwardOne(
  readLocalEntity: (id: string) => Promise<Entity | null>,
  adjacency: AdjacencyReader,
  sourceId: string,
  sourceName: string,
  field: string,
  type: string,
): Promise<Entity | null | undefined> {
  const source = await loadEntity(readLocalEntity, sourceId);
  if (source === null) return undefined;
  if (source.type !== sourceName) return undefined;
  const links = await adjacency.forwardLinks({ as: field, type, sourceId });
  recordTraversalRows(links.length);
  const first = links[0];
  if (first === undefined) return null;
  const target = await loadEntity(readLocalEntity, first.targetId);
  return target ?? undefined;
}

/**
 * Build a forward-many accessor result. The canonical FK set lives on
 * materialized `Relationship` entities, read through the forward index
 * by `source_id + field + type`; it is not a field on the source
 * entity. The distinct target ids the index returns are the
 * relationship's set of links.
 *
 * `targetShape` drives the projection on `await qb` — the chain is
 * generic over the target entity's field map.
 *
 * Synchronous: the chain defers the storage reads to a `LoadEntities`
 * callback so the builder is thenable without an outer Promise.
 */
export function forwardMany<TFields extends Record<string, TSchema>>(
  readLocalEntity: (id: string) => Promise<Entity | null>,
  adjacency: AdjacencyReader,
  sourceId: string,
  sourceName: string,
  targetName: string,
  targetShape: TObject<TFields>,
  field: string,
  type: string,
): QueryBuilder<TFields> {
  const loader: LoadEntities = async () => {
    const source = await loadEntity(readLocalEntity, sourceId);
    if (source === null) return [];
    if (source.type !== sourceName) return [];
    const links = await adjacency.forwardLinks({ as: field, type, sourceId });
    recordTraversalRows(links.length);
    const targetIds = [...new Set(links.map((link) => link.targetId))];
    return loadRows(readLocalEntity, targetIds, targetName);
  };
  return buildLazyQueryBuilder(loader, targetShape);
}

/**
 * Build the built-in membership accessor result: the `group` rows the
 * member entity is filed into, read through the entity-keyed
 * membership index. Same lazy shape as {@link forwardMany}.
 */
export function membershipGroups<TFields extends Record<string, TSchema>>(
  readLocalEntity: (id: string) => Promise<Entity | null>,
  adjacency: AdjacencyReader,
  sourceId: string,
  targetName: string,
  targetShape: TObject<TFields>,
): QueryBuilder<TFields> {
  const loader: LoadEntities = async () => {
    const memberships = await adjacency.membershipsOf(sourceId);
    recordTraversalRows(memberships.length);
    // Two rows may name the same group; the accessor projects each group
    // once, matching the type-wide read it replaced.
    const groupIds = [...new Set(memberships.map((membership) => membership.groupId))];
    return loadRows(readLocalEntity, groupIds, targetName);
  };
  return buildLazyQueryBuilder(loader, targetShape);
}

/**
 * Build a reverse accessor result. The reverse index returns the
 * distinct source ids pointing at `targetId` under `(field, type)`;
 * each is loaded and kept only when it is a live `sourceName` row.
 *
 * `sourceShape` drives the projection on `await qb` — the chain is
 * generic over the source entity's field map.
 *
 * Synchronous: the chain defers the storage reads to a `LoadEntities`
 * callback so the builder is thenable without an outer Promise.
 */
export function reverse<TFields extends Record<string, TSchema>>(
  readLocalEntity: (id: string) => Promise<Entity | null>,
  adjacency: AdjacencyReader,
  targetId: string,
  sourceName: string,
  sourceShape: TObject<TFields>,
  field: string,
  type: string,
): QueryBuilder<TFields> {
  const loader: LoadEntities = async () => {
    const sourceIds = await adjacency.reverseSourceIds({ as: field, type, targetId });
    recordTraversalRows(sourceIds.length);
    return loadRows(readLocalEntity, sourceIds, sourceName);
  };
  return buildLazyQueryBuilder(loader, sourceShape);
}

/** Load one row and count it as examined by the traversal. */
async function loadEntity(
  readLocalEntity: (id: string) => Promise<Entity | null>,
  id: string,
): Promise<Entity | null> {
  const entity = await readLocalEntity(id);
  recordTraversalRows(1);
  return entity;
}

/**
 * Load the distinct rows an index read names, keeping only rows of
 * `type`. A miss or a wrong-typed row is dropped, matching the
 * type-wide read the index replaced.
 */
async function loadRows(
  readLocalEntity: (id: string) => Promise<Entity | null>,
  ids: readonly string[],
  type: string,
): Promise<readonly Entity[]> {
  const rows = await Promise.all(ids.map((id) => loadEntity(readLocalEntity, id)));
  return rows.filter((row): row is Entity => row !== null && row.type === type);
}
