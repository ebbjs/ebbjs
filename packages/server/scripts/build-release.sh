#!/bin/bash
set -e
cd "$(dirname "$0")/../../ebb_server"
MIX_ENV=prod mix release --overwrite
mkdir -p ../packages/server/dist
rm -rf ../packages/server/dist/ebb_server
cp -r _build/prod/rel/ebb_server ../packages/server/dist/ebb_server
echo "ebb_server release built and copied."
