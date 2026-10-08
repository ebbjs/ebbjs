import { defineConfig, type AllowWarnDeny } from "oxlint";

/**
 * Anti-slop rules whose findings are migrated. These are enforced in CI.
 *
 * Add a rule here once `pnpm lint:anti-slop` reports zero findings for it.
 */
const enforcedAntiSlopRuleNames = [
  "no-array-filter-map",
  "no-conditional-empty-object-spread",
  "no-module-mocking",
  "no-object-parameters",
  "no-reduce-accumulator-copy",
  "no-reflect-apply",
  "no-unknown-type-aliases",
  "no-widen-then-assert",
] as const;

/**
 * Anti-slop rules still to migrate. They are off rather than warn so that
 * `pnpm lint` stays clean, CI enforces only the adopted set, and lefthook's
 * pre-commit `oxlint --fix` cannot silently apply their autofixes. The
 * inventory and migration plan are in `docs/tooling/anti-slop.md`; re-enable a
 * rule temporarily to re-measure it.
 */
const pendingAntiSlopRuleNames = [
  "no-chained-type-assertions",
  "no-known-value-widening",
  "no-reflect-get",
  "no-runtime-typeof",
  "no-shape-in-symbol-names",
  "no-unknown-parameters",
  "no-unknown-returns",
  "no-unsafe-dictionary-type",
  "require-readable-spacing",
  "require-safety-comment-for-type-assertion",
] as const;

const allAntiSlopRuleNames = [...enforcedAntiSlopRuleNames, ...pendingAntiSlopRuleNames];

const antiSlopRulesAt = (ruleNames: readonly string[], level: AllowWarnDeny) =>
  Object.fromEntries(ruleNames.map((rule) => [`anti-slop/${rule}`, level]));

/**
 * Trees where anti-slop does not apply: tests deliberately traffic in
 * malformed and `unknown` data, test utilities and benchmarks are not shipped
 * contracts, and `experiment/` and `examples/` are throwaway or illustrative
 * code. Default Oxlint rules still run there.
 */
const antiSlopExcludedFiles = [
  "**/__tests__/**",
  "**/test/**",
  "**/*.test.ts",
  "**/*.test.tsx",
  "**/*.spec.ts",
  "**/*.spec.tsx",
  "**/test-utils.ts",
  "**/e2e/**",
  "**/benchmark/**",
  "experiment/**",
  "examples/**",
];

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
  jsPlugins: [{ name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" }],
  rules: {
    "oxc/no-accumulating-spread": "error",
    ...antiSlopRulesAt(enforcedAntiSlopRuleNames, "error"),
    ...antiSlopRulesAt(pendingAntiSlopRuleNames, "off"),
  },
  overrides: [
    {
      files: antiSlopExcludedFiles,
      rules: antiSlopRulesAt(allAntiSlopRuleNames, "off"),
    },
  ],
});
