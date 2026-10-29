# Experiment: bundled declarations for the published packages (issue #565)

**Question.** Are bundled `.d.ts` files a viable, contained fix for the published
artifacts — one self-contained declaration per runtime entry, no relative
specifiers, no source-mirroring `.d.ts`/`.d.ts.map` in the tarball?

**Answer: viable.** `rollup-plugin-dts` reproduces the current public type
surface exactly (0 symbols added, removed, or changed; 0 degradations to
`any`/`unknown`; no consumer-visible JSDoc loss), removes the `node16` failure
mode at the root instead of patching it, and shrinks every tarball. The cost is
one 123-line build script, two devDependencies, and ~1–1.8 s of declaration
post-processing per package.

---

## 1. Setup

```
git worktree add --detach /tmp/ebb-dtsbundle feat/issue-565-npm-release
cd /tmp/ebb-dtsbundle
pnpm install --ignore-scripts --frozen-lockfile
```

`--detach` because the branch is already checked out in the primary worktree;
the experiment never commits and never pushes.

Baseline captured first: `pnpm build:packages` + `pnpm verify:packages` pass on
untouched `feat/issue-565-npm-release` (26.9 s build, 16.4 s verify on an idle
machine), and the `dist/` trees and tarballs were snapshotted for comparison.

## 2. What was tried

| Option                                                     | Result                                                                                                                  |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `vite-plugin-dts` `rollupTypes: true` (api-extractor)      | Not tested — known to collapse `@ebbjs/core`'s two entries into one file and drop the main entry's exports.             |
| **`rollup-plugin-dts@6.5.1`** (rollup, one pass per entry) | **Worked on the first try.** No per-package config: entries are read from each package's own `exports`/`types` targets. |
| `dts-bundle-generator` (CLI)                               | Not needed.                                                                                                             |

`rollup-plugin-dts` runs on the declarations `vite-plugin-dts` already emits, so
nothing about the existing dts stage changes; it is a post-processing step in
the same shape as the `fix-dts-extensions.mjs` call it replaces.

## 3. The change (copy-pasteable)

### 3.1 devDependencies (repo root)

```
pnpm add -Dw rollup-plugin-dts@^6.5.1 rollup@4.59.0
```

- `rollup` is pinned to `4.59.0` — the version `vite`/`vite-plugin-dts` already
  resolve — so the plugin shares that copy instead of installing a second one.
  (`pnpm why rollup` shows it was already a transitive dependency; adding it
  directly costs no new tarball.)
- Net new packages: **4** (`rollup-plugin-dts`, plus its optional
  `@babel/code-frame@8.0.6` → `@babel/helper-validator-identifier@8.0.6` →
  `js-tokens@10.0.0`). `rollup-plugin-dts` is 340 KB unpacked / 8 files; the
  three optional ones are ~12 KB each. `@jridgewell/remapping`,
  `@jridgewell/sourcemap-codec`, `convert-source-map`, `magic-string` were
  already in the tree.
- `pnpm-lock.yaml`: **+51 lines**.

### 3.2 `scripts/bundle-dts.mjs` (new, 123 lines)

```js
#!/usr/bin/env node
/**
 * Collapses the per-module declarations `vite-plugin-dts` emits into one
 * self-contained `.d.ts` per published entry. The emitted graph mirrors the
 * source tree and links modules with relative specifiers, which a `node16`
 * consumer cannot resolve; bundling leaves bare external imports only and
 * removes the declaration and declaration-map files the entry files subsume
 * (issue #565).
 *
 * Entries come from the package's own `exports`/`types` targets, so a new
 * subpath needs no configuration here. Runs after `vite build` on `dist`
 * output only, never on sources.
 *
 * Run from the package directory, after the build.
 */
import { readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { rollup } from "rollup";
import { dts } from "rollup-plugin-dts";

const PACKAGE_DIR = process.cwd();
const DIST = resolve(PACKAGE_DIR, "dist");

// A declaration that reaches a sibling module by relative path, or a
// sourcemap comment pointing outside the package, defeats the purpose.
const RELATIVE_SPECIFIER = /(\bfrom\s*|\bimport\(\s*)(["'])(\.[^"']*)\2/;
const SOURCE_MAP_COMMENT = /\/\/#\s*sourceMappingURL=/;

const exists = (path) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** Files under `dir` whose name matches `pattern`. */
const matchingFiles = async (dir, pattern) => {
  if (!(await exists(dir))) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => matchingFiles(join(dir, entry.name), pattern)),
  );
  return [
    ...entries
      .filter((entry) => entry.isFile() && pattern.test(entry.name))
      .map((entry) => join(dir, entry.name)),
    ...nested.flat(),
  ];
};

/** Every `.d.ts` path a consumer can reach through the manifest. */
const entryDeclarations = async (manifest) => {
  const targets = new Set();
  const walk = (value) => {
    if (typeof value === "string") {
      if (value.endsWith(".d.ts")) targets.add(resolve(PACKAGE_DIR, value));
    } else if (value && typeof value === "object") {
      for (const nested of Object.values(value)) walk(nested);
    }
  };
  walk(manifest.exports);
  walk(manifest.types);
  const present = await Promise.all(
    [...targets].map(async (file) => ((await exists(file)) ? file : null)),
  );
  return present.filter(Boolean).sort();
};

const bundle = async (file) => {
  const build = await rollup({
    input: file,
    external: (id) => !id.startsWith(".") && !isAbsolute(id),
    plugins: [dts()],
    onwarn: (warning, warn) => {
      if (warning.code === "CIRCULAR_DEPENDENCY") return;
      warn(warning);
    },
  });
  const { output } = await build.generate({ format: "es", sourcemap: false });
  await build.close();
  if (output.length !== 1) throw new Error(`${file}: expected one chunk, got ${output.length}`);
  const [chunk] = output;
  if (RELATIVE_SPECIFIER.test(chunk.code)) {
    throw new Error(`${file}: bundled declaration still has a relative specifier`);
  }
  if (SOURCE_MAP_COMMENT.test(chunk.code)) {
    throw new Error(`${file}: bundled declaration still references a source map`);
  }

  const staged = `${file}.bundling`;
  await writeFile(staged, chunk.code);
  await rename(staged, file);
  return chunk.code.length;
};

const main = async () => {
  if (!(await exists(DIST))) {
    console.error(`bundle-dts: ${DIST} is missing — run the build first`);
    process.exit(1);
  }

  const manifest = JSON.parse(await readFile(join(PACKAGE_DIR, "package.json"), "utf8"));
  const entries = await entryDeclarations(manifest);
  if (entries.length === 0) throw new Error("bundle-dts: the manifest declares no declarations");

  const sizes = new Map();
  for (const entry of entries) sizes.set(entry, await bundle(entry));

  const redundant = (await matchingFiles(DIST, /\.d\.ts$/)).filter((file) => !sizes.has(file));
  const staleMaps = await matchingFiles(DIST, /\.d\.ts\.map$/);
  await Promise.all([...redundant, ...staleMaps].map((file) => rm(file, { force: true })));

  const kept = entries.map((file) => file.slice(DIST.length + 1)).join(", ");
  console.log(
    `bundle-dts: ${entries.length} entr${entries.length === 1 ? "y" : "ies"} (${kept}), removed ${redundant.length} declaration file(s) and ${staleMaps.length} declaration map(s)`,
  );
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

The script derives the entry list from the manifest, so it needs no per-package
entry map. Produced entries:

- `@ebbjs/core` → `dist/index.d.ts`, `dist/seed/index.d.ts`
- `@ebbjs/storage` → `dist/memory/index.d.ts`, `dist/indexeddb/index.d.ts`,
  `dist/replica/index.d.ts`, `dist/types/index.d.ts`
- `@ebbjs/client`, `@ebbjs/react`, `@ebbjs/codemirror` → `dist/index.d.ts`

### 3.3 Package build scripts (one line each, 5 files)

```diff
-    "build": "vite build && node ../../scripts/fix-dts-extensions.mjs",
+    "build": "vite build && node ../../scripts/bundle-dts.mjs",
```

`scripts/fix-dts-extensions.mjs` stays in the repo, unused. No
`vite.config.ts`, `tsconfig`, `package.json#exports`, or source file changes.

### 3.4 Reproduce

```
pnpm build:packages
pnpm verify:packages
pnpm test:packages
pnpm lint && pnpm fmt:check
```

## 4. Gate results

| Gate                   | Baseline                                                                                                                | Bundled                                                                               |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `pnpm build:packages`  | pass, 26.96 s median (7 runs, 22.9–29.3 s)                                                                              | pass, 29.03 s median (7 runs, 22.9–37.2 s)                                            |
| `pnpm verify:packages` | pass (publint + attw + tarball checks + clean-project `node16` **and** `bundler` type-check with `skipLibCheck: false`) | pass, all five packages, all eight entry points                                       |
| `pnpm test:packages`   | pass                                                                                                                    | pass — 13/26/62/1/3 files, 142 + 510 (+1 skipped) + 1216 (+1 skipped) + 33 + 21 tests |
| `pnpm lint`            | 0 warnings, 0 errors                                                                                                    | 0 warnings, 0 errors                                                                  |
| `pnpm fmt:check`       | pass                                                                                                                    | pass                                                                                  |

`verify:packages` wall clock is unchanged within noise: 16.4 s → 17.6 s on an
idle machine, 32.7 s → 31.9 s when the machine was loaded (the tarballs are
smaller, so the smoke install does slightly less work).

Extra consumer check (not part of the gate): a clean project installed from the
bundled tarballs, type-checked under `node16` and `bundler` with
`skipLibCheck: false`, asserting

- `Action` from `@ebbjs/core` ↔ `Action` from `@ebbjs/core/seed` assignable in
  both directions,
- `Replica` from `@ebbjs/storage/replica` ↔ `Replica` from
  `@ebbjs/storage/types` assignable in both directions,
- `createMemoryAdapter()` assignable to `StorageAdapter` from the storage root,
- `Static<typeof ActionSchema>`, `EntityDef<…, "doc">` and
  `QueryBuilder<{ title: TString }>` still infer (`def.name` is `"doc"`,
  `qb.where("title", "eq").limit(1)` type-checks),
- two `@ts-expect-error` guards still fire (`where("title", 1)` and an unknown
  `EntityDef` member both error).

Result: clean in both resolution modes, **identical to the baseline tarballs**.

## 5. Type fidelity

Method: a TypeScript-compiler-API script per entry (baseline vs bundled) that
dumps, for every export of the entry module, the symbol name, the symbol flags,
`typeToString(…, NoTruncation | InTypeAlias)` of the declared type, the JSDoc
text, and (second pass) the raw declaration text of the aliased symbol. Plus a
per-package diff of the text of every distinct JSDoc comment.

| Entry                      | exports before | exports after | added | removed | changed | degraded to `any`/`unknown` |
| -------------------------- | -------------- | ------------- | ----- | ------- | ------- | --------------------------- |
| `@ebbjs/core`              | 63             | 63            | 0     | 0       | 0       | 0                           |
| `@ebbjs/core/seed`         | 13             | 13            | 0     | 0       | 0       | 0                           |
| `@ebbjs/storage/memory`    | 1              | 1             | 0     | 0       | 0       | 0                           |
| `@ebbjs/storage/indexeddb` | 2              | 2             | 0     | 0       | 0       | 0                           |
| `@ebbjs/storage/replica`   | 14             | 14            | 0     | 0       | 0       | 0                           |
| `@ebbjs/storage/types`     | 29             | 29            | 0     | 0       | 0       | 0                           |
| `@ebbjs/client`            | 231            | 231           | 0     | 0       | 0       | 0                           |
| `@ebbjs/react`             | 11             | 11            | 0     | 0       | 0       | 0                           |
| `@ebbjs/codemirror`        | 18             | 18            | 0     | 0       | 0       | 0                           |

Declaration text is byte-identical after normalizing whitespace, `export`
modifiers and `$N` suffixes, with three cosmetic classes of difference:

1. `import('pkg').T` type references become a namespace import
   (`_sinclair_typebox.T`, `react_jsx_runtime.JSX.Element`,
   `_codemirror_state.StateEffectType`, …). Same types, different spelling.
   Affects 15 symbols in `@ebbjs/core`, 7 in `@ebbjs/client`, 2 in
   `@ebbjs/codemirror`, 1 in `@ebbjs/react`.
2. Two `import('../relative.js').Type` references are inlined
   (`RegistryViolationListener` in `@ebbjs/client` now names the local
   `ValidationViolation`; the `*SystemEntity` values in `@ebbjs/core` name the
   local `NullableSchema`). Same types.
3. Duplicate internal aliases get `$N` suffixes — see risks.

JSDoc: every exported symbol keeps its documentation, and the set of distinct
doc comments emitted for exported declarations is unchanged. Comments that
disappear are attached to declarations that the entry can no longer reach
(module banners and internal classes such as storage's `MemoryReplicaStore`,
`IndexedDBEntityStore`): 75 in `@ebbjs/storage`, 230 in `@ebbjs/client`, 4 in
`@ebbjs/codemirror`, 1 in `@ebbjs/react`, 0 in `@ebbjs/core`. None of those
declarations were reachable through an `exports` entry before either.
`@deprecated`: none in the repo today, so nothing to lose; the mechanism that
preserves docs also preserves tags.

Generic-heavy spot checks in the bundled output:

- `@ebbjs/core`: `declare const ActionSchema: _sinclair_typebox.TObject<{ id:
_sinclair_typebox.TString; … updates: _sinclair_typebox.TArray<…> }>` and
  `type Action = Static<typeof ActionSchema>` — the TypeBox generic chain is
  intact and `@sinclair/typebox` stays a bare external import.
- `@ebbjs/client`: `interface QueryBuilder<TFields extends Record<string,
TSchema>, TJoins extends object = NoJoins, …>` keeps its overloads
  (`where<K extends keyof TFields & string>(key: K, value:
Static<TFields[K]>): QueryBuilder<…>`), `interface EntityDef<TFields, TName
extends string = string>` keeps `readonly name: TName` and the documented
  `conflictScope` / `materialization` members.

The bundled declarations also stay deterministic: two consecutive
`pnpm build:packages` runs produce byte-identical `.d.ts` (sha256 of all nine
entries). Runtime JS is byte-identical to the baseline build for all five
packages — only declarations changed.

## 6. Size and file counts

`dist/` inventory:

| Package    | `dist` files | `.d.ts` | `.d.ts.map` |
| ---------- | ------------ | ------- | ----------- |
| core       | 49 → 5       | 23 → 2  | 23 → 0      |
| storage    | 80 → 10      | 37 → 4  | 37 → 0      |
| client     | 93 → 2       | 46 → 1  | 46 → 0      |
| react      | 11 → 2       | 5 → 1   | 5 → 0       |
| codemirror | 7 → 2        | 3 → 1   | 3 → 0       |

Tarballs (`pnpm pack`):

| Package    | tarball                    | files in tarball |
| ---------- | -------------------------- | ---------------- |
| core       | 15.9 KB → 11.8 KB (−24%)   | 52 → 8           |
| storage    | 41.5 KB → 30.4 KB (−27%)   | 83 → 13          |
| client     | 160.4 KB → 116.0 KB (−28%) | 96 → 5           |
| react      | 11.5 KB → 10.2 KB (−11%)   | 14 → 5           |
| codemirror | 12.2 KB → 10.4 KB (−15%)   | 10 → 5           |

Declaration bytes (all entries of the package; gzip is what the editor/language
server actually reads):

| Package    | `.d.ts` bytes     | gzip            |
| ---------- | ----------------- | --------------- |
| core       | 24 407 → 21 349   | 3 675 → 3 353   |
| storage    | 66 653 → 79 928   | 18 992 → 13 018 |
| client     | 262 212 → 183 902 | 73 946 → 53 213 |
| react      | 6 805 → 5 781     | 2 433 → 2 183   |
| codemirror | 8 326 → 6 052     | 2 931 → 2 239   |

Consumer-side type-check of a project that imports all eight entries
(`skipLibCheck: false`): 4.5–4.8 s bundled vs 4.5–4.8 s baseline — no editor
regression.

Build-time cost, isolated per package (same `vite build` output, only the
post-processing differs):

| Package    | `fix-dts-extensions` | `bundle-dts` |
| ---------- | -------------------- | ------------ |
| core       | 0.13 s               | 1.68 s       |
| storage    | 0.15 s               | 1.25 s       |
| client     | 0.15 s               | 1.77 s       |
| react      | 0.16 s               | 1.30 s       |
| codemirror | 0.11 s               | 1.12 s       |

≈ +7 s of CPU across the five packages, ~+1 s on the slowest parallel path.
End-to-end `pnpm build:packages` wall clock is indistinguishable from noise
(median 27.0 s → 29.0 s over 7 runs each; individual runs range 22.9–37.2 s on
both sides, dominated by the ~8 s `vite:dts` emit for `@ebbjs/client`).

## 7. Diff cost in the real repo

```
 package.json                     |  2 ++
 packages/client/package.json     |  2 +-
 packages/codemirror/package.json |  2 +-
 packages/core/package.json       |  2 +-
 packages/react/package.json      |  2 +-
 packages/storage/package.json    |  2 +-
 pnpm-lock.yaml                   | 51 ++++++++++
 7 files changed, 58 insertions(+), 5 deletions(-)
```

plus `scripts/bundle-dts.mjs` (new, 123 lines) and 4 packages added to the
install graph.

Merge-conflict exposure: low. No file under `packages/*/src` is touched —
`git status` after the change lists only the six manifests, the lockfile and the
new script. The five edits are the single `build` script line per package, i.e.
the line this release branch introduced; a follow-up commit on the branch does
not race any in-flight work. The lockfile is the usual churn risk (this branch's
lockfile diff is already ~800 lines).

## 8. Risks a maintainer should know

1. **`$N` suffixes leak into declarations.** `rollup-plugin-dts` deconflicts
   same-named aliases from different source modules instead of merging them.
   `@ebbjs/client/dist/index.d.ts` therefore contains five copies of
   `type AnyEntityDef = EntityDef<Record<string, TSchema>>` (as `AnyEntityDef`,
   `AnyEntityDef$2` … `AnyEntityDef$5`) and four of `AnyRelationshipDef`, and
   its export clause reads `export type { Action$1 as Action, … }`. All copies
   were verified to have identical bodies, and the exported name resolves to one
   of them consistently, so behaviour is unaffected — but hovers and error
   messages can now print an internal `Foo$2`, and a future module pair that
   declares the _same name with different shapes_ would be silently split rather
   than reported. If that ever matters, the fix is to make the alias names
   unique in source rather than to add bundler options.
2. **Cross-entry nominal identity is now per-bundle.** Types are structural, so
   `Action` from `@ebbjs/core` and `Action` from `@ebbjs/core/seed` remain
   assignable (verified), as do storage's `Replica` types. But a `unique symbol`
   brand or a class with private/protected members declared in a module shared
   by two entries would produce two distinct identities after bundling, and
   values would stop being assignable across entries. Today no package exports
   a branded type from more than one entry (`RUN` and
   `COLLABORATIVE_TEXT_BRAND` live in single-entry `@ebbjs/client`), so the
   constraint is "keep it that way, or keep branded types inside one entry".
   Worth a sentence in `docs/tooling/releasing.md` and a cross-entry identity
   assertion in `verify-packages.mjs`.
3. **Per-entry duplication.** `@ebbjs/storage`'s four entries each inline the
   shared types, so its raw `.d.ts` bytes grow 20% (66.7 KB → 79.9 KB) even
   though gzip shrinks 32%. Nothing breaks; it is the price of self-contained
   entries. `@ebbjs/client` (one entry) shrinks by 30%.
4. **Docs for unreachable declarations are gone.** Only reachable declarations
   survive, which is what a consumer could see anyway, but a maintainer who
   greps the tarball for an internal class doc will no longer find it.
   `@deprecated` and other JSDoc tags are preserved on everything exported.
5. **Declaration merging / module augmentation would not survive** (`declare
global`, `declare module "x"`). There is none in these five packages today; a
   future augmentation (e.g. augmenting `@codemirror/state`) would need to stay
   out of the bundle or be handled explicitly.
6. **The extension check moved from "rewrite" to "assert".** `bundle-dts`
   _throws_ if a relative specifier or a sourcemap comment survives, instead of
   fixing it. That is the point (a bundled declaration must not link out), but
   it means a `vite-plugin-dts` change that starts emitting something odd fails
   the build loudly rather than silently producing a fixable artifact. Good
   trade, worth knowing.
7. **Entries come from the manifest, not from `vite.config.ts`.** A `types`
   target that does not exist is skipped rather than reported. `verify:packages`
   already fails on a missing export target, so the hole is covered by the gate,
   not by this script.
8. **One optional transitive dep wants a newer Node** than the repo's
   `engines.node` floor: `@babel/code-frame@8.0.6` (optional, pulled by
   `rollup-plugin-dts`) requires `^22.18.0 || >=24.11.0`. It is optional, so
   installs on Node 22.8–22.17 succeed and the plugin just loses pretty
   error code frames.
9. **`fix-dts-extensions.mjs` becomes dead code.** It should be deleted in the
   same PR, or it will be re-wired by someone reading the old docs;
   `verify-packages.mjs`'s `checkDeclarationSpecifiers` and `attw` keep covering
   the property it enforced.
