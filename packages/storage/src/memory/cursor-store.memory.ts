import type { CursorStore } from "../types/cursor-store";

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
