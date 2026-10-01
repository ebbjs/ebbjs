import { defineAdapterTests } from "../testing/adapter.test-suite";
import { createMemoryAdapter } from "./memory-adapter";

defineAdapterTests({
  name: "Memory",
  factory: () => createMemoryAdapter(),
});
