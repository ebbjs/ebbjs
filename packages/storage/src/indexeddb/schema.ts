import type { IDBPDatabase, DBSchema } from "idb";
import type { Action, Entity } from "@ebbjs/core";

/**
 * Structural schema for the four object stores the IndexedDB adapter
 * uses. Component factories (`action-log.indexeddb`, etc.) are typed
 * against this interface so the production schema and any test schema
 * satisfying the same shape can both be passed in without a cast.
 */
export interface EbbDBSchema extends DBSchema {
  actions: {
    key: string;
    value: Action;
  };
  entities: {
    key: string;
    value: Entity;
    indexes: { type: string };
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
 * Idempotently creates the four Ebb object stores on a database. Used
 * by both the production adapter (during the first `openDB` upgrade)
 * and the test helper (to spin up a fresh DB per test). Safe to call
 * against a database that already has the stores — existing stores are
 * left alone.
 */
export const createEbbStores = (database: IDBPDatabase<EbbDBSchema>): void => {
  if (!database.objectStoreNames.contains("actions")) {
    database.createObjectStore("actions", { keyPath: "id" });
  }
  if (!database.objectStoreNames.contains("entities")) {
    const store = database.createObjectStore("entities", { keyPath: "id" });
    if (!store.indexNames.contains("type")) store.createIndex("type", "type");
  }
  if (!database.objectStoreNames.contains("dirty")) {
    const store = database.createObjectStore("dirty", { keyPath: "entityId" });
    if (!store.indexNames.contains("entityType")) store.createIndex("entityType", "entityType");
  }
  if (!database.objectStoreNames.contains("cursors")) {
    database.createObjectStore("cursors", { keyPath: "groupId" });
  }
};
