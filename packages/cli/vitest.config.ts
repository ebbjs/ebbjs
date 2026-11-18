import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@ebbjs/server": path.resolve(__dirname, "../server/src/index.ts"),
    },
  },
  test: {
    environment: "node",
  },
});
