import { defineConfig } from "vitest/config";

/**
 * The IndexedDB adapter needs `indexedDB` in the global scope. happy-dom
 * provides a working DOM but does NOT include an IndexedDB shim, so we
 * install `fake-indexeddb/auto` via a setup file. happy-dom is used as
 * the test environment because some plugins (vite-tsconfig-paths,
 * imports) resolve better against a DOM-like context. The in-memory
 * adapter is DOM-agnostic and runs unchanged under it.
 */
export default defineConfig({
  test: {
    environment: "happy-dom",
    setupFiles: ["./test-setup.ts"],
  },
});
