import type { ActionLog } from "./action-log";
import type { DirtyTracker } from "./dirty-tracker";
import type { EntityStore } from "./entity-store";
import type { CursorStore } from "./cursor-store";
import type { EntityChangeEmitter } from "./entity-change-emitter";
import type { OutboxStore } from "./outbox-store";

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
 * - `outbox` — OutboxStore for durable pending local Actions
 *
 * ## Cross-cutting Methods
 * - `isDirty(entityId)` — delegates to dirtyTracker
 * - `reset()` — clears the action log, dirty flags, and entity cache;
 *   pending outbox entries are durable user data and survive a reset
 */
export interface StorageAdapter {
  readonly actions: ActionLog;
  readonly entities: EntityStore;
  readonly dirtyTracker: DirtyTracker;
  readonly cursors: CursorStore;
  readonly outbox: OutboxStore;
  /**
   * Observer surface for entity-change notifications. Optional —
   * adapters that don't ship an emitter can omit the field, and
   * callers that need reactivity must fall back to polling.
   */
  readonly changeEmitter?: EntityChangeEmitter;
  /**
   * Replay the action log for `entityId` into the cache and fire
   * the change emitter without clearing the dirty flag. Used by
   * SyncClient to surface inbound actions to emitter subscribers
   * immediately while preserving the `_applyAction` → `isDirty`
   * invariant. Optional — adapters that don't ship an emitter
   * also don't need this.
   */
  materializeKeepDirty?(entityId: string): Promise<void>;

  isDirty(entityId: string): Promise<boolean>;
  reset(): Promise<void>;
}

export type { ActionLog, DirtyTracker, EntityStore, CursorStore, EntityChangeEmitter };
export type { OutboxStore, OutboxEntry, OutboxStatus } from "./outbox-store";
