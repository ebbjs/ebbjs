import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for the collaborative-text demo's e2e suite.
 *
 * The suite wires up two long-lived processes via `webServer`:
 *
 *   1. `ebb_server` — a release build at `packages/server/dist/ebb_server`,
 *      started on port 4000. Reuses the artifact already produced by the
 *      `elixir-release` job (see `ci.yml`). Each test run gets a fresh
 *      data dir so previous runs don't pollute the demo state.
 *
 *   2. `pnpm --filter collaborative-text-demo dev` — vite dev server on
 *      port 5173, proxying `/sync` and `/entities` to the local
 *      `ebb_server`. Matches the developer workflow documented in the
 *      demo's README.
 *
 * Both `webServer` entries use `command` + `url` so Playwright waits for
 * readiness (HTTP 200 on the URL) before starting the suite, and
 * `reuseExistingServer: !process.env.CI` so local dev can launch the
 * servers manually and skip Playwright's startup overhead.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? "github" : "list",
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  use: {
    baseURL: "http://localhost:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: [
    {
      command: `rm -rf /tmp/ebb-playwright-data && mkdir -p /tmp/ebb-playwright-data && EBB_DATA_DIR=/tmp/ebb-playwright-data ./packages/server/dist/ebb_server/bin/ebb_server start`,
      url: "http://localhost:4000/sync/handshake",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      stdout: "ignore",
      stderr: "pipe",
    },
    {
      command: "pnpm dev",
      url: "http://localhost:5173",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      stdout: "ignore",
      stderr: "pipe",
    },
  ],
});
