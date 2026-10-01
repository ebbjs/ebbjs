#!/bin/bash
set -e
SCRIPT_DIR="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
REPO_ROOT="$SCRIPT_DIR/../../.."
RELEASE_DIR="$REPO_ROOT/packages/server/dist/ebb_server"
RELEASE_BIN="$RELEASE_DIR/bin/ebb_server"

if [ -x "$RELEASE_BIN" ]; then
  echo "ebb_server release already present."
  exit 0
fi

cd "$REPO_ROOT/ebb_server"
MIX_ENV=prod mix release --overwrite
mkdir -p "$REPO_ROOT/packages/server/dist"
rm -rf "$RELEASE_DIR"
cp -r _build/prod/rel/ebb_server "$RELEASE_DIR"
echo "ebb_server release built and copied."
