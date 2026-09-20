import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Resolves to <repo>/packages/server/dist/ebb_server/bin/ebb_server,
// independent of where Playwright invokes the webServer command from
// (which is this config file's directory, i.e. the demo package).
const ebbServerBin = resolve(__dirname, "../../../packages/server/dist/ebb_server/bin/ebb_server");

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
      command: `echo "BEFORE WEBSERVER CMD: cwd=$(pwd)"; echo "BEFORE: dist contents:"; ls -la packages/server/dist/ 2>&1 || true; ls -la packages/server/dist/ebb_server/ 2>&1 || true; ls -la packages/server/dist/ebb_server/bin/ 2>&1 || true; echo "Parent of expected bin:"; ls -la "$(dirname ${ebbServerBin})" 2>&1 || true; ls -la "$(dirname ${ebbServerBin})/.." 2>&1 || true; rm -rf /tmp/ebb-playwright-data && mkdir -p /tmp/ebb-playwright-data && (test -x ${ebbServerBin} || { echo "ebb_server binary missing or not executable: ${ebbServerBin}"; ls -la ${ebbServerBin} 2>&1 || true; ls -la "$(dirname ${ebbServerBin})" 2>&1 || true; exit 127; }) && EBB_DATA_DIR=/tmp/ebb-playwright-data ${ebbServerBin} start`,
      url: "http://localhost:4000/sync/handshake",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      stdout: "pipe",
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
