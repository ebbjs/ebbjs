import { defineEntityStoreTests } from "../testing/entity-store.test-suite";
import { createMemoryActionLog } from "./action-log.memory";
import { createMemoryDirtyTracker } from "./dirty-tracker.memory";
import { createMemoryEntityStore } from "./entity-store.memory";

defineEntityStoreTests({
  name: "Memory",
  factory: () => {
    const actionLog = createMemoryActionLog();
    const dirtyTracker = createMemoryDirtyTracker();
    const entityStore = createMemoryEntityStore(actionLog, dirtyTracker);
    return { actionLog, dirtyTracker, entityStore };
  },
});
