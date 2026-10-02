import {
  defineEntityStoreTests,
  type EntityStoreTestSuiteHarness,
} from "../testing/entity-store.test-suite";
import { defineEntityChangeEmitterTests } from "../testing/entity-change-emitter.test-suite";
import { createIndexedDBAdapter } from "./indexeddb-adapter";
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
    const { store: entityStore } = createIndexedDBEntityStore(db, actionLog, dirtyTracker);
    return { actionLog, dirtyTracker, entityStore };
  },
});

let emitterAdapterCount = 0;

defineEntityChangeEmitterTests({
  name: "IndexedDB",
  factory: async () => {
    const dbName = `ebb-change-emitter-${Date.now()}-${++emitterAdapterCount}`;
    const adapter = await createIndexedDBAdapter({ dbName });
    if (adapter.changeEmitter === undefined) {
      throw new Error("indexeddb adapter must ship a change emitter");
    }
    return { adapter, emitter: adapter.changeEmitter };
  },
});
