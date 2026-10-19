import { defineReplicaStoreTests } from "../testing/replica-store.test-suite";
import { createMemoryReplicaStore } from "./replica-store.memory";

defineReplicaStoreTests({
  name: "Memory",
  factory: () => createMemoryReplicaStore(),
});
