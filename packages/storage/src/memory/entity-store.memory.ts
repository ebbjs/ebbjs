import type { Entity, Update, PutData, PatchData, HLCTimestamp } from "@ebbjs/core";
import { compare } from "@ebbjs/core";
import type { EntityStore } from "../types/entity-store";
import type { ActionLog } from "../types/action-log";
import type { DirtyTracker } from "../types/dirty-tracker";

interface EntityStoreState {
  entities: readonly (readonly [entityId: string, entity: Entity])[];
}

const copyEntity = (entity: Entity): Entity => JSON.parse(JSON.stringify(entity));

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
        data: { fields: update.data as PutData },
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
        data: mergeFields(entity.data, update.data as PatchData),
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

const mergeFields = (existing: Entity["data"], patch: PatchData): Entity["data"] => {
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
  let state: EntityStoreState = { entities: [] };

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

    const exists = state.entities.some(([eId]) => eId === entityId);
    if (exists) {
      state = {
        entities: state.entities.map(([eId, e]) =>
          eId === entityId ? [entityId, copyEntity(entity!)] : [eId, e],
        ),
      };
    } else {
      state = {
        entities: [...state.entities, [entityId, copyEntity(entity)]],
      };
    }

    await dirtyTracker.clear(entityId);
  };

  return {
    async get(id: string): Promise<Entity | null> {
      await materialize(id);
      const found = state.entities.find(([eId]) => eId === id);
      return found ? copyEntity(found[1]) : null;
    },

    async set(entity: Entity): Promise<void> {
      const exists = state.entities.some(([eId]) => eId === entity.id);
      if (exists) {
        state = {
          entities: state.entities.map(([eId, e]) =>
            eId === entity.id ? [eId, copyEntity(entity)] : [eId, e],
          ),
        };
      } else {
        state = {
          entities: [...state.entities, [entity.id, copyEntity(entity)]],
        };
      }
    },

    async query(type: string): Promise<readonly Entity[]> {
      const dirtyIds = await dirtyTracker.getDirtyForType(type);

      for (const id of dirtyIds) {
        await materialize(id);
      }

      return state.entities.filter(([, e]) => e.type === type).map(([, e]) => copyEntity(e));
    },

    async reset(): Promise<void> {
      state = { entities: [] };
    },
  };
};
