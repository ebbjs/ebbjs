import type { IDBPDatabase, DBSchema } from "idb";
import type { Action, Entity } from "@ebbjs/core";
import type { OutboxStatus } from "../types/outbox-store";
import type { ConflictEntry } from "../types/conflict-store";
import type { RelationshipRows } from "../internal/relationship-index";

/**
 * Schema version for the IndexedDB adapter. The production adapter and
 * the test helper both open at this version so they cannot drift
 * apart.
 *
 * Pre-release reset: this was lowered from a shipped v2 to 1 with no
 * migration. `IndexedDB` refuses to open a database at a version below
 * the one it already holds (`VersionError`), so a browser carrying the
 * legacy `ebb-storage` database at v2 must clear it (or the caller must
 * pass a new `dbName`) before this adapter can open. Version 3 added the
 * `outbox` store for issue #228; 2 is skipped so that any database below
 * 3 (v1, or the legacy v2) triggers the upgrade callback and gets the new
 * store rather than silently missing it. Version 4 adds the `conflicts`
 * store for issue #307; databases below 4 trigger the upgrade callback.
 * Bump this when adding or changing object stores.
 */
export const EBB_SCHEMA_VERSION = 4;

/**
 * Structural schema for the seven object stores the IndexedDB adapter
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
   * every materialization.
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
  /**
   * Durable buffer of pending local Actions, keyed by `action.id`.
   * `createEbbStores` creates the store for databases that upgrade
   * from an earlier version; its absence at a version below 3 is
   * expected.
   */
  outbox: {
    key: string;
    value: { action: Action; status: OutboxStatus; enqueuedAtHlc: string };
  };
  /**
   * Durable table of LWW conflicts awaiting application resolution,
   * keyed by the losing `action.id`. `createEbbStores` creates the
   * store for databases that upgrade from an earlier version; its
   * absence at a version below 4 is expected.
   */
  conflicts: {
    key: string;
    value: ConflictEntry;
  };
}

/**
 * Idempotently creates the seven Ebb object stores on a database. Used
 * by both the production adapter (during the `openDB` upgrade) and the
 * test helper (to spin up a fresh DB per test). Safe to call against a
 * database that already has the stores — existing stores are left
 * alone.
 */
export const createEbbStores = (
  database: IDBPDatabase<EbbDBSchema>,
  _oldVersion: number,
  _newVersion: number | null,
): void => {
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
  if (!database.objectStoreNames.contains("outbox")) {
    // Key path reaches into the entry so the stored row keeps the
    // `{ action, status, enqueuedAtHlc }` shape without a denormalized
    // copy of the id.
    database.createObjectStore("outbox", { keyPath: "action.id" });
  }
  if (!database.objectStoreNames.contains("conflicts")) {
    // Key path reaches into the entry so the stored row keeps the
    // `{ action, winners, fields, detectedAtHlc }` shape without a
    // denormalized copy of the losing Action's id.
    database.createObjectStore("conflicts", { keyPath: "action.id" });
  }
};
