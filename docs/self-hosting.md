# self-hosting

Running `ebb_server` from a container image (issue #566). The image is a
single-node sync server: RocksDB action log, SQLite materialization, and the
sync HTTP API, with no build toolchain inside.

The container **requires explicit auth configuration**. It refuses to boot
without `EBB_AUTH_MODE`, because the alternative — a silent `:bypass` default —
lets any client forge an actor identity. See [Configuration](#configuration).

Everything below assumes Linux `amd64`; that is the only architecture the first
release publishes.

## 1. Get the image

Build it from a checkout: the build context is the repository root and the
Dockerfile reads `scripts/setup-ebb-server.sh` plus the Elixir project, so the
command must be run from the root.

```bash
# the commands below reuse this variable
EBB_IMAGE=ebb_server:local
docker build -f ebb_server/Dockerfile -t "$EBB_IMAGE" .
```

The first build compiles the RocksDB binding, so expect several minutes; later
builds reuse the dependency layers and only recompile `lib/`.

Tagged releases also publish `ghcr.io/ebbjs/ebb_server:<version>` and `latest`
(`linux/amd64`). Once a version exists, pull it and point the same variable at
it — pin the version, because `latest` moves with every release and there is no
tag rollback:

```bash
docker pull ghcr.io/ebbjs/ebb_server:<version>
EBB_IMAGE=ghcr.io/ebbjs/ebb_server:<version>
```

## 2. Run the container

```bash
docker run -d --name ebb \
  -p 4000:4000 \
  -v ebb-data:/app/data \
  -e EBB_AUTH_MODE=external \
  -e EBB_AUTH_URL=https://identity.example.com \
  "$EBB_IMAGE"

# readiness, unauthenticated
curl -s http://localhost:4000/healthz
# {"status":"ok"}
```

`GET /healthz` answers `200` with `{"status":"ok"}` once the storage supervisor,
RocksDB, SQLite, and the watermark tracker are serving, and `503` with
`{"status":"unavailable"}` until then. It is the only unauthenticated endpoint,
and it is what the image's `HEALTHCHECK` polls.

Without auth configuration the container exits instead of starting. The
release's own boot failure prints only a generic `Runtime terminating during
boot` and buries the exception in a crash dump, so the server writes its own
reason to stderr first:

```console
$ docker run --rm "$EBB_IMAGE"
ebb_server boot failed: EBB_AUTH_MODE is not set and :ebb_server, :auth_mode has no compiled value. Set EBB_AUTH_MODE to one of: bypass, external.
{exit,terminating,[...]}
Runtime terminating during boot (terminating)
$ echo $?
1
```

`EBB_AUTH_MODE=external` without a URL fails the same way:

```console
$ docker run --rm -e EBB_AUTH_MODE=external "$EBB_IMAGE"
ebb_server boot failed: EBB_AUTH_URL is required when EBB_AUTH_MODE=external. Point it at the identity service that issues actor IDs.
[...]
```

The `ebb_server boot failed:` line goes to stderr, so `docker logs <name>` and a
foreground `docker run` both show it. The BEAM also writes an `erl_crash.dump` in
the working directory (`/app`) when it dies during boot; that file is not part of
the data volume and does not survive container removal.

## 3. Docker Compose

The repository root has a `compose.yaml` with two services.

The default service requires real auth. It passes `EBB_AUTH_MODE=external` and
forwards `EBB_AUTH_URL`; if that variable is unset the container gets an empty
URL, which the server treats as unset and fails fast on. Compose does not fill in
a default, deliberately:

```bash
export EBB_AUTH_URL=https://identity.example.com
docker compose up -d
docker compose ps                                # wait for (healthy)
curl -s http://localhost:4000/healthz
```

The `dev` profile runs the same image with `EBB_AUTH_MODE=bypass` so you can try
the server without an identity service. Name the service: enabling a profile
starts the non-profiled service too, and both publish host port 4000.

```bash
docker compose --profile dev up ebb-dev
```

> [!WARNING]
> `bypass` trusts the `x-ebb-actor-id` header. Any client that can reach the port
> can claim any actor identity. Use the `dev` profile for local demos only —
> never on a reachable network, and never for a deployment you care about.

Compose names: project `ebb`, services `ebb` (default) and `ebb-dev` (profile
`dev`), named volume `ebb-data`. Override the image with `EBB_IMAGE`, e.g.
`EBB_IMAGE=ghcr.io/ebbjs/ebb_server:<version> docker compose up -d`, and the
published host port with `EBB_HOST_PORT` (the container keeps listening on
`EBB_PORT`, 4000).

## 4. Configuration

| Variable        | Default     | Description                                                                        |
| --------------- | ----------- | ---------------------------------------------------------------------------------- |
| `EBB_PORT`      | `4000`      | HTTP listen port inside the container. The image also uses it for the healthcheck. |
| `EBB_HOST_PORT` | `4000`      | Compose only: the host port published for `EBB_PORT`.                              |
| `EBB_DATA_DIR`  | `/app/data` | RocksDB + SQLite data directory. Point it at the volume, not at a layer path.      |
| `EBB_AUTH_MODE` | (none)      | `bypass` or `external`. **No default** — the container refuses to boot without it. |
| `EBB_AUTH_URL`  | (none)      | Identity service URL. Required when `EBB_AUTH_MODE=external`.                      |

Auth is the one setting where the environment wins over the release's compiled
config, so a baked-in value can never silently override the operator's
instruction.

> [!WARNING]
> `EBB_AUTH_MODE=bypass` lets any client forge an actor identity through the
> `x-ebb-actor-id` header. The server logs a warning at boot when it is active.
> A public deployment must use `external` with a reachable `EBB_AUTH_URL`.

## 5. Persistence, upgrades, and backups

`/app/data` is a volume and holds everything durable:

- `rocksdb/` — the action log. It is the source of truth; losing it loses
  history.
- `ebb.db` (plus `ebb.db-wal` / `ebb.db-shm`) — the SQLite entity cache. It is
  rebuilt from the action log, so it can be regenerated; the action log cannot.

Data survives removing and recreating the container as long as the volume is
reused:

```bash
docker rm -f ebb
docker run -d --name ebb -p 4000:4000 -v ebb-data:/app/data \
  -e EBB_AUTH_MODE=external -e EBB_AUTH_URL=https://identity.example.com \
  "$EBB_IMAGE"
```

The volume is owned by uid/gid `10001` (the container user). A bind mount
inherits the host's ownership instead, so either `chown 10001:10001` the host
directory or run the container with `--user "$(id -u):$(id -g)"`.

### Upgrading

Pull the new tag and restart against the same volume. Migrations run at boot:
SQLite creates or migrates its schema, and the action-log format only moves
forward. A newer release reads an existing volume without a manual step, but
rolling _back_ to an older tag after the newer one has written can fail to
decode the newer records. Back up first.

```bash
docker pull "$EBB_IMAGE"
docker rm -f ebb
# ... then the same `docker run` as above with the new tag
# or, with compose:
docker compose pull && docker compose up -d
```

### Backing up

Stop the container first. RocksDB and SQLite's WAL are not consistent on disk
while writes are in flight, so copying the volume under a live server produces a
torn backup.

```bash
docker stop ebb

# runs as your uid, so the archive lands on the host writable by you
# instead of owned by root
docker run --rm \
  --user "$(id -u):$(id -g)" \
  -v ebb-data:/data:ro \
  -v "$PWD":/backup \
  "$EBB_IMAGE" \
  tar czf /backup/ebb-data.tgz -C /data .

docker start ebb
```

Restore into a fresh volume with the container stopped. No `--user` here: the
image's own user (`10001`) owns a newly created volume, and the restored files
must keep that ownership for the server to write to them.

```bash
docker volume create ebb-data-restored
docker run --rm \
  -v ebb-data-restored:/data \
  -v "$PWD":/backup:ro \
  "$EBB_IMAGE" \
  tar xzf /backup/ebb-data.tgz -C /data
```

`tar` runs inside the image, so this needs no tooling on the host beyond Docker.

## 6. What the image is

- **Multi-stage.** The release is assembled in an `elixir:1.17.3-otp-27` builder
  stage (digest pinned) so the bundled ERTS and the compiled NIFs match the glibc
  and OpenSSL of the runtime stage, `debian:bookworm-slim` (also digest pinned).
- **No toolchain.** The runtime stage installs only `libsnappy1v5` (RocksDB NIF),
  `libssl3` (OTP crypto), `ca-certificates` (outbound TLS to the identity
  service), and `curl` (healthcheck). There is no Elixir, Mix, git, cmake, or
  compiler in the image, and no repository source.
- **Non-root.** Runs as `ebb`, uid/gid `10001:10001`, no login shell, home
  `/app`. `/app/data` is created and owned by that user before `VOLUME`, so an
  anonymous volume is writable out of the box.
- **Bundled ERTS.** The release carries its own Erlang runtime; the container is
  `exec`'d into the BEAM, so the BEAM is PID 1 and shuts down on `SIGTERM`.
- **Size.** 160 MiB uncompressed as measured by the CI image job: the `bookworm-slim`
  base is ~78 MB, the runtime libraries ~15 MB, and the release ~67 MB. The
  smoke test fails if the image grows past 250 MiB.
- **Not included.** TLS termination — put a reverse proxy (Caddy, nginx,
  Traefik) in front and expose the container on a private network. No
  clustering, multi-node, or horizontal scaling; a deployment is one node and
  one Writer.

## 7. Verification

The acceptance checks that need a real Docker daemon live in one script:

```bash
bash scripts/docker-smoke-test.sh ebb_server:local
```

It asserts that the image boots with a named volume and reports healthy, that
`/healthz` is reachable without auth while `/sync/handshake` still requires an
actor identity, that data written before a container is destroyed is readable
from a new container on the same volume, that the image refuses to boot without
`EBB_AUTH_MODE`, and that no build toolchain or repository source leaked into
the runtime image.

CI builds the image and runs that script on pull requests — the `docker-image`
job in `.github/workflows/ci.yml` — so a Dockerfile that stops satisfying this
contract fails CI instead of shipping. Tagged releases publish
`ghcr.io/ebbjs/ebb_server:<version>` and `:latest` from
`.github/workflows/release-image.yml`, which then pulls the pushed digest back
and runs the same script against it.
