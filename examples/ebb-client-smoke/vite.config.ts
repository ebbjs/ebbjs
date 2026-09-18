import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // Server-only deps: don't let vitest try to bundle them.
    server: {
      deps: {
        external: ["@ebbjs/server"],
      },
    },
  },
});
