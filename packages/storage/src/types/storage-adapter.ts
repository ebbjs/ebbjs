import type { ActionLog, LoggedAction } from "./action-log";
import type { DirtyTracker } from "./dirty-tracker";
import type { EntityStore } from "./entity-store";
import type { CursorStore } from "./cursor-store";
import type { OutboxStore } from "./outbox-store";
import type { ReplicaStore } from "./replica-store";

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
 * - `outbox` — OutboxStore for durable pending local Actions; a detected
 *   conflict is a status + payload on its outbox row, not a sibling store
 * - `replica` — ReplicaStore for the persisted materialized replica; single-slot
 *   and a fast path only
 *
 * ## Cross-cutting Methods
 * - `isDirty(entityId)` — delegates to dirtyTracker
 * - `reset()` — clears the action log, dirty flags, entity cache, and the
 *   persisted replica; outbox entries are durable user data and survive a reset
 */
export interface StorageAdapter {
  readonly actions: ActionLog;
  readonly entities: EntityStore;
  readonly dirtyTracker: DirtyTracker;
  readonly cursors: CursorStore;
  readonly outbox: OutboxStore;
  /**
   * Single-slot persistence for the replica. An absent or corrupt record
   * reads as `null`, so correctness never depends on it existing.
   */
  readonly replica: ReplicaStore;
  isDirty(entityId: string): Promise<boolean>;
  reset(): Promise<void>;
}

export type { ActionLog, LoggedAction, DirtyTracker, EntityStore, CursorStore };
export type { ReplicaRecord, ReplicaStore } from "./replica-store";
export type {
  OutboxStore,
  OutboxEntry,
  OutboxStatus,
  OutboxConflict,
  ConflictSide,
  ConflictSlot,
} from "./outbox-store";
