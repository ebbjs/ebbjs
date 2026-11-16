import type { DirtyTracker } from "../types/dirty-tracker";

/**
 * MemoryDirtyTracker — in-memory implementation of DirtyTracker.
 *
 * ## State
 * - `entities` — Record<entityId, model> — O(1) existence check
 * - `modelIndex` — Record<model, Set<entityId>> — O(1) lookup by model
 *
 * ## Operations (all O(1))
 * - `mark()` — idempotent, skips if already marked
 * - `isDirty()` — O(1) property lookup
 * - `getDirtyForModel()` — O(1) Set lookup + spread
 * - `clear()` — O(1) destructure + Set delete
 * - `clearAll()` — O(1) reassign
 */
interface DirtyTrackerState {
  entities: Record<string, string>;
  modelIndex: Record<string, Set<string>>;
}

export const createMemoryDirtyTracker = (): DirtyTracker => {
  let state: DirtyTrackerState = {
    entities: {},
    modelIndex: {},
  };

  return {
    async mark(entityId: string, model: string): Promise<void> {
      if (entityId in state.entities) return;
      state = {
        entities: { ...state.entities, [entityId]: model },
        modelIndex: {
          ...state.modelIndex,
          [model]: new Set(state.modelIndex[model] ?? []).add(entityId),
        },
      };
    },

    async isDirty(entityId: string): Promise<boolean> {
      return entityId in state.entities;
    },

    async getDirtyForModel(model: string): Promise<readonly string[]> {
      const set = state.modelIndex[model];
      return set ? [...set] : [];
    },

    async clear(entityId: string): Promise<void> {
      const model = state.entities[entityId];
      if (!model) return;

      const { [entityId]: _, ...remainingEntities } = state.entities;
      const typeSet = state.modelIndex[model];
      const newTypeSet = new Set(typeSet);
      newTypeSet.delete(entityId);

      state = {
        entities: remainingEntities,
        modelIndex: {
          ...state.modelIndex,
          [model]: newTypeSet,
        },
      };
    },

    async clearAll(): Promise<void> {
      state = { entities: {}, modelIndex: {} };
    },
  };
};
