import { compactCursorRecord, isEmptyCursorRecord } from "../internal/cursor-record";
import type { CursorRecord, CursorStore } from "../types/cursor-store";

/**
 * MemoryCursorStore — in-memory implementation of CursorStore.
 *
 * ## State
 * - `records` — Record<groupId, CursorRecord> — O(1) get/set
 *
 * ## Notes
 * A record holds the group's cursor and, mid-seed, its pinned listing
 * marker. Cursor represents the highest GSN the group's view is complete
 * as of, used for sync resumption.
 *
 * A record lives as long as it holds anything; a `setRecord` that leaves
 * neither a cursor, a seed marker, nor a folded position drops it, so
 * `records()` only reports groups with something to resume from.
 */
interface CursorStoreState {
  records: Record<string, CursorRecord>;
}

export const createMemoryCursorStore = (): CursorStore => {
  let state: CursorStoreState = { records: {} };

  const read = (groupId: string): CursorRecord | null => state.records[groupId] ?? null;

  return {
    async get(groupId: string): Promise<number | null> {
      return read(groupId)?.cursor ?? null;
    },

    async set(groupId: string, cursor: number): Promise<void> {
      state = {
        records: { ...state.records, [groupId]: compactCursorRecord({ ...read(groupId), cursor }) },
      };
    },

    async getRecord(groupId: string): Promise<CursorRecord | null> {
      return read(groupId);
    },

    async setRecord(groupId: string, record: CursorRecord): Promise<void> {
      if (isEmptyCursorRecord(record)) {
        const { [groupId]: _dropped, ...rest } = state.records;
        state = { records: rest };
        return;
      }
      state = { records: { ...state.records, [groupId]: compactCursorRecord(record) } };
    },

    async records(): Promise<ReadonlyMap<string, CursorRecord>> {
      return new Map(Object.entries(state.records));
    },

    async clear(): Promise<void> {
      state = { records: {} };
    },
  };
};
