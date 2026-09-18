import type { Entity, Update, PutData, PatchData, HLCTimestamp } from "@ebbjs/core";
import { compare } from "@ebbjs/core";
import type { EntityStore } from "../types/entity-store";
import type { ActionLog } from "../types/action-log";
import type { DirtyTracker } from "../types/dirty-tracker";

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
 * - **put**: full entity replacement
 * - **patch**: field-level LWW (higher HLC wins; tiebreak by lexicographic update_id >=)
 * - **delete**: soft delete (sets deleted_hlc); patch-on-deleted is ignored
 * - **updated_hlc**: set to later of entity.updated_hlc and action hlc
 *
 * ## Immutability
 * All public methods return copies of entities to prevent external mutation.
 */
interface EntityStoreState {
  entities: Record<string, Entity>;
  typeIndex: Record<string, Set<string>>;
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
 * Applies a single update to an entity during materialization.
 * Handles put, patch, and delete methods.
 */
const applyUpdate = (
  entity: Entity | null,
  update: Update,
  gsn: number,
  hlc: HLCTimestamp,
): Entity => {
  switch (update.method) {
    case "put":
      return {
        id: update.subject_id,
        type: update.subject_type,
        data: { fields: extractFields(update) },
        created_hlc: hlc,
        updated_hlc: hlc,
        deleted_hlc: null,
        last_gsn: gsn,
      };

    case "patch":
      if (!entity) throw new Error("Cannot patch non-existent entity");
      if (entity.deleted_hlc) return entity;
      return {
        ...entity,
        data: mergeFields(entity.data, update),
        updated_hlc: laterHlc(entity.updated_hlc, hlc) ? hlc : entity.updated_hlc,
        last_gsn: Math.max(entity.last_gsn, gsn),
      };

    case "delete":
      if (!entity) throw new Error("Cannot delete non-existent entity");
      return {
        ...entity,
        deleted_hlc: hlc,
        updated_hlc: hlc,
        last_gsn: Math.max(entity.last_gsn, gsn),
      };
  }
};

/**
 * Extracts the field map from an update's `data` payload.
 *
 * Mirrors `EbbServer.Storage.EntityStore.apply_put/4`:
 * - User entities (e.g. "todo") ship their fields nested under a "fields" key
 *   in `data`, e.g. `data = { fields: { title: FieldValue } }`. Use directly.
 * - System entities ("groupMember", "relationship") ship flat top-level keys,
 *   e.g. `data = { actor_id, group_id, permissions }`. Wrap into `fields` so
 *   the materialized shape matches what the server returns from
 *   `GET /entities/:id`.
 *
 * Without this branching, user-entity updates double-wrap into
 * `{ fields: { fields: {...} } }` because `update.data` is already nested.
 */
const extractFields = (update: Update): PutData => {
  if (update.subject_type === "groupMember" || update.subject_type === "relationship") {
    return (update.data ?? {}) as PutData;
  }
  // User-entity updates are wrapped in `{ fields: {...} }` by the client
  // (mirrors `ActionValidator.well_formed_data?/1`). The static type
  // `Update.data` is `PutData | PatchData | null`, neither of which models
  // the wrapping, so we cast through `unknown` at runtime.
  const data = update.data as unknown as { fields?: PutData } | null;
  return data?.fields ?? {};
};

/**
 * Extracts the field map from an update's `data` payload for a patch.
 *
 * For user entities the server nests the patch under `data.fields`, e.g.
 * `data = { fields: { title: FieldValue } }`. System entities patch flat
 * top-level keys. Without unwrapping the user-entity case, mergeFields would
 * write a `fields` key under `data.fields` (i.e. `{ fields: { fields: ... } }`).
 */
const extractPatchFields = (update: Update): PatchData => {
  if (update.subject_type === "groupMember" || update.subject_type === "relationship") {
    return (update.data ?? {}) as PatchData;
  }
  // See extractFields/1 above for the runtime cast rationale.
  const data = update.data as unknown as { fields?: PatchData } | null;
  return data?.fields ?? {};
};

/**
 * Merges patch fields into existing entity data using LWW semantics.
 * Higher HLC wins; equal HLC uses lexicographic update_id (newer >= older).
 */
const mergeFields = (existing: Entity["data"], update: Update): Entity["data"] => {
  const patch = extractPatchFields(update);
  const merged = { ...existing.fields };

  for (const [field, patchValue] of Object.entries(patch)) {
    const existingValue = merged[field];
    if (!existingValue) {
      merged[field] = patchValue;
    } else {
      const hlcCmp = compare(existingValue.hlc ?? "", patchValue.hlc ?? "");
      if (hlcCmp < 0) {
        merged[field] = patchValue;
      } else if (hlcCmp === 0) {
        if (patchValue.update_id >= existingValue.update_id) {
          merged[field] = patchValue;
        }
      }
    }
  }

  return { fields: merged };
};

const laterHlc = (a: HLCTimestamp, b: HLCTimestamp): boolean => {
  return compare(a, b) > 0;
};

export const createMemoryEntityStore = (
  actionLog: ActionLog,
  dirtyTracker: DirtyTracker,
): EntityStore => {
  let state: EntityStoreState = { entities: {}, typeIndex: {} };

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
  };

  return {
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
    },
  };
};
