import { describe, expect, it } from "vitest";
import { defineReplicaStoreTests } from "../testing/replica-store.test-suite";
import { createIndexedDBReplicaStore } from "./replica-store.indexeddb";
import { REPLICA_CURSOR_ID, type EbbDBSchema } from "./schema";
import { openTestDb } from "./test-db";

const factory = async () => {
  const db = await openTestDb("replica");
  return createIndexedDBReplicaStore(db);
};

defineReplicaStoreTests({
  name: "IndexedDB",
  factory,
});

describe("IndexedDB ReplicaStore corruption", () => {
  it("reads a cursor with a non-numeric format as null", async () => {
    const db = await openTestDb("replica-corrupt-cursor");
    const store = createIndexedDBReplicaStore(db);
    await db.put("replicaCursor", {
      id: REPLICA_CURSOR_ID,
      format: "not-a-number",
      position: 0,
      revision: 0,
    } as unknown as EbbDBSchema["replicaCursor"]["value"]);

    expect(await store.load()).toBe(null);
  });

  it("reads a cursor missing its watermark fields as null", async () => {
    const db = await openTestDb("replica-corrupt-row");
    const store = createIndexedDBReplicaStore(db);
    await db.put("replicaCursor", {
      id: REPLICA_CURSOR_ID,
    } as unknown as EbbDBSchema["replicaCursor"]["value"]);

    expect(await store.load()).toBe(null);
  });

  it("reads a row with a non-string id as null", async () => {
    const db = await openTestDb("replica-corrupt-entity");
    const store = createIndexedDBReplicaStore(db);
    await db.put("replicaCursor", { id: REPLICA_CURSOR_ID, format: 1, position: 0, revision: 0 });
    // The composite key accepts a numeric id, but the row shape does not.
    await db.put("replica", {
      type: "todo",
      id: 123,
    } as unknown as EbbDBSchema["replica"]["value"]);

    expect(await store.load()).toBe(null);
  });
});
