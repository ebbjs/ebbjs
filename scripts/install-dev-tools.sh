#!/bin/bash
#
# Install git hooks, configure local git settings, and share one compiled
# `ebb_server/deps` between worktrees.
# Runs automatically as `pnpm install`'s prepare script.
#
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$ROOT_DIR"

# Lefthook installs pre-commit and pre-push hooks into .git/hooks/.
lefthook install --reset-hooks-path

# Set the commit message template for this repo only.
# Skipped gracefully if not in a git checkout (e.g., Docker build without .git).
if [ -d .git ]; then
  git config --local commit.template .gitmessage
fi

# A worktree without this link spends ~50 minutes compiling RocksDB on its first
# `mix` command; see scripts/ebb-server-deps.sh.
bash "$SCRIPT_DIR/ebb-server-deps.sh"
