import type { IDBPDatabase } from "idb";
import type { Entity } from "@ebbjs/core";
import type { EntityStore } from "../types/entity-store";
import type { ActionLog } from "../types/action-log";
import type { DirtyTracker } from "../types/dirty-tracker";
import { applyUpdate } from "../internal/materialize";
import type { EbbDBSchema } from "./schema";

/**
 * IndexedDBEntityStore — IndexedDB implementation of EntityStore.
 *
 * Stores materialized entities in the `entities` object store, keyed by
 * entityId, with an index on `type` for O(log n) type queries. The
 * `entities` store is the materialized cache; the `actions` store holds
 * the source-of-truth log. Materialization is driven by the same
 * DirtyTracker that drives the in-memory adapter.
 *
 * ## Materialization Flow
 * 1. Caller invokes `append()` on ActionLog
 * 2. Caller invokes `mark()` on DirtyTracker for affected entities
 * 3. Caller invokes `get()` or `query()` on EntityStore
 * 4. If entity is dirty, materialize() replays all actions for that entity
 * 5. Dirty flag is cleared
 *
 * Merge logic is identical to the in-memory adapter (see
 * `../internal/materialize`). All public methods return copies via
 * `structuredClone` to prevent external mutation.
 */
export const createIndexedDBEntityStore = (
  db: IDBPDatabase<EbbDBSchema>,
  actionLog: ActionLog,
  dirtyTracker: DirtyTracker,
): EntityStore => {
  const copyEntity = (entity: Entity): Entity => structuredClone(entity);

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

    await db.put("entities", copyEntity(entity) as EbbDBSchema["entities"]["value"]);
    await dirtyTracker.clear(entityId);
  };

  return {
    async get(id: string): Promise<Entity | null> {
      await materialize(id);
      const entity = (await db.get("entities", id)) as unknown as Entity | undefined;
      return entity ? copyEntity(entity) : null;
    },

    async set(entity: Entity): Promise<void> {
      await db.put("entities", copyEntity(entity) as EbbDBSchema["entities"]["value"]);
    },

    async query(type: string): Promise<readonly Entity[]> {
      const dirtyIds = await dirtyTracker.getDirtyForType(type);

      for (const id of dirtyIds) {
        await materialize(id);
      }

      const entities = (await db.getAllFromIndex("entities", "type", type)) as unknown as Entity[];
      return entities.map(copyEntity);
    },

    async reset(): Promise<void> {
      await db.clear("entities");
    },
  };
};
