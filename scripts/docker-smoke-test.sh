#!/bin/bash
#
# Container smoke test for the published `ebb_server` image.
#
# Runs the acceptance checks from #566 that need a real Docker daemon:
# the image boots with a volume, reports healthy, gates auth, refuses to
# boot without auth configuration, keeps data across container
# recreation, and carries no build toolchain or source tree.
#
# The embedded Tailscale gateway (#728) adds: the bundled binary is present
# and executable in the release, tailscale mode boots and stays healthy with
# no published port, publishing the port still does not expose the API
# (Bandit binds loopback), and the logs name the login URL or why the control
# server is unreachable.
#
# The checks run without a tailnet: the container points
# `EBB_TAILSCALE_CONTROL_URL` at a dead port, so the node stays in
# needs-login and the interesting properties (uptime, loopback bind, log
# output) are observable offline.
#
#   bash scripts/docker-smoke-test.sh [image]
#
# `image` defaults to `ebb_server:smoke`. CI builds that tag and passes
# it in; `docker build -f ebb_server/Dockerfile -t ebb_server:smoke .`
# reproduces it locally.
#
set -euo pipefail

IMAGE="${1:-ebb_server:smoke}"
PORT="${EBB_SMOKE_PORT:-4000}"
# The embedded gateway (#728) adds a ~22 MiB static binary to the runtime
# layer, which put the measured image at 267 MiB. The ceiling moves with the
# image it governs, but stays a ceiling: it still catches a builder leak.
BUDGET_MB="${EBB_IMAGE_SIZE_BUDGET_MB:-300}"
NAME="ebb-smoke-$$"
VOLUME="ebb-smoke-data-$$"
COMPOSE_PROJECT="ebb-smoke-$$"
COMPOSE_SERVICE="ebb-dev"
BASE_URL="http://localhost:${PORT}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log() { printf '\n== %s\n' "$*"; }

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME" >/dev/null 2>&1 || true
  if have_compose; then
    compose --profile dev --profile tailscale down -v >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

have_compose() {
  docker compose version >/dev/null 2>&1
}

compose() {
  docker compose -p "$COMPOSE_PROJECT" -f "${REPO_ROOT}/compose.yaml" "$@"
}

status_of() {
  curl -s -o /dev/null -w '%{http_code}' "$@" || true
}

wait_for_health() {
  for _ in $(seq 1 60); do
    if [ "$(status_of "${BASE_URL}/healthz")" = "200" ]; then
      return 0
    fi
    if ! docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null | grep -q true; then
      log "container exited before becoming healthy"
      docker logs "$NAME" 2>&1 | tail -n 50 || true
      return 1
    fi
    sleep 1
  done
  log "container did not become healthy within 60s"
  docker logs "$NAME" 2>&1 | tail -n 50 || true
  return 1
}

start_server() {
  docker run -d --name "$NAME" \
    -p "${PORT}:4000" \
    -v "${VOLUME}:/app/data" \
    -e EBB_AUTH_MODE=bypass \
    "$IMAGE" >/dev/null
  wait_for_health
}

# In tailscale mode Bandit binds 127.0.0.1, so the host-side probes above
# cannot see the server. The image's own HEALTHCHECK is the in-container
# probe: it curls loopback from inside the network namespace, which is the
# same thing `docker exec` would do.
wait_for_container_health() {
  for _ in $(seq 1 60); do
    health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$NAME" 2>/dev/null || true)"
    if [ "$health" = "healthy" ]; then
      return 0
    fi
    if ! docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null | grep -q true; then
      log "container exited before becoming healthy"
      docker logs "$NAME" 2>&1 | tail -n 50 || true
      return 1
    fi
    sleep 1
  done
  log "container did not report healthy within 60s (state: ${health:-unknown})"
  docker logs "$NAME" 2>&1 | tail -n 50 || true
  return 1
}

# Extra arguments are docker-run flags, so the caller decides whether the port
# is published.
start_tailscale() {
  docker run -d --name "$NAME" \
    "$@" \
    -v "${VOLUME}:/app/data" \
    -e EBB_AUTH_MODE=tailscale \
    -e EBB_TAILSCALE_NODE=embedded \
    -e EBB_TAILSCALE_HOSTNAME=ebb-smoke \
    -e EBB_TAILSCALE_CONTROL_URL=http://127.0.0.1:9 \
    "$IMAGE" >/dev/null
}

log "guardrails ($IMAGE)"
# The release bundles ERTS and the Go gateway binary, but no Elixir, no Mix,
# no Go toolchain and no repository source; anything that reappears here means
# a builder stage leaked into the runtime image.
docker run --rm --entrypoint sh "$IMAGE" -c '
  set -e
  for tool in mix elixir elixirc iex erlc go gofmt; do
    if command -v "$tool" >/dev/null 2>&1; then
      echo "FAIL: build toolchain tool found: $tool"
      exit 1
    fi
  done
  for path in /app/deps /app/_build /app/node_modules /app/.git /app/scripts /usr/local/go; do
    if [ -e "$path" ]; then
      echo "FAIL: build artifact found: $path"
      exit 1
    fi
  done
  if find /app \( -name "*.ex" -o -name "*.exs" -o -name "*.go" -o -name "go.mod" -o -name "go.sum" \) | grep -q .; then
    echo "FAIL: repository source found under /app"
    exit 1
  fi
  test -x /app/bin/ebb_server
  test -d /app/data
  echo "runtime image contents clean"
'

# The release has to carry the gateway: the BEAM resolves it through
# `Application.app_dir(:ebb_server, "priv/tsnode/ebb_tsnode")`, so a missing or
# non-executable file is a boot failure for every tailscale deployment.
log "bundled tailscale gateway"
GATEWAY_PATH="$(docker run --rm --entrypoint sh "$IMAGE" -c 'ls /app/lib/ebb_server-*/priv/tsnode/ebb_tsnode' 2>/dev/null || true)"
if [ -z "$GATEWAY_PATH" ]; then
  echo "FAIL: no ebb_tsnode binary in the release (expected /app/lib/ebb_server-*/priv/tsnode/ebb_tsnode)"
  exit 1
fi
if ! docker run --rm --entrypoint sh "$IMAGE" -c 'test -x /app/lib/ebb_server-*/priv/tsnode/ebb_tsnode'; then
  echo "FAIL: ${GATEWAY_PATH} is not executable"
  exit 1
fi
# Execute it on the runtime base with stdin closed (the gateway reads its
# config from stdin and exits when there is none), so a dynamically linked or
# wrong-architecture build fails here rather than on a user's first boot. The
# exit status is not asserted: only the loader's complaints are.
GATEWAY_RUN="$(timeout 20 docker run --rm --network none --entrypoint sh "$IMAGE" \
  -c 'exec "$0" </dev/null' "$GATEWAY_PATH" 2>&1 || true)"
if printf '%s\n' "$GATEWAY_RUN" | grep -Eq 'not found|Permission denied|cannot execute|error while loading shared libraries'; then
  echo "FAIL: the bundled gateway does not run on the runtime base:"
  printf '%s\n' "$GATEWAY_RUN" | tail -n 10
  exit 1
fi
echo "gateway binary: ${GATEWAY_PATH} (runs on the runtime base)"

# The default user must be non-root; running as root would make the
# chowned data directory meaningless.
RUN_UID="$(docker run --rm --entrypoint sh "$IMAGE" -c 'id -u')"
if [ "$RUN_UID" = "0" ]; then
  echo "FAIL: image runs as root"
  exit 1
fi
echo "runtime user uid: ${RUN_UID}"

# `.Config.Healthcheck` is a pointer: rendering it directly prints
# `<nil>` rather than nothing when it is unset.
HEALTHCHECK_TEST="$(docker image inspect \
  -f '{{if .Config.Healthcheck}}{{.Config.Healthcheck.Test}}{{else}}none{{end}}' "$IMAGE")"
if [ -z "$HEALTHCHECK_TEST" ] || [ "$HEALTHCHECK_TEST" = "none" ]; then
  echo "FAIL: image declares no HEALTHCHECK"
  exit 1
fi

SIZE_BYTES="$(docker image inspect -f '{{.Size}}' "$IMAGE")"
SIZE_MB=$((SIZE_BYTES / 1024 / 1024))
log "image size: ${SIZE_MB} MiB (budget ${BUDGET_MB} MiB)"
if [ "$SIZE_MB" -gt "$BUDGET_MB" ]; then
  echo "FAIL: image is ${SIZE_MB} MiB, over the ${BUDGET_MB} MiB budget"
  exit 1
fi

log "the image refuses to start without explicit auth configuration"
set +e
timeout 60 docker run --rm -e EBB_AUTH_MODE= "$IMAGE" >/tmp/ebb-smoke-noauth.log 2>&1
NOAUTH_EXIT=$?
set -e
if [ "$NOAUTH_EXIT" -eq 0 ] || [ "$NOAUTH_EXIT" -eq 124 ]; then
  echo "FAIL: container booted (or hung) without auth configuration (exit ${NOAUTH_EXIT})"
  tail -n 30 /tmp/ebb-smoke-noauth.log
  exit 1
fi
if ! grep -q "ebb_server boot failed:.*EBB_AUTH_MODE" /tmp/ebb-smoke-noauth.log; then
  echo "FAIL: no-auth boot did not name EBB_AUTH_MODE"
  tail -n 30 /tmp/ebb-smoke-noauth.log
  exit 1
fi
echo "fail-fast boot refused with exit ${NOAUTH_EXIT}"

log "boot with a named volume"
docker volume create "$VOLUME" >/dev/null
start_server

log "health is unauthenticated; sync endpoints are not"
if [ "$(status_of -X POST "${BASE_URL}/sync/handshake" -H 'content-type: application/json' -d '{}')" != "401" ]; then
  echo "FAIL: /sync/handshake without x-ebb-actor-id did not return 401"
  exit 1
fi
if [ "$(status_of -X POST "${BASE_URL}/sync/handshake" -H 'content-type: application/json' -H 'x-ebb-actor-id: smoke' -d '{}')" != "200" ]; then
  echo "FAIL: /sync/handshake with x-ebb-actor-id did not return 200"
  exit 1
fi

log "write through the running container"
node "${REPO_ROOT}/scripts/docker-persistence-check.mjs" write "$BASE_URL"

log "recreate the container against the same volume"
docker rm -f "$NAME" >/dev/null
start_server

log "read the earlier write back from the new container"
node "${REPO_ROOT}/scripts/docker-persistence-check.mjs" verify "$BASE_URL"

log "tailscale mode boots with no published port and stays healthy"
docker rm -f "$NAME" >/dev/null
start_tailscale
wait_for_container_health
# The gateway cannot reach its control server, so its supervisor spends the
# whole run in the restart path. The BEAM and the storage healthcheck must not
# follow it down: tailnet state is reported in the logs, never by failing the
# container healthcheck. 15s clears two healthcheck intervals (10s each), so a
# crash-on-restart would have flipped the status.
sleep 15
if [ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$NAME")" != "healthy" ]; then
  echo "FAIL: container is not healthy in tailscale mode after 15s"
  docker logs "$NAME" 2>&1 | tail -n 50
  exit 1
fi
if [ -n "$(docker port "$NAME")" ]; then
  echo "FAIL: the tailscale container published a host port:"
  docker port "$NAME"
  exit 1
fi
if ! docker exec "$NAME" curl --fail --silent --show-error --max-time 2 \
    "http://127.0.0.1:4000/healthz" >/dev/null; then
  echo "FAIL: /healthz is not reachable on loopback inside the container"
  exit 1
fi
echo "tailscale mode is healthy on loopback with nothing published"

# The container points the gateway at a dead control port, so the only two
# outcomes are a login URL or the explicit unreachable line, emitted after the
# 5s grace. Either proves the gateway started and reported through the BEAM.
# Read from this container: it has already been up for the 15s above.
log "logs show a login URL, or why the node is not up"
TAILSCALE_LOGS="$(docker logs "$NAME" 2>&1 || true)"
if ! printf '%s\n' "$TAILSCALE_LOGS" | grep -Eq \
    -e 'tailscale login required: https://login\.tailscale\.com/a/' \
    -e 'ebb_tsnode: control server unreachable or node not authorized'; then
  echo "FAIL: neither a login URL nor the control-unreachable message in the tailscale logs"
  printf '%s\n' "$TAILSCALE_LOGS" | tail -n 50
  exit 1
fi
printf '%s\n' "$TAILSCALE_LOGS" | grep -E \
  'tailscale login required|control server unreachable' | tail -n 5 || true

log "the loopback bind holds even when the port is published"
docker rm -f "$NAME" >/dev/null
start_tailscale -p "${PORT}:4000"
wait_for_container_health
# A published port that reached the BEAM would mean the gateway is decoration
# and the tailnet is not the only way in.
HOST_HEALTH="$(status_of "${BASE_URL}/healthz")"
HOST_HANDSHAKE="$(status_of -X POST "${BASE_URL}/sync/handshake" \
  -H 'content-type: application/json' -d '{}')"
if [ "$HOST_HEALTH" = "200" ] || [ "$HOST_HANDSHAKE" = "200" ]; then
  echo "FAIL: host port ${PORT} reached the API in tailscale mode" \
    "(healthz ${HOST_HEALTH}, handshake ${HOST_HANDSHAKE})"
  exit 1
fi
echo "host port ${PORT} is refused (healthz ${HOST_HEALTH}, handshake ${HOST_HANDSHAKE})"

docker rm -f "$NAME" >/dev/null

log "docker compose dev profile boots the same image with a named volume"
if have_compose; then
  # The direct container publishes the same host port, and the compose
  # service name is the only way to start the profiled service alone
  # (`--profile dev` would add the non-profiled production service).
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker tag "$IMAGE" ebb-smoke-compose:test
  EBB_IMAGE=ebb-smoke-compose:test EBB_HOST_PORT="$PORT" \
    compose --profile dev up -d --no-build --wait --wait-timeout 90 "$COMPOSE_SERVICE"
  curl -fsS "${BASE_URL}/healthz" >/dev/null
  if [ "$(status_of -X POST "${BASE_URL}/sync/handshake" -H 'content-type: application/json' -H 'x-ebb-actor-id: compose-dev' -d '{}')" != "200" ]; then
    echo "FAIL: compose dev profile did not authorize a bypass handshake"
    exit 1
  fi
  echo "compose service ${COMPOSE_SERVICE} is healthy and authorizes bypass"
  compose --profile dev down -v >/dev/null

  # The default service is what docs/self-hosting.md tells operators to
  # run. External auth only needs a non-empty URL at boot; the first
  # request is what calls it.
  log "docker compose default service with external auth"
  EBB_IMAGE=ebb-smoke-compose:test EBB_HOST_PORT="$PORT" \
    EBB_AUTH_URL=http://127.0.0.1:9/auth \
    compose up -d --no-build --wait --wait-timeout 90 ebb
  if [ "$(status_of "${BASE_URL}/healthz")" != "200" ]; then
    echo "FAIL: compose default service is not healthy"
    exit 1
  fi
  if [ "$(status_of -X POST "${BASE_URL}/sync/handshake" -H 'content-type: application/json' -d '{}')" != "401" ]; then
    echo "FAIL: compose default service did not require auth"
    exit 1
  fi
  echo "compose default service is healthy and requires auth"
  compose down -v >/dev/null

  # The tailscale profile is the other shipped shape: the tailnet is the
  # ingress, so the service must publish nothing.
  log "docker compose tailscale profile boots without a published port"
  EBB_IMAGE=ebb-smoke-compose:test EBB_TAILSCALE_CONTROL_URL=http://127.0.0.1:9 \
    compose --profile tailscale up -d --no-build --wait --wait-timeout 90 ebb-tailscale
  TAILSCALE_CONTAINER="$(compose --profile tailscale ps -q ebb-tailscale)"
  if [ -z "$TAILSCALE_CONTAINER" ]; then
    echo "FAIL: compose did not start ebb-tailscale"
    exit 1
  fi
  if [ -n "$(docker port "$TAILSCALE_CONTAINER")" ]; then
    echo "FAIL: ebb-tailscale publishes a host port:"
    docker port "$TAILSCALE_CONTAINER"
    exit 1
  fi
  if [ "$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$TAILSCALE_CONTAINER")" != "healthy" ]; then
    echo "FAIL: ebb-tailscale is not healthy"
    docker logs "$TAILSCALE_CONTAINER" 2>&1 | tail -n 50
    exit 1
  fi
  echo "compose service ebb-tailscale is healthy with no published port"
  compose --profile tailscale down -v >/dev/null
else
  echo "SKIP: docker compose is not available in this environment"
fi

log "PASS: ${IMAGE}"
