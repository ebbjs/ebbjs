import type { IDBPDatabase } from "idb";
import type { DirtyTracker } from "../types/dirty-tracker";
import type { EbbDBSchema } from "./schema";

/**
 * IndexedDB-backed DirtyTracker.
 *
 * Each dirty entity is one row in the `dirty` object store keyed by
 * entityId. The store carries an index on `entityType` so
 * `getDirtyForType` can answer without a full scan.
 */
export const createIndexedDBDirtyTracker = (db: IDBPDatabase<EbbDBSchema>): DirtyTracker => {
  return {
    async mark(entityId: string, entityType: string): Promise<void> {
      const existing = await db.get("dirty", entityId);
      if (existing) return;
      await db.put("dirty", { entityId, entityType } as EbbDBSchema["dirty"]["value"]);
    },

    async isDirty(entityId: string): Promise<boolean> {
      const row = await db.get("dirty", entityId);
      return row !== undefined;
    },

    async getDirtyForType(entityType: string): Promise<readonly string[]> {
      const rows = await db.getAllFromIndex("dirty", "entityType", entityType);
      return rows.map((row) => row.entityId as string);
    },

    async clear(entityId: string): Promise<void> {
      await db.delete("dirty", entityId);
    },

    async clearAll(): Promise<void> {
      await db.clear("dirty");
    },
  };
};
