import {
  unwrap,
  type DBSchema,
  type IDBPDatabase,
  type IDBPTransaction,
  type StoreNames,
} from "idb";
import type { Action, Entity } from "@ebbjs/core";
import type { OutboxConflict, OutboxStatus } from "../types/outbox-store";
import type { IndexRows } from "../internal/reverse-index";

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
 * store rather than silently missing it. Version 4 added the `conflicts`
 * store for issue #307; that store is gone as of v6 (its payload now
 * lives on the outbox row), so a database that carries it simply leaves
 * it unread. Version 5 moves collaborative-text writes off the shared `text_document`
 * type onto per-field generated document entities (issue #398). No object
 * store shape changes; the bump gates the persisted subject-type layout so
 * a dev database carrying legacy `text_document` rows reopens and those
 * rows go unread. Version 6 adds `basedOnGsn` to the persisted outbox
 * entry and moves the conflict payload onto the outbox row (issue #390),
 * so the outbox is the single durable source for a losing Action. Version
 * 7 adds `subjectStates` — the full before/after entity rows per losing
 * subject — to that persisted conflict payload (issue #408). Version 8
 * adds the replica stores (issue #518): the log-local `position` field plus
 * index on `actions`, the `sequence` counter that assigns positions, and the
 * `replica` / `replicaCursor` stores for the persisted materialized replica.
 * It is the first version with a real migration: an existing database is
 * upgraded in place, backfilling a position for every stored Action and
 * leaving actions, cursors, and outbox rows intact. Bump this when adding
 * or changing object stores, or when a persisted row shape changes.
 */
export const EBB_SCHEMA_VERSION = 8;

/**
 * The `sequence` row that holds the action log's append cursor. One row
 * per counter; only the action position counter exists today.
 */
export const ACTION_POSITION_SEQUENCE_ID = "actionPosition";

/**
 * The `replicaCursor` row that holds the replica's `position` / `revision`
 * watermark. The replica's rows live in the `replica` store; the cursor is
 * single-slot and shares the `id` key with the sequence rows' shape.
 */
export const REPLICA_CURSOR_ID = "replica";

/**
 * Stored Action shape: the public Action plus a denormalized
 * `subject_ids` array (the unique `subject_id`s of every Update in
 * `updates`) and the log-local `position` assigned at append. The
 * `subject_id` multiEntry index is keyed on the array so
 * `ActionLog.getForEntity` can range-scan; the `position` index backs
 * `ActionLog.readTail`.
 */
export interface StoredAction extends Action {
  subject_ids: readonly string[];
  position: number;
}

/**
 * Structural schema for the object stores the IndexedDB adapter uses.
 * Component factories (`action-log.indexeddb`, etc.) are typed against this
 * interface so the production schema and any test schema satisfying the same
 * shape can both be passed in without a cast.
 */
export interface EbbDBSchema extends DBSchema {
  actions: {
    key: string;
    value: StoredAction;
    indexes: { subject_id: string; position: number };
  };
  entities: {
    key: string;
    value: Entity;
    indexes: { type: string };
  };
  /**
   * Shared adjacency index: one record per composite key, mapping each
   * live row id to its yielded id. Serves relationship edges in both
   * directions — keyed by `(field, type, target_id)` for the reverse
   * read and `(field, type, source_id)` for the forward read — and
   * `entityGroup` membership keyed by the synthetic `groups` accessor
   * (by group or by member entity). Keying on the row (not the source)
   * keeps a duplicate-natural-key row from erasing a source its sibling
   * still supplies. The name and the schema version are unchanged: the
   * index is derived, and following #248 it is not backfilled, so a
   * database written before membership keys existed must be cleared (or
   * `reset()`) rather than reused. This store is maintained alongside
   * `entities` on every materialization.
   */
  relationships: {
    key: string;
    value: { key: string; rows: IndexRows };
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
    value: {
      action: Action;
      status: OutboxStatus;
      enqueuedAtHlc: string;
      basedOnGsn: number;
      conflict?: OutboxConflict;
    };
  };
  /**
   * Generic monotonic counters, keyed by a fixed id. Holds the action
   * log's append cursor; a row is always present once v8 has opened.
   */
  sequence: {
    key: string;
    value: { id: string; value: number };
  };
  /**
   * The persisted materialized replica: one row per entity, keyed by
   * `[type, id]` so entity rows keep their natural shape and a full
   * `getAll` read is append-order independent.
   */
  replica: {
    key: [string, string];
    value: Entity;
  };
  /**
   * The replica's single watermark row — the log position and revision
   * the `replica` rows were taken at. An absent or corrupt row makes
   * `load()` return null so the caller replays the full log.
   */
  replicaCursor: {
    key: string;
    value: { id: string; format: number; position: number; revision: number };
  };
}

/**
 * Idempotently creates the Ebb object stores on a database. Used by both the
 * production adapter (during the `openDB` upgrade) and the test helper (to
 * spin up a fresh DB per test). Safe to call against a database that already
 * has the stores — existing stores are left alone.
 *
 * From v8 the upgrade also backfills an append `position` onto every Action
 * that predates it: a cursor walks `actions` in key order, stamps the row
 * 1-based, and the final count is written to the `sequence` counter. A fresh
 * database runs the same path over zero rows, leaving `sequence = 0`.
 */
export const createEbbStores = (
  database: IDBPDatabase<EbbDBSchema>,
  oldVersion: number,
  _newVersion: number | null,
  transaction: IDBPTransaction<EbbDBSchema, StoreNames<EbbDBSchema>[], "versionchange">,
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
    store.createIndex("position", "position");
  } else if (!transaction.objectStore("actions").indexNames.contains("position")) {
    // A pre-v8 database carries the store without the append index.
    transaction.objectStore("actions").createIndex("position", "position");
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
    // `{ action, status, enqueuedAtHlc, conflict? }` shape without a
    // denormalized copy of the id.
    database.createObjectStore("outbox", { keyPath: "action.id" });
  }
  if (!database.objectStoreNames.contains("sequence")) {
    database.createObjectStore("sequence", { keyPath: "id" });
  }
  if (!database.objectStoreNames.contains("replica")) {
    database.createObjectStore("replica", { keyPath: ["type", "id"] });
  }
  if (!database.objectStoreNames.contains("replicaCursor")) {
    database.createObjectStore("replicaCursor", { keyPath: "id" });
  }

  if (oldVersion < 8) {
    backfillActionPositions(transaction);
  }
};

/**
 * Stamps a 1-based append position onto every Action already in `actions`,
 * in key order, and writes the total to the `sequence` counter. `idb`
 * wraps requests as promises, so the cursor is driven through the native
 * store: the raw `onsuccess` / `continue` loop — and issuing the counter
 * write from inside its final callback — is what keeps the versionchange
 * transaction alive until the backfill commits.
 */
const backfillActionPositions = (
  transaction: IDBPTransaction<EbbDBSchema, StoreNames<EbbDBSchema>[], "versionchange">,
): void => {
  const actions = unwrap(transaction.objectStore("actions"));
  const sequence = transaction.objectStore("sequence");
  let count = 0;

  const request = actions.openCursor();
  request.onsuccess = () => {
    const cursor = request.result;
    if (cursor === null) {
      void sequence.put({ id: ACTION_POSITION_SEQUENCE_ID, value: count });
      return;
    }
    count += 1;
    cursor.update({ ...(cursor.value as StoredAction), position: count });
    cursor.continue();
  };
};
