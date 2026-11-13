import { compare } from "@ebbjs/core";
import type { IDBPDatabase } from "idb";

import type {
  OutboxConflict,
  OutboxEntry,
  OutboxStore,
  StoredOutboxConflict,
  StoredOutboxEntry,
} from "../types/outbox-store";
import type { EbbDBSchema } from "./schema";

/**
 * Normalize a conflict payload read back from an older row. The payload
 * gained `scope` and `remoteActions` at version 10, and the component hold
 * (`holds`) later; a legacy row is still a field-scope conflict with no
 * recorded remote context that holds each named subject whole.
 */
const toConflict = (conflict: StoredOutboxConflict): OutboxConflict => ({
  ...conflict,
  scope: conflict.scope ?? "field",
  remoteActions: conflict.remoteActions ?? [],
  holds: conflict.holds ?? conflict.subjects.map((subjectId) => ({ kind: "subject", subjectId })),
});

const toEntry = (row: StoredOutboxEntry): OutboxEntry => ({
  action: row.action,
  status: row.status,
  enqueuedAtHlc: row.enqueuedAtHlc,
  // A row predating the field reads as "always concurrent", never
  // silently dropped.
  basedOnGsn: row.basedOnGsn ?? 0,
  conflict: row.conflict === undefined ? undefined : toConflict(row.conflict),
});

/**
 * IndexedDB-backed OutboxStore.
 *
 * Each Action is one row in the `outbox` store, keyed by `action.id`.
 * `list()` sorts in memory by `enqueuedAtHlc` for the same reason the
 * action log sorts `getForEntity` in memory: packed BigInt HLC strings
 * do not sort numerically under IndexedDB's default string comparator,
 * so an index would not order them correctly.
 */
export const createIndexedDBOutboxStore = (db: IDBPDatabase<EbbDBSchema>): OutboxStore => {
  return {
    async put(entry: OutboxEntry): Promise<void> {
      await db.put("outbox", {
        action: entry.action,
        status: entry.status,
        enqueuedAtHlc: entry.enqueuedAtHlc,
        basedOnGsn: entry.basedOnGsn,
        conflict: entry.conflict,
      });
    },

    async putAndDelete(entry: OutboxEntry, deleteId: string): Promise<void> {
      const tx = db.transaction("outbox", "readwrite");
      tx.store.put({
        action: entry.action,
        status: entry.status,
        enqueuedAtHlc: entry.enqueuedAtHlc,
        basedOnGsn: entry.basedOnGsn,
        conflict: entry.conflict,
      });
      tx.store.delete(deleteId);
      await tx.done;
    },

    async list(): Promise<readonly OutboxEntry[]> {
      const rows = await db.getAll("outbox");
      return rows.map(toEntry).sort((a, b) => compare(a.enqueuedAtHlc, b.enqueuedAtHlc));
    },

    async get(actionId: string): Promise<OutboxEntry | null> {
      const row = await db.get("outbox", actionId);
      return row === undefined ? null : toEntry(row);
    },

    async delete(actionId: string): Promise<void> {
      await db.delete("outbox", actionId);
    },

    async clear(): Promise<void> {
      await db.clear("outbox");
    },
  };
};
