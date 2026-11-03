#!/bin/bash
#
# Point this checkout's `ebb_server/deps` at a compiled dependency tree from
# another worktree of the same repository.
#
# `ebb_server/deps/` is git-ignored, so a new worktree starts empty and its
# first `mix deps.compile` builds the RocksDB C++ sources that the `rocksdb` hex
# dependency vendors: 640 translation units, ~50 minutes on four cores, ~180 MB
# of deps plus ~100 MB of cmake objects. Only `rocksdb` is expensive; every
# other dependency compiles in seconds. One shared tree removes that cost from
# every worktree after the first.
#
# The shared tree has to be linked, not copied. CMake records the absolute build
# directory in `deps/rocksdb/_build/cmake/CMakeCache.txt` and refuses to reuse
# it from a different path ("The current CMakeCache.txt directory ... is
# different than the directory ... where CMakeCache.txt was created"). CMake
# canonicalises the directory, so a symlink through the donor resolves to the
# recorded path and leaves its build tree valid.
#
# A donor is used only when its `mix.lock` matches this checkout's: a link
# across different locked versions would resolve dependencies to code the
# checkout never asked for. A worktree sitting on a dep bump therefore builds
# its own tree, and that build becomes the shared one once the bump lands.
#
# Commands that write to `deps/` write through the link into the donor:
# `mix deps.clean`, `mix deps.update`, and `mix deps.get` on a changed
# `mix.lock`. Run those in the donor checkout instead.
#
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
DEPS_DIR="$ROOT_DIR/ebb_server/deps"

[ -f "$ROOT_DIR/ebb_server/mix.exs" ] || exit 0

# A populated tree, whether a real directory or a working link, is usable.
if [ -d "$DEPS_DIR/rocksdb" ]; then
  exit 0
fi

if ! git -C "$ROOT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  exit 0
fi

list_worktrees() {
  git -C "$ROOT_DIR" worktree list --porcelain | sed -n 's/^worktree //p'
}

current_worktree="$(git -C "$ROOT_DIR" rev-parse --show-toplevel)"
# `git worktree list` puts the main worktree first, and dep bumps land there, so
# it is both the preferred donor and the one checkout that has nothing to link
# to (a plain clone, such as CI, is its own main worktree).
main_worktree="$(list_worktrees | head -1)"

if [ "$current_worktree" = "$main_worktree" ]; then
  exit 0
fi

donor=""
while IFS= read -r candidate; do
  if [ "$candidate" = "$current_worktree" ]; then
    continue
  fi
  if [ ! -f "$candidate/ebb_server/deps/rocksdb/priv/liberocksdb.so" ]; then
    continue
  fi
  if ! cmp -s "$candidate/ebb_server/mix.lock" "$ROOT_DIR/ebb_server/mix.lock"; then
    continue
  fi
  donor="$candidate"
  break
done <<< "$(printf '%s\n%s\n' "$main_worktree" "$(list_worktrees)")"

if [ -z "$donor" ]; then
  echo "ebb_server/deps: no compiled dependency tree in another worktree yet."
  echo "  This checkout builds its own; the first compile spends ~50 minutes on"
  echo "  RocksDB. Later worktrees link to this one."
  exit 0
fi

# Also replaces a dangling link left behind by a deleted worktree.
if [ -L "$DEPS_DIR" ] || [ -d "$DEPS_DIR" ]; then
  rm -rf "$DEPS_DIR"
fi

ln -s "$donor/ebb_server/deps" "$DEPS_DIR"

echo "ebb_server/deps -> $donor/ebb_server/deps"
echo "  sharing that worktree's compiled dependencies; no RocksDB build here."
