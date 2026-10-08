import { defineConflictStoreTests } from "../testing/conflict-store.test-suite";
import { createMemoryConflictStore } from "./conflict-store.memory";

defineConflictStoreTests({
  name: "Memory",
  factory: () => ({ store: createMemoryConflictStore() }),
});
