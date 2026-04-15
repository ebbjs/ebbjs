import type { Action } from "@ebbjs/core";
import type { ActionLog } from "../types/action-log";

interface ActionLogState {
  actions: readonly Action[];
  typeIndex: readonly (readonly [type: string, entityIds: readonly string[]])[];
}

const updateTypeIndex = (
  typeIndex: readonly (readonly [string, readonly string[]])[],
  action: Action,
): (readonly [string, readonly string[]])[] => {
  const map = new Map<string, Set<string>>();
  for (const [type, entityIds] of typeIndex) {
    map.set(type, new Set(entityIds));
  }
  for (const update of action.updates) {
    const existing = map.get(update.subject_type);
    if (existing) {
      existing.add(update.subject_id);
    } else {
      map.set(update.subject_type, new Set([update.subject_id]));
    }
  }
  return Array.from(map.entries()).map(([type, ids]) => [type, Array.from(ids)] as const);
};

export const createMemoryActionLog = (): ActionLog => {
  let state: ActionLogState = {
    actions: [],
    typeIndex: [],
  };

  return {
    async append(action: Action): Promise<void> {
      state = {
        actions: [...state.actions, action],
        typeIndex: updateTypeIndex(state.typeIndex, action),
      };
    },

    async getAll(): Promise<readonly Action[]> {
      return state.actions;
    },

    async getForEntity(entityId: string): Promise<readonly Action[]> {
      const found = state.actions.filter((action) =>
        action.updates.some((update) => update.subject_id === entityId),
      );
      return found.sort((a, b) => a.gsn - b.gsn);
    },

    async clear(): Promise<void> {
      state = { actions: [], typeIndex: [] };
    },
  };
};

export const getEntityIdsForType = (state: ActionLogState, type: string): readonly string[] => {
  const entry = state.typeIndex.find(([t]) => t === type);
  return entry ? entry[1] : [];
};

export type { ActionLogState };
