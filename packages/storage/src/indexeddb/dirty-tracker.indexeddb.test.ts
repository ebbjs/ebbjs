import { defineDirtyTrackerTests } from "../testing/dirty-tracker.test-suite";
import type { DirtyTracker } from "../types/dirty-tracker";
import { createIndexedDBDirtyTracker } from "./dirty-tracker.indexeddb";
import { openTestDb } from "./test-db";

const factory = async (): Promise<DirtyTracker> => {
  const db = await openTestDb("dirty-tracker");
  return createIndexedDBDirtyTracker(db);
};

defineDirtyTrackerTests({
  name: "IndexedDB",
  factory,
});
