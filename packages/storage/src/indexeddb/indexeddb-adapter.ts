import { openDB, type IDBPDatabase } from "idb";
import type { Action } from "@ebbjs/core";
import type { StorageAdapter } from "../types/storage-adapter";
import { createEbbStores, EBB_SCHEMA_VERSION, type EbbDBSchema } from "./schema";

import { createIndexedDBActionLog } from "./action-log.indexeddb";
import { createIndexedDBConflictStore } from "./conflict-store.indexeddb";
import { createIndexedDBCursorStore } from "./cursor-store.indexeddb";
import { createIndexedDBDirtyTracker } from "./dirty-tracker.indexeddb";
import { createIndexedDBEntityStore } from "./entity-store.indexeddb";
import { createIndexedDBOutboxStore } from "./outbox-store.indexeddb";

export interface IndexedDBAdapterOptions {
  dbName?: string;
}

/**
 * Creates a `StorageAdapter` backed by IndexedDB.
 *
 * ## Usage
 * ```ts
 * const adapter = await createIndexedDBAdapter({ dbName: "my-app" });
 * await adapter.actions.append(action);
 * ```
 *
 * ## Browser-only
 * This adapter requires `indexedDB` in the global scope. In Node /
 * test environments it must be run inside a DOM environment that
 * provides the API (e.g. `happy-dom`).
 *
 * ## Concurrency
 * Single-tab ownership is assumed for v1. Multi-tab coordination is
 * out of scope per issue #145.
 *
 * ## Schema version
 * Opens at `EBB_SCHEMA_VERSION`; `openTestDb` opens the test schema at
 * the same version so the two cannot drift.
 */
export const createIndexedDBAdapter = async (
  options: IndexedDBAdapterOptions = {},
): Promise<StorageAdapter> => {
  const dbName = options.dbName ?? "ebb-storage";

  const db: IDBPDatabase<EbbDBSchema> = await openDB<EbbDBSchema>(dbName, EBB_SCHEMA_VERSION, {
    upgrade: createEbbStores,
  });

  const actionLog = createIndexedDBActionLog(db);
  const dirtyTracker = createIndexedDBDirtyTracker(db);
  const {
    store: entityStore,
    emitter: changeEmitter,
    materializeKeepDirty,
  } = createIndexedDBEntityStore(db, actionLog, dirtyTracker);
  const cursorStore = createIndexedDBCursorStore(db);
  const outboxStore = createIndexedDBOutboxStore(db);
  const conflictStore = createIndexedDBConflictStore(db);

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

    outbox: outboxStore,

    conflicts: conflictStore,

    changeEmitter,

    async materializeKeepDirty(entityId: string): Promise<void> {
      await materializeKeepDirty(entityId);
    },

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
