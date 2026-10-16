import { defineConfig } from "vitest/config";

/**
 * Unit tests for the issue-tracker seed helpers. The `e2e/` directory
 * (added by #445) is excluded — Playwright owns it, and vitest would
 * crash on its `@playwright/test` specs. `*.integration.test.ts` talks
 * to a live ebb_server and is excluded by the `test` script's
 * `--exclude` (mirroring `packages/client`), so `pnpm test` stays green
 * without a server and `pnpm test:integration` can still see the file.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
    exclude: ["node_modules", "dist", "e2e"],
  },
});
