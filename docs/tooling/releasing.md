# releasing

How the `@ebbjs/*` packages reach npm (issue #565). The release mechanics live
in `.github/workflows/release.yml`, `.changeset/config.json`, and
`scripts/verify-packages.mjs`.

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

All five published packages share **one version** (a changesets `fixed` group).
They are ESM-only and support Node `>=22.8.0`.

## Adding a change

```bash
pnpm changeset
```

Pick the bump type and describe the change in the `.changeset/*.md` file it
writes; commit that file with the PR. `pnpm changeset status` shows what the
next release would contain.

## What CI does

- **Every PR** runs the pack verification (see Guardrails below), so a broken
  `exports`, a missing type file, or a stray `workspace:` reference fails before
  it can be published.
- **Every push to `main`** runs the Release workflow. While changesets are
  pending it opens or updates the `chore(release): version packages` PR. When
  that PR merges, the same workflow builds, tests, verifies, and publishes the
  changed packages, then tags `v<version>` and creates the GitHub release.
  Changesets' per-package `<name>@<version>` tags and releases are disabled: the
  five packages share a version, so `v<version>` names the release train.
- **The tag step waits for the registry.** npm's read side replicates
  asynchronously, so `npm view` can answer 404 for a version the publish already
  accepted — seconds to a few minutes. The step polls for up to ten minutes
  before concluding nothing shipped. The same lag delays the new version in
  `npm view` and in `npm install` after the run goes green: it is replication,
  not a failed publish, and the fix is to wait rather than to bump again.
- **The image build is dispatched, not triggered.** `release-image.yml` listens
  for `push` on `v*` tags, but the tag here is created with `GITHUB_TOKEN`, and
  GitHub suppresses workflow runs for events a `GITHUB_TOKEN` caused. The tag
  step calls `gh workflow run release-image.yml` itself (hence the
  `actions: write` permission), only on the run that creates the release; a
  failed image build is re-dispatched by hand with `-f version=<v>`.
- **Re-running on an unchanged commit is a no-op.** Changesets reads the
  registry, skips versions that are already published, and exits successfully.

The version PR does not get a CI run: it is opened with the repository
`GITHUB_TOKEN`, and GitHub suppresses workflows for token-authored events. The
Release job therefore builds, tests, and verifies the five published packages
itself before publishing. Pass an app or PAT token to the action's
`github-token` input if you want full CI on that PR as well.

## One-time npm setup

Nothing in this repository can create the npm side of trusted publishing; it is
configured per package on npmjs.com by an owner:

1. npm cannot attach a trusted publisher to a name that does not exist yet, so
   `0.1.0` is bootstrapped once from a checkout of `main`, with a
   [granular access token](https://docs.npmjs.com/creating-and-viewing-access-tokens)
   for an account that owns an npm organization named `ebbjs`. The token needs
   read/write on `@ebbjs` and **2FA bypass enabled**; without the bypass npm
   refuses the publish, telling you it requires two-factor authentication or a
   granular access token with 2FA bypass.

   The npm CLI resolves `_authToken` from `.npmrc`, so put it there instead of
   relying on `NODE_AUTH_TOKEN` alone:

   ```bash
   npm config set //registry.npmjs.org/:_authToken=<token> --location=user
   npm whoami                # must print the account name, not ENEEDAUTH

   pnpm version-packages     # consumes .changeset/*.md, writes 0.1.0 + CHANGELOGs
   git add -A                # `commit -am` misses the new CHANGELOG.md files
   git commit -m "chore(release): 0.1.0"
   pnpm build:packages
   pnpm -r --filter "@ebbjs/*" --filter "!@ebbjs/server" \
     --filter "!@ebbjs/www" publish --access public --no-git-checks
   git push                  # Release finds no changesets and does nothing

   npm config delete //registry.npmjs.org/:_authToken --location=user
   ```

   This is the only publish that uses a token, and the only one without
   provenance. Revoke the token on npmjs.com afterwards. The registry answers
   404 for each new package for a few minutes after the publish is accepted;
   that is replication lag, not a failure.

2. On each of the five packages: **Settings → Trusted publishing → GitHub
   Actions**, with repository `ebbjs/ebbjs`, workflow filename `release.yml`
   (the filename alone, not a path) and no environment. Under **Allowed
   actions** tick **Allow npm publish**: `npm stage publish` is always allowed,
   direct `npm publish` is opt-in, and an unticked box fails the release with
   `403 ... OIDC permission denied for this action`. Leave **Allow npm dist-tag**
   unticked unless a release has to move a tag. A new trusted publisher must
   complete a publish within two days or it expires.
3. Confirm nothing in CI sets `NODE_AUTH_TOKEN` or `registry-url`: a configured
   registry token takes precedence over the OIDC exchange. Nothing in
   `release.yml` reads a token secret.
4. In **Settings → Actions → General**, enable _Allow GitHub Actions to create
   and approve pull requests_, or the version PR cannot be opened.
5. Once the first OIDC release is green, set each package's **Publishing
   access** to _Require two-factor authentication and disallow bypass 2fa
   tokens_. Trusted publishing is not a token, so it keeps working, and
   token-based publishing — the bootstrap's only mechanism — stops being
   possible.

The workflow installs `npm@^11.5.1` on the runner because `pnpm publish` hands
the upload to the npm CLI, and 11.5.1 is the first version that can exchange the
OIDC token (`@changesets/cli` v3 needs Node `>=22.11`; trusted publishing needs
Node `>=22.14`). Provenance is generated automatically for an OIDC publish from
a public repository; the workflow also sets `npm_config_provenance=true`, which
pnpm forwards to `npm publish`, so the attestation survives a token-based
publish.

Action pairing matters: `changesets/action@v1` detects published packages from
CLI 2's `New tag:` output, so CLI 3 with action v1 publishes without ever
tagging or creating a release. This repo uses `@changesets/cli@^3` with
`changesets/action@v2`.

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

## After publishing

```bash
npm view @ebbjs/core@0.1.0 dist.integrity dist.attestations
```

Then confirm the registry install path, which CI cannot do before the first
publish:

```bash
mkdir /tmp/ebb-registry-smoke && cd /tmp/ebb-registry-smoke
npm init -y
npm install @ebbjs/core@0.1.0 @ebbjs/storage@0.1.0 @ebbjs/client@0.1.0 \
  @ebbjs/react@0.1.0 @ebbjs/codemirror@0.1.0 react @codemirror/state @codemirror/view codemirror idb
node --input-type=module -e 'for (const s of ["@ebbjs/core","@ebbjs/storage/memory","@ebbjs/client","@ebbjs/react","@ebbjs/codemirror"]) await import(s)'
```

## Adding a new public package

Flip `"private": false`, copy the metadata block from a published package
(`license`, `repository.directory`, `homepage`, `bugs`, `engines`, `files`,
`publishConfig`, `sideEffects`), add a `prepack` license copy, append the
declaration bundling plugin to `vite.config.ts`, then add the name to `EXPECTED_PUBLISHED`
in `scripts/verify-packages.mjs` and to the `fixed` group in
`.changeset/config.json`. `scripts/generate-package.sh` does not emit any of
this yet, so a package created from the template will fail `verify:packages`
until it does.
