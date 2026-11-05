#!/bin/bash
#
# Build the static Go gateway the ebb_server image ships.
#
# The binary is a `tsnet` reverse proxy that owns the embedded Tailscale node
# and injects tailnet identity headers for the BEAM. It is built without cgo so
# the runtime image needs no libc, and the `ts_omit_logtail` tag turns
# Tailscale's log uploader into a no-op: an embedded node must not phone home.
#
# Usage:
#   bash scripts/build-tsnode.sh
#   EBB_TSNODE_OUT=/tmp/ebb_tsnode bash scripts/build-tsnode.sh
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODULE_DIR="$REPO_ROOT/ebb_server/tsnode"

OUT="${EBB_TSNODE_OUT:-ebb_server/priv/tsnode/ebb_tsnode}"
case "$OUT" in
  /*) ;;
  *) OUT="$REPO_ROOT/$OUT" ;;
esac

if ! GO="$(command -v go)"; then
  echo "Error: the Go toolchain is required to build ebb_tsnode;" >&2
  echo "install Go 1.27.x (the version ebb_server/tsnode/go.mod requires) and put it on PATH." >&2
  exit 1
fi

mkdir -p "$(dirname "$OUT")"

cd "$MODULE_DIR"
CGO_ENABLED=0 "$GO" build -tags ts_omit_logtail -trimpath -ldflags="-s -w" -o "$OUT" .

echo "wrote ${OUT#"$REPO_ROOT"/}"
