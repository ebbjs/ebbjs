import { isValidReplicaRecord } from "../internal/replica-record";
import type { ReplicaRecord, ReplicaStore } from "../types/replica-store";

/**
 * MemoryReplicaStore — single-slot in-memory ReplicaStore.
 *
 * The saved value is held untyped and validated on read, so a corrupt
 * write reads back as `null` (full replay) rather than hydrating a
 * partial base.
 */
export const createMemoryReplicaStore = (): ReplicaStore => {
  let stored: unknown = null;

  return {
    async load(): Promise<ReplicaRecord | null> {
      return isValidReplicaRecord(stored) ? stored : null;
    },

    async save(record: ReplicaRecord): Promise<void> {
      stored = record;
    },

    async clear(): Promise<void> {
      stored = null;
    },
  };
};
