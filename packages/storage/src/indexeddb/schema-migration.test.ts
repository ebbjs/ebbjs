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
 * The v7 store set, reproduced here so the migration test opens a database
 * shaped like the one a shipped client carries. `actions` is keyed by id with
 * the `subject_id` multiEntry index and no append order; there is no
 * `sequence`, `replica`, or `replicaCursor`.
 */
const LEGACY_SCHEMA_VERSION = 7;

interface LegacyStoredAction extends Action {
  subject_ids: readonly string[];
}

interface LegacyDBSchema extends DBSchema {
  actions: {
    key: string;
    value: LegacyStoredAction;
    indexes: { subject_id: string };
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
}

const createLegacyStores = (
  database: IDBPDatabase<LegacyDBSchema>,
  _oldVersion: number,
  _newVersion: number | null,
): void => {
  const actions = database.createObjectStore("actions", { keyPath: "id" });
  actions.createIndex("subject_id", "subject_ids", { multiEntry: true });
  database.createObjectStore("entities", { keyPath: "id" });
  database.createObjectStore("relationships", { keyPath: "key" });
  database.createObjectStore("dirty", { keyPath: "entityId" });
  database.createObjectStore("cursors", { keyPath: "groupId" });
  database.createObjectStore("outbox", { keyPath: "action.id" });
};

let counter = 0;
const legacyDbName = (): string => `ebb-migration-${Date.now()}-${++counter}`;

describe("IndexedDB v7 → v8 migration", () => {
  it("backfills action positions and preserves cursors and outbox rows", async () => {
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
    legacy.close();

    const upgraded = await openDB<EbbDBSchema>(dbName, EBB_SCHEMA_VERSION, {
      upgrade: createEbbStores,
    });

    for (const store of ["sequence", "replica", "replicaCursor"]) {
      expect(Array.from(upgraded.objectStoreNames)).toContain(store);
    }

    const storedAction = await upgraded.get("actions", action.id);
    expect(storedAction).toMatchObject(action);
    expect(storedAction?.position).toBe(1);
    expect((await upgraded.get("actions", second.id))?.position).toBe(2);

    const tx = upgraded.transaction("actions", "readonly");
    const indexed = await tx.store.index("position").getAll();
    expect(indexed.map((row) => row.position)).toEqual([1, 2]);

    expect(await upgraded.get("sequence", ACTION_POSITION_SEQUENCE_ID)).toEqual({
      id: ACTION_POSITION_SEQUENCE_ID,
      value: 2,
    });
    expect(await upgraded.get("cursors", "group_1")).toEqual({ groupId: "group_1", cursor: 42 });
    expect(await upgraded.get("outbox", action.id)).toEqual(outboxEntry);

    const log = createIndexedDBActionLog(upgraded);
    const tail = await log.readTail(0);
    expect(tail.map((entry) => entry.position)).toEqual([1, 2]);
    expect(tail[0]!.action).toEqual(action);
    expect(await log.lastPosition()).toBe(2);
  });
});
