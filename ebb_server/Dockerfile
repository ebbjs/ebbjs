# Build context is the repository root:
#   docker build -f ebb_server/Dockerfile -t ebb_server:local .
#
# The release is assembled here, inside the builder, never copied in from a
# host `_build`: the bundled ERTS and the compiled NIFs link against the
# builder's glibc and OpenSSL, so a release built on a newer host libc fails to
# load on the runtime base below.
#
# Tag + digest pin: `elixir:1.17.3-otp-27` is the Elixir 1.17 / OTP 27 pair that
# `ebb_server/mix.exs` and `.tool-versions` target; refresh the digest
# deliberately (and the runtime digest with it) when bumping either.
FROM elixir:1.17.3-otp-27@sha256:ceab9a0a37f0d8b5d405efe0eb4c8575477864c2fcff017e949dbaf9b46d741b AS builder

# Build-only system dependencies. `scripts/setup-ebb-server.sh` is the
# canonical list (cmake plus the `-dev` headers the NIFs compile against) and
# is shared with local dev and CI; it is not a runtime list.
COPY scripts/setup-ebb-server.sh /tmp/setup-ebb-server.sh
RUN bash /tmp/setup-ebb-server.sh && rm /tmp/setup-ebb-server.sh

WORKDIR /app
ENV MIX_ENV=prod

# Dependencies first, so editing `lib/` or `config/` never re-fetches or
# re-compiles them. `mix.exs` and `mix.lock` are all Mix needs at this point;
# `config/config.exs` is absent and Mix skips loading it.
COPY ebb_server/mix.exs ebb_server/mix.lock ./
RUN mix local.hex --force && \
    mix local.rebar --force && \
    mix deps.get

# rocksdb's rebar3 compile hook runs `git submodule update --init --recursive`,
# which exits non-zero outside a work tree. Its hex package vendors the C++
# sources, so an empty repository makes the hook a no-op instead of a failure.
RUN git init --quiet .

RUN mix deps.compile

COPY ebb_server/config ./config
COPY ebb_server/lib ./lib

# `elixirc_paths(:prod)` is `["lib"]`, so `test/` and `bench/` never reach the
# compiler and are not part of the build context.
RUN mix compile

# `include_erts` defaults to true, so the release carries its own runtime and
# the image needs no Erlang or Elixir install.
RUN mix release

# Same Debian release as the builder: the bundled ERTS and the NIFs inside the
# release are linked against bookworm's glibc 2.36 and OpenSSL 3.
FROM debian:bookworm-slim@sha256:7ff6ba31527b9e336162fa061746c366c4b2032f4d2cff2078bea43f78efe3f8

# Runtime libraries only:
#   libsnappy1v5  — `liberocksdb.so` links it (liblz4, libstdc++, libgcc are
#                   already in the slim base)
#   libssl3       — `crypto.so` links `libcrypto.so.3`
#   ca-certificates — the external auth mode posts over HTTPS and OTP reads the
#                   OS trust store
#   curl          — the HEALTHCHECK below
# The `-dev` packages from `scripts/setup-ebb-server.sh` are build-only and
# deliberately absent here.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      libsnappy1v5 \
      libssl3 \
      ca-certificates \
      curl && \
    rm -rf /var/lib/apt/lists/*

# Fixed numeric ids keep volume ownership stable across image rebuilds.
RUN groupadd --gid 10001 ebb && \
    useradd --uid 10001 --gid 10001 --home-dir /app --no-create-home --shell /usr/sbin/nologin ebb

COPY --from=builder --chown=10001:10001 /app/_build/prod/rel/ebb_server /app

# Created before `VOLUME` so an anonymous volume inherits the runtime
# user's ownership and RocksDB can open its directory.
RUN install -d --owner 10001 --group 10001 /app/data

# Stamped by the release workflow (`--build-arg VERSION=<tag>`); the defaults
# describe a local build, and a bumped version only invalidates this layer.
ARG VERSION=dev
ARG REVISION=dev

LABEL org.opencontainers.image.title="ebb_server" \
      org.opencontainers.image.description="Elixir/OTP sync server for ebb: RocksDB action log, SQLite materialization, sync API, SSE fan-out." \
      org.opencontainers.image.source="https://github.com/ebbjs/ebbjs" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.version="${VERSION}"

# The BEAM's file-name handling and the release's own output assume a UTF-8
# locale; the slim base does not set one.
ENV LANG=C.UTF-8
ENV EBB_PORT=4000
ENV EBB_DATA_DIR=/app/data

WORKDIR /app
USER ebb

VOLUME /app/data

EXPOSE 4000

# Shell form so `${EBB_PORT}` expands. `/healthz` is unauthenticated and
# answers 200 only once the storage supervisor is serving, so a booting
# container fails the check instead of reporting ready.
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=3 \
  CMD curl --fail --silent --show-error --max-time 2 "http://127.0.0.1:${EBB_PORT}/healthz"

# `start` execs the bundled ERTS, so the BEAM is PID 1 and receives SIGTERM.
CMD ["/app/bin/ebb_server", "start"]
