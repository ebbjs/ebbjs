#!/bin/bash
set -e
SCRIPT_DIR="$(dirname "$0")"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT/ebb_server"
MIX_ENV=prod mix release --overwrite
mkdir -p "$REPO_ROOT/packages/server/dist"
rm -rf "$REPO_ROOT/packages/server/dist/ebb_server"
cp -r _build/prod/rel/ebb_server "$REPO_ROOT/packages/server/dist/ebb_server"
echo "ebb_server release built and copied."
