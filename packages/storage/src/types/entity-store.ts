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

/** One live `ebb/membership` row read from the member entity side. */
export interface MembershipLink {
  /** The membership row id — the `subject_id` a delete names. */
  readonly membershipId: string;
  readonly groupId: string;
}

/**
 * EntityStore — materialized entity cache supporting get-by-ID and query-by-model.
 *
 * Entities are materialized on-demand from the action log when they are dirty.
 * The entity store is not responsible for marking entities dirty — that is
 * handled by the DirtyTracker.
 *
 * ## Merge Semantics
 * - **create** — the row's existence, its model, and its creation time. It
 *   names no component, and it is the only write that makes a row exist; a
 *   duplicate create for a row the store already holds (or has tombstoned) is
 *   a no-op.
 * - **merge** — Last-Writer-Wins (LWW) at the component's field: higher HLC wins; tiebreak by lexicographic `update_id`
 * - **replace** — the component's field is set whole
 * - **drop** — the component's field is removed; the row survives
 * - **delete** — soft delete (sets `deleted_hlc`); the row retains its model
 *
 * A component write whose create the store has not seen materializes a
 * placeholder with `exists: false`; it never invents the row, so the base
 * backfill can supply the create.
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
 * - `query(model)` — returns all materialized entities of a model
 * - `queryByComponent(component)` — returns the live ids carrying that
 *   `<model>/<field>` component in ascending order, materializing dirty rows
 * - `queryByRelationship({ as, type, targetId })` — returns the distinct
 *   source ids indexed under that triple in ascending order,
 *   materializing dirty rows
 * - `queryByMembership(groupId)` — returns the distinct live member
 *   entity ids whose `ebb/membership` row points at the group, ascending,
 *   materializing dirty `ebb` rows first
 * - `queryByMembershipEntity(entityId)` — returns the live membership
 *   rows of that member entity, ascending by group id, materializing
 *   dirty `ebb` rows first
 * - `reset()` — clears all cached entities
 *
 * Forward relationship traversal is not a store read: an edge is a key of its
 * source row's `ebb/link` component, so the caller reads the source row and
 * derives its targets with `linkTargets`.
 */
export interface EntityStore {
  get(id: string): Promise<Entity | null>;
  set(entity: Entity): Promise<void>;
  query(model: string): Promise<readonly Entity[]>;
  /**
   * Live rows currently carrying `component` (`<model>/<field>`), ascending by
   * id. Existence is the set of present fields on a row, so this is an index
   * read rather than a row filter; a tombstoned row's components are not
   * existence.
   *
   * A platform component (`ebb/link`) may sit on a row of any model (#820), so
   * its read materializes every dirty row; a user component materializes the
   * dirty rows of its own model.
   */
  queryByComponent(component: string): Promise<readonly string[]>;
  /**
   * The distinct live sources of the edges under `(as, type, targetId)`,
   * ascending. The reverse adjacency direction; a source's own edges are a
   * component read of its row.
   */
  queryByRelationship(query: RelationshipIndexQuery): Promise<readonly string[]>;
  queryByMembership(groupId: string): Promise<readonly string[]>;
  queryByMembershipEntity(entityId: string): Promise<readonly MembershipLink[]>;
  reset(): Promise<void>;
}
