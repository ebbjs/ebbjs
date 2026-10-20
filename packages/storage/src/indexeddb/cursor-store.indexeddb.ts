import type { IDBPDatabase } from "idb";
import { compactCursorRecord, isEmptyCursorRecord } from "../internal/cursor-record";
import type { CursorRecord, CursorStore } from "../types/cursor-store";
import type { EbbDBSchema } from "./schema";

/**
 * IndexedDB-backed CursorStore.
 *
 * Each group is one row in the `cursors` store: its cursor, its in-flight
 * seed marker, and how far a completed seed folded. Storing `0` is
 * intentionally allowed: get returns 0, not null, for any group whose cursor
 * has been set, even if the value is 0.
 *
 * The row shape only gained optional fields, so a row written by an earlier
 * version reads back as a cursor with no seed in flight and the schema
 * version did not need to move.
 */
const toRecord = (row: EbbDBSchema["cursors"]["value"] | undefined): CursorRecord | null =>
  row === undefined ? null : compactCursorRecord(row);

export const createIndexedDBCursorStore = (db: IDBPDatabase<EbbDBSchema>): CursorStore => {
  const read = async (groupId: string): Promise<CursorRecord | null> =>
    toRecord(await db.get("cursors", groupId));

  return {
    async get(groupId: string): Promise<number | null> {
      const row = await db.get("cursors", groupId);
      return row?.cursor ?? null;
    },

    async set(groupId: string, cursor: number): Promise<void> {
      const existing = await read(groupId);
      await db.put("cursors", { groupId, ...existing, cursor } as EbbDBSchema["cursors"]["value"]);
    },

    async getRecord(groupId: string): Promise<CursorRecord | null> {
      return read(groupId);
    },

    async setRecord(groupId: string, record: CursorRecord): Promise<void> {
      if (isEmptyCursorRecord(record)) {
        await db.delete("cursors", groupId);
        return;
      }
      await db.put("cursors", {
        groupId,
        ...compactCursorRecord(record),
      } as EbbDBSchema["cursors"]["value"]);
    },

    async records(): Promise<ReadonlyMap<string, CursorRecord>> {
      const rows = await db.getAll("cursors");
      const records = new Map<string, CursorRecord>();
      for (const row of rows) {
        records.set(row.groupId, toRecord(row) ?? {});
      }
      return records;
    },

    async clear(): Promise<void> {
      await db.clear("cursors");
    },
  };
};
