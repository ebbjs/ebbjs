#!/bin/bash
#
# End-to-end check for the embedded Tailscale gateway, on a real control plane.
#
# Runs the real `ebb_tsnode` binary against Headscale and a second real tailnet
# node, then asserts what no unit test can: that tsnet's WhoIs answer reaches
# the backend as the BEAM's identity headers, that a peer-supplied copy is
# stripped, and that an SSE stream passes through without being buffered.
#
# Deliberately not covered here:
#   - the BEAM boot and supervision: `scripts/docker-smoke-test.sh` (real image);
#   - TLS/ACME: needs a public DNS name, see `docs/self-hosting.md`;
#   - tagged peers: Headscale keeps a user identity on tagged nodes, so the
#     gateway's 403 cannot be reproduced. That stays with the Go test and the
#     manual acceptance run.
#
# Requires: docker, go (the version in `ebb_server/.tool-versions`), node, curl.
#
#   bash scripts/tsnode-e2e.sh
#   EBB_E2E_KEEP=1 bash scripts/tsnode-e2e.sh   # keep containers and logs
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="${EBB_TSNODE_OUT:-$REPO_ROOT/ebb_server/priv/tsnode/ebb_tsnode}"

HEADSCALE_IMAGE="${EBB_E2E_HEADSCALE_IMAGE:-headscale/headscale:0.26.1}"
CLIENT_IMAGE="${EBB_E2E_CLIENT_IMAGE:-tailscale/tailscale:v1.104.4}"
CONTROL_PORT="${EBB_E2E_CONTROL_PORT:-18080}"
SOCKS_PORT="${EBB_E2E_SOCKS_PORT:-11055}"

PREFIX="ebb-e2e-$$"
HS_NAME="$PREFIX-headscale"
CLIENT_NAME="$PREFIX-client"
NETWORK="$PREFIX-net"
STATE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ebb-e2e-XXXXXX")"
KEEP="${EBB_E2E_KEEP:-0}"

log() { printf '\n== %s\n' "$*"; }
fail() {
  echo "FAIL: $*" >&2
  for log_file in "$STATE_DIR/gateway.out" "$STATE_DIR/backend.out"; do
    if [ -s "$log_file" ]; then
      echo "--- $(basename "$log_file") ---" >&2
      tail -n 40 "$log_file" >&2
    fi
  done
  if [ -n "${CLIENT_NAME:-}" ] && docker inspect "$CLIENT_NAME" >/dev/null 2>&1; then
    echo "--- client log ---" >&2
    docker logs "$CLIENT_NAME" 2>&1 | tail -n 40 >&2
    if [ -n "${EBB_E2E_ARTIFACT_DIR:-}" ]; then
      mkdir -p "$EBB_E2E_ARTIFACT_DIR"
      docker logs "$CLIENT_NAME" >"$EBB_E2E_ARTIFACT_DIR/client.log" 2>&1 || true
    fi
  fi
  if [ -n "${EBB_E2E_ARTIFACT_DIR:-}" ]; then
    mkdir -p "$EBB_E2E_ARTIFACT_DIR"
    cp "$STATE_DIR"/*.out "$EBB_E2E_ARTIFACT_DIR"/ 2>/dev/null || true
  fi
  exit 1
}

cleanup() {
  exec 3>&- 2>/dev/null || true
  for pid in "${GATEWAY_PID:-}" "${WRITER_PID:-}" "${BACKEND_PID:-}"; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  done
  if [ "$KEEP" = "1" ]; then
    echo "kept $NETWORK, $HS_NAME, $CLIENT_NAME and $STATE_DIR"
    return
  fi
  docker rm -f "$CLIENT_NAME" "$HS_NAME" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  rm -rf "$STATE_DIR"
}
trap cleanup EXIT

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing dependency: $1" >&2; exit 1; }; }
for tool in docker node curl; do need "$tool"; done
command -v go >/dev/null 2>&1 || fail "the Go toolchain is required (see ebb_server/.tool-versions)"

# ── the gateway binary ─────────────────────────────────────────────────────

log "building the gateway"
EBB_TSNODE_OUT="$BIN" bash "$REPO_ROOT/scripts/build-tsnode.sh" >/dev/null

# ── Headscale ──────────────────────────────────────────────────────────────

log "starting Headscale ($HEADSCALE_IMAGE)"
cat >"$STATE_DIR/headscale.yaml" <<EOF
server_url: http://127.0.0.1:$CONTROL_PORT
listen_addr: 0.0.0.0:8080
metrics_listen_addr: 127.0.0.1:9090
grpc_listen_addr: 127.0.0.1:50443
grpc_allow_insecure: true
noise:
  private_key_path: /var/lib/headscale/noise_private.key
prefixes:
  v4: 100.64.0.0/10
  v6: fd7a:115c:a1e0::/48
  allocation: sequential
derp:
  server:
    enabled: false
  urls:
    - https://controlplane.tailscale.com/derpmap/default
  auto_update_enabled: false
database:
  type: sqlite
  sqlite:
    path: /var/lib/headscale/db.sqlite
dns:
  magic_dns: false
  override_local_dns: false
log:
  level: info
  format: text
EOF

docker network create "$NETWORK" >/dev/null
docker run -d --name "$HS_NAME" --network "$NETWORK" \
  -p "$CONTROL_PORT:8080" \
  -v "$STATE_DIR/headscale.yaml:/etc/headscale/config.yaml" \
  "$HEADSCALE_IMAGE" serve >/dev/null

for _ in $(seq 1 60); do
  curl -fsS -o /dev/null "http://127.0.0.1:$CONTROL_PORT/health" 2>/dev/null && break
  sleep 1
done
curl -fsS -o /dev/null "http://127.0.0.1:$CONTROL_PORT/health" ||
  fail "Headscale did not become healthy"

docker exec "$HS_NAME" headscale users create e2e >/dev/null
USER_ID="$(docker exec "$HS_NAME" headscale users list -o json |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String(JSON.parse(s)[0].id)))')"
KEY="$(docker exec "$HS_NAME" headscale preauthkeys create --user "$USER_ID" --reusable --expiration 1h -o json |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).key))')"
[ -n "$KEY" ] || fail "Headscale did not issue a preauth key"

# ── stub backend ───────────────────────────────────────────────────────────

log "starting the stub backend"
cat >"$STATE_DIR/backend.js" <<'EOF'
const http = require("http");

http
  .createServer((req, res) => {
    if (req.url === "/stream") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: chunk-a\n\n");
      setTimeout(() => {
        res.write("data: chunk-b\n\n");
        res.end();
      }, 2000);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ path: req.url, headers: req.headers }));
  })
  .listen(0, "127.0.0.1", function () {
    process.stdout.write(String(this.address().port) + "\n");
  });
EOF

node "$STATE_DIR/backend.js" >"$STATE_DIR/backend.port" 2>"$STATE_DIR/backend.out" &
BACKEND_PID=$!
for _ in $(seq 1 50); do
  [ -s "$STATE_DIR/backend.port" ] && break
  sleep 0.1
done
BACKEND_PORT="$(head -1 "$STATE_DIR/backend.port")"
[ -n "$BACKEND_PORT" ] || fail "the stub backend did not start"

# ── the gateway ────────────────────────────────────────────────────────────

log "starting the gateway against Headscale"
mkfifo "$STATE_DIR/gateway.in"
"$BIN" <"$STATE_DIR/gateway.in" >"$STATE_DIR/gateway.out" 2>&1 &
GATEWAY_PID=$!

CONFIG="$(node -e '
  process.stdout.write(JSON.stringify({
    state_dir: process.argv[1] + "/state",
    hostname: "ebb-gw",
    auth_key: process.argv[2],
    control_url: "http://127.0.0.1:" + process.argv[3],
    tags: [],
    https: "off",
    backend_addr: "127.0.0.1:" + process.argv[4],
    proxy_secret: "e2e-proxy-secret",
    qr: false
  }));
' "$STATE_DIR" "$KEY" "$CONTROL_PORT" "$BACKEND_PORT")"

# Holding stdin open is what keeps the gateway running; closing it is the
# shutdown request, so the writer has to outlive the assertions.
{ printf '%s\n' "$CONFIG"; sleep 600; } >"$STATE_DIR/gateway.in" &
WRITER_PID=$!

for _ in $(seq 1 120); do
  grep -q '"event":"running"' "$STATE_DIR/gateway.out" 2>/dev/null && break
  kill -0 "$GATEWAY_PID" 2>/dev/null || fail "the gateway exited before reaching Running"
  sleep 1
done
grep -q '"event":"running"' "$STATE_DIR/gateway.out" || fail "the gateway never reached Running"
GW_IP="$(grep '"event":"running"' "$STATE_DIR/gateway.out" | head -1 |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).ips[0]))')"
[ -n "$GW_IP" ] || fail "could not read the gateway's tailnet address"
echo "gateway is serving at $GW_IP"

# ── a real tailnet client ──────────────────────────────────────────────────

log "starting a tailnet client ($CLIENT_IMAGE)"
docker run -d --name "$CLIENT_NAME" --network "$NETWORK" -p "$SOCKS_PORT:1055" \
  -e TS_AUTHKEY="$KEY" \
  -e TS_STATE_DIR=/tmp/ts-state \
  -e TS_USERSPACE=true \
  -e TS_EXTRA_ARGS="--login-server=http://$HS_NAME:8080 --hostname=e2e-client --accept-dns=false" \
  -e TS_TAILSCALED_EXTRA_ARGS="--socks5-server=0.0.0.0:1055" \
  "$CLIENT_IMAGE" >/dev/null

for _ in $(seq 1 120); do
  if docker logs "$CLIENT_NAME" 2>&1 | grep -q "Startup complete"; then break; fi
  sleep 1
done
docker logs "$CLIENT_NAME" 2>&1 | grep -q "Startup complete" || fail "the client did not join the tailnet"

# curl through the client's SOCKS5 proxy: the request is a genuine tailnet
# connection from another node, which is what makes WhoIs meaningful.
fetch() {
  curl -sS --max-time 20 --socks5-hostname "127.0.0.1:$SOCKS_PORT" "$@"
}

visit() {
  fetch -H 'content-type: application/json' "http://$GW_IP$1"
}

log "identity reaches the backend"
visit "/sync/identity" >"$STATE_DIR/identity.json" ||
  fail "the gateway did not answer the identity request"
assert_identity() {
  node -e '
    const headers = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).headers;
    const problems = [];
    const want = {
      "tailscale-user-login": "e2e",
      "tailscale-user-name": "e2e",
      "x-ebb-tailscale-secret": "e2e-proxy-secret"
    };
    for (const [name, value] of Object.entries(want)) {
      if (headers[name] !== value) problems.push(`${name} = ${headers[name]}, want ${value}`);
    }
    if (!headers["x-ebb-tailscale-user-id"]) problems.push("missing x-ebb-tailscale-user-id");
    if (headers["x-ebb-actor-id"]) problems.push("x-ebb-actor-id reached the backend");
    if (headers["x-forwarded-for"] === "203.0.113.9") problems.push("a spoofed X-Forwarded-For survived");
    if (!headers["x-forwarded-for"]) problems.push("missing X-Forwarded-For");
    if (problems.length) {
      console.error(problems.join("\n"));
      process.exit(1);
    }
  ' "$STATE_DIR/identity.json" || fail "identity headers are wrong (see above)"
}
assert_identity
echo "backend saw tailscale-user-login=e2e and the gateway's secret"

log "a peer cannot claim an identity"
fetch -H 'Tailscale-User-Login: mallory@example.com' \
  -H 'Tailscale-User-Name: Mallory' \
  -H 'X-Ebb-Tailscale-Secret: guessed' \
  -H 'X-Ebb-Tailscale-User-Id: 99' \
  -H 'X-Ebb-Actor-Id: mallory' \
  -H 'X-Forwarded-For: 203.0.113.9' \
  "http://$GW_IP/sync/identity" >"$STATE_DIR/spoof.json" ||
  fail "the gateway did not answer the spoofing request"
assert_identity
echo "spoofed identity headers and X-Forwarded-For were dropped"

log "SSE streams through the gateway"
T0="$(date +%s%N)"
FIRST_MS=""
CHUNKS=""
while IFS= read -r line; do
  if [ -z "$FIRST_MS" ] && [[ "$line" == data:* ]]; then
    FIRST_MS=$(((($(date +%s%N) - T0)) / 1000000))
  fi
  [[ "$line" == data:* ]] && CHUNKS="$CHUNKS$line"$'\n'
done < <(fetch -N "http://$GW_IP/stream")
[[ "$CHUNKS" == *"chunk-a"* && "$CHUNKS" == *"chunk-b"* ]] ||
  fail "the SSE stream did not pass both chunks through: $CHUNKS"
[ -n "$FIRST_MS" ] || fail "no SSE chunk arrived"
# The backend waits 2s between chunks; a proxy that buffered the stream would
# deliver both at the end instead.
[ "$FIRST_MS" -lt 1500 ] ||
  fail "the first SSE chunk arrived after ${FIRST_MS}ms, so the stream was buffered"
echo "first chunk at ${FIRST_MS}ms, both chunks arrived"

log "ok: identity, spoofing and SSE are correct on a real tailnet"
