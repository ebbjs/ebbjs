import type { IDBPDatabase } from "idb";
import type { Action } from "@ebbjs/core";
import { mergeActionUpdates } from "../internal/action-merge";
import type { ActionLog } from "../types/action-log";
import type { EbbDBSchema } from "./schema";

/**
 * IndexedDB-backed ActionLog.
 *
 * Stores every received Action in a single `actions` object store keyed
 * by Action.id. Each stored record is augmented with a denormalized
 * `subject_ids` array (the unique `subject_id`s of every Update in
 * `updates`). The `actions.subject_id` multiEntry index (declared in
 * `schema.ts`) is the entry point for `getForEntity`: it keys each
 * element of `subject_ids`, so the per-entity materialization can
 * range-scan instead of full-table-scanning. The result is sorted
 * in-memory by gsn to match the in-memory adapter's contract.
 *
 * The type index used by the in-memory adapter is not needed here —
 * the IndexedDB action log is queried by entity-id, not by entity-type.
 *
 * Per-Update delivery (#473) can deliver one Action once per group it
 * touches; `append` merges the copies into the one id-keyed record.
 */
const collectSubjectIds = (action: Action): readonly string[] => {
  const ids = new Set<string>();
  for (const update of action.updates) {
    ids.add(update.subject_id);
  }
  return Array.from(ids);
};

/**
 * Strip the denormalized `subject_ids` field off a stored Action so
 * the public `ActionLog` API can return the public `Action` shape.
 */
const toPublicAction = (stored: EbbDBSchema["actions"]["value"]): Action => {
  const { subject_ids: _subjectIds, ...rest } = stored;

  return rest;
};

export const createIndexedDBActionLog = (db: IDBPDatabase<EbbDBSchema>): ActionLog => {
  return {
    async append(action: Action): Promise<void> {
      const tx = db.transaction("actions", "readwrite");
      const existing = await tx.store.get(action.id);

      const merged =
        existing === undefined
          ? action
          : { ...action, updates: mergeActionUpdates(existing.updates, action.updates) };

      await tx.store.put({ ...merged, subject_ids: collectSubjectIds(merged) });
      await tx.done;
    },

    async getAll(): Promise<readonly Action[]> {
      const stored = await db.getAll("actions");
      return stored.map(toPublicAction);
    },

    async getForEntity(entityId: string): Promise<readonly Action[]> {
      const tx = db.transaction("actions", "readonly");
      const stored = (await tx.store.index("subject_id").getAll(entityId)) as ReadonlyArray<
        EbbDBSchema["actions"]["value"]
      >;
      await tx.done;
      const actions = stored.map(toPublicAction);
      return actions.sort((a, b) => a.gsn - b.gsn);
    },

    async clear(): Promise<void> {
      await db.clear("actions");
    },
  };
};
