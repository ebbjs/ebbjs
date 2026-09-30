import { defineDirtyTrackerTests } from "../testing/dirty-tracker.test-suite";
import { createMemoryDirtyTracker } from "./dirty-tracker.memory";

defineDirtyTrackerTests({
  name: "Memory",
  factory: () => createMemoryDirtyTracker(),
});
