# anti-slop

[anti-slop](https://github.com/dmmulroy/anti-slop) is a set of opinionated
Oxlint rules that reject low-evidence TypeScript patterns (`unknown` contracts,
type-assertion chains, runtime `typeof` narrowing, `Record<string, unknown>`
dictionaries). It is meant to be **vendored** and tuned, not consumed as a
package.

This document records the phase-1 adoption: the vendored plugin, the rules we
enforce today, the measured findings still to migrate, and the plan for the
rest.

## Setup

- `tools/oxlint/anti-slop/` — the vendored plugin (upstream `src/` plus its
  `LICENSE`). Provenance is in `tools/oxlint/anti-slop/UPSTREAM.md`.
- `oxlint.config.ts` — registers the plugin and splits the rules into
  **enforced** (`error`) and **pending** (`warn`).
- `@oxlint/plugins` and `oxlint` are pinned to the same exact version
  (`1.56.0`). The plugin's runtime API is tied to the Oxlint version, so the
  two must move together.
- `.prettierignore` excludes `tools/oxlint/anti-slop/` so the vendored source
  stays byte-identical to upstream for clean updates.
- CI already runs `pnpm lint` (`.github/workflows/ci.yml`, `typescript-lint`).
  Enforced rules are `error`, so that job now blocks regressions; pending rules
  are `warn` and do not fail the build.

The plugin works on the Oxlint version already in our lockfile even though
upstream targets a newer one; every rule was verified to fire on a fixture.

Note: the root `pnpm typecheck` runs `tsc --noEmit` over a solution-style
`tsconfig.json` with only project references, so it does not actually check the
packages. The real typecheck is `pnpm build` (via `vite-plugin-checker` inside
each package). Verify type changes with `pnpm build`, not `pnpm typecheck`.

## Scope

Anti-slop runs on shipped source only. The config turns it off for:

`**/__tests__/**`, `**/test/**`, `**/*.test.ts(x)`, `**/*.spec.ts(x)`,
`**/test-utils.ts`, `**/e2e/**`, `**/benchmark/**`, `experiment/**`,
`examples/**`.

Those trees deliberately traffic in malformed and `unknown` data, or are not
shipped contracts. Default Oxlint rules still run there. As a result all 1365
measured findings are in source (0 in the excluded trees).

## Enforced rules (phase 1)

These run at `error` and report zero findings. `Fixed` is how many findings
phase 1 removed.

| Rule                                 | Fixed | What it catches                         |
| ------------------------------------ | ----: | --------------------------------------- |
| `no-array-filter-map`                |     2 | consecutive `map`/`filter` passes       |
| `no-conditional-empty-object-spread` |     0 | conditional `{}` spread to omit a field |
| `no-module-mocking`                  |     0 | `vi.mock` (tests are out of scope)      |
| `no-object-parameters`               |     0 | `object` parameters                     |
| `no-reduce-accumulator-copy`         |     0 | copying reducer accumulators            |
| `no-reflect-apply`                   |     0 | `Reflect.apply`                         |
| `no-unknown-type-aliases`            |     0 | `type X = unknown`                      |
| `no-widen-then-assert`               |     0 | widen to `unknown`, assert back         |

What the fixes actually improved:

- `liveMemberships` did `rows.map(...).filter(...)`; it now does one
  `flatMap` pass (`packages/client/src/sync/entity-group.ts`).
- The memory store's `query` ended in `.filter(Boolean)` on a `map` whose
  result is never falsy — the filter was dead. Removed
  (`packages/storage/src/memory/entity-store.memory.ts`).

Evaluating `no-chained-type-assertions` also paid off even though the rule is
not yet enforceable (see below): 11 of its 15 findings were redundant casts
that are now gone, including the IndexedDB entity store's four
`as unknown as Entity` casts (`IDBPDatabase<EbbDBSchema>` is already typed),
`toPublicAction`'s `rest as unknown as Action`, and two `as unknown as` probes
in `isNullableSchema`, which now uses an `in` check and
`Object.getOwnPropertyDescriptor`.

## Deferred: chained assertions and `unknown` returns

`no-chained-type-assertions` (4 findings) and `no-unknown-returns` (2) are
**not** enforced. The remaining findings are intentional type erasure at four
sites:

- `atomic.ts` `markHandle` / draft `create` — the draft handle is built
  dynamically and asserted to `AtomicHandle` / `CreatedEntity`.
- `client.ts` action `RUN` descriptor — the erased call signature must accept
  `unknown` params and return `unknown`.
- `namespace.ts` row assembly — the projected object is asserted to
  `EntityRow<TFields, TAccessors>`.

TypeScript requires `as unknown as T` when the source and target do not
sufficiently overlap; it rejects the single assertion. In other words, the rule
conflicts with the language exactly at the erasure boundaries this code
intentionally uses. Satisfying it means refactoring the erased types rather
than swapping one cast for another. That is the work tracked in the migration
plan, not a mechanical fix.

## Pending rules (measured, not enforced)

These are `off` in the config, so `pnpm lint` is clean and CI enforces only the
adopted set. The table is the measured inventory on this branch; move a rule to
`enforcedAntiSlopRuleNames` (or re-enable it) to reproduce its findings. Keeping
them `off` rather than `warn` also stops lefthook's pre-commit `oxlint --fix`
from silently applying pending autofixes to staged files.

| Rule                                        | Findings | Nature                    |
| ------------------------------------------- | -------: | ------------------------- |
| `require-readable-spacing`                  |     1029 | style; autofixable        |
| `require-safety-comment-for-type-assertion` |      105 | needs `SAFETY:` comments  |
| `no-shape-in-symbol-names`                  |       83 | naming taste              |
| `no-runtime-typeof`                         |       53 | boundary parsing          |
| `no-known-value-widening`                   |       39 | type evidence             |
| `no-unsafe-dictionary-type`                 |       26 | boundary parsing          |
| `no-unknown-parameters`                     |       23 | boundary parsing          |
| `no-chained-type-assertions`                |        4 | type-erasure refactor     |
| `no-unknown-returns`                        |        2 | type-erasure refactor     |
| `no-reflect-get`                            |        1 | one legitimate Proxy trap |
| **Total**                                   | **1365** |                           |

Four pre-existing `eslint(no-unused-vars)` warnings are unrelated.

## Migration plan

Rules are promoted from `pendingAntiSlopRuleNames` to
`enforcedAntiSlopRuleNames` only once they report zero findings.

1. **`require-readable-spacing` (1029).** One mechanical `oxlint --fix` commit:
   whitespace only (+1029 blank lines, 0 deletions) and `oxfmt` accepts the
   result, so the two tools do not fight. Wide diff, no semantic risk.
2. **`no-known-value-widening` (39).** Replace explicit wide annotations
   (`Record<string, X>`, anonymous object types) with inference or `satisfies`.
   Mostly mechanical, per file. Best next rule to adopt.
3. **`no-chained-type-assertions` (4) + `no-unknown-returns` (2).** Refactor
   the four erased boundaries above so the values are typed at construction
   instead of asserted after the fact. No `unknown` bridge once the types
   overlap.
4. **`no-unsafe-dictionary-type` (26) + `no-unknown-parameters` (23) +
   `no-runtime-typeof` (53).** These are one decision: how the codebase parses
   external payloads. We have no schema/parser library (no zod/valibot/arktype/
   Effect), so the rules' "parse at the boundary" advice needs a mechanism.
   Options: introduce a JSON/domain parser for serialization boundaries, or
   keep named `unknown`-backed aliases and leave these rules pending.
   `no-runtime-typeof` only has ~2 checks inside type guards, so
   `{ "allowInTypeGuards": true }` is not a meaningful shortcut.
5. **`require-safety-comment-for-type-assertion` (105).** Adopt a `SAFETY:`
   comment convention for necessary assertions. Do this after steps 1–4, which
   remove assertions, so the comment count only decreases.
6. **`no-shape-in-symbol-names` (83).** "Shape" is deliberate domain vocabulary
   here (`ShapeFields`, `sourceShape`, `targetShape`). Renaming is churn with
   no correctness value; recommend either keeping it pending indefinitely or
   removing it from both lists with a note.
7. **`no-reflect-get` (1).** The single finding is a Proxy `get` trap
   (`packages/client/src/sync/client.ts`), where `Reflect.get(target, prop,
receiver)` is the correct implementation. Either refactor the Proxy or leave
   the rule pending with a documented justification.

The opt-in Effect rules are not relevant: no package depends on Effect.

## Evaluation notes

- Phase 1 found real problems: a dead `.filter(Boolean)`, redundant casts, and
  assertion chains. The zero-count rules were already clean, so they cost
  nothing to enforce.
- The rules are syntactic and operate per file; they resolve same-file aliases
  but do not follow imported type definitions. `no-unknown-returns` can
  therefore be satisfied by naming a domain alias whose underlying type is
  still `unknown` (`FieldValue["value"]` in `atomic.ts`/`query-builder.ts`).
  Those contracts are honestly still `unknown` at the leaves until a parser
  exists; the alias improves naming, not evidence.
- `no-chained-type-assertions` is the sharpest example of a rule that is right
  in principle but fights TypeScript at intentional erasure boundaries.
- The two biggest blocks (spacing, safety comments) are style and convention,
  not architecture. The architecture-sensitive block is the boundary-parsing
  family (step 4), which is why it is deferred.
- `no-shape-in-symbol-names` and `no-reflect-get` are candidates to drop or
  justify rather than satisfy; anti-slop is explicitly a taste-driven ruleset.

## Reproducing

```bash
pnpm lint                        # enforced rules error; pending rules are off
pnpm exec oxlint --format=json   # machine-readable findings
pnpm exec oxlint --fix           # style autofix (blank lines)
pnpm build                       # real typecheck; pnpm typecheck is a no-op
```

To re-measure a single pending rule, temporarily move it to
`enforcedAntiSlopRuleNames` or lower it to `"warn"` in place, then run
`pnpm lint`.
