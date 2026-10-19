import type { IDBPDatabase } from "idb";
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
  addIndexRow,
  forwardIndexDelta,
  forwardIndexKey,
  forwardMembershipIndexKey,
  liveMembershipLinks,
  liveRelationshipLinks,
  liveSourceIds,
  membershipIndexKey,
  MEMBERSHIP_ENTITY_TYPE,
  removeIndexRow,
  reverseIndexDelta,
  reverseIndexKey,
  RELATIONSHIP_ENTITY_TYPE,
  type IndexEntry,
  type IndexRows,
} from "../internal/reverse-index";
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
 * The `relationships` object store is the shared adjacency index: one
 * record per composite key mapping each live row id to its yielded id.
 * It serves relationship edges in both directions — keyed by
 * `(field, type, target_id)` for the reverse read and
 * `(field, type, source_id)` for the forward read — and `entityGroup`
 * membership keyed by the synthetic `groups` accessor (by group or by
 * member entity). The store name and schema version are unchanged; the
 * index is derived and, following #248, is not backfilled, so a
 * database predating membership keys must be cleared rather than
 * reused. It is rewritten alongside the entity store on every
 * materialization.
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

  const writeRows = async (key: string, rows: IndexRows | null): Promise<void> => {
    if (rows === null) await db.delete("relationships", key);
    else await db.put("relationships", { key, rows });
  };

  /**
   * Read-modify-write one row into the `relationships` store. A row is
   * keyed by its id, so a tombstone or re-key drops only that row and
   * leaves sibling rows on the same natural key intact.
   */
  const addIndexEntry = async (entry: IndexEntry): Promise<void> => {
    const record = await db.get("relationships", entry.key);
    await writeRows(entry.key, addIndexRow(record?.rows, entry));
  };

  const removeIndexEntry = async (entry: IndexEntry): Promise<void> => {
    const record = await db.get("relationships", entry.key);
    await writeRows(entry.key, removeIndexRow(record?.rows, entry));
  };

  const updateIndex = async (
    previous: Entity | undefined,
    next: Entity | undefined,
  ): Promise<void> => {
    // Reverse then forward: the same physical store keeps the two
    // directions under distinct key prefixes.
    for (const delta of [reverseIndexDelta(previous, next), forwardIndexDelta(previous, next)]) {
      if (delta.remove !== null) await removeIndexEntry(delta.remove);
      if (delta.add !== null) await addIndexEntry(delta.add);
    }
  };

  /** Replay the log for `entityId` into the cache and clear its dirty flag. */
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

    const previous = await db.get("entities", entityId);
    await db.put("entities", copyEntity(entity) as EbbDBSchema["entities"]["value"]);
    await updateIndex(previous, entity);

    await dirtyTracker.clear(entityId);
  };

  /** Materialize every dirty row of a type before an index read. */
  const materializeDirtyType = async (entityType: string): Promise<void> => {
    for (const id of await dirtyTracker.getDirtyForType(entityType)) {
      await replay(id);
    }
  };

  const readIndex = async (key: string): Promise<readonly string[]> => {
    const record = await db.get("relationships", key);
    return liveSourceIds(record?.rows);
  };

  const store: EntityStore = {
    async get(id: string): Promise<Entity | null> {
      await replay(id);
      const entity = await db.get("entities", id);

      return entity ? copyEntity(entity) : null;
    },

    async set(entity: Entity): Promise<void> {
      const previous = await db.get("entities", entity.id);
      await db.put("entities", copyEntity(entity) as EbbDBSchema["entities"]["value"]);
      await updateIndex(previous, entity);
    },

    async query(type: string): Promise<readonly Entity[]> {
      await materializeDirtyType(type);

      const entities = await db.getAllFromIndex("entities", "type", type);

      return entities.map(copyEntity);
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
      const record = await db.get("relationships", forwardIndexKey(as, type, sourceId));
      return liveRelationshipLinks(record?.rows);
    },

    async queryByMembership(groupId: string): Promise<readonly string[]> {
      await materializeDirtyType(MEMBERSHIP_ENTITY_TYPE);
      return readIndex(membershipIndexKey(groupId));
    },

    async queryByMembershipEntity(entityId: string): Promise<readonly MembershipLink[]> {
      await materializeDirtyType(MEMBERSHIP_ENTITY_TYPE);
      const record = await db.get("relationships", forwardMembershipIndexKey(entityId));
      return liveMembershipLinks(record?.rows);
    },

    async reset(): Promise<void> {
      await db.clear("relationships");
      await db.clear("entities");
    },
  };

  return store;
};
