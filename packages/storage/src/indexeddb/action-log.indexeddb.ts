import type { IDBPDatabase, IDBPTransaction, StoreNames } from "idb";
import type { Action } from "@ebbjs/core";
import { addedUpdates, mergeActionUpdates } from "../internal/action-merge";
import type { ActionLog, LoggedAction } from "../types/action-log";
import { ACTION_POSITION_SEQUENCE_ID, type EbbDBSchema } from "./schema";

/**
 * IndexedDB-backed ActionLog.
 *
 * Stores every received Action in a single `actions` object store keyed
 * by Action.id. Each stored record is augmented with a denormalized
 * `subject_ids` array (the unique `subject_id`s of every Update in
 * `updates`) and the log-local append `position`. The
 * `actions.subject_id` multiEntry index (declared in `schema.ts`) is the
 * entry point for `getForEntity`: it keys each element of `subject_ids`,
 * so the per-entity materialization can range-scan instead of
 * full-table-scanning. The `actions.position` index backs `readTail`,
 * which is the replica's replay path. The result is sorted in-memory by
 * gsn to match the in-memory adapter's contract.
 *
 * The `sequence` store holds the append cursor so a new id claims the next
 * position without a scan. The position is assigned once, on first insert;
 * re-delivering a known id (#473) keeps the original position and merges
 * the Updates.
 */
const collectSubjectIds = (action: Action): readonly string[] => {
  const ids = new Set<string>();
  for (const update of action.updates) {
    ids.add(update.subject_id);
  }
  return Array.from(ids);
};

/**
 * Strip the denormalized `subject_ids` and `position` fields off a
 * stored Action so the public `ActionLog` API returns the public
 * `Action` shape.
 */
const toPublicAction = (stored: EbbDBSchema["actions"]["value"]): Action => {
  const { subject_ids: _subjectIds, position: _position, ...rest } = stored;

  return rest;
};

type LogTransaction = IDBPTransaction<EbbDBSchema, StoreNames<EbbDBSchema>[], "readwrite">;

/**
 * Append one Action inside `tx`. The transaction stays alive across the
 * awaits because every read it waits on is issued through it, which is what
 * lets `appendMany` commit a whole page as one unit.
 */
const appendInto = async (tx: LogTransaction, action: Action): Promise<LoggedAction> => {
  const actions = tx.objectStore("actions");
  const existing = await actions.get(action.id);
  const sequence = await tx.objectStore("sequence").get(ACTION_POSITION_SEQUENCE_ID);

  const created = existing === undefined;
  const position = created ? (sequence?.value ?? 0) + 1 : existing.position;
  const merged =
    existing === undefined
      ? action
      : { ...action, updates: mergeActionUpdates(existing.updates, action.updates) };
  const added = addedUpdates(existing?.updates ?? [], action.updates);

  await actions.put({ ...merged, position, subject_ids: collectSubjectIds(merged) });
  if (created) {
    await tx.objectStore("sequence").put({ id: ACTION_POSITION_SEQUENCE_ID, value: position });
  }

  return { action: merged, position, added };
};

export const createIndexedDBActionLog = (db: IDBPDatabase<EbbDBSchema>): ActionLog => {
  return {
    async append(action: Action): Promise<LoggedAction> {
      const tx = db.transaction(["actions", "sequence"], "readwrite");
      const entry = await appendInto(tx, action);
      await tx.done;

      return entry;
    },

    async appendMany(actions: readonly Action[]): Promise<readonly LoggedAction[]> {
      const tx = db.transaction(["actions", "sequence"], "readwrite");
      const entries: LoggedAction[] = [];
      for (const action of actions) {
        entries.push(await appendInto(tx, action));
      }
      await tx.done;

      return entries;
    },

    async readTail(afterPosition: number): Promise<readonly LoggedAction[]> {
      const tx = db.transaction("actions", "readonly");
      const stored = await tx.store
        .index("position")
        .getAll(IDBKeyRange.lowerBound(afterPosition, true));
      await tx.done;

      return stored.map((row) => ({
        action: toPublicAction(row),
        position: row.position,
        added: row.updates,
      }));
    },

    async lastPosition(): Promise<number> {
      const sequence = await db.get("sequence", ACTION_POSITION_SEQUENCE_ID);
      return sequence?.value ?? 0;
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
      const tx = db.transaction(["actions", "sequence"], "readwrite");
      await tx.objectStore("actions").clear();
      await tx.objectStore("sequence").put({ id: ACTION_POSITION_SEQUENCE_ID, value: 0 });
      await tx.done;
    },
  };
};
