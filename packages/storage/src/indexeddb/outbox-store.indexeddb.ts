import { compare } from "@ebbjs/core";
import type { IDBPDatabase } from "idb";

import type { OutboxEntry, OutboxStore } from "../types/outbox-store";
import type { EbbDBSchema } from "./schema";

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
      await db.put("outbox", entry);
    },

    async putAndDelete(entry: OutboxEntry, deleteId: string): Promise<void> {
      const tx = db.transaction("outbox", "readwrite");
      tx.store.put(entry);
      tx.store.delete(deleteId);
      await tx.done;
    },

    async list(): Promise<readonly OutboxEntry[]> {
      const rows = await db.getAll("outbox");
      return rows.sort((a, b) => compare(a.enqueuedAtHlc, b.enqueuedAtHlc));
    },

    async get(actionId: string): Promise<OutboxEntry | null> {
      return (await db.get("outbox", actionId)) ?? null;
    },

    async delete(actionId: string): Promise<void> {
      await db.delete("outbox", actionId);
    },

    async clear(): Promise<void> {
      await db.clear("outbox");
    },
  };
};
