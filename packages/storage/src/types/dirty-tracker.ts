/**
 * DirtyTracker — tracks which entities need rematerialization.
 *
 * An entity is "dirty" when it has pending actions that haven't been
 * applied to the materialized entity cache. Callers should invoke
 * `mark(entityId, model)` when an action affects an entity, then
 * materialize via `EntityStore.get()` or `EntityStore.query()`.
 *
 * ## Methods
 * - `mark(entityId, model)` — marks an entity dirty (idempotent)
 * - `isDirty(entityId)` — checks if an entity needs materialization
 * - `getDirtyForModel(model)` — returns all dirty entity IDs of a type
 * - `getDirty()` — returns every dirty entity ID, for a read whose rows may
 *   belong to any model
 * - `clear(entityId)` — clears dirty flag after materialization
 * - `clearAll()` — clears all dirty flags (used for reset)
 */
export interface DirtyTracker {
  mark(entityId: string, model: string): Promise<void>;
  isDirty(entityId: string): Promise<boolean>;
  getDirtyForModel(model: string): Promise<readonly string[]>;
  /**
   * Every dirty entity id, whatever model it belongs to. A platform component
   * can sit on a row of any model, so a read over one cannot narrow to a model.
   */
  getDirty(): Promise<readonly string[]>;
  clear(entityId: string): Promise<void>;
  clearAll(): Promise<void>;
}
