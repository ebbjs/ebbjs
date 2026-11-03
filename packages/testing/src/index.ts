import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const RELEASE_BIN_PATH = join(__dirname, "../dist/ebb_server/bin/ebb_server");

export { startServer, waitForReady, type ServerOptions, type RunningServer } from "./harness";
export {
  seed,
  buildSeedAction,
  type GroupSeed,
  type GroupMemberSeed,
  type EntitySeed,
  type SeedData,
  type Action,
} from "./seed-client";
