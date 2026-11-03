# ebb_server dependency builds across worktrees

`ebb_server/deps/` is git-ignored, so every new worktree starts without it, and
the first `mix` command in that worktree compiles the dependency tree from
scratch. Almost all of that work is one dependency.

## What the build costs

The `rocksdb` hex package (`erlang-rocksdb`) ships the RocksDB C++ sources and
compiles them through cmake from a rebar3 compile hook. Nothing in the repo
builds it incrementally across worktrees: the sources, the object files and the
resulting NIF all live inside the checkout's `deps/`.

Measured in a fresh worktree, `mix deps.compile rocksdb` from a blank
`deps/rocksdb/_build/cmake` takes **49m19s** and leaves ~100 MB of cmake
objects plus a 15 MB `priv/liberocksdb.so`. Every other dependency together is
seconds, and the app itself compiles 108 modules in ~40s. A full cold
`mix compile` in a worktree with no `_build/` is ~3 minutes once `deps/` is
populated.

## How the build is shared

`scripts/ebb-server-deps.sh` symlinks the checkout's `ebb_server/deps` at a
worktree that already has a built tree:

```
worktree/ebb_server/deps -> main-checkout/ebb_server/deps
```

It runs from `pnpm install` (via `scripts/install-dev-tools.sh`), so a worktree
that installs Node dependencies pays nothing, and it is safe to run by hand:

```bash
bash scripts/ebb-server-deps.sh
```

The first `mix` command in the linked worktree then runs the rebar3 hooks
against an up-to-date cmake tree — a no-op rebuild — which costs ~10s instead of
49 minutes.

Two constraints decide the shape of this:

- **A link, not a copy.** CMake bakes the absolute build directory into
  `deps/rocksdb/_build/cmake/CMakeCache.txt`. Copying the tree to another path
  makes the next configure fail with `The current CMakeCache.txt directory ...
is different than the directory ... where CMakeCache.txt was created`, and
  `mix deps.get` does not repair it. CMake canonicalises paths, so a symlink
  resolves back to the recorded directory and the donor's tree stays valid.
- **Matching `mix.lock`.** Linking across different locked versions would
  silently resolve to dependency code the checkout never asked for, so the
  script skips donors whose `ebb_server/mix.lock` differs. A worktree on a dep
  bump builds privately; once the bump lands on the donor, later worktrees share
  it again.

`_build/` stays per-worktree on purpose: it holds the compiled modules of each
branch's own source, and sharing it across concurrently running worktrees would
race.

## Caveats

- Commands that write to `deps/` write through the link into the donor:
  `mix deps.clean`, `mix deps.update`, and `mix deps.get` after changing
  `mix.lock`. Run those in the donor checkout. Wiping the shared tree costs the
  next worktree a full 49-minute rebuild.
- Deleting the donor worktree leaves every link dangling. Re-running
  `pnpm install` (or the script) re-links to whichever worktree still has a
  build.
- The donor's `priv/liberocksdb.so` links the donor machine's glibc, snappy and
  lz4, so the link is only valid on the same machine and OS image. A worktree on
  another host has no donor and builds its own.
