import { test, expect, applyTestConfig } from "./helpers";
import { spawn, type ChildProcess } from "child_process";
import { RELEASE_BIN_PATH } from "@ebbjs/server";
import { existsSync, mkdirSync } from "fs";

/**
 * Connection-state transitions — kill the server, watch the badge
 * transition through `reconnecting` → `offline`; restart the server,
 * watch the badge return to `live`.
 *
 * ## Why a test seam?
 *
 * The SyncClient's reconnect backoff defaults to 1s initial, doubling
 * to a 60s cap, with a max of 10 attempts. That's ~4 minutes of CI
 * time to reach `offline` — too slow for a per-PR test.
 *
 * The bootstrap reads `window.__EBB_DEMO_TEST_CONFIG__.reconnectInitialMs`
 * and `.reconnectMaxMs` and passes them through to
 * `SyncClient.createClient({...})`. Both tabs in this spec set them
 * to small values so the transitions complete in seconds.
 *
 * ## Lifecycle caveats
 *
 * The `ebb_server start` command runs the BEAM VM as a foreground
 * child process that Playwright tracks as a `webServer` entry. When
 * a test kills the BEAM (via `lsof` lookup on :4000), Playwright
 * doesn't know — it considers the webServer "running" until the
 * port check fails or the suite ends.
 *
 * To bring the server back, the test spawns a fresh BEAM with the
 * SAME `EBB_DATA_DIR` so the on-disk RocksDB + SQLite state survives
 * the restart. The webServer URL check (`/sync/handshake`) then
 * starts responding again and the SSE reconnection succeeds.
 *
 * The data dir layout matches the `webServer` command in
 * `playwright.config.ts` (`/tmp/ebb-playwright-data`). Tests outside
 * this spec don't touch that dir, so the kill/restart cycle is
 * safe.
 *
 * ## Single-worker requirement
 *
 * The Playwright config runs with `workers: 1` in CI so other tests
 * in the same suite don't get a half-killed server. This spec does
 * NOT need the `webServer.command` to be re-run between tests — the
 * server we start inside this spec is a separate child process from
 * the webServer, but it shares the same port + data dir.
 */

const DATA_DIR = "/tmp/ebb-playwright-data";
const PORT = 4000;
const BASE_URL = `http://localhost:${PORT}`;

/** Start a fresh ebb_server BEAM. Does NOT recreate the data dir. */
function startServer(): ChildProcess {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
  const proc = spawn(RELEASE_BIN_PATH, ["start"], {
    env: {
      ...process.env,
      EBB_DATA_DIR: DATA_DIR,
      EBB_PORT: String(PORT),
    },
    stdio: "ignore",
    detached: false,
  });
  return proc;
}

/**
 * Poll `/sync/handshake` until it responds 2xx (any non-500 response
 * is fine — handshake rejects unknown actors with 4xx, but the
 * server being up is what we care about). Returns true if the
 * server became ready within `timeoutMs`.
 */
async function waitForReady(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/sync/handshake`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-ebb-actor-id": "ready-check",
        },
        body: "{}",
      });
      // The server is up if it responds at all (even a 4xx means it's
      // processing requests — the alternative is ECONNREFUSED).
      if (res.status < 500) return true;
    } catch {
      // connection refused — keep polling
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/** Kill whatever process is bound to the given TCP port. Returns true if a process was killed. */
async function killProcessOnPort(port: number): Promise<boolean> {
  // Use `lsof` to find the pid listening on the port, then SIGKILL
  // it. `lsof` is available on macOS and Linux; CI runs Ubuntu.
  const { exec } = await import("child_process");
  return new Promise((resolve) => {
    exec(`lsof -ti tcp:${port}`, (err, stdout) => {
      if (err || !stdout.trim()) {
        resolve(false);
        return;
      }
      const pids = stdout.trim().split("\n").filter(Boolean);
      const followups = pids.map(
        (pid) =>
          new Promise<void>((res) => {
            exec(`kill -9 ${pid}`, () => res());
          }),
      );
      Promise.all(followups).then(() => resolve(true));
    });
  });
}

test.describe("connection state transitions", () => {
  test("kill server → reconnecting → offline; restart → live", async ({ browser }) => {
    // Apply the test config BEFORE navigation so bootstrap() picks
    // up the shortened backoff. Both tabs need it.
    const ctx = await browser.newContext();
    const aliceCtx = await browser.newContext();
    await applyTestConfig(ctx, { reconnectInitialMs: 200, reconnectMaxMs: 500 });
    await applyTestConfig(aliceCtx, { reconnectInitialMs: 200, reconnectMaxMs: 500 });

    const page = await ctx.newPage();
    const alicePage = await aliceCtx.newPage();
    await page.goto("/?actor=drew");
    await alicePage.goto("/?actor=alice");

    // Both tabs reach "live" against the webServer-managed ebb_server.
    await expect(page.getByText("live").first()).toBeVisible({ timeout: 30_000 });
    await expect(alicePage.getByText("live").first()).toBeVisible({ timeout: 30_000 });

    // Kill the server. The SyncClient should detect the drop within
    // the SSE iterator's next-promise reject window and transition to
    // "reconnecting".
    const killed = await killProcessOnPort(PORT);
    expect(killed).toBe(true);

    // With the 200ms initial backoff, the first reconnect attempt
    // fails fast → "reconnecting" badge appears. Both tabs.
    await expect(page.getByText("reconnecting").first()).toBeVisible({ timeout: 10_000 });
    await expect(alicePage.getByText("reconnecting").first()).toBeVisible({ timeout: 10_000 });

    // With reconnectMaxMs=500 and the doubling schedule capped at 500ms,
    // the 10 attempts exhaust in roughly 5 seconds (200+400+500+500+...).
    // After exhausting, the state machine transitions to "offline".
    await expect(page.getByText("offline").first()).toBeVisible({ timeout: 20_000 });
    await expect(alicePage.getByText("offline").first()).toBeVisible({ timeout: 20_000 });

    // Restart the server on the same port with the same data dir.
    const child = startServer();
    // Detach so the test process doesn't block on the child's stdio.
    child.unref?.();

    // Wait for the server to be ready before expecting reconnection.
    const ready = await waitForReady(30_000);
    expect(ready).toBe(true);

    // Both tabs should reconnect — once an SSE chunk arrives the
    // state machine flips back to "live".
    await expect(page.getByText("live").first()).toBeVisible({ timeout: 30_000 });
    await expect(alicePage.getByText("live").first()).toBeVisible({ timeout: 30_000 });

    await ctx.close();
    await aliceCtx.close();
  });
});
