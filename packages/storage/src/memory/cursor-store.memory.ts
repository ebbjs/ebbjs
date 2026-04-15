import type { CursorStore } from "../types/cursor-store";

interface CursorStoreState {
  cursors: readonly (readonly [groupId: string, cursor: number])[];
}

export const createMemoryCursorStore = (): CursorStore => {
  let state: CursorStoreState = { cursors: [] };

  return {
    async get(groupId: string): Promise<number | null> {
      const entry = state.cursors.find(([gId]) => gId === groupId);
      return entry ? entry[1] : null;
    },

    async set(groupId: string, cursor: number): Promise<void> {
      const exists = state.cursors.some(([gId]) => gId === groupId);
      if (exists) {
        state = {
          cursors: state.cursors.map(([gId, c]) =>
            gId === groupId ? [groupId, cursor] : [gId, c],
          ),
        };
      } else {
        state = {
          cursors: [...state.cursors, [groupId, cursor]],
        };
      }
    },
  };
};
