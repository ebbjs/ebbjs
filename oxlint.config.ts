import { defineConfig, type AllowWarnDeny } from "oxlint";

/**
 * Anti-slop rules from the vendored plugin in `tools/oxlint/anti-slop`.
 *
 * They start at `warn` while the existing findings are migrated; each rule is
 * promoted to `error` once its count reaches zero. The final state is `error`
 * for every rule.
 */
const antiSlopRuleNames = [
  "no-array-filter-map",
  "no-reduce-accumulator-copy",
  "no-chained-type-assertions",
  "no-conditional-empty-object-spread",
  "no-known-value-widening",
  "no-module-mocking",
  "no-object-parameters",
  "no-reflect-apply",
  "no-reflect-get",
  "no-runtime-typeof",
  "no-shape-in-symbol-names",
  "no-unknown-parameters",
  "no-unknown-returns",
  "no-unknown-type-aliases",
  "no-unsafe-dictionary-type",
  "no-widen-then-assert",
  "require-readable-spacing",
  "require-safety-comment-for-type-assertion",
] as const;

const antiSlopRules = Object.fromEntries(
  antiSlopRuleNames.map((rule) => [`anti-slop/${rule}`, "warn" satisfies AllowWarnDeny]),
) as Record<`anti-slop/${(typeof antiSlopRuleNames)[number]}`, AllowWarnDeny>;

const disableAntiSlopRules = Object.fromEntries(
  antiSlopRuleNames.map((rule) => [`anti-slop/${rule}`, "off" satisfies AllowWarnDeny]),
) as typeof antiSlopRules;

/**
 * Trees where anti-slop does not apply: tests deliberately traffic in
 * malformed and `unknown` data, and `experiment/` and `examples/` are
 * throwaway or illustrative code. Default Oxlint rules still run there.
 */
const antiSlopExcludedFiles = [
  "**/__tests__/**",
  "**/*.test.ts",
  "**/*.test.tsx",
  "**/*.spec.ts",
  "**/*.spec.tsx",
  "**/e2e/**",
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
  jsPlugins: [
    { name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" },
  ],
  rules: {
    "oxc/no-accumulating-spread": "error",
    ...antiSlopRules,
  },
  overrides: [
    {
      files: antiSlopExcludedFiles,
      rules: disableAntiSlopRules,
    },
  ],
});
