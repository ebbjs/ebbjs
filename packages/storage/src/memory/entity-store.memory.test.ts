import { defineEntityStoreTests } from "../testing/entity-store.test-suite";
import { defineEntityChangeEmitterTests } from "../testing/entity-change-emitter.test-suite";
import { createMemoryAdapter } from "./memory-adapter";
import { createMemoryActionLog } from "./action-log.memory";
import { createMemoryDirtyTracker } from "./dirty-tracker.memory";
import { createMemoryEntityStore } from "./entity-store.memory";

defineEntityStoreTests({
  name: "Memory",
  factory: () => {
    const actionLog = createMemoryActionLog();
    const dirtyTracker = createMemoryDirtyTracker();
    const { store: entityStore } = createMemoryEntityStore(actionLog, dirtyTracker);
    return { actionLog, dirtyTracker, entityStore };
  },
});

defineEntityChangeEmitterTests({
  name: "Memory",
  factory: () => {
    const adapter = createMemoryAdapter();
    // The emitter is optional on StorageAdapter but always present
    // on the memory adapter; narrow for the test harness.
    if (adapter.changeEmitter === undefined) {
      throw new Error("memory adapter must ship a change emitter");
    }
    return { adapter, emitter: adapter.changeEmitter };
  },
});
