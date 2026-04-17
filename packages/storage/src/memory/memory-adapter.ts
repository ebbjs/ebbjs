import type { Action } from "@ebbjs/core";
import type { StorageAdapter } from "../types/storage-adapter";

import { createMemoryActionLog } from "./action-log.memory";
import { createMemoryDirtyTracker } from "./dirty-tracker.memory";
import { createMemoryEntityStore } from "./entity-store.memory";
import { createMemoryCursorStore } from "./cursor-store.memory";

/**
 * MemoryAdapter — in-memory implementation of StorageAdapter for v1.
 *
 * ## Composition
 * - ActionLog — stores actions, provides entity-level queries
 * - DirtyTracker — tracks dirty entities, queryable by type
 * - EntityStore — materialized entity cache
 * - CursorStore — per-group GSN cursors
 *
 * ## Usage
 * ```typescript
 * const storage = createMemoryAdapter();
 *
 * // On action receipt:
 * await storage.actions.append(action);
 * for (const update of action.updates) {
 *   await storage.dirtyTracker.mark(update.subject_id, update.subject_type);
 * }
 *
 * // On entity read:
 * const entity = await storage.entities.get(entityId);
 *
 * // On query:
 * const entities = await storage.entities.query("todo");
 * ```
 *
 * ## Sync with Server
 * The adapter maintains local state only. Sync with the server requires:
 * 1. Receiving actions from server (append to ActionLog, mark dirty)
 * 2. Sending local changes to server (future: outbox/writes)
 */
export const createMemoryAdapter = (): StorageAdapter => {
  const actionLog = createMemoryActionLog();
  const dirtyTracker = createMemoryDirtyTracker();
  const entityStore = createMemoryEntityStore(actionLog, dirtyTracker);
  const cursorStore = createMemoryCursorStore();

  return {
    actions: {
      async append(action: Action): Promise<void> {
        await actionLog.append(action);
        for (const update of action.updates) {
          await dirtyTracker.mark(update.subject_id, update.subject_type);
        }
      },

      async getAll(): Promise<readonly Action[]> {
        return actionLog.getAll();
      },

      async getForEntity(entityId: string): Promise<readonly Action[]> {
        return actionLog.getForEntity(entityId);
      },

      async clear(): Promise<void> {
        await actionLog.clear();
        await dirtyTracker.clearAll();
        await entityStore.reset();
      },
    },

    entities: entityStore,

    dirtyTracker: {
      async mark(entityId: string, entityType: string): Promise<void> {
        await dirtyTracker.mark(entityId, entityType);
      },

      async isDirty(entityId: string): Promise<boolean> {
        return dirtyTracker.isDirty(entityId);
      },

      async getDirtyForType(entityType: string): Promise<readonly string[]> {
        return dirtyTracker.getDirtyForType(entityType);
      },

      async clear(entityId: string): Promise<void> {
        await dirtyTracker.clear(entityId);
      },

      async clearAll(): Promise<void> {
        await dirtyTracker.clearAll();
      },
    },

    cursors: cursorStore,

    async isDirty(entityId: string): Promise<boolean> {
      return dirtyTracker.isDirty(entityId);
    },

    async reset(): Promise<void> {
      await actionLog.clear();
      await dirtyTracker.clearAll();
      await entityStore.reset();
    },
  };
};
