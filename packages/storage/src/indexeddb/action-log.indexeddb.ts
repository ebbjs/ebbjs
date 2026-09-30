import type { IDBPDatabase } from "idb";
import type { Action } from "@ebbjs/core";
import type { ActionLog } from "../types/action-log";
import type { EbbDBSchema } from "./schema";

/**
 * IndexedDB-backed ActionLog.
 *
 * Stores every received Action in a single `actions` object store keyed
 * by Action.id. The `getForEntity` query walks the full action list and
 * filters by subject_id, then sorts by gsn. This matches the in-memory
 * implementation's ordering contract.
 *
 * The type index used by the in-memory adapter is not needed here —
 * the IndexedDB action log is queried by entity-id, not by entity-type.
 */
export const createIndexedDBActionLog = (db: IDBPDatabase<EbbDBSchema>): ActionLog => {
  return {
    async append(action: Action): Promise<void> {
      await db.put("actions", action as unknown as EbbDBSchema["actions"]["value"]);
    },

    async getAll(): Promise<readonly Action[]> {
      return (await db.getAll("actions")) as unknown as readonly Action[];
    },

    async getForEntity(entityId: string): Promise<readonly Action[]> {
      const all = (await db.getAll("actions")) as unknown as readonly Action[];
      const filtered = all.filter((action: Action) =>
        action.updates.some((update) => update.subject_id === entityId),
      );
      return filtered.sort((a: Action, b: Action) => a.gsn - b.gsn);
    },

    async clear(): Promise<void> {
      await db.clear("actions");
    },
  };
};
