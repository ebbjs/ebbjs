# Contributing

## Commits

[Conventional Commits](https://www.conventionalcommits.org/).

```
<type>(<scope>): <subject>

<body>

<footer>
```

- **types:** `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `perf`, `ci`, `build`, `style`
- **scope** (in parens): the affected package or area, e.g. `(client)`, `(ebb_server)`, `(hooks)`
- **subject:** lowercase, imperative mood, no trailing period, ≤72 chars
- **body:** explain _why_, not _what_; wrap at 72 chars
- **footer:** `(#NN)` for issue references, `BREAKING CHANGE:` notes for breaking changes

The template at `.gitmessage` is wired into `prepare` and applied automatically on `pnpm install`.

## Branches

`<type>/<description>` or `<type>/issue-<N>-<description>`

- types match the commit convention above, plus `debug` for local exploration
- description is kebab-case, e.g. `reconnect-backoff`
- include the issue number when one exists; omit for purely-local work

Examples:

- `fix/issue-40-reconnect-backoff`
- `feat/issue-61-slice4-playwright-scenarios`
- `chore/devex-cleanup`

GitHub disallows `#` in branch names, so the issue number goes _after_ the dash, not as `#40`.

The `pre-push` hook in `lefthook.yml` emits a soft warning for non-conforming names. The push is not blocked.

## Pull Requests

PR body uses [`.github/PULL_REQUEST_TEMPLATE.md`](.github/PULL_REQUEST_TEMPLATE.md):

- **Summary** — with a diff sketch, call tree, or diagram
- **Evidence** — before/after, with concrete output (test runs, screenshots, repros)
- **Merge Danger** — one-way vs. two-way door + blast radius

## Issues

- **Bug reports:** [`.github/ISSUE_TEMPLATE/bug.md`](.github/ISSUE_TEMPLATE/bug.md)
- **Feature requests:** [`.github/ISSUE_TEMPLATE/feature.md`](.github/ISSUE_TEMPLATE/feature.md)

## Code Style

- Prefer functional style over OO: pure functions, immutable data,
  avoid class hierarchies and inheritance.
- Comments document intent for future maintainers. Don't narrate
  what the code does or explain choices visible in the code.

## Local setup

```bash
pnpm install          # installs hooks + wires commit.template (via scripts/install-dev-tools.sh)
pnpm typecheck        # typecheck (root-level project references)
pnpm core:build       # build a single package
pnpm setup:ebb-server # install Elixir system deps (see scripts/setup-ebb-server.sh)
```

See `ebb_server/README.md` for the Elixir server's own setup notes.
