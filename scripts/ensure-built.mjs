#!/usr/bin/env node
//
// Fail fast when the workspace hasn't been built.
//
// Tests import sibling work packages through their built `dist/` entry points
// (package.json `main` / `exports`), so skipping `pnpm build` otherwise shows
// up as a cryptic `vite:import-analysis` resolve error. This checks the
// runtime entries instead and points at the missing build step.
//
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Only `packages/*`: examples' `main` fields are placeholders, and nothing
// imports an example package at test time.
function workPackageDirs() {
  const base = path.join(root, "packages");
  return readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join("packages", entry.name))
    .filter((dir) => existsSync(path.join(root, dir, "package.json")));
}

// Collect every runtime target from `main` / `exports`, skipping type-only
// conditions (those are resolved by tsc, not the test runtime). Handles the
// string shorthand, nested conditions, and arrays.
function runtimeEntries(pkg) {
  const entries = new Set();
  const addEntry = (entry) => {
    if (typeof entry === "string") entries.add(entry.replace(/^\.\//, ""));
  };
  const walk = (value) => {
    if (typeof value === "string") addEntry(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") {
      for (const [condition, target] of Object.entries(value)) {
        if (condition !== "types") walk(target);
      }
    }
  };
  addEntry(pkg.main);
  walk(pkg.exports);
  return [...entries];
}

const missing = [];
for (const dir of workPackageDirs()) {
  const pkg = JSON.parse(readFileSync(path.join(root, dir, "package.json"), "utf8"));
  if (!pkg.scripts?.build) continue;
  for (const entry of runtimeEntries(pkg)) {
    const relativePath = path.join(dir, entry);
    if (!existsSync(path.join(root, relativePath))) {
      missing.push({ name: pkg.name ?? dir, relativePath });
    }
  }
}

if (missing.length > 0) {
  console.error("Build output required by the test suite is missing:\n");
  for (const { name, relativePath } of missing) console.error(`  ${relativePath}  (${name})`);
  console.error("\nRun `pnpm build` first — see CONTRIBUTING.md → Local setup.");
  process.exit(1);
}
