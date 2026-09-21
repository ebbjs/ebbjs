import { defineConfig } from "vitest/config";

/**
 * Vitest config for the collaborative-text-demo package.
 *
 * Excludes the `e2e/` directory from vitest's test glob. Playwright owns
 * that directory (see `playwright.config.ts`) — its spec files use
 * `test.describe()` from `@playwright/test`, which is not vitest. If
 * vitest picks them up, it crashes with
 *
 *   Error: Playwright Test did not expect test.describe() to be called here.
 *
 * The `src/` directory is included explicitly so vitest still runs any
 * future unit tests added there.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
    exclude: ["node_modules", "dist", "e2e"],
  },
});
