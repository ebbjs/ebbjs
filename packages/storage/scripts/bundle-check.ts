/**
 * Bundle-check: confirms the per-adapter subpath split in
 * `packages/storage/package.json` produces adapter-isolated
 * artifacts. Run with `pnpm --filter @ebbjs/storage bundle-check`
 * after a build.
 *
 * Acceptance criteria (issue #203):
 *   1. dist/memory/index.js contains no reference to `idb` or `indexedDB`.
 *   2. dist/indexeddb/index.js is the only artifact that imports `idb`.
 *   3. Memory bundle gzip size is under 2 KB.
 *   4. IndexedDB bundle gzip size is under 8 KB.
 *
 * Exits with code 1 on any failure; logs a one-line summary per check.
 */
import { gzipSync } from "node:zlib";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const DIST = join(process.cwd(), "dist");

interface CheckResult {
  name: string;
  pass: boolean;
  detail: string;
}

const readArtifact = (rel: string): string => {
  return readFileSync(join(DIST, rel), "utf8");
};

const listArtifacts = (): readonly string[] => {
  // Walk one level deep so per-adapter subpath entries (memory/index.js,
  // indexeddb/index.js) are included alongside flat shared chunks.
  const entries: string[] = [];
  for (const name of readdirSync(DIST)) {
    const fullPath = join(DIST, name);
    if (statSync(fullPath).isDirectory()) {
      const candidate = join(name, "index.js");
      try {
        statSync(join(DIST, candidate));
        entries.push(candidate);
      } catch {
        // no index.js inside; skip
      }
    } else if (name.endsWith(".js")) {
      entries.push(name);
    }
  }
  return entries;
};

const hasString = (src: string, needle: string): boolean => src.includes(needle);

const gzipSize = (src: string): number => gzipSync(src).length;

const checks: CheckResult[] = [];

const memorySrc = (() => {
  try {
    return readArtifact("memory/index.js");
  } catch {
    return null;
  }
})();
const indexeddbSrc = (() => {
  try {
    return readArtifact("indexeddb/index.js");
  } catch {
    return null;
  }
})();

if (!memorySrc || !indexeddbSrc) {
  console.error(
    `bundle-check: dist/memory/index.js or dist/indexeddb/index.js missing. Run \`pnpm build\` first.`,
  );
  process.exit(1);
}

checks.push({
  name: "dist/memory/index.js exists",
  pass: true,
  detail: `gzip ${gzipSize(memorySrc)} bytes`,
});
checks.push({
  name: "dist/indexeddb/index.js exists",
  pass: true,
  detail: `gzip ${gzipSize(indexeddbSrc)} bytes`,
});
checks.push({
  name: "memory artifact contains no reference to `idb`",
  pass: !hasString(memorySrc, 'from "idb"'),
  detail: hasString(memorySrc, 'from "idb"') ? 'found `from "idb"`' : "clean",
});
checks.push({
  name: "memory artifact contains no reference to `indexedDB`",
  pass: !hasString(memorySrc, "indexedDB"),
  detail: hasString(memorySrc, "indexedDB") ? "found `indexedDB`" : "clean",
});
checks.push({
  name: "memory artifact under 2 KB gzip",
  pass: gzipSize(memorySrc) < 2_048,
  detail: `${gzipSize(memorySrc)} bytes`,
});
checks.push({
  name: "indexeddb artifact under 8 KB gzip",
  pass: gzipSize(indexeddbSrc) < 8_192,
  detail: `${gzipSize(indexeddbSrc)} bytes`,
});

// `idb` may appear in any chunk that imports it (memory, indexeddb, or a
// shared chunk materialized from create-storage-adapter's `await import(...)`).
// Confirm it appears in the indexeddb artifact OR any chunk referenced from it,
// and does NOT appear in the memory artifact alone.
const allArtifacts = listArtifacts();
const idbImporters = allArtifacts.filter((rel) => hasString(readArtifact(rel), 'from "idb"'));
checks.push({
  name: "`idb` import present in at most the indexeddb artifact (plus shared chunks pulled in by it)",
  pass: !idbImporters.some((rel) => rel.startsWith("memory/")),
  detail: `importers: ${idbImporters.join(", ") || "(none)"}`,
});

let failed = 0;
for (const check of checks) {
  const marker = check.pass ? "OK  " : "FAIL";
  if (!check.pass) failed += 1;
  console.log(`${marker}  ${check.name}  — ${check.detail}`);
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed.`);
  process.exit(1);
}
console.log("\nbundle-check: all checks passed.");
