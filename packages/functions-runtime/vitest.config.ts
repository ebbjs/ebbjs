import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@ebbjs/client": path.resolve(__dirname, "../client/src/index.ts"),
      "@ebbjs/functions-protocol": path.resolve(__dirname, "../functions-protocol/src/index.ts"),
    },
  },
  test: {
    environment: "node",
  },
});
