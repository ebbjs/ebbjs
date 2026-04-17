import type { DirtyTracker } from "../types/dirty-tracker";

/**
 * MemoryDirtyTracker — in-memory implementation of DirtyTracker.
 *
 * ## State
 * - `entities` — Record<entityId, entityType> — O(1) existence check
 * - `typeIndex` — Record<type, Set<entityId>> — O(1) lookup by type
 *
 * ## Operations (all O(1))
 * - `mark()` — idempotent, skips if already marked
 * - `isDirty()` — O(1) property lookup
 * - `getDirtyForType()` — O(1) Set lookup + spread
 * - `clear()` — O(1) destructure + Set delete
 * - `clearAll()` — O(1) reassign
 */
interface DirtyTrackerState {
  entities: Record<string, string>;
  typeIndex: Record<string, Set<string>>;
}

export const createMemoryDirtyTracker = (): DirtyTracker => {
  let state: DirtyTrackerState = {
    entities: {},
    typeIndex: {},
  };

  return {
    async mark(entityId: string, entityType: string): Promise<void> {
      if (entityId in state.entities) return;
      state = {
        entities: { ...state.entities, [entityId]: entityType },
        typeIndex: {
          ...state.typeIndex,
          [entityType]: new Set(state.typeIndex[entityType] ?? []).add(entityId),
        },
      };
    },

    async isDirty(entityId: string): Promise<boolean> {
      return entityId in state.entities;
    },

    async getDirtyForType(entityType: string): Promise<readonly string[]> {
      const set = state.typeIndex[entityType];
      return set ? [...set] : [];
    },

    async clear(entityId: string): Promise<void> {
      const entityType = state.entities[entityId];
      if (!entityType) return;

      const { [entityId]: _, ...remainingEntities } = state.entities;
      const typeSet = state.typeIndex[entityType];
      const newTypeSet = new Set(typeSet);
      newTypeSet.delete(entityId);

      state = {
        entities: remainingEntities,
        typeIndex: {
          ...state.typeIndex,
          [entityType]: newTypeSet,
        },
      };
    },

    async clearAll(): Promise<void> {
      state = { entities: {}, typeIndex: {} };
    },
  };
};
