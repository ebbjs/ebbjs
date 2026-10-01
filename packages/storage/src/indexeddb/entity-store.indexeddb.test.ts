import {
  defineEntityStoreTests,
  type EntityStoreTestSuiteHarness,
} from "../testing/entity-store.test-suite";
import { createIndexedDBActionLog } from "./action-log.indexeddb";
import { createIndexedDBDirtyTracker } from "./dirty-tracker.indexeddb";
import { createIndexedDBEntityStore } from "./entity-store.indexeddb";
import { openTestDb } from "./test-db";

const factory = async (): Promise<EntityStoreTestSuiteHarness> => {
  const db = await openTestDb("entity-store");
  const actionLog = createIndexedDBActionLog(db);
  const dirtyTracker = createIndexedDBDirtyTracker(db);
  const entityStore = createIndexedDBEntityStore(db, actionLog, dirtyTracker);
  return { actionLog, dirtyTracker, entityStore };
};

defineEntityStoreTests({
  name: "IndexedDB",
  factory,
});
