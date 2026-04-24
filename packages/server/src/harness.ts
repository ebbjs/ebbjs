import { spawn } from "child_process";
import { mkdirSync, existsSync } from "fs";
import { join } from "path";
import { ServerOptions, RunningServer } from "./types";

const RELEASE_BIN = join(__dirname, "../dist/ebb_server/bin/ebb_server");
const DEFAULT_PORT = 4000;
const READY_TIMEOUT_MS = 120_000;
const SHUTDOWN_GRACE_MS = 5_000;

export type { ServerOptions, RunningServer };

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const { dataDir, port = DEFAULT_PORT, env = {} } = opts;

  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  const url = `http://localhost:${port}`;

  console.error("[harness] spawning server:", RELEASE_BIN);
  const child = spawn(RELEASE_BIN, ["start"], {
    env: { ...process.env, ...env, EBB_DATA_DIR: dataDir, EBB_PORT: String(port) },
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

    waitForReady(url, READY_TIMEOUT_MS)
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

export async function waitForReady(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  console.error("[harness] waitForReady starting, URL:", url, "timeout:", timeoutMs);

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/entities/non-existent-readiness-check`, {
        headers: { "x-ebb-actor-id": "readiness-check" },
      });
      console.error("[harness] got response status:", res.status);
      if (res.status === 404) {
        return;
      }
    } catch (e) {
      // connection refused, server not up yet
      if (Date.now() % 5000 < 200) {
        console.error("[harness] connection attempt failed:", (e as Error).message);
      }
    }

    await new Promise((r) => setTimeout(r, 100));
  }

  throw new Error(`Server did not become ready within ${timeoutMs}ms`);
}
