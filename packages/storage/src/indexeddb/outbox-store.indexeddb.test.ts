import { openDB } from "idb";

import {
  defineOutboxStoreTests,
  type OutboxStoreTestSuiteHarness,
} from "../testing/outbox-store.test-suite";
import { createIndexedDBOutboxStore } from "./outbox-store.indexeddb";
import { createEbbStores, EBB_SCHEMA_VERSION, type EbbDBSchema } from "./schema";
import { openTestDb } from "./test-db";

const factory = async (): Promise<OutboxStoreTestSuiteHarness> => {
  const db = await openTestDb("outbox");

  return {
    store: createIndexedDBOutboxStore(db),
    // Close the original connection first so the reopen exercises
    // durability rather than reading back through a live handle.
    reopen: async () => {
      db.close();
      const reopened = await openDB<EbbDBSchema>(db.name, EBB_SCHEMA_VERSION, {
        upgrade: createEbbStores,
      });
      return createIndexedDBOutboxStore(reopened);
    },
  };
};

defineOutboxStoreTests({
  name: "IndexedDB",
  factory,
});
