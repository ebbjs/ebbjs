# Research: npm release mechanics for #565

pnpm 10.30.1, Node `>=22.8.0` (npm 11.19.0 on this box), changesets, GitHub Actions,
npm trusted publishing. Each claim is a doc URL I read or a command I ran on
2026-10-22 (scratch workspaces in `/tmp`; pnpm internals read from
`~/.cache/node/corepack/v1/pnpm/10.30.1/dist/pnpm.cjs`).

**Baseline caveat.** The tree was already dirty with in-progress #565 work and kept
changing during the session (`package.json`, `packages/*/package.json`, `pnpm-lock.yaml`
modified; new `scripts/{copy-license,fix-dts-extensions,verify-packages}.mjs`;
`@changesets/cli@^3.0.3` devDep; `packages/codemirror` `workspace:*` → `workspace:^`).
Independent results were re-verified in `/tmp`.

## 1. pnpm workspace protocol on publish/pack

<https://pnpm.io/workspaces#publishing-workspace-packages>: "When a workspace package is
packed into an archive (**whether it's through `pnpm pack` or one of the publish commands
like `pnpm publish`**), we dynamically replace any `workspace:` dependency".

Verified (`/tmp/ws`, dep `@t/a@0.5.0`, manifest read via `tar -xOf … package/package.json`):

| source spec                       | packed spec               |
| --------------------------------- | ------------------------- |
| `workspace:*` / bare `workspace:` | `0.5.0` (exact, no caret) |
| `workspace:^`                     | `^0.5.0`                  |
| `workspace:~`                     | `~0.5.0`                  |
| `workspace:0.5.0`                 | `0.5.0`                   |
| `workspace:^0.5.0`                | `^0.5.0`                  |

Real tarball (`pnpm --filter @ebbjs/client pack`, pre-WIP): `"@ebbjs/core": "0.0.1"`,
`"@ebbjs/storage": "0.0.1"`. `devDependencies` are rewritten too (`@ebbjs/codemirror`:
`workspace:^` → `^0.0.1`), so a no-`workspace:` guardrail must scan devDeps.

10.30.1 source facts:

- `createExportableManifest` drops `pnpm`, `packageManager` and the scripts
  `prepublishOnly, prepack, prepare, postpack, publish, postpublish` (`prepublish` stays).
- Uninstalled workspace dep → `CANNOT_RESOLVE_WORKSPACE_PROTOCOL` ("…not installed. Try
  running `pnpm install`"). Install error, not a registry check.
- Single-package `publish()` never calls `isAlreadyPublished`: pnpm does **not** refuse
  because a sibling version is not on npm yet. `pnpm -r publish` does check and publishes
  topologically — `/tmp/ws` dry run printed `@t/a` (the dependency) first.
- `pnpm publish` delegates (pack to a temp dir, copy `.npmrc` beside the tarball, then
  `runNpm(npmPath, ["publish","--ignore-scripts", tarball, ...args])`).
  `removePnpmSpecificOptions` strips only `--no-git-checks`, `--embed-readme`,
  `--no-embed-readme`, `--publish-branch`, `--npm-path`, so `--provenance`/`--access`
  reach npm: **the runner's npm CLI decides OIDC support, not pnpm.**
- `--no-git-checks` (<https://pnpm.io/10.x/cli/publish>) skips dirty-tree, publish-branch
  (`main`/`master`) and remote-sync checks; changesets adds it itself for pnpm ≥ 5.

## 2. Changesets fixed/lockstep

Use `fixed`, not `linked`: "all packages in the group of fixed packages will be
version-bumped and published together even when there are no changes", while `linked`
bumps only members that have changesets
(<https://github.com/changesets/changesets/blob/maintenance/v2/docs/fixed-packages.md>).

Scratch 7-package workspace (`/tmp/cs`: all `0.0.1`, fixed group of 5, one `minor`
changeset, `privatePackages.version:false`, CLI 3.0.3):

```
@ebbjs/{client,codemirror,core,react,storage} 0.1.0   private=false
  client deps = { '@ebbjs/core': 'workspace:*', '@ebbjs/storage': 'workspace:*' }
@ebbjs/server 0.0.1  private=true      @ebbjs/www 0.0.1  private=true
```

- `0.0.1 + minor = 0.1.0`; changesets leaves `workspace:*` untouched (only pnpm rewrites).
- **v2 differs:** same workspace on CLI 2.31.1 with no `privatePackages` key bumps
  `@ebbjs/server` to `0.0.2` (v2 defaults `privatePackages.version: true`, v3 `false` —
  <https://github.com/changesets/changesets/blob/main/docs/config-file-options.md>).
- No public package depends on `@ebbjs/server`/`@ebbjs/www`; the two private examples do
  (`examples/*/package.json` → `"@ebbjs/server": "workspace:*"`), which is fine since
  they never publish. `private: true` suffices — no `ignore` entry (docs: temporary-only).

```json
{
  "changelog": ["@changesets/changelog-github", { "repo": "ebbjs/ebbjs" }],
  "commit": false,
  "fixed": [
    ["@ebbjs/core", "@ebbjs/storage", "@ebbjs/client", "@ebbjs/react", "@ebbjs/codemirror"]
  ],
  "linked": [],
  "access": "public",
  "baseBranch": "main",
  "updateInternalDependencies": "patch",
  "privatePackages": { "version": false, "tag": false }
}
```

`commit: false` (the action commits). `@changesets/changelog-github` is not bundled
(`@changesets/cli` deps include only `changelog-git`), so it needs a devDep plus
`GITHUB_TOKEN`; `"@changesets/cli/changelog"` is the zero-dep default.
`updateInternalDependencies` only matters once deps are no longer `workspace:*`.

First-release files: `.changeset/config.json`, an initial changeset (`minor` × 5),
`@changesets/cli` devDep, root scripts (`changeset`, `version`→`changeset version`,
`release`→`changeset publish`), `private: false` per publishing package.

`changesets/action` (<https://github.com/changesets/action/blob/maintenance/v1/README.md>):

|                       | v1                                                                                   | v2 (`main`, pairs with CLI 3)                                               |
| --------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- | ------------------------------------------ |
| detects publishes via | stdout regex `/New tag:\s+(@scope\/name                                              | name)@version/`                                                             | JSONL at `$CHANGESETS_OUTPUT` (`--output`) |
| inputs                | `publish`, `version`, `commit`, `title`, `createGithubReleases`, `commitMode`, `cwd` | `publish-script`, `version-script`, `push-git-tags`, `push-with-git-cli`, … |
| outputs               | `published`, `publishedPackages`                                                     | `published`, `published-packages`, `has-changesets`, `pr-number`            |

- Version PR needs `contents: write` + `pull-requests: write` (and the repo setting "Allow
  GitHub Actions to create and approve pull requests"); both are stated in the v2 README
  — the v1 README documents neither, only its inputs/outputs. Add `id-token: write` for OIDC.
- **Do not mix CLI 3 with action v1:** publishing still happens, but v1 never sees
  `New tag:` (3.0.3 prints `Created git tags:` / `- name@version`, `git-tag/utils.ts`),
  so `published` stays false and no Release/tag is pushed.
- No `publish` input ⇒ version PR only; `publish: pnpm release` is what publishes.
- The action writes `.npmrc` `_authToken=${NPM_TOKEN}` **only when `NPM_TOKEN` is set**
  (`src/index.ts`) — leave it unset for OIDC.
- Tags are `<pkg>@<version>` in monorepos, `v<version>` only for single-package repos
  (`packages/cli/src/utils/gitTags.ts`), so #565's `vX.Y.Z` tag needs its own step.

## 3. npm trusted publishing (OIDC), 2026

<https://docs.npmjs.com/trusted-publishers> (page current to Sep 2026):

| requirement      | value                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| npm CLI          | **≥ 11.5.1**                                                                                                                    |
| Node             | **≥ 22.14.0**                                                                                                                   |
| permission       | `id-token: write` (+ `contents: read`)                                                                                          |
| runner           | GitHub-hosted only (self-hosted unsupported)                                                                                    |
| npmjs.com fields | org/user `ebbjs`, repo `ebbjs`, **workflow filename** (`release.yml`, must exist in `.github/workflows/`), optional environment |
| expiry           | a new trusted publisher must publish successfully within 2 days                                                                 |

npm on Node 22 (from <https://nodejs.org/dist/index.json>):
`v22.8.0 → npm 10.8.2`, `v22.14.0 → 10.9.2`, latest v22 (22.23.4) → 10.9.9,
latest v24 (24.22.1) → 11.19.1. So run the publish job on Node 24 or
`npm install -g npm@^11.5.1` first — load-bearing because pnpm shells out to npm.

`NODE_AUTH_TOKEN`/`registry-url`: the 2026 docs example still sets `registry-url` with
`actions/setup-node@v6`; nothing says it must be absent, and unset `NODE_AUTH_TOKEN`
breaks neither tool (`env -u NODE_AUTH_TOKEN pnpm publish --dry-run` with a setup-node
style `.npmrc` only warns that "environment variables are not expanded in
repository-controlled registry credentials", then packs and exits 0; `npm publish
--dry-run` likewise exits 0).

`--provenance` is **not needed**: with trusted publishing "npm automatically generates
and publishes provenance attestations… you don't need to add the `--provenance` flag"
(same page; also <https://docs.npmjs.com/generating-provenance-statements>).
Auto-provenance requires OIDC publish + **public repository** + **public package**;
"not supported for private repositories, even when publishing public packages". Disable
via `NPM_CONFIG_PROVENANCE=false`, `.npmrc provenance=false`, or
`publishConfig.provenance: false`; pnpm's `publishConfig` whitelist excludes
`provenance`/`access`, so both reach npm through the tarball.

`--access public` on first scoped publish (verified locally):

```
$ npm publish --dry-run   → "…with tag latest and default access (dry-run)"
$ # publishConfig: { "access": "public" }
$ npm publish --dry-run   → "…with tag latest and public access (dry-run)"
```

Prefer `publishConfig.access` + changesets `access: "public"` over a CLI flag.

## 4. Idempotent republish

`npm publish` hard-fails: "The publish will fail if the package name and version
combination already exists in the specified registry… can never be used again"
(<https://docs.npmjs.com/cli/v11/commands/npm-publish>); a single `pnpm publish` inherits
that. `pnpm -r publish` skips and exits 0:

```
$ cd /tmp/ws4   # @msgpack/msgpack@3.1.3, already on npm
$ pnpm -r publish --dry-run --no-git-checks
There are no new packages that should be published        # exit 0
```

`changeset publish` skips too — docs ("checking if the version it has in its
`package.json` is published on npm, and if it is not, running the `npm publish`… with
pnpm… it uses `pnpm publish`",
<https://github.com/changesets/changesets/blob/maintenance/v2/docs/command-line-options.md>)
and source (`publishPackages.ts#getUnpublishedPackages` keeps a package only when
`!publishedVersions.includes(localVersion)`; `index.ts` warns "No unpublished projects to
publish" and returns 0; only a real `result:"failed"` throws `ExitError(1)`; CLI 3
behaves the same). npm's `cannot publish over the previously published version` becomes
`result:"skipped"` (`npm-utils.ts#isAlreadyPublishedError`), and the probe is
`npm info <pkg> --json` (npm on PATH, no auth for public reads). CLI 2 publishes with
`Promise.all`, i.e. unordered — safe, because npm never validates deps at publish time.

Recipe: publish only through `changeset publish` / `pnpm -r publish`, never `--force`,
never a per-package loop. Reruns skip existing tags (CLI 3 logs "Skipped tags (already
exist)") but will not back-fill a Release a failed run never created — keep Release
creation in the `published == 'true'` branch.

## 5. Packed-artifact verification

Both tools accept a tarball path (attw's `--pack` is npm-only: "the `--pack` option does
not support package managers other than npm",
<https://github.com/arethetypeswrong/arethetypeswrong.github.io/blob/main/packages/cli/README.md>):

```bash
pnpm --filter @ebbjs/core pack --pack-destination "$PWD/.tarballs"
pnpm exec publint .tarballs/ebbjs-core-0.1.0.tgz
pnpm exec attw .tarballs/ebbjs-core-0.1.0.tgz --profile node16
```

Exit codes: publint → 1 on errors, 0 clean (`--strict` promotes warnings); verified both
ways (`pkg.exports["."].types is ./dist/index.d.ts but the file does not exist.` → 1;
healthy tarball → `All good!` 0). attw → 1 on any non-ignored problem, 0 clean, and **0
when the package has no types at all** (`getExitCode.ts`: `if (!analysis.types) return 0`).

Profile for "node16 and bundler": `--profile node16` ignores only `node10`
(`packages/cli/src/profiles.ts`: `node16: { ignoreResolutions: ["node10"] }`), so
node16-cjs, node16-esm and bundler are all enforced; `strict` adds node10 (fails
`exports`-only packages); `esm-only` also drops node16-cjs — what
`scripts/verify-packages.mjs` uses today. A types-only root export
(`@ebbjs/storage` `"."` = `{"types": …}` only) passes: a fixture mirroring the real
export map reported `OK (ESM)` for node16-from-ESM, `OK` for bundler, and
`ESM (dynamic import only)` for node16-from-CJS on both `"."` and `"./memory"`. The only
trigger is `cjs-resolves-to-esm` (unavoidable for ESM-only `import`-only packages — it
hits every public package here). Both suppressions exit 0:

```bash
attw <tgz> --profile node16 --ignore-rules cjs-resolves-to-esm
attw <tgz> --profile esm-only
```

Baseline: all five real tarballs pass `publint run <tgz>` and
`attw <tgz> --profile node16 --ignore-rules cjs-resolves-to-esm`, packed from the `dist/`
the in-progress build produced (I did not run `pnpm build` myself). An earlier pack of a
**stale `dist/`** gave 6 × `InternalResolutionError`
on `@ebbjs/core` (`./types` without extension under node16 ESM) — the class of bug
`scripts/fix-dts-extensions.mjs` now prevents. Verify after `pnpm build`, never against
a leftover `dist/`.

## 6. npm `files` + LICENSE

<https://docs.npmjs.com/cli/v11/configuring-npm/package-json#files>: `files` is a
whitelist (absent ⇒ `["*"]`); "Certain files are always included, regardless of settings:
`package.json`, `README`, `LICENSE`/`LICENCE` (any case and extension), the file in
`main`, `bin` files". A package-local `LICENSE.txt` needs no entry, but
`files: ["../../LICENSE.txt"]` cannot reach a parent directory. Verified in `/tmp/ws2`
(root `LICENSE.txt` two levels above):

```
npm pack --dry-run  → COPYING, LICENSE, README.md, dist/index.js, package.json
                      (only package-local files; no parent LICENSE)
pnpm pack           → dist/index.js, package.json, README.md, LICENSE.txt
                      (workspace-root LICENSE.txt injected anyway)
```

pnpm injects it: "When publishing a package inside a workspace, the LICENSE file from the
root of the workspace is packed with the package (unless the package has a license of its
own)" (<https://pnpm.io/10.x/cli/publish>); 10.30.1 source:

```js
const LICENSE_GLOB = "LICEN{S,C}E{,.*}";
if (
  opts.workspaceDir != null &&
  dir !== opts.workspaceDir &&
  !files.some((file) => /LICEN[CS]E(?:\..+)?/i.test(file))
) {
  /* add root license */
}
```

That fires even with `files` set, so pnpm needs no copy. Because it is pnpm-only, the
WIP's gitignored per-package `prepack` copy keeps `npm pack` equivalent; the
`LICENSE`/`LICENSE.txt` name matters only for npm's always-include rule, so listing
`"LICENSE.txt"` in `files` is redundant under both.

`prepack` runs on `pnpm pack` and `pnpm publish` (which packs internally); `prepare` also
runs on every `pnpm install` (root and workspace packages), so using it for publish-only
work would dirty the tree on install and make packs non-reproducible.

## 7. `latest` dependency ranges

From `pnpm-lock.yaml` (current; pre-WIP also had `@sinclair/typebox@0.34.49` for
`packages/core` beside `0.34.52` for `packages/client` — hence the single pinned range):

| package             | resolved | where                       | range to write                          |
| ------------------- | -------- | --------------------------- | --------------------------------------- |
| `@msgpack/msgpack`  | 3.1.3    | core deps                   | `^3.1.3`                                |
| `@sinclair/typebox` | 0.34.52  | core + client deps          | `^0.34.52` (caret on 0.x = `<0.35.0`)   |
| `nanoid`            | 5.1.7    | core deps, root deps        | `^5.1.7` (`3.3.11` exists transitively) |
| `idb`               | 8.0.3    | storage optional peer + dev | `^8.0.3` (unchanged)                    |
| `react`             | 19.2.4   | react peer + dev            | `^18.0.0 \|\| ^19.0.0` (unchanged)      |
| `@codemirror/state` | 6.6.0    | codemirror peer + dev       | `^6.6.0` (from `^6.5.0`)                |
| `@codemirror/view`  | 6.40.0   | codemirror peer + dev       | `^6.40.0` (from `^6.30.0`)              |
| `codemirror`        | 6.0.2    | codemirror peer + dev       | `^6.0.0` (fine)                         |

## Decisions for #565

- Keep `workspace:*` in source (packed as exact `0.1.0`); use `workspace:^` only if
  published manifests should carry `^0.1.0`. Never hand-write version literals.
- `fixed` group of the five public packages (`linked` is not lockstep); `access: "public"`,
  `baseBranch: "main"`, `commit: false`, `privatePackages: {version:false,tag:false}`
  (mandatory under any CLI 2.x), `updateInternalDependencies: "patch"`.
- Pick one pair: `@changesets/cli@^3` + `changesets/action@v2`, or
  `@changesets/cli@^2.31` + `changesets/action@v1`. CLI 3 + action v1 silently skips
  GitHub Releases.
- Release workflow: `permissions: {contents: write, pull-requests: write, id-token: write}`;
  no `NPM_TOKEN`, no provenance flag; Node 24 (or `npm i -g npm@^11.5.1`);
  `publish: pnpm release`. Add an explicit `v<version>` tag/Release step — changesets
  tags `@ebbjs/<pkg>@<version>`.
- Idempotency: publish only via `changeset publish` / `pnpm -r publish`; no `--force`, no
  per-package loop.
- Verification: pack after a fresh build, then `publint run <tgz>` and
  `attw <tgz> --profile node16 --ignore-rules cjs-resolves-to-esm` (or `--profile
esm-only`); extend `scripts/verify-packages.mjs` to scan **devDependencies** for
  leftover `workspace:`.
- LICENSE: keep the `prepack` copy (npm-compatible); pnpm's root injection is the safety
  net, so `"LICENSE.txt"` in `files` is optional.
- Ranges `^3.1.3`, `^0.34.52`, `^5.1.7`; bump CodeMirror peers to `^6.6.0`/`^6.40.0`.
- The WIP that landed during this research (`.github/workflows/release.yml`,
  `.changeset/config.json`) already matches the findings above: CLI 3 + `changesets/action@v2`
  (tags `v2.0.0`–`v2.1.2` exist, `api.github.com/repos/changesets/action/git/refs/tags`),
  `id-token: write`, no `registry-url`, `npm i -g npm@^11.5.1` on Node 22,
  `privatePackages` off, `format: "oxfmt"` (valid: `"auto"|"prettier"|"oxfmt"|"deno"|"dprint"|false`,
  changesets `types/src/index.ts`), and a separate `v<version>` GitHub Release step.

## Open questions

- No real OIDC publish was executed (no credentials; publishing out of scope), so
  trusted publishing + provenance is doc-verified only. The trusted publisher must
  complete its first publish within 2 days or it expires.
- Untested: npm behaviour when a user-level `~/.npmrc` holds a stale `_authToken`
  alongside OIDC (pnpm ignores repo-level auth lines; npm's token-vs-OIDC precedence was
  not exercised).
- `commitMode: "github-api"` (GPG-signed commits/tags) vs `git-cli` under this repo's
  branch protection is unverified; the WIP uses the default (`git-cli`).
