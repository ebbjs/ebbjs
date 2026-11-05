#!/bin/bash
#
# Build the single-file runner the release ships.
#
# `packages/runner/src/main.ts` imports workspace packages whose sources live in
# this repo. A release cannot resolve those, and Bun is the only runtime the
# server ships, so the runner is bundled into one file under
# `ebb_server/priv/runner/` and committed. Mix releases copy the app's `priv/`
# directory, so the bundle travels with the release without a Node or pnpm
# install in the Docker runtime image.
#
# Usage:
#   bash scripts/build-runner.sh          # write ebb_server/priv/runner/main.js
#   bash scripts/build-runner.sh --check  # fail if the committed bundle is stale
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENTRY="$REPO_ROOT/packages/runner/src/main.ts"
OUT="$REPO_ROOT/ebb_server/priv/runner/main.js"
PINNED_BUN="$(tr -d '[:space:]' < "$REPO_ROOT/.bun-version")"

BUN="${BUN_BIN:-$(command -v bun || true)}"
if [ -z "$BUN" ]; then
  echo "Error: Bun is required to build the runner; install $PINNED_BUN (see .bun-version)." >&2
  exit 1
fi

INSTALLED="$("$BUN" --version)"
if [ "$INSTALLED" != "$PINNED_BUN" ]; then
  echo "Error: Bun $INSTALLED is installed but .bun-version pins $PINNED_BUN." >&2
  exit 1
fi

if [ ! -d "$REPO_ROOT/node_modules" ]; then
  echo "Error: workspace packages are not installed; run 'pnpm install' first." >&2
  exit 1
fi

# The workspace packages resolve through their published `dist` entries, the
# same entries a deployed bundle uses.
if [ ! -f "$REPO_ROOT/packages/core/dist/index.js" ]; then
  echo "Error: workspace packages are not built; run 'pnpm build:packages' first." >&2
  exit 1
fi

build() {
  "$BUN" build "$ENTRY" \
    --target=bun \
    --format=esm \
    --outfile="$1" \
    --minify
}

if [ "${1:-}" = "--check" ]; then
  TMP="$(mktemp)"
  trap 'rm -f "$TMP"' EXIT
  build "$TMP"

  if ! diff -q "$TMP" "$OUT" >/dev/null 2>&1; then
    echo "Error: ebb_server/priv/runner/main.js is stale." >&2
    echo "Run 'bash scripts/build-runner.sh' and commit the result." >&2
    exit 1
  fi

  echo "committed runner bundle is up to date"
  exit 0
fi

mkdir -p "$(dirname "$OUT")"
build "$OUT"
echo "wrote ${OUT#"$REPO_ROOT"/} (Bun $INSTALLED)"
