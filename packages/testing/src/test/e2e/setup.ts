import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "@ebbjs/testing";
import type { RunningServer } from "@ebbjs/testing";

let server: RunningServer;

/**
 * A per-run data dir. A fixed one makes the second local run fail: the seed
 * re-creates `grp_001`, and a re-put of a committed group is not a bootstrap,
 * so the authorization refuses it. `EBB_SERVER_DATA_DIR` still pins one when a
 * caller wants to inspect it.
 */
const dataDir = process.env.EBB_SERVER_DATA_DIR ?? mkdtempSync(join(tmpdir(), "ebb-test-data-"));

beforeAll(async () => {
  server = await startServer({ dataDir, port: 4000 });
}, 60000);

afterAll(async () => {
  await server.kill();
  if (process.env.EBB_SERVER_DATA_DIR === undefined)
    rmSync(dataDir, { recursive: true, force: true });
});

export { server };
