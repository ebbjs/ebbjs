# self-hosting

Running `ebb_server` from a container image (issue #566). The image is a
single-node sync server: RocksDB action log, SQLite materialization, and the
sync HTTP API, with no build toolchain inside.

The container **requires explicit auth configuration**. It refuses to boot
without `EBB_AUTH_MODE`, because the alternative — a silent `:bypass` default —
lets any client forge an actor identity. See [Configuration](#4-configuration).

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
ebb_server boot failed: EBB_AUTH_MODE is not set and :ebb_server, :auth_mode has no compiled value. Set EBB_AUTH_MODE to one of: bypass, external, tailscale.
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

The repository root has a `compose.yaml` with three services: the default
`ebb`, the `dev`-profile demo, and the `tailscale`-profile embedded node.

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

Compose names: project `ebb`, services `ebb` (default), `ebb-dev` (profile
`dev`), and `ebb-tailscale` (profile `tailscale`), named volume `ebb-data`.
Override the image with `EBB_IMAGE`, e.g.
`EBB_IMAGE=ghcr.io/ebbjs/ebb_server:<version> docker compose up -d`, and the
published host port with `EBB_HOST_PORT` (the container keeps listening on
`EBB_PORT`, 4000).

The `tailscale` profile publishes no host port at all — the embedded node is the
ingress. It is covered in [Embedded node](#embedded-node).

## 4. Configuration

| Variable             | Default     | Description                                                                                                 |
| -------------------- | ----------- | ----------------------------------------------------------------------------------------------------------- |
| `EBB_PORT`           | `4000`      | HTTP listen port inside the container. The image also uses it for the healthcheck.                          |
| `EBB_HOST_PORT`      | `4000`      | Compose only: the host port published for `EBB_PORT`.                                                       |
| `EBB_DATA_DIR`       | `/app/data` | RocksDB + SQLite data directory. Point it at the volume, not at a layer path.                               |
| `EBB_AUTH_MODE`      | (none)      | `bypass`, `external`, or `tailscale`. **No default** — the container refuses to boot without it.            |
| `EBB_AUTH_URL`       | (none)      | Identity service URL. Required when `EBB_AUTH_MODE=external`; unused by `tailscale`.                        |
| `EBB_ADMIN_TOKEN`    | (unset)     | Admin `Authorization: Bearer` credential for `/admin/apps` and function deploys; unset denies admin routes. |
| `EBB_CORS_ORIGINS`   | (empty)     | Comma-separated browser origins always admitted, unioned with the app registry.                             |
| `EBB_CORS_ALLOW_ANY` | (unset)     | `1` admits every browser origin, overriding the mode default; logged at boot.                               |

Auth is the one setting where the environment wins over the release's compiled
config, so a baked-in value can never silently override the operator's
instruction.

> [!WARNING]
> `EBB_AUTH_MODE=bypass` lets any client forge an actor identity through the
> `x-ebb-actor-id` header. The server logs a warning at boot when it is active.
> A public deployment must use `external` with a reachable `EBB_AUTH_URL`, or
> `tailscale` behind a gateway.

### Tailscale identity

`EBB_AUTH_MODE=tailscale` derives the actor from the Tailscale user a gateway
in front of the container identifies. It needs no `EBB_AUTH_URL`, and it binds
Bandit to `127.0.0.1` inside the container, so a published container port
cannot reach it: the gateway must share that loopback (the embedded node, or a
sidecar with a shared network namespace).

The server trusts these request headers, and only from a loopback peer:

| Header                    | Meaning                                                   |
| ------------------------- | --------------------------------------------------------- |
| `tailscale-user-login`    | The actor id (required, exactly one non-empty value)      |
| `tailscale-user-name`     | Display name, returned by `GET /sync/identity` (optional) |
| `x-ebb-tailscale-user-id` | Numeric user id, returned as `provider_id` (optional)     |
| `x-ebb-tailscale-secret`  | Closes local-process spoofing when a secret is configured |

Header names are compared lowercased, so the gateway's casing is irrelevant.

A user-run `tailscale serve` cannot inject a secret, so leave
`:tailscale_proxy_secret` unset with it and accept that any local process can
claim an identity. The embedded gateway is given a secret the server generates
at boot, which closes local-process spoofing (see [Embedded node](#embedded-node)).
In both cases `x-ebb-actor-id` is ignored: there is no fallback to the bypass
header.

> [!WARNING]
> These headers are ordinary request headers. They are safe only because the
> gateway strips any client-supplied copy and injects the identity it looked up
> itself. A reverse proxy that forwards inbound `tailscale-user-*` or
> `x-ebb-tailscale-*` headers is a spoofing hole, not a gateway.

`GET /sync/identity` returns the resolved actor so a browser client can learn an
identity it cannot know before asking:

```console
$ curl -s http://127.0.0.1:4000/sync/identity \
    -H 'tailscale-user-login: alice@example.com' \
    -H 'tailscale-user-name: Alice'
{"actor_id":"alice@example.com","display_name":"Alice","provider":"tailscale"}
```

#### Embedded node

The image bundles the gateway (`EBB_TAILSCALE_NODE=embedded` is its default), so
the turnkey deployment is a container with no published port: the node is the
ingress, and Bandit binds loopback inside the container.

```console
$ docker run --name ebb -d \
    -v ebb-data:/app/data \
    -e EBB_AUTH_MODE=tailscale \
    "$EBB_IMAGE"
```

The first boot prints the Tailscale login URL and an ASCII QR of the same URL:

```console
$ docker logs -f ebb
[...] tailscale login required: https://login.tailscale.com/a/xxxxxxxxxxxx
<QR block>
```

Open the URL or scan the QR and authorize the node once. The URL is logged
once per distinct URL, so a gateway retrying the control plane does not repeat
it. The QR can be turned off with `EBB_TAILSCALE_QR=false`; the URL line is
still logged.

The compose equivalent is the `tailscale` profile, which also publishes nothing
and keeps node state on the named volume:

```console
$ docker compose --profile tailscale up ebb-tailscale
```

#### Node state and persistence

The node's registration lives in `EBB_TAILSCALE_STATE_DIR`, default
`<EBB_DATA_DIR>/tailscale` (`/app/data/tailscale` in the image), and must be on
the volume. A restart with that directory reuses the existing node and does not
ask for authorization again. Deleting the volume — or just that directory —
re-registers the node: it appears as a new device in the tailnet and prints a
new login URL, so the old device stays behind until removed from the admin
console.

The directory is part of the data you back up; see [Persistence, upgrades, and
backups](#5-persistence-upgrades-and-backups). Restoring it restores the same
registration, so the restored deployment does not ask for login again. A state
directory whose device was removed from the tailnet in the meantime comes back
as needs-login and prints a fresh URL.

#### Tags and key expiry

Set `EBB_TAILSCALE_TAGS=tag:ebb` (comma or space separated) to request a tag at
first login, or use an auth key that was created with that tag. Tagged nodes
have key expiry disabled by default, which is what keeps a self-hosted node
signed in without operator attention.

The tag has to exist in the tailnet policy and the authorizing user has to be
allowed to apply it. When tags were requested but Tailscale applied none, the
gateway logs a warning naming the policy snippet it needs:

```json
"tagOwners": { "tag:ebb": ["autogroup:admin"] }
```

Tags are fixed at first login, so changing the list requires re-authenticating
the node: remove its state directory (or the device from the admin console) and
log in again. `EBB_TAILSCALE_REQUIRE_TAGS=true` turns that warning into a
failure — the gateway stops instead of serving untagged, which is the safer
default for a deployment that depends on not expiring.

An untagged node logs its key expiry date with the same snippet, and an expiry
within 14 days logs a warning.

Two consequences of tagging are worth planning for:

- The node's identity becomes the tag, not the operator's user. ACLs written
  against the user's login no longer cover it, and a restrictive tailnet needs
  an explicit inbound rule, e.g. `dst: tag:ebb:443`.
- Sharing still works. A tailnet admin can share the machine; the tag is
  stripped for the recipient, and they resolve to their own login.

#### HTTPS

`EBB_TAILSCALE_HTTPS` selects the listener mode:

- `auto` (default) — when MagicDNS and HTTPS certificates are enabled for the
  tailnet, serve TLS on `:443` and redirect `:80` with a `308`; otherwise serve
  plain HTTP on `:80` and warn, naming the admin-console DNS page to enable
  them.
- `on` — require TLS; fail instead of degrading to HTTP.
- `off` — always plain HTTP on `:80`.

The certificate is `<hostname>.<tailnet>.ts.net`, issued and renewed through
tsnet. Browsers only expose some APIs in a secure context, so enabling HTTPS on
the tailnet is recommended even though tailnet traffic is WireGuard-encrypted
either way.

#### External node

`EBB_TAILSCALE_NODE=external` is the dev default and the path for operators
whose own node already fronts the server. The server starts no gateway; the
operator's node proxies to it:

```console
$ tailscale serve --bg --https=443 http://127.0.0.1:4000
```

Containerized, the node has to share the server container's network namespace
— a sidecar with `network_mode: "service:ebb"` — so `tailscale serve …
http://127.0.0.1:4000` reaches Bandit on the shared loopback. A node on the host
cannot reach a container port that is bound to the container's own loopback.

There is no generated proxy secret on this path. `:tailscale_proxy_secret` must
stay unset, and the loopback peer is the only credential: any local process can
claim an identity by sending `tailscale-user-login` itself. That is why
`tailscale serve` cannot close local-process spoofing, while the embedded node
can.

#### Node settings

Every setting reads its `EBB_TAILSCALE_*` variable first, then the matching
`:ebb_server` application key, then the default. Blank counts as unset, and an
invalid value fails boot rather than at request time. `EBB_TAILSCALE_NODE` is
set to `embedded` in the image and `external` in `config/dev.exs`, so a dev run
does not spawn a gateway.

| Variable                     | Default                                    | Description                                                                                     |
| ---------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `EBB_TAILSCALE_NODE`         | `embedded` in the image, `external` in dev | Who runs the node: the bundled gateway, or the operator's `tailscale serve` / sidecar           |
| `EBB_TAILSCALE_STATE_DIR`    | `<EBB_DATA_DIR>/tailscale`                 | tsnet state directory. Must be on the volume, or every restart re-registers.                    |
| `EBB_TAILSCALE_HOSTNAME`     | `ebb`                                      | MagicDNS hostname; the node is `<hostname>.<tailnet>.ts.net`.                                   |
| `EBB_TAILSCALE_AUTHKEY`      | (unset)                                    | Optional auth key for unattended registration. The state directory is the normal path.          |
| `EBB_TAILSCALE_CONTROL_URL`  | (unset)                                    | Self-hosted control server (Headscale). Untested.                                               |
| `EBB_TAILSCALE_TAGS`         | (empty)                                    | Tags requested at first login, e.g. `tag:ebb`. See [Tags and key expiry](#tags-and-key-expiry). |
| `EBB_TAILSCALE_REQUIRE_TAGS` | `false`                                    | Stop the gateway rather than warn when requested tags were not applied.                         |
| `EBB_TAILSCALE_HTTPS`        | `auto`                                     | `auto`, `on`, or `off`; see [HTTPS](#https).                                                    |
| `EBB_TAILSCALE_QR`           | `true`                                     | Render the login URL as an ASCII QR in the logs.                                                |
| `EBB_TAILSCALE_PROXY_BIN`    | bundled `ebb_tsnode`                       | Gateway path override for dev and tests. Embedded mode fails at boot if it is not executable.   |

#### Health and operations

`/healthz` stays a storage-readiness check. A node that cannot reach the control
server, or is waiting for authorization, does **not** fail the container
healthcheck: the BEAM, storage, and the healthcheck stay up while the gateway
retries with backoff, and the tailnet state is reported in the logs.

On `SIGTERM` the server closes the gateway's stdin, waits up to five seconds for
it to drain open streams, then kills it; the supervisor waits longer still, so
the drain wins. A gateway that stops itself because a setting cannot work (a
configuration the server rejects, a tailnet that refuses the node) logs why and
is not restarted: fix the setting and restart the container.

The gateway is a static binary using tsnet's userspace network stack. It needs
no `/dev/net/tun`, no root, no capabilities, and no privileged host port, so the
container stays non-root with the same hardening as the other modes. Tailscale's
backend log upload is omitted at build time (`ts_omit_logtail`), and
`TS_NO_LOGS_NO_SUPPORT=1` is set in the gateway's environment.

#### Accepted limitations

- Removing a user from the tailnet does not terminate an open SSE stream
  immediately; the connection ends when it next closes.
- One person on two devices is one actor, because the actor is the tailnet
  login. Presence peers for that person collapse into one.
- With `EBB_TAILSCALE_REQUIRE_TAGS`, a node whose tags were not applied stops
  the gateway on purpose. `/healthz` stays green because it is a storage check,
  so the condition shows up as an error line in the logs rather than as an
  unhealthy container.

These are recorded in the design record ([#697](https://github.com/ebbjs/ebbjs/issues/697)).

### Request body limits

The server bounds each body-bearing route with an application-env key, read on
`POST /sync/actions`, `/sync/handshake`, `/entities/query`, `/sync/presence`.
These keys are documented in `ebb_server/README.md`; the published image has no
`EBB_*` overlay for them, so a release that needs a different ceiling sets them
in its own config, while a container operator's control is the reverse-proxy
limit below.

| Key                              | Default     | Route                  |
| -------------------------------- | ----------- | ---------------------- |
| `:sync_actions_max_body_bytes`   | `8_000_000` | `POST /sync/actions`   |
| `:sync_handshake_max_body_bytes` | `1_048_576` | `POST /sync/handshake` |
| `:entities_query_max_body_bytes` | `1_048_576` | `POST /entities/query` |
| `:presence_max_body_bytes`       | `32_768`    | `POST /sync/presence`  |

A body over the limit is `413 payload_too_large`; a body the adapter cannot
read is `400 invalid_body`. These bounds apply to HTTP/1 `Content-Length` and
HTTP/2 data-frame bodies. Bandit 1.x drains a `Transfer-Encoding: chunked`
body in one call and cannot enforce a limit there, so a deployment that accepts
chunked uploads must also set a body limit at the reverse proxy:

```caddyfile
# Caddy: 10MB, comfortably above the 8,000,000-byte default Action ceiling
example.com {
  request_body {
    max_size 10MB
  }
  reverse_proxy ebb:4000
}
```

```nginx
# nginx: same 10MB ceiling
client_max_body_size 10m;
```

### Browser origins and CORS

Ebb is one store reused by many apps, so cross-origin browser requests are
normal. CORS here is **browser-origin admission, not authorization**: it decides
which browser origins may read a response, while an actor's group grants remain
the only permission boundary. Non-browser clients — the CLI, functions,
server-to-server calls, `curl` — are unaffected by the registry and ignore CORS
entirely; they authenticate exactly as before.

The server admits an origin when it appears in either source (outside
`:bypass`, which admits every origin):

- `EBB_CORS_ORIGINS` — a comma-separated list of exact origins baked into the
  deployment's config or IaC.
- The app registry — apps and browser origins registered at `/admin/apps` and
  persisted in `<EBB_DATA_DIR>/apps.json`.

Register an app's origins in CI or at deploy time, using `ebb apps`
([#730](https://github.com/ebbjs/ebbjs/issues/730)) or the admin API below.
Removing an origin (or a whole app) revokes it once the browser's preflight
cache expires — about 300 seconds — not on the next request.

#### Mode defaults

| Auth mode   | Default until an origin is registered   |
| ----------- | --------------------------------------- |
| `bypass`    | `*` (every origin), with a boot warning |
| `external`  | deny all origins                        |
| `tailscale` | deny all origins                        |

`bypass` is dev-only. `external` and `tailscale` admit nothing until an origin
is registered or listed, because the browser's device or cookie can carry
ambient authority. `EBB_CORS_ALLOW_ANY=1` overrides either deny-all default,
admits every origin, and is logged at boot. There is no flag that guesses
whether an external app uses a bearer token or a cookie: external deployments
configure their origins.

#### Preflight

A preflight (`OPTIONS`) is answered with `GET, POST, DELETE, OPTIONS` and the
headers the client sends — `content-type`, `x-ebb-actor-id`, `accept`,
`cache-control`, `last-event-id`, `authorization` — plus `Access-Control-Max-Age: 300` and
`Vary: Origin`. The response reflects the matched origin, never a wildcard
pattern, and allows credentials only for an exact-origin match (never with
`*`). CORS headers also accompany auth and error responses, so a browser sees
the `401` instead of an opaque CORS failure.

#### Wildcard origins

An origin such as `https://*.example.com` is accepted but logs a warning;
prefer exact origins. The bare `*` is never an app origin: only
`EBB_CORS_ALLOW_ANY=1` admits every origin.

#### Admin API

`EBB_ADMIN_TOKEN` is the Bearer credential for `/admin/apps` (compiled:
`:ebb_server, :admin_token`). `EBB_FUNCTIONS_ADMIN_TOKEN` and the nested
`:ebb_server, :functions, :admin_token` remain a fallback, so an existing
function deployment keeps working. With no token configured there is no admin
credential and the admin routes fail closed; they are never open.

| Method   | Path                              | Body                 | Purpose                                       |
| -------- | --------------------------------- | -------------------- | --------------------------------------------- |
| `GET`    | `/admin/apps`                     | —                    | List registered apps and their origins        |
| `POST`   | `/admin/apps`                     | `{"name","origins"}` | Register an app; names and origins are unique |
| `DELETE` | `/admin/apps/:id`                 | —                    | Remove an app and its origins                 |
| `POST`   | `/admin/apps/:id/origins`         | `{"origin"}`         | Add one origin to an app                      |
| `DELETE` | `/admin/apps/:id/origins/:origin` | —                    | Remove one origin; URL-encode the origin      |

Every route requires `Authorization: Bearer`. Errors are
`{"error": "...", "details": ...}`, with `details` present only when there is
more to say. Origins are normalized (lowercase scheme and host, default port
stripped, no path/query/fragment; `null` is rejected), so
`https://notes.example.com:443/` and `https://notes.example.com` are the same
origin.

```console
# register an app and its production origin
$ curl -s http://localhost:4000/admin/apps \
    -H "Authorization: Bearer $EBB_ADMIN_TOKEN" \
    -H 'content-type: application/json' \
    -d '{"name":"notes","origins":["https://notes.example.com"]}'

# list apps and take the id you need
$ curl -s http://localhost:4000/admin/apps \
    -H "Authorization: Bearer $EBB_ADMIN_TOKEN" | jq -r '.apps[].id'

# remove the app; its origins stop being admitted after the preflight cache
$ curl -s -X DELETE http://localhost:4000/admin/apps/<id> \
    -H "Authorization: Bearer $EBB_ADMIN_TOKEN"

# remove one origin instead (the origin is URL-encoded)
$ curl -s -X DELETE \
    'http://localhost:4000/admin/apps/<id>/origins/https%3A%2F%2Fnotes.example.com' \
    -H "Authorization: Bearer $EBB_ADMIN_TOKEN"
```

#### Storage and backups

`apps.json` sits on the data volume beside RocksDB and SQLite. Writes are
atomic, so a crash cannot leave a half-written registry. A corrupt file fails
closed at boot — no origin is admitted until it is repaired or restored, and
the error is logged. Back it up and restore it with the rest of the volume (see
[Persistence, upgrades, and backups](#5-persistence-upgrades-and-backups)).
There is no file watcher; change the registry through the admin API.

## 5. Persistence, upgrades, and backups

`/app/data` is a volume and holds everything durable:

- `rocksdb/` — the action log. It is the source of truth; losing it loses
  history.
- `ebb.db` (plus `ebb.db-wal` / `ebb.db-shm`) — the SQLite entity cache. It is
  rebuilt from the action log, so it can be regenerated; the action log cannot.
- `apps.json` — the app registry (see [Browser origins and
  CORS](#browser-origins-and-cors)). Losing it admits no registered origin
  until the apps are registered again.
- `tailscale/` — the embedded node's registration state (see [Node state and
  persistence](#node-state-and-persistence)). It is not part of the sync data,
  but losing it re-registers the node and prints a new login URL.

With `EBB_AUTH_MODE=tailscale` the run command has no `-p`; the node is the
ingress (see [Embedded node](#embedded-node)).

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

The archive is the whole volume, so it includes `tailscale/` when the embedded
node is in use. Restoring it restores the node's registration, so the restored
deployment does not prompt for login again. A restored registration whose
device was removed from the tailnet in the meantime comes back as needs-login
and prints a fresh URL.

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
- **Bundled gateway.** The embedded Tailscale gateway (`ebb_server/tsnode`) is
  built in a pinned Go builder stage by `scripts/build-tsnode.sh` and copied
  into the release as `priv/tsnode/ebb_tsnode`. It is a static binary on
  tsnet's userspace network stack: no `/dev/net/tun`, no root, no privileged
  port. The runtime image keeps no Go toolchain and no gateway source.
- **Size.** The gateway stage adds its ~22 MiB static binary to the runtime
  image (267 MiB with it), and the smoke test fails if the image grows past
  300 MiB; the image job reports the measured size for a release.
- **Not included.** TLS termination for any ingress other than the embedded
  Tailscale node — put a reverse proxy (Caddy, nginx, Traefik) in front and
  expose the container on a private network. No clustering, multi-node, or
  horizontal scaling; a deployment is one node and one Writer.

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
the runtime image. It also boots a tailscale-mode container against an
unreachable control server and asserts that it stays healthy, publishes no host
port, keeps Bandit on loopback even when a port is published, and logs either a
login URL or why the node is not up.

CI builds the image and runs that script on pull requests — the `docker-image`
job in `.github/workflows/ci.yml` — so a Dockerfile that stops satisfying this
contract fails CI instead of shipping. Tagged releases publish
`ghcr.io/ebbjs/ebb_server:<version>` and `:latest` from
`.github/workflows/release-image.yml`, which then pulls the pushed digest back
and runs the same script against it.

### Automated tailnet harness

`scripts/tsnode-e2e.sh` (CI job `tsnode-e2e`) runs the real gateway binary
against a real Headscale control plane and a second real tailnet node, then
asserts that the backend receives the connecting user's identity, that a
peer-supplied identity or `X-Forwarded-For` is stripped, and that an SSE stream
is not buffered. It needs Docker, Go, Node, and curl.

Headscale keeps a user identity on tagged nodes, unlike Tailscale, so the
tagged-peer rejection and TLS below still need the manual run.

### Manual acceptance on a real tailnet

CI cannot join a tailnet, so the identity, TLS, and state behaviour are checked
by hand against a real one before a release. The run below assumes a fresh
volume; `$EBB_IMAGE` is the image built above.

1. Boot without a published port, with a tag requested, and authorize the node
   from the logs:

   ```console
   $ docker run --name ebb -d -v ebb-check:/app/data \
       -e EBB_AUTH_MODE=tailscale -e EBB_TAILSCALE_TAGS=tag:ebb \
       "$EBB_IMAGE"
   $ docker logs -f ebb
   ```

   Open the printed login URL (or scan the QR), authorize, and confirm the log
   line `tailscale node is serving https://…` reports `tls: on` and
   `tags: tag:ebb`.

2. From two devices on the tailnet, `GET /sync/identity` on the served URL
   returns each device's own login as `actor_id`. Complete a handshake and a
   write from each; open an SSE stream and confirm events arrive without
   buffering.

3. A tagged node logs no key-expiry warning. An untagged node logs its expiry
   date and the `tagOwners` snippet. A _tagged client_ — a device with no user
   identity — is rejected with `403` by the gateway.

4. `docker restart ebb` reuses the state directory without a new login prompt.
   Deleting the volume and starting again prints a new login URL.

5. Remove the node in the Tailscale admin console (or let its key expire). The
   gateway logs a fresh login URL; authorizing it restores service.

6. The client's SSE reconnect/catch-up path works over the gateway: kill and
   restore the tailnet connection mid-stream and confirm the client catches up
   rather than losing actions.
