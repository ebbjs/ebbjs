import type { Action } from "@ebbjs/core";

/**
 * ActionLog — stores received actions and provides entity-level queries.
 *
 * The action log is the source of truth. Entities are derived by replaying
 * actions during materialization.
 *
 * ## Methods
 * - `append(action)` — stores an action, marks affected entities dirty
 * - `getAll()` — returns all stored actions
 * - `getForEntity(entityId)` — returns all actions affecting an entity, sorted by GSN
 * - `clear()` — removes all actions (used for reset)
 */
export interface ActionLog {
  append(action: Action): Promise<void>;
  getAll(): Promise<readonly Action[]>;
  getForEntity(entityId: string): Promise<readonly Action[]>;
  clear(): Promise<void>;
}
