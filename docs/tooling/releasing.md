# releasing

How the `@ebbjs/*` packages are packaged and checked before they reach npm
(issue #565). The checks live in `scripts/verify-packages.mjs`.

## What publishes

| Package             | Published | Notes                                                         |
| ------------------- | --------- | ------------------------------------------------------------- |
| `@ebbjs/core`       | yes       | Runtime dependency of `storage`, `client`, and `codemirror`.  |
| `@ebbjs/storage`    | yes       | Root export is types-only; code imports the subpaths.         |
| `@ebbjs/client`     | yes       |                                                               |
| `@ebbjs/react`      | yes       | Peer: `react`.                                                |
| `@ebbjs/codemirror` | yes       | Peers: `@codemirror/state`, `@codemirror/view`, `codemirror`. |
| `@ebbjs/server`     | no        | Private E2E harness.                                          |
| `@ebbjs/www`        | no        | Private Astro docs site.                                      |

All five published packages are intended to share **one version** and are
ESM-only, supporting Node `>=22.8.0`.

## Guardrails

```bash
pnpm build:packages
pnpm verify:packages
```

`verify:packages` reads `dist/`, so it must run after a real build. The
per-package `dev` script (`vite build --watch`) never finishes, so it does not
bundle declarations — pack only from a completed `build`.

`verify:packages` packs every public package and fails when:

- a public package is missing release metadata (`license`, `repository.directory`,
  `homepage`, `bugs`, `engines`, `files`, `publishConfig.access`, `sideEffects`),
  or a package that must stay private is not `"private": true`
- the tarball contains anything outside `dist/`, `README.md`, `LICENSE*`,
  `package.json`, or contains source, tests, test support modules, benchmarks,
  or build config
- the packed manifest still contains a `workspace:` range, or a sibling
  `@ebbjs/*` dependency does not point at the version being released
- an `exports`/`main`/`types` target is missing from the tarball
- a declaration file contains a relative specifier at all (bundled declarations
  must be self-contained; the bundling plugin enforces it at build time)
- a `.d.ts.map` ships (its `sources` point at a `src/` that is not in the tarball)
- `publint` reports a problem, or `@arethetypeswrong/cli --profile node16
--ignore-rules cjs-resolves-to-esm` does. The packages are ESM-only, so the
  `cjs-resolves-to-esm` interop warning is the single rule ignored;
  node16-from-ESM and bundler resolution are enforced.
- a clean temporary project cannot install the tarballs, import every public
  entry point, and type-check under both `node16` and `bundler` resolution

### Why the declarations are bundled

Each package's JavaScript is a single bundle per entry (`dist/index.js`,
`dist/memory/index.js`, …). Emitting a declaration per source module to match the
source tree would leave a graph linked by relative specifiers, which a `node16`
consumer cannot resolve: under `moduleResolution: "bundler"` (what
`tsconfig.base.json` uses) tsc writes `export * from "./types"`, so they get
`TS2834` — or with `skipLibCheck: true` silently no types at all. TypeScript's
[library guide](https://www.typescriptlang.org/docs/handbook/modules/guides/choosing-compiler-options.html#considerations-for-bundling-libraries)
names this exact combination and offers two fixes: compile under `nodenext`, or
bundle the declarations.

We bundle, and we bundle straight from source. `scripts/vite-plugin-bundle-declarations.mjs`
runs `rollup-plugin-dts` over each published entry and writes one self-contained
`.d.ts` per entry — no relative specifiers, so the artifact resolves identically
under `node16`, `bundler`, and CJS-aware resolvers. It replaces `vite-plugin-dts`
for the published packages, which is what makes the shape simple: one
declaration build per entry instead of emitting a per-module tree and then
re-bundling it. It runs in `closeBundle`, so `vite build --watch` produces the
same artifact, and the entry list comes from the package's own `exports`, so a
new subpath needs no configuration. Bundling from source also keeps the JSDoc
that the declaration emitter dropped.

Two consequences to keep in mind:

- A type shared by two entries is bundled into each, so it must stay one type.
  The clean-project smoke test asserts that (`Action` across `core` and
  `core/seed`, `Replica` across `storage/replica` and `storage/types`).
- Internal aliases can surface as `Name$1` in editor hovers. Harmless today;
  worth knowing when a type looks oddly named.

The alternative — writing `.js` in every relative import and compiling under
`nodenext` — is what TypeScript recommends for libraries that do _not_ bundle
their JavaScript. It is the better long-term config hygiene for this repo, but
it is a ~360-specifier source change across packages with in-flight branches, and
bundling already produces a correct artifact.

## Adding a new public package

Flip `"private": false`, copy the metadata block from a published package
(`license`, `repository.directory`, `homepage`, `bugs`, `engines`, `files`,
`publishConfig`, `sideEffects`), add a `prepack` license copy, add the
declaration bundling plugin to `vite.config.ts`, then add the name to
`EXPECTED_PUBLISHED` in `scripts/verify-packages.mjs`. `scripts/generate-package.sh`
does not emit any of this yet, so a package created from the template will fail
`verify:packages` until it does.
