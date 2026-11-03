import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@ebbjs/client": path.resolve(__dirname, "../client/src/index.ts"),
      "@ebbjs/core": path.resolve(__dirname, "../core/src/index.ts"),
      "@ebbjs/core/*": path.resolve(__dirname, "../core/src/*/index.ts"),
      "@ebbjs/functions-protocol": path.resolve(__dirname, "../functions-protocol/src/index.ts"),
      "@ebbjs/schema": path.resolve(__dirname, "../schema/src/index.ts"),
      "@ebbjs/write": path.resolve(__dirname, "../write/src/index.ts"),
    },
  },
  test: {
    environment: "node",
  },
});
