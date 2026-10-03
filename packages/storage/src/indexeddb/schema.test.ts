import { describe, expect, it } from "vitest";
import { openDB, type IDBPDatabase } from "idb";
import type { Entity } from "@ebbjs/core";
import { createEbbStores, EBB_SCHEMA_VERSION, type EbbDBSchema } from "./schema";
import { createIndexedDBAdapter } from "./indexeddb-adapter";
import { openTestDb } from "./test-db";

/**
 * The pre-#248 schema: four stores, no `relationships`. Kept inline so
 * the upgrade test opens a database that looks like one a shipped v2
 * client left behind.
 */
const upgradeToV2 = (database: IDBPDatabase<EbbDBSchema>): void => {
  if (!database.objectStoreNames.contains("actions")) {
    const store = database.createObjectStore("actions", { keyPath: "id" });
    store.createIndex("subject_id", "subject_ids", { multiEntry: true });
  }
  if (!database.objectStoreNames.contains("entities")) {
    const store = database.createObjectStore("entities", { keyPath: "id" });
    store.createIndex("type", "type");
  }
  if (!database.objectStoreNames.contains("dirty")) {
    const store = database.createObjectStore("dirty", { keyPath: "entityId" });
    store.createIndex("entityType", "entityType");
  }
  if (!database.objectStoreNames.contains("cursors")) {
    database.createObjectStore("cursors", { keyPath: "groupId" });
  }
};

const makeEntity = (): Entity => ({
  id: "todo_1",
  type: "todo",
  data: { fields: { title: { value: "Hello", update_id: "u_1" } } },
  created_hlc: "1-0",
  updated_hlc: "1-0",
  deleted_hlc: null,
  last_gsn: 1,
});

/** A Relationship row a v2 client would already have materialized. */
const makeRelationshipEntity = (): Entity => {
  const field = (value: string) => ({ value, update_id: "u_rel_1" });

  return {
    id: "rel_1",
    type: "relationship",
    data: {
      fields: {
        source_id: field("todo_1"),
        target_id: field("list_1"),
        type: field("todo_list"),
        field: field("list"),
        kind: field("link"),
      },
    },
    created_hlc: "1-0",
    updated_hlc: "1-0",
    deleted_hlc: null,
    last_gsn: 1,
  };
};

describe("EbbDBSchema", () => {
  describe("actions store", () => {
    it("has a subject_id index for getForEntity range scans", async () => {
      const db = await openTestDb("schema");
      const tx = db.transaction("actions", "readonly");
      const indexes = Array.from(tx.store.indexNames);
      expect(indexes).toContain("subject_id");
    });
  });

  describe("relationships store", () => {
    it("is created at the current schema version", async () => {
      const db = await openTestDb("schema");
      expect(Array.from(db.objectStoreNames)).toContain("relationships");
    });

    it("is added when upgrading a v2 database, preserving entities and backfilling the index", async () => {
      const dbName = `ebb-schema-upgrade-${Date.now()}`;

      const v2 = await openDB<EbbDBSchema>(dbName, 2, { upgrade: upgradeToV2 });
      await v2.put("entities", makeEntity());
      await v2.put("entities", makeRelationshipEntity());
      v2.close();

      const upgraded = await openDB<EbbDBSchema>(dbName, EBB_SCHEMA_VERSION, {
        upgrade: createEbbStores,
      });

      expect(Array.from(upgraded.objectStoreNames)).toContain("relationships");
      expect(await upgraded.get("entities", "todo_1")).toEqual(makeEntity());
      upgraded.close();

      // A v2 client left these rows clean, so nothing replays them: the
      // edge is visible only if the upgrade backfilled the index.
      const adapter = await createIndexedDBAdapter({ dbName });
      expect(
        await adapter.entities.queryByRelationship({
          as: "list",
          type: "todo_list",
          targetId: "list_1",
        }),
      ).toEqual(["todo_1"]);
      await adapter.reset();
    });
  });
});
