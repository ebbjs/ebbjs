import type { IDBPDatabase } from "idb";
import type { CursorStore } from "../types/cursor-store";
import type { EbbDBSchema } from "./schema";

/**
 * IndexedDB-backed CursorStore.
 *
 * Each (groupId, cursor) pair is one row in the `cursors` store.
 * Storing `0` is intentionally allowed: get returns 0, not null,
 * for any group whose cursor has been set, even if the value is 0.
 */
export const createIndexedDBCursorStore = (db: IDBPDatabase<EbbDBSchema>): CursorStore => {
  return {
    async get(groupId: string): Promise<number | null> {
      const row = await db.get("cursors", groupId);
      return row ? (row.cursor as number) : null;
    },

    async set(groupId: string, cursor: number): Promise<void> {
      await db.put("cursors", { groupId, cursor } as EbbDBSchema["cursors"]["value"]);
    },
  };
};
