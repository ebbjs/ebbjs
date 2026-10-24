#!/bin/bash
#
# Container smoke test for the published `ebb_server` image.
#
# Runs the acceptance checks from #566 that need a real Docker daemon:
# the image boots with a volume, reports healthy, gates auth, refuses to
# boot without auth configuration, keeps data across container
# recreation, and carries no build toolchain or source tree.
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
BUDGET_MB="${EBB_IMAGE_SIZE_BUDGET_MB:-250}"
NAME="ebb-smoke-$$"
VOLUME="ebb-smoke-data-$$"
BASE_URL="http://localhost:${PORT}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log() { printf '\n== %s\n' "$*"; }

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm "$VOLUME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

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

log "guardrails ($IMAGE)"
# The release bundles ERTS but no Elixir, no Mix, and no repository
# source; anything that reappears here means the builder stage leaked
# into the runtime image.
docker run --rm --entrypoint sh "$IMAGE" -c '
  set -e
  for tool in mix elixir elixirc iex erlc; do
    if command -v "$tool" >/dev/null 2>&1; then
      echo "FAIL: build toolchain tool found: $tool"
      exit 1
    fi
  done
  for path in /app/deps /app/_build /app/node_modules /app/.git /app/scripts; do
    if [ -e "$path" ]; then
      echo "FAIL: build artifact found: $path"
      exit 1
    fi
  done
  if find /app -name "*.ex" -o -name "*.exs" | grep -q .; then
    echo "FAIL: repository source found under /app"
    exit 1
  fi
  test -x /app/bin/ebb_server
  test -d /app/data
  echo "runtime image contents clean"
'

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

log "PASS: ${IMAGE}"
