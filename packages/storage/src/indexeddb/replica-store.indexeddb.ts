import type { IDBPDatabase } from "idb";
import { isValidReplicaRecord } from "../internal/replica-record";
import type { ReplicaRecord, ReplicaStore } from "../types/replica-store";
import { REPLICA_CURSOR_ID, type EbbDBSchema } from "./schema";

/**
 * IndexedDB-backed ReplicaStore.
 *
 * The rows live in the `replica` store keyed by `[type, id]`, so the stored
 * value keeps the entity's natural shape. The `position` / `revision`
 * watermark lives in the single `replicaCursor` row. On load the cursor is
 * read first: an absent or structurally invalid cursor — or a malformed row
 * in the row store — reads as `null`, so the caller falls back to full log
 * replay rather than hydrating a partial base.
 */
export const createIndexedDBReplicaStore = (db: IDBPDatabase<EbbDBSchema>): ReplicaStore => {
  return {
    async load(): Promise<ReplicaRecord | null> {
      const tx = db.transaction(["replica", "replicaCursor"], "readonly");
      const cursor = await tx.objectStore("replicaCursor").get(REPLICA_CURSOR_ID);
      if (cursor === undefined) {
        await tx.done;
        return null;
      }
      const entities = await tx.objectStore("replica").getAll();
      await tx.done;

      const record = {
        format: cursor.format,
        position: cursor.position,
        revision: cursor.revision,
        entities,
      };
      return isValidReplicaRecord(record) ? record : null;
    },

    async save(record: ReplicaRecord): Promise<void> {
      const tx = db.transaction(["replica", "replicaCursor"], "readwrite");
      const rows = tx.objectStore("replica");
      await rows.clear();
      for (const entity of record.entities) {
        await rows.put(entity);
      }
      await tx.objectStore("replicaCursor").put({
        id: REPLICA_CURSOR_ID,
        format: record.format,
        position: record.position,
        revision: record.revision,
      });
      await tx.done;
    },

    async clear(): Promise<void> {
      const tx = db.transaction(["replica", "replicaCursor"], "readwrite");
      await tx.objectStore("replica").clear();
      await tx.objectStore("replicaCursor").clear();
      await tx.done;
    },
  };
};
