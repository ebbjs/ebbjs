import type { ActionLog } from "./action-log";
import type { DirtyTracker } from "./dirty-tracker";
import type { EntityStore } from "./entity-store";
import type { CursorStore } from "./cursor-store";

/**
 * StorageAdapter — unified interface composing all storage components.
 *
 * Use `createMemoryAdapter()` from `@ebbjs/storage` to get a full
 * in-memory implementation.
 *
 * ## Composition
 * - `actions` — ActionLog for storing and querying actions
 * - `entities` — EntityStore for materialized entity cache
 * - `dirtyTracker` — DirtyTracker for tracking entities needing materialization
 * - `cursors` — CursorStore for per-group GSN tracking
 *
 * ## Cross-cutting Methods
 * - `isDirty(entityId)` — delegates to dirtyTracker
 * - `reset()` — clears all components
 */
export interface StorageAdapter {
  readonly actions: ActionLog;
  readonly entities: EntityStore;
  readonly dirtyTracker: DirtyTracker;
  readonly cursors: CursorStore;

  isDirty(entityId: string): Promise<boolean>;
  reset(): Promise<void>;
}

export type { ActionLog, DirtyTracker, EntityStore, CursorStore };
