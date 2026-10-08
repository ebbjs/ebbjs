# anti-slop

Vendored Oxlint plugin. Do not edit the rules in place without recording the
change below; upstream is the canonical source for the copied files.

- **Source:** <https://github.com/dmmulroy/anti-slop>
- **Revision:** `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b` (2026-09-10)
- **Installed paths:** `tools/oxlint/anti-slop/` (entry point `index.ts`)
- **Plugin dependencies:** `@oxlint/plugins` pinned to the installed Oxlint
  version in the root `package.json`.
- **Intentional deviations from upstream:** none yet. Upstream's README rule
  set is enabled in `oxlint.config.ts`, except that the generic rules are
  scoped out of test, `experiment/`, and `examples/` trees via an override,
  and severities are promoted from `warn` to `error` as each rule's findings
  reach zero.

Upstream is MIT-licensed; the copied `LICENSE` travels with the plugin, and
`vendor/eslint-stylistic/` carries its own license and provenance.
