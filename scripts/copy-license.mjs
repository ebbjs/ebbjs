#!/usr/bin/env node
// Each package publishes from its own directory, and npm's `files` whitelist
// cannot reach a parent directory, so the repository licence has to sit beside
// the manifest at pack time. Run from the package directory (`prepack` does
// this); the copy is gitignored, and unchanged copies are not rewritten so a
// repeated pack stays byte-identical.
import { copyFile, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const source = resolve(scriptDir, "..", "LICENSE.txt");
const target = join(process.cwd(), "LICENSE.txt");

const readOrNull = (path) => readFile(path, "utf8").catch(() => null);

const [rootLicense, packageLicense] = await Promise.all([readOrNull(source), readOrNull(target)]);

if (rootLicense === null) {
  console.error(`copy-license: ${source} is missing`);
  process.exitCode = 1;
} else if (rootLicense !== packageLicense) {
  await copyFile(source, target);
}
