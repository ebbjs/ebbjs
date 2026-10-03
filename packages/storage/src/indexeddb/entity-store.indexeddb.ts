import type { IDBPDatabase } from "idb";
import type { Entity } from "@ebbjs/core";
import type { EntityStore, RelationshipIndexQuery } from "../types/entity-store";
import type { EntityChangeEmitter } from "../types/entity-change-emitter";
import type { ActionLog } from "../types/action-log";
import type { DirtyTracker } from "../types/dirty-tracker";
import { applyUpdate } from "../internal/materialize";
import { createEntityChangeEmitter } from "../internal/entity-change-emitter";
import {
  applyRelationshipEntry,
  liveSourceIds,
  relationshipIndexDelta,
  relationshipIndexKey,
  RELATIONSHIP_ENTITY_TYPE,
  type RelationshipEntry,
} from "../internal/relationship-index";
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
 * The `relationships` object store mirrors the in-memory adapter's
 * reverse relationship index: one record per `(field, type, target_id)`
 * composite key mapping each live relationship row id to its source id.
 * It is rewritten alongside the entity store on every materialization.
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
export interface IndexedDBEntityStoreBundle {
  store: EntityStore;
  emitter: EntityChangeEmitter;
  /**
   * Replay actions for `entityId` into the cache and fire the
   * emitter without clearing the dirty flag. Mirrors the
   * memory adapter's hook so callers see identical subscribe
   * semantics across backends.
   */
  materializeKeepDirty(entityId: string): Promise<void>;
}

export const createIndexedDBEntityStore = (
  db: IDBPDatabase<EbbDBSchema>,
  actionLog: ActionLog,
  dirtyTracker: DirtyTracker,
): IndexedDBEntityStoreBundle => {
  const copyEntity = (entity: Entity): Entity => structuredClone(entity);
  const { emitter, emit } = createEntityChangeEmitter();

  /**
   * Read-modify-write one index entry into the `relationships` store.
   * A row is keyed by its id, so a tombstone or re-key drops only that
   * row and leaves sibling rows on the same natural key intact.
   */
  const writeRelationshipEntry = async (
    entry: RelationshipEntry,
    present: boolean,
  ): Promise<void> => {
    const record = await db.get("relationships", entry.key);
    const rows = applyRelationshipEntry(record?.rows, entry, present);

    if (rows === null) await db.delete("relationships", entry.key);
    else await db.put("relationships", { key: entry.key, rows });
  };

  const updateRelationshipIndex = async (
    previous: Entity | undefined,
    next: Entity | undefined,
  ): Promise<void> => {
    const delta = relationshipIndexDelta(previous, next);
    if (delta.remove !== null) await writeRelationshipEntry(delta.remove, false);
    if (delta.add !== null) await writeRelationshipEntry(delta.add, true);
  };

  /**
   * Replay actions for `entityId` into the cache. `clearDirty`
   * toggles whether the dirty flag is reset — false keeps the
   * flag set so the eager fan-out can observe the emit without
   * disturbing a subsequent `isDirty` check.
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

    const previous = (await db.get("entities", entityId)) as unknown as Entity | undefined;
    await db.put("entities", copyEntity(entity) as EbbDBSchema["entities"]["value"]);
    await updateRelationshipIndex(previous, entity);

    if (clearDirty) {
      await dirtyTracker.clear(entityId);
    }

    emit(entityId, entity);
  };

  const store: EntityStore = {
    async get(id: string): Promise<Entity | null> {
      await replay(id, true);
      const entity = (await db.get("entities", id)) as unknown as Entity | undefined;
      return entity ? copyEntity(entity) : null;
    },

    async set(entity: Entity): Promise<void> {
      const previous = (await db.get("entities", entity.id)) as unknown as Entity | undefined;
      await db.put("entities", copyEntity(entity) as EbbDBSchema["entities"]["value"]);
      await updateRelationshipIndex(previous, entity);
      emit(entity.id, entity);
    },

    async query(type: string): Promise<readonly Entity[]> {
      const dirtyIds = await dirtyTracker.getDirtyForType(type);

      for (const id of dirtyIds) {
        await replay(id, true);
      }

      const entities = (await db.getAllFromIndex("entities", "type", type)) as unknown as Entity[];
      return entities.map(copyEntity);
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

      const record = await db.get("relationships", relationshipIndexKey(as, type, targetId));
      return liveSourceIds(record?.rows);
    },

    async reset(): Promise<void> {
      await db.clear("relationships");
      await db.clear("entities");
      emitter.reset();
    },
  };

  return { store, emitter, materializeKeepDirty: (id) => replay(id, false) };
};
