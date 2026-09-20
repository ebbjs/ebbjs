import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";
import path from "path";

export default defineConfig({
  plugins: [tsconfigPaths()],
  // Resolve `@ebbjs/client` to the source TypeScript entry rather than
  // the bundled `dist/index.js`. Without this, tests run against whatever
  // version of the bundle was last produced by `pnpm build`. After a
  // rebase that drops commits, source and bundle drift apart and tests
  // silently run against stale behavior — the failure mode we hit when
  // a rebase dropped `b68f0ed` (the HLC ordering check): the bundle
  // still had it, source didn't, so a test using HLC="3000" against a
  // Date.now()-sourced run hlc was rejected by the bundle and passed
  // the source.
  resolve: {
    alias: {
      "@ebbjs/client": path.resolve(__dirname, "../client/src/index.ts"),
    },
  },
  test: {
    globals: true,
    environment: "happy-dom",
    include: ["src/**/__tests__/**/*.test.ts", "src/**/*.test.ts"],
  },
});
