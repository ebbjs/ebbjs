# Investigation: adopting anti-slop Oxlint rules

Source: <https://github.com/dmmulroy/anti-slop> at commit
`c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b` (2026-09-10).

## Summary

anti-slop is a set of opinionated Oxlint JS-plugin rules that reject
"low-evidence" TypeScript patterns (`unknown` contracts, type-assertion
chains, runtime `typeof` narrowing, `Record<string, unknown>` dictionaries,
noisy spacing). It is designed to be **vendored**, not installed as a
dependency.

The plugin loads and every rule runs under the Oxlint version already in our
lockfile (1.56.0), even though upstream pins 1.78.0. Enabling the full
ruleset on `main` produces **3099 errors across 258 files** (baseline is
0 errors). Roughly a third are style and auto-fixable; the rest require real
design changes. This document is the investigation, not an adoption.

## What was tried

A working proof of concept was built locally for this investigation (not
committed; re-create it from the appendix):

- `tools/oxlint/anti-slop/` — the vendored plugin copied from upstream `src/`
  (46 files, 368 KB).
- `oxlint.config.ts` — registers the plugin and enables all 19 generic rules
  plus native `oxc/no-accumulating-spread`.
- `package.json` / `pnpm-lock.yaml` — `@oxlint/plugins@1.56.0` added as a root
  dev dependency, pinned exactly to the installed Oxlint version.

Commands:

```bash
pnpm exec oxlint              # full run
pnpm exec oxlint --fix        # style autofix
pnpm exec oxlint --format=json > /tmp/anti-slop.json
```

## Compatibility

| | |
|---|---|
| Declared Oxlint range | `^1.47.0` |
| Installed Oxlint | `1.56.0` |
| `@oxlint/plugins` installed | `1.56.0` (exists and matches) |
| anti-slop upstream target | Oxlint `1.78.0` |

Findings:

- **It works on 1.56.0.** The config loaded, all rule names were accepted, and
  a fixture exercised every rule that reported zero hits in our tree
  (`no-object-parameters`, `no-reduce-accumulator-copy`, `no-reflect-apply`,
  `no-unknown-type-aliases`, `no-widen-then-assert`) and confirmed they fire.
  No rule failed to load or silently no-opped.
- `@oxlint/plugins` versions exist for every Oxlint minor since 1.43, so
  pinning the pair is possible without upgrading Oxlint.
- The config **must** be named `oxlint.config.ts`. Renaming it to
  `oxlint.config.mts` silently disables it in 1.56 (no config loaded, 93 rules
  instead of 112). Loading the `.ts` config emits a
  `MODULE_TYPELESS_PACKAGE_JSON` warning on stderr because the root
  `package.json` has no `"type": "module"`. It is cosmetic; adding
  `"type": "module"` would silence it but is a repo-wide change.
- No package declares `effect`, so the opt-in Effect rules are not relevant.
- `@oxlint/plugins` must be pinned exactly to the Oxlint version. The root
  `package.json` currently uses a `^` range for Oxlint; a `pnpm update` that
  bumps Oxlint without bumping `@oxlint/plugins` would drift the pair.

## Violation inventory

Baseline (`main`, no anti-slop): 0 errors, 4 warnings, 258 files, 93 rules.
With anti-slop: 3099 errors, 258 files, 112 rules, ~1.2 s.

| Rule | Test/experiment | Source | Total |
|---|---:|---:|---:|
| `require-readable-spacing` | 1143 | 1133 | 2276 |
| `require-safety-comment-for-type-assertion` | 252 | 143 | 395 |
| `no-shape-in-symbol-names` | 16 | 84 | 100 |
| `no-runtime-typeof` | 42 | 55 | 97 |
| `no-chained-type-assertions` | 63 | 18 | 81 |
| `no-known-value-widening` | 18 | 44 | 62 |
| `no-unsafe-dictionary-type` | 15 | 27 | 42 |
| `no-unknown-parameters` | 8 | 23 | 31 |
| `no-unknown-returns` | 6 | 5 | 11 |
| `no-array-filter-map` | 0 | 2 | 2 |
| `no-conditional-empty-object-spread` | 1 | 0 | 1 |
| `no-reflect-get` | 0 | 1 | 1 |
| `oxc/no-accumulating-spread` | 0 | 0 | 0 |
| **Total** | **1564** | **1539** | **3103** |

Roughly half of all findings sit in `__tests__`, `*.spec.*`, `experiment/`,
and `examples/` trees, where deliberately malformed/`unknown` data is the
point of the test. Adopting anti-slop in tests as-is is mostly noise.

Concentration by area: `packages/client` 2133, `packages/storage` 201,
`packages/www` 193, `experiment/` 173, `examples/` 114, `packages/core` 101,
`packages/codemirror` 88, `packages/react` 25, `packages/server` 19,
`scripts/` 13. Oxlint also lints the 27 `.astro` files (40 findings) and
`scripts/*.mjs` (13 findings) — those are outside the TS package build.

## What autofix gets us

`pnpm exec oxlint --fix` rewrites **169 files, +2286 lines, 0 deletions** —
pure blank-line insertions from `require-readable-spacing`. It leaves
**823 errors**:

| Rule | Remaining |
|---|---:|
| `require-safety-comment-for-type-assertion` | 395 |
| `no-shape-in-symbol-names` | 100 |
| `no-runtime-typeof` | 97 |
| `no-chained-type-assertions` | 81 |
| `no-known-value-widening` | 62 |
| `no-unsafe-dictionary-type` | 42 |
| `no-unknown-parameters` | 31 |
| `no-unknown-returns` | 11 |
| `no-array-filter-map` | 2 |
| `no-conditional-empty-object-spread` | 1 |
| `no-reflect-get` | 1 |
| `eslint(no-unused-vars)` (pre-existing) | 4 |

Formatter interaction: `oxfmt --check` accepts the spacing autofix. On
`packages/client/src/schema/schema.ts` the fix added four blank lines and
`oxfmt` still reported "correct format", so the two tools do not fight.

## Rules that need a policy decision

- **`require-safety-comment-for-type-assertion` (395).** Every non-`const`
  assertion needs a `// SAFETY:` justification. The repo currently has zero
  `SAFETY`/`INVARIANT` comments, so this is entirely new convention. Markers
  are configurable (e.g. `["INVARIANT", "SAFETY"]`) if we already have a
  preferred word — we do not.
- **`no-shape-in-symbol-names` (100).** Rejects the substring `shape` in
  locally owned names. We use it deliberately (`snapshotShape`, entity
  "shape" vocabulary). Either rename or drop this rule; it is taste, not
  correctness.
- **`no-runtime-typeof` (97).** Requires parsing at I/O boundaries instead of
  `typeof` narrowing. We have no schema/parser library (no zod/valibot/
  arktype/Effect), so "parse at the boundary" has no existing mechanism. The
  rule supports `{ "allowInTypeGuards": true }` to keep narrowing inside type
  predicates.
- **`no-unsafe-dictionary-type` (42) + `no-unknown-parameters` (31) +
  `no-unknown-returns` (11) + `no-unknown-type-aliases` (0).** These push
  `unknown` out of internal contracts and into named boundary parsers. For a
  sync/serialization framework this is a real architecture question, not a
  lint fix.
- **`no-known-value-widening` (62).** Mostly explicit `Record<string, X>` on
  known-key literals; often fixable with `satisfies`.
- **`no-chained-type-assertions` (81).** `as unknown as X` chains, mostly in
  test helpers.

## Operational impact

- `pnpm lint` (CI `typescript-lint`) would fail immediately at the current
  severities. CI runs it on every PR.
- `lefthook` `pre-commit` runs `oxlint --fix {staged_files}` with
  `stage_fixed: true`. Once the plugin is active at `error`, any commit
  touching a file with an unfixable finding is blocked. The spacing fixes
  would be applied and re-staged automatically.
- Runtime cost of the plugin is negligible (~1.2 s for the whole repo).

## Options

1. **Report only.** Keep anti-slop out of the repo; adopt individual ideas
   (e.g. `satisfies` over widening) through review and `AGENTS.md`.
2. **Phased adoption, warnings first.** Land the vendored plugin + config with
   the full ruleset at `"warn"` (CI stays green), scope it to package `src/`
   (not tests/examples/experiment), autofix spacing, then promote rules to
   `"error"` rule-by-rule as each reaches zero. This mirrors upstream's
   "vendored, make it yours" intent.
3. **Curated subset at `error` now.** Enable only the low-volume, high-signal
   rules (`no-array-filter-map`, `no-conditional-empty-object-spread`,
   `no-reflect-get`, `oxc/no-accumulating-spread`, `no-reduce-accumulator-copy`,
   `no-module-mocking`, `require-readable-spacing`) and defer the boundary-
   parsing family until we have a parsing story.
4. **Full adoption.** ~823 manual fixes plus 395 SAFETY comments. Largest
   effort, and it forces decisions about `unknown` at serialization
   boundaries before we have a parser.

## Recommendation

Option 2, scoped and inverted: start with the deterministic rules at `error`
(`require-readable-spacing` after one autofix pass, the zero/near-zero
correctness rules), and hold the boundary-parsing family and
`require-safety-comment-for-type-assertion` at `warn` until we decide on a
parsing library and assert-comment convention. Add `ignorePatterns` for
test/experiment/example trees rather than fighting their intentional
malformed data, and pin Oxlint + `@oxlint/plugins` exactly together.

## Reproducing

To reproduce the measurements:

```bash
pnpm exec oxlint --format=json > /tmp/anti-slop.json
pnpm exec oxlint --fix            # then `git diff --stat` to see style churn
```

## Appendix: exact setup used

1. Vendor upstream `src/` to `tools/oxlint/anti-slop/` (keep the nested
   `vendor/eslint-stylistic/LICENSE` and `UPSTREAM.md`).
2. `pnpm add -D -w @oxlint/plugins@1.56.0 --save-exact` (match the installed
   Oxlint version).
3. Add `oxlint.config.ts`:

```ts
import { defineConfig } from "oxlint";

export default defineConfig({
  ignorePatterns: [
    ".agent/**",
    ".agents/**",
    ".claude/**",
    ".codex/**",
    ".continue/**",
    ".cursor/**",
    ".gemini/**",
    ".opencode/**",
    ".pi/**",
    ".roo/**",
    ".windsurf/**",
    "tools/oxlint/anti-slop/**",
  ],
  jsPlugins: [
    { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
  ],
  rules: {
    "oxc/no-accumulating-spread": "error",
    "anti-slop/no-array-filter-map": "error",
    "anti-slop/no-reduce-accumulator-copy": "error",
    "anti-slop/no-chained-type-assertions": "error",
    "anti-slop/no-conditional-empty-object-spread": "error",
    "anti-slop/no-known-value-widening": "error",
    "anti-slop/no-module-mocking": "error",
    "anti-slop/no-object-parameters": "error",
    "anti-slop/no-reflect-apply": "error",
    "anti-slop/no-reflect-get": "error",
    "anti-slop/no-runtime-typeof": "error",
    "anti-slop/no-shape-in-symbol-names": "error",
    "anti-slop/no-unknown-parameters": "error",
    "anti-slop/no-unknown-returns": "error",
    "anti-slop/no-unknown-type-aliases": "error",
    "anti-slop/no-unsafe-dictionary-type": "error",
    "anti-slop/no-widen-then-assert": "error",
    "anti-slop/require-readable-spacing": "error",
    "anti-slop/require-safety-comment-for-type-assertion": "error",
  },
});
```

The PoC used for this investigation enabled every generic rule at `error` and
is expected to fail `pnpm lint`; it exists to measure the gap.
