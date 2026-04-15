import type { DirtyTracker } from "../types/dirty-tracker";

interface DirtyTrackerState {
  entities: readonly (readonly [entityId: string, type: string])[];
  typeIndex: readonly (readonly [type: string, entityIds: readonly string[]])[];
}

const updateTypeIndex = (
  typeIndex: readonly (readonly [string, readonly string[]])[],
  type: string,
  entityId: string,
): readonly (readonly [string, readonly string[]])[] => {
  const entry = typeIndex.find(([t]) => t === type);
  if (entry) {
    if (!entry[1].includes(entityId)) {
      return typeIndex.map(([t, ids]) =>
        t === type ? ([t, [...ids, entityId]] as const) : ([t, ids] as const),
      );
    }
    return typeIndex;
  }
  return [...typeIndex, [type, [entityId]] as const];
};

const removeFromTypeIndex = (
  typeIndex: readonly (readonly [string, readonly string[]])[],
  type: string,
  entityId: string,
): readonly (readonly [string, readonly string[]])[] => {
  return typeIndex
    .map(([t, ids]) =>
      t === type ? ([t, ids.filter((id) => id !== entityId)] as const) : ([t, ids] as const),
    )
    .filter(([, ids]) => ids.length > 0);
};

export const createMemoryDirtyTracker = (): DirtyTracker => {
  let state: DirtyTrackerState = {
    entities: [],
    typeIndex: [],
  };

  return {
    async mark(entityId: string, entityType: string): Promise<void> {
      const exists = state.entities.some(([eId]) => eId === entityId);
      if (!exists) {
        state = {
          entities: [...state.entities, [entityId, entityType]],
          typeIndex: updateTypeIndex(state.typeIndex, entityType, entityId),
        };
      }
    },

    async isDirty(entityId: string): Promise<boolean> {
      return state.entities.some(([eId]) => eId === entityId);
    },

    async getDirtyForType(entityType: string): Promise<readonly string[]> {
      const entry = state.typeIndex.find(([t]) => t === entityType);
      return entry ? entry[1] : [];
    },

    async clear(entityId: string): Promise<void> {
      const entity = state.entities.find(([eId]) => eId === entityId);
      if (!entity) return;

      state = {
        entities: state.entities.filter(([eId]) => eId !== entityId),
        typeIndex: removeFromTypeIndex(state.typeIndex, entity[1], entityId),
      };
    },

    async clearAll(): Promise<void> {
      state = { entities: [], typeIndex: [] };
    },
  };
};
