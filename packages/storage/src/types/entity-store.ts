import type { Entity } from "@ebbjs/core";

/**
 * Lookup key for the relationship index: the accessor name (`as`),
 * the relationship type string, and the target entity id.
 */
export interface RelationshipIndexQuery {
  readonly as: string;
  readonly type: string;
  readonly targetId: string;
}

/**
 * EntityStore — materialized entity cache supporting get-by-ID and query-by-type.
 *
 * Entities are materialized on-demand from the action log when they are dirty.
 * The entity store is not responsible for marking entities dirty — that is
 * handled by the DirtyTracker.
 *
 * ## Merge Semantics
 * - **put** — full entity replacement
 * - **patch** — field-level Last-Writer-Wins (LWW): higher HLC wins; tiebreak by lexicographic `update_id`
 * - **delete** — soft delete (sets `deleted_hlc`); patch-on-deleted is ignored
 *
 * A field value is either a leaf merged by the LWW rule above, or a
 * `{ map }` of nested field values merged key by key under the same
 * rule. Map key sets are unioned, so a write to one key leaves its
 * siblings untouched; a leaf `value: null` is a tombstone retained for
 * late-apply and hidden by projection.
 *
 * ## Methods
 * - `get(id)` — returns entity by ID, materializes if dirty
 * - `set(entity)` — directly sets an entity (bypasses materialization)
 * - `query(type)` — returns all materialized entities of a type
 * - `queryByRelationship({ as, type, targetId })` — returns the distinct
 *   source ids indexed under that triple in ascending order,
 *   materializing dirty relationship rows first
 * - `queryByMembership(groupId)` — returns the distinct live member
 *   entity ids whose `entityGroup` row points at the group, ascending,
 *   materializing dirty `entityGroup` rows first
 * - `reset()` — clears all cached entities
 */
export interface EntityStore {
  get(id: string): Promise<Entity | null>;
  set(entity: Entity): Promise<void>;
  query(type: string): Promise<readonly Entity[]>;
  queryByRelationship(query: RelationshipIndexQuery): Promise<readonly string[]>;
  queryByMembership(groupId: string): Promise<readonly string[]>;
  reset(): Promise<void>;
}
