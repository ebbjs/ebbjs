import { spawn } from "child_process";
import { mkdirSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { ReadyCheck, ServerOptions, RunningServer } from "./types";

// ESM-safe equivalent of `__dirname` for the file this runs from. It resolves
// the same path from `src/` and from the built `dist/`, so the constant is the
// package's one answer to "where is the release".
const __dirname = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the bundled `ebb_server` release binary. */
export const RELEASE_BIN_PATH = join(__dirname, "../dist/ebb_server/bin/ebb_server");

const DEFAULT_PORT = 4000;
/** How long a server gets to start before `startServer` gives up. */
export const DEFAULT_READY_TIMEOUT_MS = 120_000;
const SHUTDOWN_GRACE_MS = 5_000;
/** How long the probe waits between attempts. */
const READY_POLL_INTERVAL_MS = 100;
/** At most one "still not up" line per window, however many attempts fail. */
const FAILURE_LOG_INTERVAL_MS = 5_000;

/**
 * The default readiness probe: a route the server routes but holds no entity
 * for, so a 404 proves it is serving without touching the data directory.
 */
export const DEFAULT_READY_CHECK: ReadyCheck = {
  path: "/entities/non-existent-readiness-check",
  expectedStatus: 404,
};

export type { ServerOptions, ReadyCheck, RunningServer };

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const { dataDir, port = DEFAULT_PORT, env = {}, readyCheck = DEFAULT_READY_CHECK } = opts;

  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  const url = `http://localhost:${port}`;

  console.error("[harness] spawning server:", RELEASE_BIN_PATH);
  // This harness is a dev/test tool, so it defaults the release to bypass
  // auth; prod releases require real auth configuration. An explicit
  // EBB_AUTH_MODE in `env` still overrides the default.
  const child = spawn(RELEASE_BIN_PATH, ["start"], {
    env: {
      ...process.env,
      EBB_AUTH_MODE: "bypass",
      // The harness exercises sync; the release defaults functions on and this
      // environment may not have Bun. A caller can opt back in through `env`.
      EBB_FUNCTIONS_ENABLED: "false",
      ...env,
      EBB_DATA_DIR: dataDir,
      EBB_PORT: String(port),
    },
    stdio: "pipe",
  });
  console.error("[harness] spawned process with pid:", child.pid);

  let killed = false;

  const kill = async (): Promise<void> => {
    if (killed) return;
    killed = true;

    return new Promise((resolve) => {
      child.once("exit", () => resolve());

      child.kill("SIGTERM");

      setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
        resolve();
      }, SHUTDOWN_GRACE_MS);
    });
  };

  return new Promise((resolve, reject) => {
    const rejectOnce = (err: Error) => {
      kill().catch(() => {});
      reject(err);
    };

    child.on("error", rejectOnce);

    child.stderr?.on("data", (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (line) console.error("[ebb_server stderr]", line);
    });

    child.on("exit", (code) => {
      if (code !== null && code !== 0 && !killed) {
        rejectOnce(new Error(`ebb_server exited with code ${code}`));
      }
    });

    waitForReady(url, DEFAULT_READY_TIMEOUT_MS, readyCheck)
      .then(() => {
        console.error("[harness] server ready!");
        resolve({
          pid: child.pid!,
          port,
          url,
          dataDir,
          kill,
        });
      })
      .catch((err) => {
        console.error("[harness] waitForReady failed:", err.message);
        rejectOnce(err);
      });
  });
}

/** Poll `url`'s `readyCheck` until it answers, or throw once `timeoutMs` passes. */
export async function waitForReady(
  url: string,
  timeoutMs = DEFAULT_READY_TIMEOUT_MS,
  readyCheck: ReadyCheck = DEFAULT_READY_CHECK,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  console.error("[harness] waitForReady starting, URL:", url, "timeout:", timeoutMs);

  let lastFailureLogAt = 0;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}${readyCheck.path}`, {
        headers: { "x-ebb-actor-id": "readiness-check" },
      });
      if (res.status === readyCheck.expectedStatus) return;
      console.error("[harness] got response status:", res.status);
    } catch (e) {
      // Connection refused: the release has not bound its port yet. The first
      // attempt logs, then at most one line per FAILURE_LOG_INTERVAL_MS, so a
      // slow start cannot bury the harness's own output.
      const now = Date.now();
      if (now - lastFailureLogAt >= FAILURE_LOG_INTERVAL_MS) {
        lastFailureLogAt = now;
        console.error("[harness] connection attempt failed:", (e as Error).message);
      }
    }

    await new Promise((r) => setTimeout(r, READY_POLL_INTERVAL_MS));
  }

  throw new Error(`Server did not become ready within ${timeoutMs}ms`);
}
