# Declaration emit practice for ESM-only libraries (issue #565)

Question: how do ESM-only libraries make `dist/*.d.ts` correct for `moduleResolution: node16` /
`nodenext` consumers when JS comes from `vite build` and declarations from `vite-plugin-dts`
(`rollupTypes: false`) compiled under `moduleResolution: "bundler"`? Measured 2026-10-22 with
`typescript@5.9.2` (repo) and `7.0.2`, `@arethetypeswrong/cli@0.18.5`, `npm pack <pkg>@latest`.

## Summary

1. TypeScript's library guide names this exact failure and gives two fixes: compile under
   `nodenext`, or bundle your declarations.
2. **No compiler option adds extensions to extensionless specifiers in declaration emit.**
   `rewriteRelativeImportExtensions` handles `.ts/.tsx/.mts/.cts` only, JS emit only (open:
   microsoft/TypeScript#61037). `attw` likewise says compile/check with `nodenext`, not patch the
   artifact.
3. Of 13 sampled packages, **none** ships an extensionless relative specifier in an ESM-resolved
   declaration; it survives only in CJS-resolved `.d.ts` trees, where it is legal.
4. `zustand` and `valtio` ship a **post-build script that appends extensions to emitted `.d.ts`** —
   direct precedent for `scripts/fix-dts-extensions.mjs`.
5. `vite-plugin-dts`'s `rollupTypes: true` is built on api-extractor, which "assumes that your
   package has a single entry point". Its multi-entry failure modes (#321, #322) match the observed
   loss of `@ebbjs/core`'s main-entry exports.

## 1. What TypeScript says

> "Extensionless relative paths are not supported in `import` paths in Node.js ... TypeScript
> currently never supports omitting a `.mjs`/`.mts` or `.cjs`/`.cts` file extension."
> — https://www.typescriptlang.org/docs/handbook/modules/reference.html#extensionless-relative-paths

> "`node16`, `node18`, and `nodenext` are the only correct `module` options for all apps and
> libraries that are intended to run in Node.js v12 or later, whether they use ES modules or not."
> — .../modules/reference.html#node16-nodenext

**The library guide covers our configuration.** "I'm writing a library" → "Considerations for
bundling libraries", caveat 2:

> "If you use `moduleResolution: "bundler"` and use a bundler to emit an ESM bundle while using
> `tsc` to emit many individual declaration files, your declaration files may cause errors when
> consumed under `module: "nodenext"` ... That import statement ... will contain an invalid module
> specifier in Node.js, since it's missing a file extension. For Node.js users, TypeScript will error
> on the declaration file and infect types referencing `Component` with `any` ...
> If your TypeScript bundler does not produce bundled declaration files, use
> `moduleResolution: "nodenext"` to ensure that the imports preserved in your declaration files will
> be compatible with end-users' TypeScript settings. Even better, consider not bundling your library."
> — https://www.typescriptlang.org/docs/handbook/modules/guides/choosing-compiler-options.html#considerations-for-bundling-libraries

Same page: "`moduleResolution: "bundler"` is infectious, allowing code that only works in bundlers
to be produced." `declarationMap` is only useful if the library ships sources. `typesVersions` is a
redirect for older TS, not an extension fix (.../reference.html#packagejson-typesversions).

**`rewriteRelativeImportExtensions` (TS 5.7) does not solve this.**

> "When an import path is _relative_ ..., ends in a TypeScript extension (`.ts`, `.tsx`, `.mts`,
> `.cts`), and is a non-declaration file, the compiler will rewrite the path to the corresponding
> JavaScript extension ... these will NOT be rewritten in any way: `import * as a from "./foo";`"
> — https://devblogs.microsoft.com/typescript/announcing-typescript-5-7/#path-rewriting-for-relative-paths

So: TypeScript extensions only, never extensionless; "non-declaration file" excludes `.d.ts`.
Measured, not assumed:

- TS 5.9.2, `module: nodenext`, `allowImportingTsExtensions` + `rewriteRelativeImportExtensions`,
  source `export * from "./a.ts"` → `dist/b.js` has `require("./a.js")`, `dist/b.d.ts` still has
  `export * from "./a.ts"`.
- TS 7.0.2: identical.
- TS 7.0.2, `module: esnext` + `moduleResolution: bundler`, source `export * from "./a"` →
  `dist/b.d.ts` has `export * from "./a"`.

Upstream: this is a tracked, **open** request — "rewriteRelativeImportExtensions: tsc doesn't
rewrite extensions in emitted declaration files", _Suggestion / Experience Enhancement_
(https://github.com/microsoft/TypeScript/issues/61037). Ryan Cavanaugh on the implementing PR:

> "Imports in `.d.ts` files are allowed to use `.ts` extensions regardless of config, so I wouldn't
> really consider that a bug." — https://github.com/microsoft/TypeScript/pull/59767#issuecomment-2389761587

Consumer consequence, measured in a scratch project (`skipLibCheck: false`):
`node_modules/pkg/index.d.ts(1,24): error TS2834: Relative import paths need explicit file
extensions in ECMAScript imports when '--moduleResolution' is 'node16' or 'nodenext'.`
With `skipLibCheck: true` the error vanishes and the type becomes `any` (`const n: number = y.a`
compiles) — the silent zero-types mode. A `.ts` specifier in a `.d.ts` is _not_ an error:
`import type { T } from "./types.ts"` resolved to `types.d.ts` and type-checked cleanly under
nodenext, which is why `date-fns` and `@noble/hashes` get away with it. No option adds extensions to
extensionless specifiers in 5.9.2 or 7.0.2.

## 2. What `@arethetypeswrong/cli` recommends

> "This problem can occur with `tsc` alone if the library author compiles with
> `--moduleResolution node` (also known as `node10`) or `bundler`, especially in combination with a
> package.json that has `"type": "module"`. Library authors should always compile/check with
> `--module node16 --moduleResolution node16` or `nodenext` ... because this is the only TypeScript
> mode that recognizes Node's strict module resolution algorithm for ESM."
> — https://github.com/arethetypeswrong/arethetypeswrong.github.io/blob/main/docs/problems/InternalResolutionError.md

No post-processing remediation is offered. `CJSResolvesToESM` is orthogonal — it states CJS consumers
cannot `require()` the package and is "correct about the problem that will occur at runtime"; the tool
is neutral on ESM-only (.../docs/problems/CJSResolvesToESM.md).

## 3. What published packages ship (measured)

`npm pack <pkg>@latest` → extract → count files, regex relative specifiers per declaration class,
`attw --profile node16` on the tarball. `.d.*` = `.d.ts` + `.d.mts` + `.d.cts`.

| package@version             | `type`   | .js  | .d.\* | emission                          | relative specifiers in ESM-resolved decls               | `.d.ts.map`                 |
| --------------------------- | -------- | ---- | ----- | --------------------------------- | ------------------------------------------------------- | --------------------------- |
| `ai@7.0.149`                | module   | 4    | 5     | bundled/entry (tsdown), 437 KB    | none¹                                                   | yes, 1/335 sources dangling |
| `date-fns@4.4.0`            | module   | 2659 | 2461  | per-module                        | 5162 × `.ts`                                            | none                        |
| `drizzle-orm@0.45.4`        | module   | 896  | 896   | per-module                        | 5353 × `.js`; 63 × `.ts` in `.d.cts`                    | none                        |
| `eventsource-client@1.2.0`  | (none)   | 4    | 1     | single (`pkg-utils`)              | none                                                    | none                        |
| `hono@4.13.13`              | module   | 380  | 189   | per-module                        | 342 × `.js`                                             | none                        |
| `immer@11.2.9`              | (none)   | 6    | 2     | single 17 KB (tsup)               | none                                                    | none                        |
| `nanoid@6.0.2`              | module   | 6    | 2     | **hand-written**, no emit         | none                                                    | none                        |
| `@noble/hashes@2.4.0`       | module   | 19   | 19    | per-module (`tsc`, ships `.ts`)   | 23 × `.ts`                                              | none                        |
| `@sinclair/typebox@0.34.52` | (none)   | 532  | 532   | dual tree                         | `.d.ts` 1239 extensionless (CJS); `.d.mts` 1239 × `.js` | none                        |
| `@tanstack/store@0.11.2`    | module   | 10   | 12    | per-module (tsdown)               | 14 × `.js`                                              | none                        |
| `valtio@2.3.2`              | commonjs | 12   | 29    | dual tree + **post-build script** | `.d.ts` 8 extensionless (CJS); `.d.mts` 8 × `.mjs`      | none                        |
| `zod@4.6.7`                 | module   | 248  | 248   | per-module (zshy)                 | 622 × `.js`                                             | none                        |
| `zustand@5.0.16`            | commonjs | 18   | 31    | dual tree + **post-build script** | `.d.ts` 6 extensionless (CJS); `.d.mts` 6 × `.mjs`      | none                        |

¹ All 5 matches in `ai` are JSDoc code examples (`from './main'`), not imports. Corrected to 0.

- **0 of 13** ships an extensionless relative specifier in an ESM-resolved declaration; extensionless
  survives only in CJS-resolved trees (`type: commonjs`/absent), where `nodenext` uses Node's CJS
  algorithm. Per-module + explicit `.js` is the dominant style (`zod`, `hono`, `drizzle-orm`,
  `@tanstack/store`); `.ts` specifiers are a valid alternative (`date-fns`, `@noble/hashes`, both of
  which import cleanly under nodenext with `skipLibCheck: false` in a scratch project). Bundled
  declarations are common for bundler-built packages (`ai`, `immer`, `eventsource-client`).
- **Only `nanoid` is hand-written.** `zustand`/`valtio`'s published `postbuild` runs
  `find('dist/esm/**/*.d.ts')` → rename to `.mts` → `sed ' from '(\.[^']+)';$'` → `'$1.mjs'`
  (https://github.com/pmndrs/zustand/blob/main/package.json, same script in valtio).
- `attw --profile node16`: **zero `InternalResolutionError`** on the 11 packages it finished; it
  timed out at 900 s on `date-fns`/`drizzle-orm` (~2500/~900 entrypoints), both covered above.
- Declaration maps ship in 1/13, with a dangling source. Ours are `.d.ts.map` → `../src/*.ts` while
  `files: ["dist", ...]` excludes `src` — same defect.

## 4. Tooling landscape

Registry: `npm view <pkg> version time.modified` + `api.npmjs.org/downloads/point/last-week`.

| approach                                        | last release          | dl/wk  | multi-entry                 | known failure modes                                                                                                  |
| ----------------------------------------------- | --------------------- | ------ | --------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Explicit `.js` in source + `nodenext`           | `typescript@7.0.2`    | —      | native                      | 363 files to edit; needs each bundler to resolve `./x.js` → `x.ts`; cannot express bundler-only imports              |
| `tsc-alias` (`resolveFullPaths`)                | 1.9.9, 2026-10-22     | 2.18 M | yes                         | post-process only; alias rewriting can over-reach                                                                    |
| `tsc-esm-fix`                                   | 3.1.2, **2024-11-01** | 34 k   | yes                         | effectively unmaintained; regex rewrite of `.d.ts`, our family                                                       |
| `rollup-plugin-dts`                             | 6.5.1, 2026-08-04     | 1.32 M | one bundle per rollup input | works on emitted `.d.ts`; rewrites shared private chunks, can still emit `TS2742`-prone types; per-entry duplication |
| `dts-bundle-generator`                          | 9.5.1, **2024-04-21** | 249 k  | multiple entry files        | stale; bundle-only                                                                                                   |
| `vite-plugin-dts` `bundleTypes` (api-extractor) | 5.1.2, 2026-10-03     | 2.07 M | per entry, but see below    | #417, #321, #415, #319, #322                                                                                         |
| `@microsoft/api-extractor`                      | 7.59.4, 2026-10-06    | 2.63 M | **no**                      | single entry by design; release tags for trimming                                                                    |

### `rollupTypes: true` with multiple `build.lib.entry` entries

> "An important limitation: The `.d.ts` rollup feature currently assumes that your package has a
> single entry point (the `mainEntryPointFilePath` setting). This isn't always the case."
> — https://api-extractor.com/pages/setup/configure_rollup/

Plugin issues (repo renamed `qmhc/unplugin-dts`):

- **#321 (open) "Duplicate definition of types when multiple entrypoints"** — shared code is inlined
  into each entry instead of a shared chunk: "leads to two definitions of several of the types".
  Maintainer: "Currently this is hard to implement. The rollup process is powered by
  `@microsoft/api-extractor` and it's difficult (probably noway) to change its behavior."
- **#417** — plugin strips the entry extension, emitting `export * from './index'`, "incompatible
  with `moduleResolution: "nodenext"`".
- **#262 / #415** — multi-entry builds fail with `mainEntryPointFilePath path does not exist:
dist/<entry>.d.ts`; and "You should empty `dist` before each build, because `rollupTypes` base on
  the files in output dir."
- **#319 / #322** — default export dropped (`hasExportDefault` misses `export default class`);
  "Errors being swallowed when `rollupTypes: true`": api-extractor errors are logged but do not fail
  the build.

No issue is titled "one entry's exports vanish"; #321 + #322 + the single-entry assumption explain
that class of failure, and #322 means it can be silent.

### api-extractor's trimming burden

> "By default, it requires every declaration in your API to have a release tag."
> — https://api-extractor.com/pages/messages/ae-missing-release-tag/

Trimming to `@public` is opt-in (`dtsRollup.publicTrimmedFilePath`) and `ae-missing-release-tag` can
be disabled. But a trimmed surface needs a tag on every outermost declaration: ~100 tags plus TSDoc
maintenance for this API, and a forgotten tag is a warning the plugin may not surface (#322).
Workable for a curated public API; poor fit for typebox-derived exports.

## 5. What build-tool docs recommend for libraries

- **TypeScript (authority):** for bundler-built libraries, bundle declarations or compile under
  `nodenext`; "Even better, consider not bundling your library" (§1).
- **`tshy`:** forces `module`/`moduleResolution: NodeNext` (https://github.com/isaacs/tshy#tsconfigs);
  examples author `import { Thing } from './thing.js'` — source extensions, no post-processing.
- **`zod`** builds with `zshy`; **`hono`, `drizzle-orm`, `@noble/hashes`** use `tsc`-family emit —
  all per-module with `.js`/`.ts` specifiers (measured). **`ai`, `@tanstack/store`** use `tsdown`,
  which bundles declarations per entry.
- **Vite `build.lib` docs:** no declaration guidance. "Library mode includes a simple and
  opinionated configuration for browser-oriented and JS framework libraries. If you are building
  non-browser libraries ... you can use tsdown or Rolldown directly."
  — https://vitejs.dev/guide/build.html#library-mode
- **`vite-plugin-dts`/`unplugin-dts` README:** documents declaration extensions and dual ESM/CJS
  output, nothing about node16 specifier compatibility. **`zustand`/`valtio`** are the only sampled
  packages doing the codemod, in `postbuild` shell scripts.

Net: for bundler-built libraries the recommended path is (b) declaration bundling or (a) source
extensions; accepting bundler-resolution-only consumers is what TypeScript warns against. Post-build
rewriting is a minority but real third option in high-download packages.

## 6. Cost/benefit for this repo

```
shipped source (reaches dist): 120 files → 363 relative specifiers
test-only files:               116 files → 376 relative specifiers
total under src/:                          739 relative specifiers
emitted declarations now: core 23, storage 37, client 46, react 5, codemirror 3 = 114 .d.ts
```

The brief's "~680 in shipped code" is the with-tests total; shipped-only is 363. Same order,
different denominator. Normal or smell? Both readings hold:

- Normal: 2/13 sampled packages (`zustand`, `valtio`) ship exactly this rewrite, at 18 M and 5 M
  weekly downloads — a recognised maintenance burden, not a hack unique to us.
- Smell: 10/13 solve it at emit time (7 per-module, 3 bundled), and the TS guide treats
  "bundler-emitted JS + unbundled `tsc` declarations" as the anti-pattern. The codemod compensates
  for a mismatch; it is not a design.

Keeping it costs one ~100-line idempotent script that fails loudly on unresolvable specifiers and is
already wired into `verify-packages.mjs`. Alternative 1 costs 363 edits plus a bundler-resolution
dependency (`.js` → `.ts`) our toolchain does not guarantee.

## Recommendation

**Keep per-module declaration emit and the post-build `.js` rewrite, and make the artifact
verifiable** rather than switching to declaration bundling. Concretely: `vite build` +
`vite-plugin-dts` (`rollupTypes: false`) + `fix-dts-extensions.mjs` as today, plus (1) run
`attw --profile node16` on packed tarballs inside `verify-packages.mjs` so a regression fails CI, and
(2) ship `src/` so `dist/*.d.ts.map` resolves, or drop `declarationMap`. Emit `.js`, not `.ts`, so
declarations also work for tools without TS's `.ts`-specifier tolerance. Ranked alternatives:

1. **Source `.js` extensions + `module`/`moduleResolution: nodenext`** (TS's documented fix). Best
   long-term: no build step, no artifact mutation. Cost: 363 edits, and Vite/Vitest/`tsx` must each
   resolve `./x.js` → `x.ts`; pilot it on one package.
2. **Bundle declarations per entry with `rollup-plugin-dts`** (or `tsdown`). What `ai` and
   `@tanstack/store` ship; keeps multi-entry, removes the extension problem. Cost: new build layer,
   shared-type duplication across `@ebbjs/core`'s two entries, `TS2742`-prone types.
3. **`vite-plugin-dts` `rollupTypes: true`.** Last: api-extractor is single-entry by design, the
   plugin swallows its errors (#322), and this configuration already lost the main-entry exports.
4. **Accept bundler-only consumers.** Rejected: the one option TS explicitly warns against, and it
   degrades to `any` under `skipLibCheck`.

Strongest argument against this recommendation: the script emits a shape `tsc` cannot produce, so it
is only as correct as its own tests — it does not verify that externalized dependency imports are
Node-safe, does not fix the `.d.ts.map` sources, and needs re-auditing whenever declaration emit
changes (e.g. if #61037 lands). Source extensions (alternative 1) remove that risk and are the path
TypeScript, `tshy`, and 10/13 sampled packages take; the codemod is a build-time invariant the
compiler does not enforce.
