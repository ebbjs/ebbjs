/**
 * DirtyTracker — tracks which entities need rematerialization.
 *
 * An entity is "dirty" when it has pending actions that haven't been
 * applied to the materialized entity cache. Callers should invoke
 * `mark(entityId, entityType)` when an action affects an entity, then
 * materialize via `EntityStore.get()` or `EntityStore.query()`.
 *
 * ## Methods
 * - `mark(entityId, entityType)` — marks an entity dirty (idempotent)
 * - `isDirty(entityId)` — checks if an entity needs materialization
 * - `getDirtyForType(entityType)` — returns all dirty entity IDs of a type
 * - `clear(entityId)` — clears dirty flag after materialization
 * - `clearAll()` — clears all dirty flags (used for reset)
 */
export interface DirtyTracker {
  mark(entityId: string, entityType: string): Promise<void>;
  isDirty(entityId: string): Promise<boolean>;
  getDirtyForType(entityType: string): Promise<readonly string[]>;
  clear(entityId: string): Promise<void>;
  clearAll(): Promise<void>;
}
