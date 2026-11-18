import type { IDBPDatabase } from "idb";
import { componentModel, EBB_MODEL_NAME, isEbbComponent, type Entity } from "@ebbjs/core";
import type { EntityStore, MembershipLink, RelationshipIndexQuery } from "../types/entity-store";
import type { ActionLog } from "../types/action-log";
import type { DirtyTracker } from "../types/dirty-tracker";
import { componentsOf } from "../internal/component-index";
import { foldEntityActions } from "../internal/materialize";
import {
  addIndexRow,
  forwardIndexDelta,
  forwardMembershipIndexKey,
  liveMembershipLinks,
  liveSourceIds,
  membershipIndexKey,
  removeIndexRow,
  reverseIndexDelta,
  reverseIndexKey,
  type IndexEntry,
  type IndexRows,
} from "../internal/reverse-index";
import type { EbbDBSchema, StoredEntity } from "./schema";

/**
 * IndexedDBEntityStore — IndexedDB implementation of EntityStore.
 *
 * Stores materialized entities in the `entities` object store, keyed by
 * entityId, with an index on `type` for O(log n) type queries and a
 * multiEntry index on the row's denormalized component names for O(log n)
 * component existence reads. The `entities` store is the materialized cache;
 * the `actions` store holds the source-of-truth log. Materialization is
 * driven by the same DirtyTracker that drives the in-memory adapter.
 *
 * The `relationships` object store is the shared adjacency index: one
 * record per composite key mapping each live entry to its yielded id.
 * It serves the reverse direction of `ebb/link` edges — keyed by
 * `(field, type, target_id)`, each entry the source row carrying the edge —
 * and `ebb/membership` rows in both directions, keyed by the synthetic
 * `groups` accessor (by group or by member entity). The index is derived and,
 * following #248, is not backfilled, so it is rewritten alongside the entity
 * store on every materialization.
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
  /**
   * The stored row is the in-memory row plus the component names the
   * multiEntry index reads; the property never survives a read, so the row
   * shape every caller sees is unchanged.
   */
  const storedEntity = (entity: Entity): StoredEntity => ({
    ...structuredClone(entity),
    components: componentsOf(entity),
  });

  const readEntity = (stored: StoredEntity): Entity => {
    const { components: _components, ...entity } = stored;
    return entity;
  };

  /** The stored row with its denormalized property stripped, or undefined. */
  const previousRow = async (id: string): Promise<Entity | undefined> => {
    const stored = await db.get("entities", id);
    return stored === undefined ? undefined : readEntity(stored);
  };

  const writeRows = async (key: string, rows: IndexRows | null): Promise<void> => {
    if (rows === null) await db.delete("relationships", key);
    else await db.put("relationships", { key, rows });
  };

  /**
   * Read-modify-write one entry into the `relationships` store. An entry is
   * keyed by its own id, so a tombstone or a dropped key removes only that
   * entry and leaves its siblings on the same index key intact.
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
      for (const entry of delta.remove) await removeIndexEntry(entry);
      for (const entry of delta.add) await addIndexEntry(entry);
    }
  };

  /** Replay the log for `entityId` into the cache and clear its dirty flag. */
  const replay = async (entityId: string): Promise<void> => {
    const isEntityDirty = await dirtyTracker.isDirty(entityId);
    if (!isEntityDirty) return;

    const actions = await actionLog.getForEntity(entityId);
    if (actions.length === 0) return;

    const entity = foldEntityActions(actions, entityId);

    if (entity === null) return;

    const previous = await previousRow(entityId);
    await db.put("entities", storedEntity(entity));
    await updateIndex(previous, entity);

    await dirtyTracker.clear(entityId);
  };

  /** Materialize every dirty row of a type before an index read. */
  const materializeDirtyModel = async (model: string): Promise<void> => {
    for (const id of await dirtyTracker.getDirtyForModel(model)) {
      await replay(id);
    }
  };

  /**
   * Materialize every dirty row, whatever model it belongs to, before a read
   * whose rows may carry the component under any model.
   */
  const materializeDirty = async (): Promise<void> => {
    for (const id of await dirtyTracker.getDirty()) {
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
      const stored = await db.get("entities", id);

      return stored === undefined ? null : readEntity(stored);
    },

    async set(entity: Entity): Promise<void> {
      const previous = await previousRow(entity.id);
      await db.put("entities", storedEntity(entity));
      await updateIndex(previous, entity);
    },

    async query(model: string): Promise<readonly Entity[]> {
      await materializeDirtyModel(model);

      const entities = await db.getAllFromIndex("entities", "model", model);

      return entities.map(readEntity);
    },

    async queryByComponent(component: string): Promise<readonly string[]> {
      // An `ebb/*` overlay sits on a row of any model, so its read cannot
      // narrow to one.
      if (isEbbComponent(component)) await materializeDirty();
      else await materializeDirtyModel(componentModel(component));

      const rows = await db.getAllFromIndex("entities", "components", component);

      // A tombstoned row keeps its fields, so its index entries outlive its
      // liveness: existence is only ever a question about live rows.
      return rows
        .filter((row) => row.deleted_hlc === null)
        .map((row) => row.id)
        .sort();
    },

    async queryByRelationship({
      as,
      type,
      targetId,
    }: RelationshipIndexQuery): Promise<readonly string[]> {
      // The source row carrying the edge may be any model's.
      await materializeDirty();
      return readIndex(reverseIndexKey(as, type, targetId));
    },

    async queryByMembership(groupId: string): Promise<readonly string[]> {
      await materializeDirtyModel(EBB_MODEL_NAME);
      return readIndex(membershipIndexKey(groupId));
    },

    async queryByMembershipEntity(entityId: string): Promise<readonly MembershipLink[]> {
      await materializeDirtyModel(EBB_MODEL_NAME);
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
