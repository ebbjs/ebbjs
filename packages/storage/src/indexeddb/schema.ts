import type { IDBPDatabase, IDBPTransaction, DBSchema, StoreNames } from "idb";
import { unwrap } from "idb";
import type { Action, Entity } from "@ebbjs/core";
import {
  applyRelationshipEntry,
  relationshipEntryFor,
  type RelationshipRows,
} from "../internal/relationship-index";

/**
 * Schema version for the IndexedDB adapter. Bump when adding or
 * changing object stores. The production adapter and the test helper
 * both open at this version so the upgrade path cannot be exercised
 * at one version and shipped at another.
 */
export const EBB_SCHEMA_VERSION = 3;

/**
 * Structural schema for the five object stores the IndexedDB adapter
 * uses. Component factories (`action-log.indexeddb`, etc.) are typed
 * against this interface so the production schema and any test schema
 * satisfying the same shape can both be passed in without a cast.
 */
/**
 * Stored Action shape: the public Action plus a denormalized
 * `subject_ids` array (the unique `subject_id`s of every Update in
 * `updates`). The `subject_id` multiEntry index is keyed on this
 * array so `ActionLog.getForEntity` can range-scan.
 */
export interface StoredAction extends Action {
  subject_ids: readonly string[];
}

export interface EbbDBSchema extends DBSchema {
  actions: {
    key: string;
    value: StoredAction;
    indexes: { subject_id: string };
  };
  entities: {
    key: string;
    value: Entity;
    indexes: { type: string };
  };
  /**
   * Reverse relationship index: one record per
   * `(field, type, target_id)` composite key, mapping each live
   * relationship row id to its source id. Keying on the row (not the
   * source) keeps a duplicate-natural-key row from erasing a source
   * its sibling still supplies. Maintained alongside `entities` on
   * every materialization and backfilled when a pre-#248 database is
   * upgraded.
   */
  relationships: {
    key: string;
    value: { key: string; rows: RelationshipRows };
  };
  dirty: {
    key: string;
    value: { entityId: string; entityType: string };
    indexes: { entityType: string };
  };
  cursors: {
    key: string;
    value: { groupId: string; cursor: number };
  };
}

/**
 * Walks the materialized `entities` store inside the upgrade
 * transaction and writes the derived reverse-index rows. A v2 client
 * already materialized its Relationship rows but has no index and no
 * dirty flag to replay, so without this every pre-existing edge would
 * be invisible to `queryByRelationship`. The cursor keeps the
 * versionchange transaction alive across the walk (idb does not await
 * the upgrade callback, so it must stay synchronous).
 */
const backfillRelationshipIndex = (
  transaction: IDBPTransaction<EbbDBSchema, StoreNames<EbbDBSchema>[], "versionchange">,
): void => {
  const relationships = unwrap(transaction.objectStore("relationships"));
  const request = unwrap(transaction.objectStore("entities")).openCursor();
  let rowsByKey: Record<string, RelationshipRows> = {};

  request.onsuccess = () => {
    const cursor = request.result;
    if (cursor === null) {
      for (const [key, rows] of Object.entries(rowsByKey)) {
        relationships.put({ key, rows });
      }
      return;
    }

    const entry = relationshipEntryFor(cursor.value as Entity);
    if (entry !== null) {
      const rows = applyRelationshipEntry(rowsByKey[entry.key], entry, true);
      if (rows !== null) rowsByKey = { ...rowsByKey, [entry.key]: rows };
    }
    cursor.continue();
  };
};

/**
 * Idempotently creates the five Ebb object stores on a database. Used
 * by both the production adapter (during the `openDB` upgrade) and the
 * test helper (to spin up a fresh DB per test). Safe to call against a
 * database that already has the stores — existing stores are left
 * alone.
 *
 * When the `relationships` store is first added to a database that
 * already holds materialized entities, the index is backfilled from
 * them in the same upgrade transaction.
 */
export const createEbbStores = (
  database: IDBPDatabase<EbbDBSchema>,
  oldVersion: number,
  _newVersion: number | null,
  transaction: IDBPTransaction<EbbDBSchema, StoreNames<EbbDBSchema>[], "versionchange">,
): void => {
  const backfillRelationships =
    oldVersion > 0 && !database.objectStoreNames.contains("relationships");
  if (!database.objectStoreNames.contains("actions")) {
    const store = database.createObjectStore("actions", { keyPath: "id" });
    // multiEntry on `subject_ids`: every element of the denormalized
    // `subject_ids` array becomes a separate index entry, so an Action
    // affecting both `todo_1` and `todo_2` is returned by
    // `idx.getAll("todo_1")` and `idx.getAll("todo_2")`. The stored
    // Action shape is augmented with `subject_ids` by the action-log
    // factory at write time so the index does not have to traverse
    // `updates` (which would also work in real browsers but is not
    // supported by fake-indexeddb's key-path extraction).
    store.createIndex("subject_id", "subject_ids", { multiEntry: true });
  }
  if (!database.objectStoreNames.contains("entities")) {
    const store = database.createObjectStore("entities", { keyPath: "id" });
    if (!store.indexNames.contains("type")) store.createIndex("type", "type");
  }
  if (!database.objectStoreNames.contains("relationships")) {
    database.createObjectStore("relationships", { keyPath: "key" });
  }
  if (!database.objectStoreNames.contains("dirty")) {
    const store = database.createObjectStore("dirty", { keyPath: "entityId" });
    if (!store.indexNames.contains("entityType")) store.createIndex("entityType", "entityType");
  }
  if (!database.objectStoreNames.contains("cursors")) {
    database.createObjectStore("cursors", { keyPath: "groupId" });
  }

  if (backfillRelationships) backfillRelationshipIndex(transaction);
};
