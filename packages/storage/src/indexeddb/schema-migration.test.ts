import { describe, expect, it } from "vitest";
import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { Action } from "@ebbjs/core";
import { buildPatchAction, buildPutAction } from "../testing/fixtures";
import { createIndexedDBActionLog } from "./action-log.indexeddb";
import {
  ACTION_POSITION_SEQUENCE_ID,
  createEbbStores,
  EBB_SCHEMA_VERSION,
  type EbbDBSchema,
} from "./schema";

/**
 * The pre-v9 store sets, reproduced here so the reset test opens databases
 * shaped like the ones a shipped client carries. A v7 database has no append
 * order on `actions` and no `sequence` / `replica` / `replicaCursor`; the v8
 * additions are created only when the open targets v8.
 */
const LEGACY_SCHEMA_VERSION = 7;
const PRE_RESET_SCHEMA_VERSION = 8;
const PRE_COMPONENT_INDEX_SCHEMA_VERSION = 10;
const PRE_COMPONENT_HOLD_SCHEMA_VERSION = 11;

interface LegacyStoredAction extends Action {
  subject_ids: readonly string[];
  position?: number;
}

interface LegacyDBSchema extends DBSchema {
  actions: {
    key: string;
    value: LegacyStoredAction;
    indexes: { subject_id: string; position: number };
  };
  entities: { key: string; value: unknown };
  relationships: { key: string; value: unknown };
  dirty: { key: string; value: unknown };
  cursors: { key: string; value: { groupId: string; cursor: number } };
  outbox: {
    key: string;
    value: {
      action: Action;
      status: "pending";
      enqueuedAtHlc: string;
      basedOnGsn: number;
    };
  };
  sequence: { key: string; value: { id: string; value: number } };
  replica: { key: [string, string]; value: unknown };
  replicaCursor: {
    key: string;
    value: { id: string; format: number; position: number; revision: number };
  };
}

const createLegacyStores = (
  database: IDBPDatabase<LegacyDBSchema>,
  _oldVersion: number,
  newVersion: number | null,
): void => {
  const version = newVersion ?? 0;
  const actions = database.createObjectStore("actions", { keyPath: "id" });
  actions.createIndex("subject_id", "subject_ids", { multiEntry: true });
  if (version >= 8) actions.createIndex("position", "position");
  database.createObjectStore("entities", { keyPath: "id" });
  database.createObjectStore("relationships", { keyPath: "key" });
  database.createObjectStore("dirty", { keyPath: "entityId" });
  database.createObjectStore("cursors", { keyPath: "groupId" });
  database.createObjectStore("outbox", { keyPath: "action.id" });
  if (version >= 8) {
    database.createObjectStore("sequence", { keyPath: "id" });
    database.createObjectStore("replica", { keyPath: ["type", "id"] });
    database.createObjectStore("replicaCursor", { keyPath: "id" });
  }
};

/** Every store the current version opens with. */
const CURRENT_STORES = [
  "actions",
  "entities",
  "relationships",
  "dirty",
  "cursors",
  "outbox",
  "sequence",
  "replica",
  "replicaCursor",
] as const;

/**
 * A reset database comes up with the full current store set, an empty action
 * log, no cursor or outbox rows, and the position counter at zero.
 */
const expectEmptyCurrentSchema = async (database: IDBPDatabase<EbbDBSchema>): Promise<void> => {
  const names = Array.from(database.objectStoreNames);
  expect(names.sort()).toEqual([...CURRENT_STORES].sort());

  // `sequence` holds only the zeroed append counter; every other store is
  // empty.
  for (const store of CURRENT_STORES.filter((name) => name !== "sequence")) {
    expect(await database.count(store)).toBe(0);
  }

  const actions = database.transaction("actions", "readonly").store;
  expect(Array.from(actions.indexNames)).toEqual(
    expect.arrayContaining(["subject_id", "position"]),
  );

  const entities = database.transaction("entities", "readonly").store;
  expect(Array.from(entities.indexNames)).toEqual(expect.arrayContaining(["type", "components"]));
  expect(entities.index("components").multiEntry).toBe(true);
  expect(entities.index("type").multiEntry).toBe(false);

  expect(await database.get("sequence", ACTION_POSITION_SEQUENCE_ID)).toEqual({
    id: ACTION_POSITION_SEQUENCE_ID,
    value: 0,
  });
};

let counter = 0;
const legacyDbName = (): string => `ebb-migration-${Date.now()}-${++counter}`;

describe("IndexedDB v7/v8 → v9 reset", () => {
  it("discards a v7 database instead of half-reading the new cell format", async () => {
    const dbName = legacyDbName();
    const action = buildPutAction();
    const second = buildPatchAction();
    const outboxEntry = {
      action,
      status: "pending" as const,
      enqueuedAtHlc: action.hlc,
      basedOnGsn: 0,
    };

    const legacy = await openDB<LegacyDBSchema>(dbName, LEGACY_SCHEMA_VERSION, {
      upgrade: createLegacyStores,
    });
    await legacy.put("actions", { ...action, subject_ids: ["todo_1"] });
    await legacy.put("actions", { ...second, subject_ids: ["todo_1"] });
    await legacy.put("cursors", { groupId: "group_1", cursor: 42 });
    await legacy.put("outbox", outboxEntry);
    expect(await legacy.count("actions")).toBe(2);
    legacy.close();

    const upgraded = await openDB<EbbDBSchema>(dbName, EBB_SCHEMA_VERSION, {
      upgrade: createEbbStores,
    });

    await expectEmptyCurrentSchema(upgraded);
    expect(await upgraded.get("actions", action.id)).toBeUndefined();
    expect(await upgraded.get("actions", second.id)).toBeUndefined();
    expect(await upgraded.get("cursors", "group_1")).toBeUndefined();
    expect(await upgraded.get("outbox", action.id)).toBeUndefined();

    const log = createIndexedDBActionLog(upgraded);
    expect(await log.readTail(0)).toEqual([]);
    expect(await log.lastPosition()).toBe(0);
  });

  it("also discards a v8 database", async () => {
    const dbName = legacyDbName();
    const action = buildPutAction();
    const outboxEntry = {
      action,
      status: "pending" as const,
      enqueuedAtHlc: action.hlc,
      basedOnGsn: 0,
    };

    const legacy = await openDB<LegacyDBSchema>(dbName, PRE_RESET_SCHEMA_VERSION, {
      upgrade: createLegacyStores,
    });
    await legacy.put("actions", { ...action, subject_ids: ["todo_1"], position: 1 });
    await legacy.put("sequence", { id: ACTION_POSITION_SEQUENCE_ID, value: 1 });
    await legacy.put("cursors", { groupId: "group_1", cursor: 42 });
    await legacy.put("outbox", outboxEntry);
    expect(await legacy.count("actions")).toBe(1);
    expect(await legacy.count("replica")).toBe(0);
    legacy.close();

    const upgraded = await openDB<EbbDBSchema>(dbName, EBB_SCHEMA_VERSION, {
      upgrade: createEbbStores,
    });

    await expectEmptyCurrentSchema(upgraded);
    expect(await upgraded.get("outbox", action.id)).toBeUndefined();
    expect(await createIndexedDBActionLog(upgraded).lastPosition()).toBe(0);
  });
});

describe("IndexedDB v11 → v12 component-hold reset", () => {
  it("discards a v11 database rather than reading conflicts without holds", async () => {
    const dbName = legacyDbName();
    const action = buildPutAction();

    const v11 = await openDB<LegacyDBSchema>(dbName, PRE_COMPONENT_HOLD_SCHEMA_VERSION, {
      upgrade: createLegacyStores,
    });
    await v11.put("outbox", {
      action,
      status: "pending",
      enqueuedAtHlc: action.hlc,
      basedOnGsn: 0,
    });
    expect(await v11.count("outbox")).toBe(1);
    v11.close();

    const current = await openDB<EbbDBSchema>(dbName, EBB_SCHEMA_VERSION, {
      upgrade: createEbbStores,
    });

    expect(await current.get("outbox", action.id)).toBeUndefined();
  });
});

describe("IndexedDB v10 → v11 component index reset", () => {
  it("discards a v10 database rather than reusing rows the index cannot see", async () => {
    const dbName = legacyDbName();
    const action = buildPutAction();
    const outboxEntry = {
      action,
      status: "pending" as const,
      enqueuedAtHlc: action.hlc,
      basedOnGsn: 0,
    };

    const v10 = await openDB<LegacyDBSchema>(dbName, PRE_COMPONENT_INDEX_SCHEMA_VERSION, {
      upgrade: createLegacyStores,
    });
    await v10.put("actions", { ...action, subject_ids: ["todo_1"], position: 1 });
    await v10.put("sequence", { id: ACTION_POSITION_SEQUENCE_ID, value: 1 });
    await v10.put("entities", { id: "todo_1", type: "todo" });
    await v10.put("outbox", outboxEntry);
    expect(await v10.count("entities")).toBe(1);
    v10.close();

    const upgraded = await openDB<EbbDBSchema>(dbName, EBB_SCHEMA_VERSION, {
      upgrade: createEbbStores,
    });

    await expectEmptyCurrentSchema(upgraded);
    expect(await upgraded.count("entities")).toBe(0);
    expect(await upgraded.get("outbox", action.id)).toBeUndefined();
    expect(await createIndexedDBActionLog(upgraded).lastPosition()).toBe(0);
  });
});
