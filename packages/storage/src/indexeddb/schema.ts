import {
  unwrap,
  type DBSchema,
  type IDBPDatabase,
  type IDBPTransaction,
  type StoreNames,
} from "idb";
import type { Action, Entity } from "@ebbjs/core";
import type { OutboxEntry } from "../types/outbox-store";
import type { SeedMarker } from "../types/cursor-store";
import type { IndexRows } from "../internal/reverse-index";

/**
 * Schema version for the IndexedDB adapter. The production adapter and
 * the test helper both open at this version so they cannot drift
 * apart.
 *
 * Pre-release reset: this was lowered from a shipped v2 to 1 with no
 * migration. `IndexedDB` refuses to open a database at a version below
 * the one it already holds (`VersionError`), so a browser carrying the
 * legacy `DEFAULT_DB_NAME` database at v2 must clear it (or the caller must
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
 * leaving actions, cursors, and outbox rows intact. Version 9 is the
 * collaborative-text cell-format reset (issue #764): text bodies now carry
 * immutable run cells plus additive cut cells and declare a `version` leaf.
 * The encoding changed incompatibly, so there is no migration from a lower
 * version — an existing database below 9 is discarded at open and rebuilt
 * empty. Version 10 added `scope` and `remoteActions` to the persisted
 * conflict payload (issue #781). Version 11 added the `components` multiEntry
 * index to `entities` (issue #799): rows now carry a denormalized
 * component-name array, so there is no migration from a lower version — an
 * existing database below 11 is discarded at open and rebuilt empty. Version
 * 12 adds `holds` to the persisted conflict payload (issue #801): the
 * positions a detected conflict keeps off the wire. The payload shape changed,
 * so a database below 12 is discarded rather than reading a conflict without
 * its holds. Version 13 adds `componentVersions` to the replica cursor (issue
 * #804): the persisted record gained the version each component was
 * materialized at. Version 14 moves the four system types onto `ebb/*`
 * components (issue #805): an adjacency key's middle segment is the component
 * name and a stored system row is one atomic component value. Version 15
 * renames a row's committed model from `type` to `model`, which moves the
 * `entities` index, the `dirty` index, and the `replica` key with it. Version
 * 16 makes row existence a persisted row fact carried by the row's create
 * (issue #817): a stored row's `exists` / `created_hlc` may come from the
 * deleted "`replace` implies create" inference, and a stored Action may carry
 * only component writes, so the pair cannot be read as the new shape. Version
 * 17 makes a link a keyed component of its source row (issue #820): a database
 * below it carries `rel_*` link rows and reverse entries keyed on them, which
 * is not the shape a reader derives from a row count. None of
 * these shapes can be read out of the previous one, so a database below any of
 * them is discarded at open. Bump this when adding or changing object stores,
 * or when a persisted row shape changes.
 */
export const EBB_SCHEMA_VERSION = 17;

/**
 * The IndexedDB database name an adapter opens when the caller passes none.
 * Namespaced per app by passing `dbName`.
 */
export const DEFAULT_DB_NAME = "ebb-storage";

/** One version at which a persisted shape changed incompatibly. */
export interface ResetGate {
  /** The schema version the gate runs at. */
  readonly version: number;
  /** Why the shapes below it cannot be read as the ones above it. */
  readonly reason: string;
}

/**
 * The versions at which an incompatible persisted shape is discarded instead
 * of migrated: a database older than a gate is reset at open. Declared as one
 * list so a gate's reason, its version, and its participation in the reset
 * cannot drift apart — adding a gate is one entry, not a constant plus an
 * array slot.
 */
export const RESET_VERSIONS: readonly ResetGate[] = Object.freeze([
  {
    version: 9,
    reason:
      "the collaborative-text cell format changed: text bodies carry immutable run cells " +
      "plus additive cut cells and declare a `version` leaf (issue #764)",
  },
  {
    version: 11,
    reason:
      "stored entity rows gained the denormalized component names the `components` index " +
      "reads, which cannot be inferred for a row written before it (issue #799)",
  },
  {
    version: 12,
    reason: "a persisted conflict gained the component holds it keeps off the wire (issue #801)",
  },
  {
    version: 13,
    reason: "the replica cursor gained the version each component was materialized at (issue #804)",
  },
  {
    version: 14,
    reason:
      "an adjacency key's segments became component names and a stored system row became " +
      "one atomic value (issue #805)",
  },
  {
    version: 15,
    reason:
      "a row's committed model moved from `type` to `model`, taking the `entities` index, " +
      "the `dirty` index, and the `replica` key with it",
  },
  {
    version: 16,
    reason:
      "row existence became the create's persisted fact: a row written before it may carry " +
      "the existence the old inference gave it, and its Actions may carry only component " +
      "writes (issue #817)",
  },
  {
    version: 17,
    reason:
      "a link became a keyed component of its source row, so a stored `ebb/link` row and the " +
      "reverse entries keyed on it are not the shape this version reads (issue #820)",
  },
]);

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
 * Stored entity shape: the public Entity plus a denormalized
 * `components` array (`<model>/<field>` per present field). The
 * `components` multiEntry index is keyed on the array so
 * `queryByComponent` is one index read; the property is stripped on the
 * way back out so the in-memory row shape is unchanged.
 */
export interface StoredEntity extends Entity {
  components: readonly string[];
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
    value: StoredEntity;
    indexes: {
      /** The row's model; the query and listing source. */
      model: string;
      /** Every `<model>/<field>` the row carries, as a multiEntry index. */
      components: string;
    };
  };
  /**
   * Shared adjacency index: one record per composite key, mapping each
   * live entry to its yielded id. Serves the reverse direction of
   * `ebb/link` edges — keyed by `(field, type, target_id)`, each entry the
   * source row that carries the edge — and `ebb/membership` rows in both
   * directions, keyed by the synthetic `groups` accessor (by group or by
   * member entity). A membership entry keeps its row id, so a duplicate
   * membership row cannot erase a member its sibling still supplies; a link
   * entry is the source id itself. The index is derived, and following #248
   * it is not backfilled, so it is rebuilt rather than reused across the
   * versions {@link RESET_VERSIONS} discards. It is maintained alongside
   * `entities` on every materialization.
   */
  relationships: {
    key: string;
    value: { key: string; rows: IndexRows };
  };
  dirty: {
    key: string;
    value: { entityId: string; model: string };
    indexes: { model: string };
  };
  cursors: {
    key: string;
    /**
     * One resume record per group: its cursor, any in-flight seed marker,
     * and how far a completed seed's base folded.
     */
    value: { groupId: string; cursor?: number; seed?: SeedMarker; through?: number };
  };
  /**
   * Durable buffer of pending local Actions, keyed by `action.id`.
   * `createEbbStores` creates the store for databases that upgrade
   * from an earlier version; its absence at a version below 3 is
   * expected.
   */
  outbox: {
    key: string;
    value: OutboxEntry;
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
   * `[model, id]` so entity rows keep their natural shape and a full
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
    value: {
      id: string;
      format: number;
      position: number;
      revision: number;
      componentVersions: Readonly<Record<string, Readonly<Record<string, number>>>>;
    };
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
 *
 * An existing database older than any gate in {@link RESET_VERSIONS} is
 * reset rather than upgraded: every store is deleted before the current stores
 * are created and the action-position counter is opened at zero. Each entry
 * carries why its shape cannot be read out of the previous one. Only a
 * genuinely fresh database (`oldVersion === 0`) skips the reset.
 */
export const createEbbStores = (
  database: IDBPDatabase<EbbDBSchema>,
  oldVersion: number,
  _newVersion: number | null,
  transaction: IDBPTransaction<EbbDBSchema, StoreNames<EbbDBSchema>[], "versionchange">,
): void => {
  // A gate is declared once, in `RESET_VERSIONS`, so a version bump cannot
  // land a new incompatible shape without the reset that discards it.
  const reset = oldVersion > 0 && RESET_VERSIONS.some(({ version }) => oldVersion < version);
  if (reset) {
    // `objectStoreNames` is live while stores are deleted, so iterate a copy.
    for (const name of Array.from(database.objectStoreNames)) {
      database.deleteObjectStore(name);
    }
  }
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
    if (!store.indexNames.contains("model")) store.createIndex("model", "model");
    // multiEntry on `components`: each element of the denormalized
    // component-name array becomes its own index entry, so a row carrying
    // `todo/title` and `todo/status` is returned by a lookup for either.
    store.createIndex("components", "components", { multiEntry: true });
  }
  if (!database.objectStoreNames.contains("relationships")) {
    database.createObjectStore("relationships", { keyPath: "key" });
  }
  if (!database.objectStoreNames.contains("dirty")) {
    const store = database.createObjectStore("dirty", { keyPath: "entityId" });
    if (!store.indexNames.contains("model")) store.createIndex("model", "model");
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
    database.createObjectStore("replica", { keyPath: ["model", "id"] });
  }
  if (!database.objectStoreNames.contains("replicaCursor")) {
    database.createObjectStore("replicaCursor", { keyPath: "id" });
  }

  if (reset) {
    // The reset left a fresh database: open the append cursor at zero so the
    // counter row exists before the first append.
    void transaction.objectStore("sequence").put({ id: ACTION_POSITION_SEQUENCE_ID, value: 0 });
  } else if (oldVersion < 8) {
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
