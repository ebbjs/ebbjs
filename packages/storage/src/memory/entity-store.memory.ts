import type { Entity } from "@ebbjs/core";
import type { EntityStore, RelationshipIndexQuery } from "../types/entity-store";
import type { ActionLog } from "../types/action-log";
import type { DirtyTracker } from "../types/dirty-tracker";
import type { EntityChangeEmitter } from "../types/entity-change-emitter";
import { applyUpdate } from "../internal/materialize";
import { createEntityChangeEmitter } from "../internal/entity-change-emitter";
import {
  applyRelationshipDelta,
  liveSourceIds,
  relationshipIndexDelta,
  relationshipIndexKey,
  RELATIONSHIP_ENTITY_TYPE,
  type RelationshipIndex,
} from "../internal/relationship-index";

/**
 * MemoryEntityStore — in-memory implementation of EntityStore.
 *
 * ## State
 * - `entities` — Record<entityId, Entity> — O(1) entity lookup
 * - `typeIndex` — Record<type, Set<entityId>> — O(1) query by type
 * - `relationshipIndex` — Record<indexKey, rowId → sourceId> — O(1) reverse
 *   relationship lookup; indexKey is the `(field, type, target_id)` triple
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
  relationshipIndex: RelationshipIndex;
}

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

/**
 * Rebuild the relationship index around a single entity write. The
 * delta comes from the previous and next versions of the row, so a
 * patch that re-points or re-keys a row, or a tombstone that hides
 * one, leaves no stale row behind.
 */
const updateRelationshipIndex = (
  index: RelationshipIndex,
  previous: Entity | undefined,
  next: Entity | undefined,
): RelationshipIndex => applyRelationshipDelta(index, relationshipIndexDelta(previous, next));

export interface MemoryEntityStoreBundle {
  store: EntityStore;
  emitter: EntityChangeEmitter;
  /**
   * Replay actions for `entityId` into the cache and fire the
   * emitter WITHOUT clearing the dirty flag. Used by the
   * SyncClient fan-out to surface inbound actions to subscribers
   * while preserving the existing `_applyAction` → `isDirty`
   * invariant that the SSE tests pin.
   */
  materializeKeepDirty(id: string): Promise<void>;
}

export const createMemoryEntityStore = (
  actionLog: ActionLog,
  dirtyTracker: DirtyTracker,
): MemoryEntityStoreBundle => {
  let state: EntityStoreState = { entities: {}, typeIndex: {}, relationshipIndex: {} };
  const { emitter, emit } = createEntityChangeEmitter();

  /**
   * Replay actions for `entityId` into the cache. The `clearDirty`
   * flag toggles whether the dirty flag is reset — the public
   * materialize-on-read path clears it (a subsequent read sees
   * the cached entity), the eager fan-out path keeps it (the
   * dirty flag remains so callers checking `isDirty` see the
   * same state the SSE tests pin).
   *
   * Fires the change emitter after the cache lands.
   */
  const replay = async (entityId: string, clearDirty: boolean): Promise<void> => {
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
      relationshipIndex: updateRelationshipIndex(state.relationshipIndex, oldEntity, entity),
    };

    if (clearDirty) {
      await dirtyTracker.clear(entityId);
    }

    emit(entityId, state.entities[entityId]);
  };

  const store: EntityStore = {
    async get(id: string): Promise<Entity | null> {
      await replay(id, true);
      const entity = state.entities[id];
      return entity ? copyEntity(entity) : null;
    },

    async set(entity: Entity): Promise<void> {
      const oldEntity = state.entities[entity.id];
      state = {
        entities: { ...state.entities, [entity.id]: copyEntity(entity) },
        typeIndex: updateTypeIndexOnSet(state.typeIndex, entity, oldEntity?.type),
        relationshipIndex: updateRelationshipIndex(state.relationshipIndex, oldEntity, entity),
      };
      emit(entity.id, state.entities[entity.id]);
    },

    async query(type: string): Promise<readonly Entity[]> {
      const dirtyIds = await dirtyTracker.getDirtyForType(type);

      for (const id of dirtyIds) {
        await replay(id, true);
      }

      const entityIds = state.typeIndex[type] ?? new Set();

      return [...entityIds].map((id) => copyEntity(state.entities[id]));
    },

    async queryByRelationship({
      as,
      type,
      targetId,
    }: RelationshipIndexQuery): Promise<readonly string[]> {
      const dirtyIds = await dirtyTracker.getDirtyForType(RELATIONSHIP_ENTITY_TYPE);

      for (const id of dirtyIds) {
        await replay(id, true);
      }

      return liveSourceIds(state.relationshipIndex[relationshipIndexKey(as, type, targetId)]);
    },

    async reset(): Promise<void> {
      state = { entities: {}, typeIndex: {}, relationshipIndex: {} };
      emitter.reset();
    },
  };

  return { store, emitter, materializeKeepDirty: (id) => replay(id, false) };
};
