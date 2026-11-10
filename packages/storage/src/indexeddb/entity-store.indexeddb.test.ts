import { describe, expect, it } from "vitest";
import { buildPutAction } from "../testing/fixtures";
import {
  defineEntityStoreTests,
  type EntityStoreTestSuiteHarness,
} from "../testing/entity-store.test-suite";
import { createIndexedDBActionLog } from "./action-log.indexeddb";
import { createIndexedDBDirtyTracker } from "./dirty-tracker.indexeddb";
import { createIndexedDBEntityStore } from "./entity-store.indexeddb";
import { openTestDb } from "./test-db";

defineEntityStoreTests({
  name: "IndexedDB",
  factory: async (): Promise<EntityStoreTestSuiteHarness> => {
    const db = await openTestDb("entity-store");
    const actionLog = createIndexedDBActionLog(db);
    const dirtyTracker = createIndexedDBDirtyTracker(db);
    const entityStore = createIndexedDBEntityStore(db, actionLog, dirtyTracker);
    return { actionLog, dirtyTracker, entityStore };
  },
});

describe("IndexedDB EntityStore storage shape", () => {
  const harness = async () => {
    const db = await openTestDb("entity-store-components");
    const actionLog = createIndexedDBActionLog(db);
    const dirtyTracker = createIndexedDBDirtyTracker(db);
    return {
      db,
      actionLog,
      dirtyTracker,
      entityStore: createIndexedDBEntityStore(db, actionLog, dirtyTracker),
    };
  };

  it("stores the component names de-normalized and strips them on read", async () => {
    const { db, actionLog, dirtyTracker, entityStore } = await harness();
    await actionLog.append(buildPutAction());
    await dirtyTracker.mark("todo_1", "todo");

    const row = await entityStore.get("todo_1");

    expect(row).not.toHaveProperty("components");
    const stored = await db.get("entities", "todo_1");
    expect(stored?.components).toEqual(["todo/title"]);
    expect(await db.getAllFromIndex("entities", "components", "todo/title")).toHaveLength(1);
  });
});
