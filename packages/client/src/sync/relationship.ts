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

import { carriesComponent, type EbbComponentKind, type Entity } from "@ebbjs/core";
import type { MembershipLink, RelationshipIndexQuery } from "@ebbjs/storage/types";
import type { TObject, TSchema } from "@sinclair/typebox/type";

import type { ComponentMigrations } from "./migrations";
import { type LoadEntities, type QueryBuilder, buildLazyQueryBuilder } from "./query-builder";
import { componentRowView } from "./system-row";
import { recordTraversalRows } from "./traversal-counter";

export {
  buildMembershipDelete,
  buildMembershipUpdate,
  buildMembershipUpdates,
  buildRelationshipWrite,
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
 * rather than scanning the `ebb` model — is what keeps a traversal
 * proportional to the degree of the row it starts from. The client binds it
 * to the storage layer's adjacency index in `buildRowAccessors`.
 */
export interface AdjacencyReader {
  /**
   * Live target ids of `(as, type)` on the source row's own `ebb/link`
   * component, ascending. A component read, not an index read: the source row
   * carries its edges.
   */
  forwardTargets(sourceId: string, as: string, type: string): Promise<readonly string[]>;
  /** Distinct live source ids pointing at the query's target, ascending. */
  reverseSourceIds(query: RelationshipIndexQuery): Promise<readonly string[]>;
  /** Live membership rows of the member entity, ascending by group id. */
  membershipsOf(entityId: string): Promise<readonly MembershipLink[]>;
}

/**
 * Build a forward-singular accessor result. For
 * `sourceCardinality: "one"` the edge is a key of the source row's
 * `ebb/link` component, read as `linkTargets(row, as, type)`; it is not a
 * field on the source's model, so users don't have to declare one —
 * `defineRelationship({source, target, as})` alone wires the link.
 *
 * Returns:
 * - `null` when the source carries no live edge for `(field, type)` — the
 *   link was cleared or never set, or the source row is tombstoned
 * - `undefined` when the target id is dangling (target missing from the
 *   cache)
 * - `Entity` when both the edge and target resolve
 *
 * Source-mismatch (`source.model !== sourceName`) and missing-source
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
  if (source.model !== sourceName) return undefined;
  // A tombstoned row keeps its fields, so its edges are asked for separately.
  if (source.deleted_hlc !== null) return null;
  const targets = await adjacency.forwardTargets(sourceId, field, type);
  recordTraversalRows(targets.length);
  const first = targets[0];
  if (first === undefined) return null;
  const target = await loadEntity(readLocalEntity, first);
  return target ?? undefined;
}

/**
 * Build a forward-many accessor result. The target set is the live edges
 * keyed on the source row's `ebb/link` component, read as
 * `linkTargets(row, as, type)`; it is not a field on the source entity.
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
  migrations?: ComponentMigrations,
): QueryBuilder<TFields> {
  const loader: LoadEntities = async () => {
    const source = await loadEntity(readLocalEntity, sourceId);
    if (source === null) return [];
    if (source.model !== sourceName) return [];
    if (source.deleted_hlc !== null) return [];
    const targetIds = await adjacency.forwardTargets(sourceId, field, type);
    recordTraversalRows(targetIds.length);
    return loadRows(readLocalEntity, targetIds, targetName);
  };
  return buildLazyQueryBuilder(loader, targetShape, migrations);
}

/**
 * Build the built-in membership accessor result: the group rows the member
 * entity is filed into, read through the entity-keyed membership index. Same
 * lazy shape as {@link forwardMany}. Rows are filtered on the `ebb/group`
 * component, since `row.model` is `ebb` for a grant too.
 */
export function membershipGroups<TFields extends Record<string, TSchema>>(
  readLocalEntity: (id: string) => Promise<Entity | null>,
  adjacency: AdjacencyReader,
  sourceId: string,
  targetName: string,
  targetShape: TObject<TFields>,
  migrations?: ComponentMigrations,
): QueryBuilder<TFields> {
  const loader: LoadEntities = async () => {
    const memberships = await adjacency.membershipsOf(sourceId);
    recordTraversalRows(memberships.length);
    // Two rows may name the same group; the accessor projects each group
    // once, matching the type-wide read it replaced.
    const groupIds = [...new Set(memberships.map((membership) => membership.groupId))];
    const rows = await loadRows(readLocalEntity, groupIds, targetName, "group");
    // The accessor projects the component's value, not the `ebb` row: a group
    // reads as `{id, name, apps}`.
    return rows.flatMap((row) => componentRowView(row, "group") ?? []);
  };
  return buildLazyQueryBuilder(loader, targetShape, migrations);
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
  migrations?: ComponentMigrations,
): QueryBuilder<TFields> {
  const loader: LoadEntities = async () => {
    const sourceIds = await adjacency.reverseSourceIds({ as: field, type, targetId });
    recordTraversalRows(sourceIds.length);
    return loadRows(readLocalEntity, sourceIds, sourceName);
  };
  return buildLazyQueryBuilder(loader, sourceShape, migrations);
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
 * Load the distinct rows an index read names, keeping only rows of `type` and,
 * for a platform target whose model is shared by all four kinds, only rows
 * carrying `component`.
 */
async function loadRows(
  readLocalEntity: (id: string) => Promise<Entity | null>,
  ids: readonly string[],
  type: string,
  component?: EbbComponentKind,
): Promise<readonly Entity[]> {
  const rows = await Promise.all(ids.map((id) => loadEntity(readLocalEntity, id)));
  return rows.filter(
    (row): row is Entity =>
      row !== null &&
      row.model === type &&
      (component === undefined || carriesComponent(row, component)),
  );
}
