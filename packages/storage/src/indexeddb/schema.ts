import type { IDBPDatabase, DBSchema } from "idb";
import type { Action, Entity } from "@ebbjs/core";

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
   * `(field, type, target_id)` composite key, holding the ids of the
   * source entities whose Relationship rows point at `target_id`
   * through that accessor. Maintained alongside `entities` on every
   * materialization so a relationship-aware query avoids scanning the
   * whole Relationship table.
   */
  relationships: {
    key: string;
    value: { key: string; source_ids: readonly string[] };
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
 * Idempotently creates the five Ebb object stores on a database. Used
 * by both the production adapter (during the first `openDB` upgrade)
 * and the test helper (to spin up a fresh DB per test). Safe to call
 * against a database that already has the stores — existing stores are
 * left alone.
 */
export const createEbbStores = (database: IDBPDatabase<EbbDBSchema>): void => {
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
};
