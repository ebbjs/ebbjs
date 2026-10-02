import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";
import path from "path";

export default defineConfig({
  plugins: [tsconfigPaths()],
  // Resolve `@ebbjs/client` to source rather than the last-built bundle,
  // matching packages/codemirror. Tests should exercise the client the
  // workspace is editing, not whatever `dist/` happened to survive a rebase.
  resolve: {
    alias: {
      "@ebbjs/client": path.resolve(__dirname, "../client/src/index.ts"),
    },
  },
  test: {
    globals: true,
    environment: "happy-dom",
    include: ["src/**/__tests__/**/*.test.ts", "src/**/__tests__/**/*.test.tsx"],
  },
});
