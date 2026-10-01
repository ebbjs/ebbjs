import { defineCursorStoreTests } from "../testing/cursor-store.test-suite";
import { createMemoryCursorStore } from "./cursor-store.memory";

defineCursorStoreTests({
  name: "Memory",
  factory: () => createMemoryCursorStore(),
});
