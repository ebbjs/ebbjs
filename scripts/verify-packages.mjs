#!/usr/bin/env node
/**
 * Verifies what npm would actually receive for every public package
 * (issue #565). Tests run against workspace `dist/`, so this is the only
 * place that checks the packed artifact: manifest metadata, the file
 * whitelist, `workspace:` rewriting, `exports` targets, declaration-file
 * module resolution, and that a clean project can install, import, and
 * type-check the tarballs.
 *
 * Run after `pnpm build`:
 *   pnpm verify:packages
 *
 * Fails with a list of problems and exit code 1.
 */
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES_DIR = join(ROOT, "packages");
const LICENSE = readFileSync(join(ROOT, "LICENSE.txt"), "utf8");
const TSC = createRequire(import.meta.url).resolve("typescript/bin/tsc");

const EXPECTED_PUBLISHED = [
  "@ebbjs/core",
  "@ebbjs/storage",
  "@ebbjs/client",
  "@ebbjs/react",
  "@ebbjs/codemirror",
];
const EXPECTED_PRIVATE = ["@ebbjs/server", "@ebbjs/www"];

/** Entry points exercised by the clean-project smoke test. */
const RUNTIME_ENTRY_POINTS = [
  "@ebbjs/core",
  "@ebbjs/core/seed",
  "@ebbjs/storage/memory",
  "@ebbjs/storage/indexeddb",
  "@ebbjs/storage/replica",
  "@ebbjs/client",
  "@ebbjs/react",
  "@ebbjs/codemirror",
];

const FORBIDDEN_IN_TARBALL = [
  {
    pattern: /(^|\/)(src|test|tests|__tests__|__snapshots__)\//,
    reason: "source or test directory",
  },
  { pattern: /\.(test|spec)\.[cm]?[jt]sx?$/, reason: "test file" },
  {
    pattern: /(^|\/)(test-utils|test-db|test-helpers|testing)\.[cm]?[jt]sx?$/,
    reason: "test support module",
  },
  { pattern: /(^|\/)benchmark\//, reason: "benchmark module" },
  {
    pattern: /(^|\/)(tsconfig|vite\.config|vitest\.config|playwright\.config)\.[cm]?[jt]s(on)?$/,
    reason: "build config",
  },
  { pattern: /\.tsbuildinfo$/, reason: "build cache" },
  {
    pattern: /\.d\.ts\.map$/,
    reason: "declaration map (the sources it points at are not shipped)",
  },
  { pattern: /(^|\/)\.env/, reason: "environment file" },
];

const problems = [];
const fail = (scope, message) => problems.push(`${scope}: ${message}`);
const passed = (scope, message) =>
  console.log(`  \u001b[32m\u2713\u001b[0m ${scope} \u2014 ${message}`);

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const isFile = (path) => existsSync(path) && statSync(path).isFile();
const isDir = (path) => existsSync(path) && statSync(path).isDirectory();

const run = (command, args, options = {}) => {
  const result = execFileSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: "pipe",
    ...options,
  });
  return result.trim();
};

const workspacePackages = () =>
  readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(PACKAGES_DIR, entry.name))
    .filter((dir) => isFile(join(dir, "package.json")))
    .map((dir) => ({
      dir,
      path: relative(ROOT, dir),
      manifest: readJson(join(dir, "package.json")),
    }));

/**
 * Flatten `exports` into `{ path, target }` pairs, plus the `main`/`types`
 * fields. `exports` targets must be relative (`.`-prefixed); the two manifest
 * fields are paths without that requirement.
 */
const exportTargets = (manifest) => {
  const targets = [];
  const walk = (value, path) => {
    if (typeof value === "string") targets.push({ path, target: value, mustBeRelative: true });
    else if (value && typeof value === "object") {
      for (const [condition, nested] of Object.entries(value)) walk(nested, `${path}.${condition}`);
    }
  };
  for (const [subpath, value] of Object.entries(manifest.exports ?? {})) walk(value, subpath);
  for (const field of ["main", "types"]) {
    if (manifest[field])
      targets.push({ path: field, target: manifest[field], mustBeRelative: false });
  }
  return targets;
};

const walkFiles = (dir) => {
  if (!isDir(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walkFiles(full) : [full];
  });
};

const checkPublishTargets = () => {
  const packages = workspacePackages();
  const published = packages
    .filter(({ manifest }) => manifest.private !== true)
    .map(({ manifest }) => manifest.name);
  const priv = packages
    .filter(({ manifest }) => manifest.private === true)
    .map(({ manifest }) => manifest.name);

  const missing = EXPECTED_PUBLISHED.filter((name) => !published.includes(name));
  const extra = published.filter((name) => !EXPECTED_PUBLISHED.includes(name));
  if (missing.length > 0) fail("publish set", `not publishable: ${missing.join(", ")}`);
  if (extra.length > 0) fail("publish set", `unexpectedly publishable: ${extra.join(", ")}`);
  const leaked = EXPECTED_PRIVATE.filter((name) => !priv.includes(name));
  if (leaked.length > 0) fail("publish set", `must stay private: ${leaked.join(", ")}`);

  return packages.filter(({ manifest }) => EXPECTED_PUBLISHED.includes(manifest.name));
};

const checkManifest = ({ path, manifest }) => {
  const scope = manifest.name;

  if (!EXPECTED_PUBLISHED.includes(manifest.name)) {
    if (manifest.private !== true) fail(scope, `private package must set "private": true`);
    return;
  }

  const required = {
    version: (value) => /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(value ?? ""),
    description: (value) => typeof value === "string" && value.length > 0,
    license: (value) => value === "Apache-2.0",
    homepage: (value) => typeof value === "string" && value.startsWith("https://"),
    "repository.directory": () => manifest.repository?.directory === path,
    "repository.url": () => manifest.repository?.url === "git+https://github.com/ebbjs/ebbjs.git",
    "bugs.url": () => manifest.bugs?.url === "https://github.com/ebbjs/ebbjs/issues",
    "engines.node": (value) => typeof value === "string" && value.length > 0,
    files: (value) => Array.isArray(value) && value.includes("dist"),
    "publishConfig.access": () => manifest.publishConfig?.access === "public",
    sideEffects: (value) => value === false,
  };

  for (const [field, valid] of Object.entries(required)) {
    const value = field.split(".").reduce((node, key) => node?.[key], manifest);
    if (!valid(value)) fail(scope, `package.json ${field} is ${JSON.stringify(value)}`);
  }
  if (Object.keys(manifest.exports ?? {}).length === 0)
    fail(scope, "package.json exports is empty");
  if (manifest.private !== false)
    fail(scope, `private must be false, got ${JSON.stringify(manifest.private)}`);
};

const pack = ({ manifest }) => {
  const target = mkdtempSync(join(tmpdir(), `ebb-pack-${manifest.name.replace(/[@/]/g, "-")}-`));
  run("pnpm", ["--filter", manifest.name, "pack", "--pack-destination", target]);
  const tarball = readdirSync(target).find((name) => name.endsWith(".tgz"));
  if (!tarball) throw new Error(`pnpm pack produced no tarball for ${manifest.name}`);
  return { tarball: join(target, tarball), target };
};

const extract = (tarball) => {
  const dir = mkdtempSync(join(tmpdir(), "ebb-unpack-"));
  run("tar", ["-xzf", tarball, "-C", dir]);
  return { dir, packageDir: join(dir, "package") };
};

const checkTarballContents = ({ manifest }, unpacked) => {
  const scope = manifest.name;
  const files = walkFiles(unpacked).map((file) => relative(unpacked, file));

  for (const file of files) {
    const top = file.split("/")[0];
    const allowed =
      top === "dist" ||
      top === "package.json" ||
      top === "README.md" ||
      /^LICENSE(\.\w+)?$/.test(top);
    if (!allowed) fail(scope, `unexpected file in tarball: ${file}`);
    for (const { pattern, reason } of FORBIDDEN_IN_TARBALL) {
      if (pattern.test(file)) fail(scope, `${reason} in tarball: ${file}`);
    }
  }

  if (!files.includes("README.md")) fail(scope, "tarball is missing README.md");
  const licenseFile = files.find((file) => /^LICENSE(\.\w+)?$/.test(file));
  if (licenseFile === undefined) fail(scope, "tarball is missing LICENSE.txt");
  else if (readFileSync(join(unpacked, licenseFile), "utf8") !== LICENSE) {
    fail(scope, `${licenseFile} does not match the repository LICENSE.txt`);
  }
  if (!files.some((file) => file.startsWith("dist/"))) fail(scope, "tarball is missing dist/");
};

const checkPackedManifest = ({ manifest }, unpacked) => {
  const scope = manifest.name;
  const packed = readJson(join(unpacked, "package.json"));
  const siblings = workspacePackages();

  if (packed.private === true) fail(scope, "packed manifest is private");
  const serialized = JSON.stringify(packed);
  if (serialized.includes("workspace:"))
    fail(scope, "packed manifest still contains a workspace: range");

  for (const field of [
    "dependencies",
    "peerDependencies",
    "optionalDependencies",
    "devDependencies",
  ]) {
    for (const [name, range] of Object.entries(packed[field] ?? {})) {
      if (!name.startsWith("@ebbjs/")) continue;
      const sibling = siblings.find((entry) => entry.manifest.name === name);
      if (!sibling) continue;
      if (field !== "devDependencies" && sibling.manifest.private === true) {
        fail(scope, `${field} depends on the private workspace package ${name}`);
      }
      if (!String(range).includes(sibling.manifest.version)) {
        fail(
          scope,
          `${field} ${name} is "${range}", expected the published ${sibling.manifest.version}`,
        );
      }
    }
  }
};

const checkExportTargets = ({ manifest }, unpacked) => {
  const scope = manifest.name;
  const targets = exportTargets(manifest);
  if (targets.length === 0) fail(scope, "no exports/main/types targets to verify");

  for (const { path, target, mustBeRelative } of targets) {
    if (!target.startsWith("./")) {
      if (mustBeRelative) fail(scope, `export ${path} target "${target}" is not a relative path`);
      else if (!isFile(join(unpacked, target))) {
        fail(scope, `package.json ${path} target ${target} is missing from the tarball`);
      }
      continue;
    }
    if (!isFile(join(unpacked, target.slice(2)))) {
      fail(scope, `export ${path} target ${target} is missing from the tarball`);
    }
  }
};

/**
 * Bundled declarations must be self-contained: a relative specifier would only
 * resolve under the resolution mode the declarations were emitted for, which is
 * the failure `node16` consumers hit.
 */
const checkDeclarationSelfContained = ({ manifest }, unpacked) => {
  const scope = manifest.name;
  const specifierPattern = /(\bfrom\s*|\bimport\(\s*)(["'])(\.[^"']*)\2/g;
  const declarations = walkFiles(join(unpacked, "dist")).filter((file) => file.endsWith(".d.ts"));

  if (declarations.length === 0) fail(scope, "tarball has no .d.ts files");
  for (const file of declarations) {
    const source = readFileSync(file, "utf8");
    for (const [, , , specifier] of source.matchAll(specifierPattern)) {
      fail(
        scope,
        `${relative(unpacked, file)} imports "${specifier}"; declaration bundles must be self-contained`,
      );
    }
  }
};

const checkLinters = ({ manifest }, tarball) => {
  const scope = manifest.name;
  try {
    run("pnpm", ["exec", "publint", tarball]);
  } catch (error) {
    fail(scope, `publint failed:\n${error.stdout ?? error.message}`);
  }
  try {
    // `node16` enforces node16-from-ESM, node16-from-CJS, and bundler
    // resolution; the packages are ESM-only by design, so the CJS/ESM interop
    // warning is the one expected problem and the only one ignored.
    run("pnpm", [
      "exec",
      "attw",
      tarball,
      "--profile",
      "node16",
      "--ignore-rules",
      "cjs-resolves-to-esm",
    ]);
  } catch (error) {
    fail(scope, `attw failed:\n${error.stdout ?? error.message}`);
  }
};

const SMOKE_ENTRIES = `import { buildSeedAction } from "@ebbjs/core/seed";
import type { Action, Entity } from "@ebbjs/core";
import type { Action as SeedAction } from "@ebbjs/core/seed";
import type { StorageAdapter } from "@ebbjs/storage";
import { createMemoryAdapter } from "@ebbjs/storage/memory";
import { createIndexedDBAdapter } from "@ebbjs/storage/indexeddb";
import { createReplica, holdAll } from "@ebbjs/storage/replica";
import type { Replica } from "@ebbjs/storage/types";
import type { Replica as ReplicaEntry } from "@ebbjs/storage/replica";
import { createClient } from "@ebbjs/client";
import { EbbProvider } from "@ebbjs/react";
import { createBridgeExtension } from "@ebbjs/codemirror";

// Referencing every entry point makes the type-check resolve each one.
export const publicApi = {
  buildSeedAction,
  createMemoryAdapter,
  createIndexedDBAdapter,
  createReplica,
  holdAll,
  createClient,
  EbbProvider,
  createBridgeExtension,
} as const;

export type Row = Entity;
export type Storage = StorageAdapter;

// Each entry ships its own bundle, so a declaration shared by two entries must
// still be one type. These assignments stop compiling if the bundler forks it.
export const actionIdentity: Action = null as unknown as SeedAction;
export const replicaIdentity: Replica = null as unknown as ReplicaEntry;
`;

const smokeTsconfig = (module, moduleResolution) => ({
  compilerOptions: {
    target: "es2022",
    lib: ["es2022", "dom", "dom.iterable"],
    module,
    moduleResolution,
    strict: true,
    noEmit: true,
    skipLibCheck: false,
    types: [],
  },
  include: ["entries.ts"],
});

/**
 * Install the tarballs into a directory that shares nothing with the
 * workspace, then import and type-check every public entry point. pnpm
 * resolves sibling ranges from the registry, so `overrides` points them at
 * the tarballs under test.
 */
const runSmokeTest = (packs) => {
  const scope = "clean project";
  const dir = mkdtempSync(join(tmpdir(), "ebb-smoke-"));
  const overrides = Object.fromEntries(
    packs.map(({ tarball, manifest }) => {
      const copied = join(dir, `${manifest.name.replace(/[@/]/g, "-")}.tgz`);
      copyFileSync(tarball, copied);
      return [manifest.name, `file:./${relative(dir, copied)}`];
    }),
  );
  const dependencies = Object.fromEntries(
    packs.map(({ manifest }) => [
      manifest.name,
      `file:./${manifest.name.replace(/[@/]/g, "-")}.tgz`,
    ]),
  );

  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name: "ebb-smoke",
        private: true,
        type: "module",
        dependencies,
        devDependencies: {
          "@codemirror/state": "^6",
          "@codemirror/view": "^6",
          "@types/react": "^19",
          codemirror: "^6",
          idb: "^8",
          react: "^19",
        },
      },
      null,
      2,
    ),
  );
  // Sibling ranges name unpublished versions, so point them at the tarballs.
  // pnpm 10 reads overrides from the workspace file, not package.json.
  writeFileSync(
    join(dir, "pnpm-workspace.yaml"),
    [
      "overrides:",
      ...Object.entries(overrides).map(
        ([name, range]) => `  ${JSON.stringify(name)}: ${JSON.stringify(range)}`,
      ),
      "",
    ].join("\n"),
  );
  writeFileSync(join(dir, "entries.ts"), SMOKE_ENTRIES);
  writeFileSync(
    join(dir, "tsconfig.node16.json"),
    JSON.stringify(smokeTsconfig("node16", "node16"), null, 2),
  );
  writeFileSync(
    join(dir, "tsconfig.bundler.json"),
    JSON.stringify(smokeTsconfig("esnext", "bundler"), null, 2),
  );

  try {
    run("pnpm", ["install", "--ignore-scripts", "--config.confirmModulesPurge=false"], {
      cwd: dir,
    });
  } catch (error) {
    fail(scope, `install failed:\n${error.stdout ?? ""}${error.stderr ?? error.message}`);
    return dir;
  }

  const specifiers = JSON.stringify(RUNTIME_ENTRY_POINTS);
  try {
    run(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `for (const specifier of ${specifiers}) { await import(specifier); }`,
      ],
      { cwd: dir },
    );
  } catch (error) {
    fail(scope, `importing the public entry points failed:\n${error.stderr ?? error.message}`);
  }

  for (const config of ["tsconfig.node16.json", "tsconfig.bundler.json"]) {
    try {
      run(process.execPath, [TSC, "-p", config], {
        cwd: dir,
      });
    } catch (error) {
      fail(scope, `type-check with ${config} failed:\n${error.stdout ?? error.message}`);
    }
  }

  return dir;
};

const main = () => {
  const publicPackages = checkPublishTargets();
  for (const entry of workspacePackages()) checkManifest(entry);
  console.log(`Checked metadata for ${workspacePackages().length} workspace packages.`);

  const packs = [];
  const unpackedDirs = [];
  for (const entry of publicPackages) {
    const before = problems.length;
    if (!isDir(join(entry.dir, "dist"))) {
      fail(entry.manifest.name, "no dist/ — run `pnpm build` first");
      continue;
    }

    let packed;
    let unpacked;
    try {
      packed = pack(entry);
      unpacked = extract(packed.tarball);
    } catch (error) {
      fail(entry.manifest.name, `could not pack or unpack: ${error.stderr ?? error.message}`);
      continue;
    }
    packs.push({ ...packed, manifest: entry.manifest });
    unpackedDirs.push(unpacked.dir);

    checkTarballContents(entry, unpacked.packageDir);
    checkPackedManifest(entry, unpacked.packageDir);
    checkExportTargets(entry, unpacked.packageDir);
    checkDeclarationSelfContained(entry, unpacked.packageDir);
    checkLinters(entry, packed.tarball);

    if (problems.length === before)
      passed(entry.manifest.name, "tarball contents, exports, types, publint, attw");
  }

  if (packs.length === publicPackages.length) {
    const before = problems.length;
    const smokeDir = runSmokeTest(packs);
    if (problems.length === before)
      passed("clean project", "install, runtime imports, node16 + bundler type-check");
    rmSync(smokeDir, { recursive: true, force: true });
  }

  for (const dir of [...packs.map((pack) => pack.target), ...unpackedDirs]) {
    rmSync(dir, { recursive: true, force: true });
  }

  if (problems.length > 0) {
    console.error(`\n\u001b[31m${problems.length} packaging problem(s):\u001b[0m`);
    for (const problem of problems) console.error(`  \u2022 ${problem}`);
    process.exit(1);
  }
  console.log("\nAll public packages are publishable.");
};

main();
