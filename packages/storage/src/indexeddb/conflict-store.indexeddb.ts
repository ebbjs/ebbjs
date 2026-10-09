import { compare } from "@ebbjs/core";
import type { IDBPDatabase } from "idb";

import type { ConflictEntry, ConflictStore } from "../types/conflict-store";
import type { EbbDBSchema } from "./schema";

const toEntry = (row: EbbDBSchema["conflicts"]["value"]): ConflictEntry => ({
  action: row.action,
  losses: row.losses,
  detectedAtHlc: row.detectedAtHlc,
});

/**
 * IndexedDB-backed ConflictStore.
 *
 * Each conflict is one row in the `conflicts` store, keyed by
 * `action.id`. `list()` sorts in memory by `detectedAtHlc` for the same
 * reason the action log sorts `getForEntity` in memory: packed BigInt
 * HLC strings do not sort numerically under IndexedDB's default string
 * comparator, so an index would not order them correctly.
 */
export const createIndexedDBConflictStore = (db: IDBPDatabase<EbbDBSchema>): ConflictStore => {
  return {
    async put(entry: ConflictEntry): Promise<void> {
      await db.put("conflicts", {
        action: entry.action,
        losses: entry.losses,
        detectedAtHlc: entry.detectedAtHlc,
      });
    },

    async list(): Promise<readonly ConflictEntry[]> {
      const rows = await db.getAll("conflicts");
      return rows.map(toEntry).sort((a, b) => compare(a.detectedAtHlc, b.detectedAtHlc));
    },

    async get(actionId: string): Promise<ConflictEntry | null> {
      const row = await db.get("conflicts", actionId);
      return row === undefined ? null : toEntry(row);
    },

    async delete(actionId: string): Promise<void> {
      await db.delete("conflicts", actionId);
    },

    async clear(): Promise<void> {
      await db.clear("conflicts");
    },
  };
};
