import { defineConfig } from "vitest/config";

/**
 * Unit tests for the issue-tracker seed helpers. The `e2e/` directory
 * (added by #445) is excluded — Playwright owns it, and vitest would
 * crash on its `@playwright/test` specs.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
    exclude: ["node_modules", "dist", "e2e"],
  },
});
