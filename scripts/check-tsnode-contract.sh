#!/bin/bash
#
# The fast half of the Go↔BEAM contract check.
#
# Pins what the two halves agree on without running either full suite:
#   - `ebb_server/tsnode/contract.json`: header names, stripped names, fatal
#     exit status;
#   - `ebb_server/tsnode/testdata/events.ndjson`: the NDJSON event vocabulary.
#
# A rename on one side fails here in seconds. The full suites still run in CI;
# this is the pre-commit gate.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v go >/dev/null 2>&1; then
  echo "skip: the Go toolchain is not on PATH (see ebb_server/.tool-versions)" >&2
  exit 0
fi

cd "$REPO_ROOT/ebb_server/tsnode"

unformatted="$(gofmt -l .)"
if [ -n "$unformatted" ]; then
  echo "gofmt reports unformatted files:" >&2
  echo "$unformatted" >&2
  exit 1
fi

go test -run 'Contract|Transcript|Emitter' ./...

cd "$REPO_ROOT/ebb_server"
mix test --no-start test/ebb_server/tailscale --only gateway_contract
