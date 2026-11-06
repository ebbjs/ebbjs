#!/bin/bash
#
# Run the gateway on this machine, with no tailnet and no image build.
#
# A stub backend echoes the headers it receives, control points at a dead port,
# and the gateway's own NDJSON events, log forwarding and shutdown are visible
# on stdout. This is the loop for event/QR/proxy changes; the BEAM wiring is
# `mix test test/ebb_server/tailscale`, and the real control plane is
# `scripts/tsnode-e2e.sh`.
#
#   bash scripts/dev-tsnode.sh
#   EBB_DEV_PORT=4000 bash scripts/dev-tsnode.sh
#
# Requires: go (the version in `ebb_server/.tool-versions`) and node.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="${EBB_TSNODE_OUT:-$REPO_ROOT/ebb_server/priv/tsnode/ebb_tsnode}"
PORT="${EBB_DEV_PORT:-4000}"
STATE_DIR="${EBB_DEV_STATE_DIR:-${TMPDIR:-/tmp}/ebb-tsnode-dev}"
mkdir -p "$STATE_DIR"

BACKEND_PID=""
cleanup() {
  [ -n "$BACKEND_PID" ] && kill "$BACKEND_PID" 2>/dev/null || true
}
trap cleanup EXIT

command -v go >/dev/null 2>&1 ||
  { echo "the Go toolchain is required (see ebb_server/.tool-versions)" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo "missing dependency: node" >&2; exit 1; }

echo "== building the gateway"
EBB_TSNODE_OUT="$BIN" bash "$REPO_ROOT/scripts/build-tsnode.sh"

echo "== starting the stub backend on :$PORT"
node -e '
  require("http").createServer((req, res) => {
    if (req.url === "/stream") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: chunk-a\n\n");
      setTimeout(() => { res.write("data: chunk-b\n\n"); res.end(); }, 2000);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ path: req.url, headers: req.headers }, null, 2));
  }).listen(Number(process.argv[1]), "127.0.0.1");
' "$PORT" &
BACKEND_PID=$!

echo "== starting the gateway (control is unreachable on purpose)"
# stdin stays open for the process lifetime; Ctrl-C shuts everything down.
{
  printf '%s\n' "$(node -e '
    process.stdout.write(JSON.stringify({
      state_dir: process.argv[1] + "/state",
      hostname: "ebb-dev",
      auth_key: "",
      control_url: "http://127.0.0.1:9",
      tags: [],
      https: "off",
      backend_addr: "127.0.0.1:" + process.argv[2],
      proxy_secret: "",
      qr: true
    }));
  ' "$STATE_DIR" "$PORT")"
  exec sleep 86400
} | "$BIN"
