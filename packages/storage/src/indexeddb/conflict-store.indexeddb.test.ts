import { openDB } from "idb";

import {
  defineConflictStoreTests,
  type ConflictStoreTestSuiteHarness,
} from "../testing/conflict-store.test-suite";
import { createIndexedDBConflictStore } from "./conflict-store.indexeddb";
import { createEbbStores, EBB_SCHEMA_VERSION, type EbbDBSchema } from "./schema";
import { openTestDb } from "./test-db";

const factory = async (): Promise<ConflictStoreTestSuiteHarness> => {
  const db = await openTestDb("conflict");

  return {
    store: createIndexedDBConflictStore(db),
    // Close the original connection first so the reopen exercises
    // durability rather than reading back through a live handle.
    reopen: async () => {
      db.close();
      const reopened = await openDB<EbbDBSchema>(db.name, EBB_SCHEMA_VERSION, {
        upgrade: createEbbStores,
      });
      return createIndexedDBConflictStore(reopened);
    },
  };
};

defineConflictStoreTests({
  name: "IndexedDB",
  factory,
});
