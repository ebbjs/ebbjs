import type { CursorStore } from "../types/cursor-store";

/**
 * MemoryCursorStore — in-memory implementation of CursorStore.
 *
 * ## State
 * - `cursors` — Record<groupId, cursor> — O(1) get/set
 *
 * ## Notes
 * Simple object-based storage. Cursor represents the highest observed GSN
 * for a group, used for sync resumption.
 */
interface CursorStoreState {
  cursors: Record<string, number>;
}

export const createMemoryCursorStore = (): CursorStore => {
  let state: CursorStoreState = { cursors: {} };

  return {
    async get(groupId: string): Promise<number | null> {
      return state.cursors[groupId] ?? null;
    },

    async set(groupId: string, cursor: number): Promise<void> {
      state = {
        cursors: { ...state.cursors, [groupId]: cursor },
      };
    },
  };
};
