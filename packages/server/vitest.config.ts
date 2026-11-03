import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@ebbjs/client": path.resolve(__dirname, "../client/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    typecheck: {
      // The workspace packages are not built in the local/dev loop, so the
      // typecheck program reads their sources through `tsconfig.typecheck.json`.
      tsconfig: "./tsconfig.typecheck.json",
    },
  },
});
