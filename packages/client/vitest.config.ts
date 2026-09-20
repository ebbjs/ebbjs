import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Integration tests talk to a real ebb_server over HTTP. Give them
    // generous timeouts; the default 5s is too tight for the seed +
    // addMember + write + catchUp dance each test runs.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: {
      src: path.resolve(__dirname, "./src"),
    },
  },
});
