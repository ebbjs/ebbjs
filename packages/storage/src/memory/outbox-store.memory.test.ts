import { defineOutboxStoreTests } from "../testing/outbox-store.test-suite";
import { createMemoryOutboxStore } from "./outbox-store.memory";

defineOutboxStoreTests({
  name: "Memory",
  factory: () => ({ store: createMemoryOutboxStore() }),
});
