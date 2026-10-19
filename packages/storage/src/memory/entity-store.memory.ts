import type { Entity } from "@ebbjs/core";
import type {
  EntityStore,
  MembershipLink,
  RelationshipIndexQuery,
  RelationshipLink,
  RelationshipSourceQuery,
} from "../types/entity-store";
import type { ActionLog } from "../types/action-log";
import type { DirtyTracker } from "../types/dirty-tracker";
import { applyUpdate } from "../internal/materialize";
import {
  applyIndexDelta,
  forwardIndexDelta,
  forwardIndexKey,
  forwardMembershipIndexKey,
  liveMembershipLinks,
  liveRelationshipLinks,
  liveSourceIds,
  membershipIndexKey,
  MEMBERSHIP_ENTITY_TYPE,
  reverseIndexDelta,
  reverseIndexKey,
  RELATIONSHIP_ENTITY_TYPE,
  type ReverseIndex,
} from "../internal/reverse-index";

/**
 * MemoryEntityStore — in-memory implementation of EntityStore.
 *
 * ## State
 * - `entities` — Record<entityId, Entity> — O(1) entity lookup
 * - `typeIndex` — Record<type, Set<entityId>> — O(1) query by type
 * - `index` — Record<indexKey, rowId → yieldedId> — O(1) adjacency lookup
 *   for relationship edges (both the `(field, type, target_id)` reverse
 *   key and the `(field, type, source_id)` forward key) and group
 *   membership (the synthetic `groups` accessor, keyed by group or by
 *   member entity).
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
  index: ReverseIndex;
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
 * Rebuild the adjacency index around a single entity write. The deltas
 * come from the previous and next versions of the row, so a patch that
 * re-points or re-keys a row, or a tombstone that hides one, leaves no
 * stale row behind. Both directions (reverse and forward) are covered,
 * as are relationship edges and membership rows.
 */
const updateIndex = (
  index: ReverseIndex,
  previous: Entity | undefined,
  next: Entity | undefined,
): ReverseIndex =>
  applyIndexDelta(
    applyIndexDelta(index, reverseIndexDelta(previous, next)),
    forwardIndexDelta(previous, next),
  );

export const createMemoryEntityStore = (
  actionLog: ActionLog,
  dirtyTracker: DirtyTracker,
): EntityStore => {
  let state: EntityStoreState = { entities: {}, typeIndex: {}, index: {} };

  /**
   * Replay the action log for `entityId` into the cache when the dirty
   * tracker says it needs materializing, then clear the flag so a later read
   * sees the cached row.
   */
  const replay = async (entityId: string): Promise<void> => {
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
      index: updateIndex(state.index, oldEntity, entity),
    };

    await dirtyTracker.clear(entityId);
  };

  /** Materialize every dirty row of a type before an index read. */
  const materializeDirtyType = async (entityType: string): Promise<void> => {
    for (const id of await dirtyTracker.getDirtyForType(entityType)) {
      await replay(id);
    }
  };

  const readIndex = (key: string): readonly string[] => liveSourceIds(state.index[key]);

  const store: EntityStore = {
    async get(id: string): Promise<Entity | null> {
      await replay(id);
      const entity = state.entities[id];
      return entity ? copyEntity(entity) : null;
    },

    async set(entity: Entity): Promise<void> {
      const oldEntity = state.entities[entity.id];
      state = {
        entities: { ...state.entities, [entity.id]: copyEntity(entity) },
        typeIndex: updateTypeIndexOnSet(state.typeIndex, entity, oldEntity?.type),
        index: updateIndex(state.index, oldEntity, entity),
      };
    },

    async query(type: string): Promise<readonly Entity[]> {
      await materializeDirtyType(type);

      const entityIds = state.typeIndex[type] ?? new Set();

      return [...entityIds].map((id) => copyEntity(state.entities[id]));
    },

    async queryByRelationship({
      as,
      type,
      targetId,
    }: RelationshipIndexQuery): Promise<readonly string[]> {
      await materializeDirtyType(RELATIONSHIP_ENTITY_TYPE);
      return readIndex(reverseIndexKey(as, type, targetId));
    },

    async queryByRelationshipSource({
      as,
      type,
      sourceId,
    }: RelationshipSourceQuery): Promise<readonly RelationshipLink[]> {
      await materializeDirtyType(RELATIONSHIP_ENTITY_TYPE);
      return liveRelationshipLinks(state.index[forwardIndexKey(as, type, sourceId)]);
    },

    async queryByMembership(groupId: string): Promise<readonly string[]> {
      await materializeDirtyType(MEMBERSHIP_ENTITY_TYPE);
      return readIndex(membershipIndexKey(groupId));
    },

    async queryByMembershipEntity(entityId: string): Promise<readonly MembershipLink[]> {
      await materializeDirtyType(MEMBERSHIP_ENTITY_TYPE);
      return liveMembershipLinks(state.index[forwardMembershipIndexKey(entityId)]);
    },

    async reset(): Promise<void> {
      state = { entities: {}, typeIndex: {}, index: {} };
    },
  };

  return store;
};
