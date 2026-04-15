import type { ActionLog } from "./action-log";
import type { DirtyTracker } from "./dirty-tracker";
import type { EntityStore } from "./entity-store";
import type { CursorStore } from "./cursor-store";

export interface StorageAdapter {
  readonly actions: ActionLog;
  readonly entities: EntityStore;
  readonly dirtyTracker: DirtyTracker;
  readonly cursors: CursorStore;

  isDirty(entityId: string): Promise<boolean>;
  reset(): Promise<void>;
}

export type { ActionLog, DirtyTracker, EntityStore, CursorStore };
