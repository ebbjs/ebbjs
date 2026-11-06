# Agents

## Code Style

- Prefer functional style over OO: pure functions, immutable data,
  avoid class hierarchies and inheritance.
- Comments document intent for future maintainers. Don't narrate
  what the code does or explain choices visible in the code.

## Worktrees

- `ebb_server/deps` is git-ignored and holds a ~50 minute RocksDB build. Before
  running any `mix` command in a fresh worktree, run
  `bash scripts/ebb-server-deps.sh` (`pnpm install` already does) so the
  checkout shares an existing build instead of recompiling it.
- That makes `ebb_server/deps` a symlink into another worktree. Never run
  `mix deps.clean`, `mix deps.update`, or a lockfile-following `mix deps.get`
  there; they write through the link into the shared tree.
- `ebb_server/tsnode` is Go; the version is pinned in `ebb_server/.tool-versions`.
  `bash scripts/dev-tsnode.sh` runs the gateway with no tailnet,
  `bash scripts/tsnode-e2e.sh` runs it against Headscale in Docker, and
  `bash scripts/check-tsnode-contract.sh` is the seconds-long Go↔BEAM contract
  check that `pre-commit` runs.
