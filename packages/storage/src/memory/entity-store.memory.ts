import type { Entity } from "@ebbjs/core";
import type { EntityStore } from "../types/entity-store";
import type { ActionLog } from "../types/action-log";
import type { DirtyTracker } from "../types/dirty-tracker";
import type { EntityChangeEmitter } from "../types/entity-change-emitter";
import { applyUpdate } from "../internal/materialize";

/**
 * MemoryEntityStore — in-memory implementation of EntityStore.
 *
 * ## State
 * - `entities` — Record<entityId, Entity> — O(1) entity lookup
 * - `typeIndex` — Record<type, Set<entityId>> — O(1) query by type
 *
 * ## Materialization Flow
 * 1. Caller invokes `append()` on ActionLog
 * 2. Caller invokes `mark()` on DirtyTracker for affected entities
 * 3. Caller invokes `get()` or `query()` on EntityStore
 * 4. If entity is dirty, materialize() replays all actions for that entity
 * 5. Dirty flag is cleared
 *
 * ## Merge Semantics
 * Merge logic lives in `../internal/materialize` and is shared with the
 * IndexedDB adapter. See that module for LWW rules.
 *
 * ## Immutability
 * All public methods return copies of entities to prevent external mutation.
 */
interface EntityStoreState {
  entities: Record<string, Entity>;
  typeIndex: Record<string, Set<string>>;
}

/**
 * In-memory observer fan-out. The factory returns both the public
 * `EntityChangeEmitter` (subscribe-side) and an internal `fire`
 * pair the entity store calls on materialize/set. Listeners are
 * keyed by entityId and by type; emit-on-materialize dispatches
 * to both groups. Throwing listeners are caught and logged so one
 * bad subscriber can't break the others (matches the SDK's wider
 * error-isolation pattern).
 */
const createMemoryChangeEmitter = (): {
  emitter: EntityChangeEmitter;
  emit: (id: string, entity: Entity) => void;
} => {
  const byId = new Map<string, Set<(entity: Entity | null) => void>>();
  const byType = new Map<string, Set<(entity: Entity) => void>>();
  const fireId = (id: string, entity: Entity | null): void => {
    const listeners = byId.get(id);
    if (listeners === undefined) return;
    for (const cb of listeners) {
      try {
        cb(entity);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[EntityChangeEmitter] onEntityChange handler threw:", err);
      }
    }
  };
  const fireType = (entity: Entity): void => {
    const listeners = byType.get(entity.type);
    if (listeners === undefined) return;
    for (const cb of listeners) {
      try {
        cb(entity);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[EntityChangeEmitter] onTypeChange handler threw:", err);
      }
    }
  };
  const emit = (id: string, entity: Entity): void => {
    fireId(id, entity);
    fireType(entity);
  };
  const emitter: EntityChangeEmitter = {
    onEntityChange(id, listener) {
      let bucket = byId.get(id);
      if (bucket === undefined) {
        bucket = new Set();
        byId.set(id, bucket);
      }
      bucket.add(listener);
      return () => {
        bucket?.delete(listener);
      };
    },
    onTypeChange(type, listener) {
      let bucket = byType.get(type);
      if (bucket === undefined) {
        bucket = new Set();
        byType.set(type, bucket);
      }
      bucket.add(listener);
      return () => {
        bucket?.delete(listener);
      };
    },
    reset() {
      byId.clear();
      byType.clear();
    },
  };
  return { emitter, emit };
};

const copyEntity = (entity: Entity): Entity => JSON.parse(JSON.stringify(entity));

/**
 * Updates typeIndex when an entity is set or materialized.
 * Removes entity from old type's Set if type changed.
 */
const updateTypeIndexOnSet = (
  typeIndex: Record<string, Set<string>>,
  entity: Entity,
  oldType?: string,
): Record<string, Set<string>> => {
  const newTypeIndex = { ...typeIndex };

  if (oldType && oldType !== entity.type) {
    const oldSet = new Set(newTypeIndex[oldType] ?? []);
    oldSet.delete(entity.id);
    newTypeIndex[oldType] = oldSet;
  }

  if (!newTypeIndex[entity.type]) {
    newTypeIndex[entity.type] = new Set();
  }
  newTypeIndex[entity.type] = new Set(newTypeIndex[entity.type]).add(entity.id);

  return newTypeIndex;
};

export const createMemoryEntityStore = (
  actionLog: ActionLog,
  dirtyTracker: DirtyTracker,
): { store: EntityStore; emitter: EntityChangeEmitter } => {
  let state: EntityStoreState = { entities: {}, typeIndex: {} };
  const { emitter, emit } = createMemoryChangeEmitter();

  const materialize = async (entityId: string): Promise<void> => {
    const isEntityDirty = await dirtyTracker.isDirty(entityId);
    if (!isEntityDirty) return;

    const actions = await actionLog.getForEntity(entityId);
    if (actions.length === 0) return;

    let entity: Entity | null = null;

    for (const action of actions) {
      for (const update of action.updates) {
        if (update.subject_id !== entityId) continue;
        entity = applyUpdate(entity, update, action.gsn, action.hlc);
      }
    }

    if (entity === null) return;

    const oldEntity = state.entities[entityId];
    state = {
      entities: { ...state.entities, [entityId]: copyEntity(entity) },
      typeIndex: updateTypeIndexOnSet(state.typeIndex, entity, oldEntity?.type),
    };

    await dirtyTracker.clear(entityId);

    // Fire after the materialization lands so subscribers reading
    // through the adapter see the new state. Delete Updates land
    // here with `deleted_hlc` set; the listener gets the deleted
    // envelope (the spec leaves delete semantics to the consumer —
    // a future filter could surface a `deleted: true` flag).
    emit(entityId, state.entities[entityId]);
  };

  const store: EntityStore = {
    async get(id: string): Promise<Entity | null> {
      await materialize(id);
      const entity = state.entities[id];
      return entity ? copyEntity(entity) : null;
    },

    async set(entity: Entity): Promise<void> {
      const oldEntity = state.entities[entity.id];
      state = {
        entities: { ...state.entities, [entity.id]: copyEntity(entity) },
        typeIndex: updateTypeIndexOnSet(state.typeIndex, entity, oldEntity?.type),
      };
      emit(entity.id, state.entities[entity.id]);
    },

    async query(type: string): Promise<readonly Entity[]> {
      const dirtyIds = await dirtyTracker.getDirtyForType(type);

      for (const id of dirtyIds) {
        await materialize(id);
      }

      const entityIds = state.typeIndex[type] ?? new Set();
      return [...entityIds].map((id) => copyEntity(state.entities[id])).filter(Boolean);
    },

    async reset(): Promise<void> {
      state = { entities: {}, typeIndex: {} };
      emitter.reset();
    },
  };

  return { store, emitter };
};
