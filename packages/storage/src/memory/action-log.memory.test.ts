import { defineActionLogTests } from "../testing/action-log.test-suite";
import { createMemoryActionLog } from "./action-log.memory";

defineActionLogTests({
  name: "Memory",
  factory: () => createMemoryActionLog(),
});
