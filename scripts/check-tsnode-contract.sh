#!/bin/bash
#
# The fast half of the Go↔BEAM contract check.
#
# Pins what the two halves agree on without running either full suite:
#   - `ebb_server/tsnode/contract.json`: header names, stripped names, fatal
#     exit status;
#   - `ebb_server/tsnode/testdata/events.ndjson`: the NDJSON event vocabulary.
#
# With staged files as arguments it runs only the half those files can break:
# a Go change checks the Go side, an Elixir change the Elixir side, and a
# contract or transcript change both. Without arguments it runs both.
#
# A rename on one side fails here in seconds. The full suites still run in CI;
# this is the pre-commit gate.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
run_go=1
run_elixir=1

if [ "$#" -gt 0 ]; then
  run_go=0
  run_elixir=0

  for file in "$@"; do
    case "$file" in
      # Both halves read these, so a change here can break either.
      ebb_server/tsnode/contract.json | ebb_server/tsnode/testdata/*)
        run_go=1
        run_elixir=1
        ;;
      ebb_server/tsnode/*)
        run_go=1
        ;;
      ebb_server/lib/ebb_server/tailscale/* | \
        ebb_server/lib/ebb_server/sync/auth_plug.ex | \
        ebb_server/test/ebb_server/tailscale/*)
        run_elixir=1
        ;;
    esac
  done
fi

if [ "$run_go" = 0 ] && [ "$run_elixir" = 0 ]; then
  exit 0
fi

if [ "$run_go" = 1 ]; then
  if command -v go >/dev/null 2>&1; then
    cd "$REPO_ROOT/ebb_server/tsnode"

    unformatted="$(gofmt -l .)"
    if [ -n "$unformatted" ]; then
      echo "gofmt reports unformatted files:" >&2
      echo "$unformatted" >&2
      exit 1
    fi

    go test -run 'Contract|Transcript|Emitter' ./...
  else
    echo "skip: Go half (the Go toolchain is not on PATH; see ebb_server/.tool-versions)" >&2
  fi
fi

if [ "$run_elixir" = 1 ]; then
  cd "$REPO_ROOT/ebb_server"
  mix test --no-start test/ebb_server/tailscale --only gateway_contract
fi
