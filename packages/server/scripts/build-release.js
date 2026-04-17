/**
 * build-release.js
 *
 * Builds the Elixir ebb_server release and bundles it into the package dist.
 * Uses incremental build — skips mix release if source hasn't changed.
 */

import { existsSync, mkdirSync } from "fs";
import { execSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { cpSync, rmSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
const ebbServerDir = join(rootDir, "../../ebb_server");
const releaseSrc = join(ebbServerDir, "_build/prod/rel/ebb_server");
const releaseDest = join(rootDir, "dist/ebb_server");
const bundledBinary = join(releaseDest, "bin/ebb_server");

const exec = (cmd, opts = {}) => execSync(cmd, { encoding: "utf8", stdio: "inherit", ...opts });

const ensureDir = (dir) => {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
};

/**
 * Returns true if the bundled binary doesn't exist or any .ex source is newer.
 * Uses `find -newer` which is O(1) — fast even for large codebases.
 */
const sourceFilesChanged = () => {
  if (!existsSync(bundledBinary)) return true;

  try {
    const result = exec(
      `find "${join(ebbServerDir, "lib")}" -name "*.ex" -newer "${bundledBinary}" -print -quit`,
      { stdio: ["pipe", "pipe", "ignore"] },
    );
    return result.trim().length > 0;
  } catch {
    return true;
  }
};

/**
 * Returns true if mix.exs or mix.lock changed since last build.
 */
const configFilesChanged = () => {
  const files = [join(ebbServerDir, "mix.exs"), join(ebbServerDir, "mix.lock")];

  for (const file of files) {
    if (existsSync(file)) {
      try {
        const result = exec(`find "${file}" -newer "${bundledBinary}" -print -quit`, {
          stdio: ["pipe", "pipe", "ignore"],
        });
        if (result.trim().length > 0) return true;
      } catch {
        return true;
      }
    }
  }
  return false;
};

const needsBuild = () => {
  if (existsSync(releaseDest)) {
    try {
      exec("which mix", { stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      console.log("Elixir not available, using cached release artifact.");
      return false;
    }
    if (!sourceFilesChanged() && !configFilesChanged()) {
      return false;
    }
  }
  return true;
};

// Ensure dist directory exists
ensureDir(join(rootDir, "dist"));

// Copy existing release if no rebuild needed
if (!needsBuild()) {
  if (existsSync(releaseSrc) && !existsSync(releaseDest)) {
    console.log("Copying existing release (no source changes)...");
    cpSync(releaseSrc, releaseDest, { recursive: true });
  } else if (existsSync(releaseDest)) {
    console.log("Release up-to-date, using cached bundle.");
  }
  process.exit(0);
}

// Build fresh
console.log("Source changed, rebuilding...");
exec("mix release", { cwd: ebbServerDir });

// Copy to dist
if (existsSync(releaseDest)) {
  rmSync(releaseDest, { recursive: true, force: true });
}
cpSync(releaseSrc, releaseDest, { recursive: true });

console.log("Release bundled successfully.");
