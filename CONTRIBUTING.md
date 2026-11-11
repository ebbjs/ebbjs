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

## Releasing

The seven public `@ebbjs/*` packages are published from `main` by the Release
workflow, versioned in lockstep with changesets. Add a changeset
(`pnpm changeset`) to any PR that changes a published package, and see
[`docs/tooling/releasing.md`](docs/tooling/releasing.md) for the release flow,
the npm trusted-publishing setup, and the artifact guardrails.

While pre-alpha, **every changeset is `minor`** and the release train never
crosses `2.0.0`; the full policy is in the releasing guide.

## Local setup

```bash
pnpm install          # hooks, commit.template, and a shared ebb_server/deps (scripts/install-dev-tools.sh)
pnpm setup:ebb-server # install Elixir system deps (see scripts/setup-ebb-server.sh)
pnpm build            # build every package — required before pnpm test
pnpm test             # run the test suite
pnpm typecheck        # typecheck (root-level project references)
pnpm core:build       # rebuild a single package
```

Tests import sibling workspaces through their built `dist/` entry points, so
`pnpm build` is a prerequisite for `pnpm test`. The root `pretest` hook checks
for missing build output and points back here if you skipped it.

See `ebb_server/README.md` for the Elixir server's own setup notes.

### Tailscale gateway (`ebb_server/tsnode`)

The embedded gateway is Go; the version is pinned in `ebb_server/.tool-versions`
(`asdf plugin add golang && asdf install`). Three loops, cheapest first:

```bash
bash scripts/check-tsnode-contract.sh  # Go↔BEAM contract, seconds (pre-commit)
bash scripts/dev-tsnode.sh             # gateway + stub backend, no tailnet
bash scripts/tsnode-e2e.sh             # real Headscale + real client, Docker
```

`scripts/tsnode-e2e.sh` is also the `tsnode-e2e` CI job: it runs the real binary
against a real control plane and asserts that identity reaches the backend
through `WhoIs`.

Hooks are fast by design. `pre-commit` runs formatters, `gofmt`, and the
contract check, scoped to the staged side (seconds). `pre-push` runs
`mix compile --warnings-as-errors` and `go test`, nothing more. The Elixir
suite, Credo, the Docker smoke test, and the Headscale harness run in CI, which
gates every merge; run `pnpm test`, `mix test`, or `mix credo --strict` yourself
when you want them before pushing.
