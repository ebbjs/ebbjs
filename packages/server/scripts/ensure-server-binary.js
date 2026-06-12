import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const releaseBinary = join(__dirname, "../dist/ebb_server/bin/ebb_server");

if (existsSync(releaseBinary)) {
  console.log("ebb_server release found.");
  process.exit(0);
} else {
  console.error("Error: ebb_server release not found at dist/ebb_server/bin/ebb_server");
  console.error("Run 'pnpm build:local' to build and copy it.");
  process.exit(1);
}
