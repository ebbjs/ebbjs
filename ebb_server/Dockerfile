FROM elixir:1.17-otp-27

# Install system deps via the shared setup script (canonical source of truth).
# Build from the repo root so `scripts/` resolves — e.g.:
#   docker build -f ebb_server/Dockerfile .
COPY scripts/setup-ebb-server.sh /tmp/setup-ebb-server.sh
RUN bash /tmp/setup-ebb-server.sh && rm /tmp/setup-ebb-server.sh

RUN useradd --create-home --shell /bin/bash app

WORKDIR /app

COPY mix.exs mix.lock ./
RUN mix local.hex --force && \
    mix local.rebar --force && \
    mix deps.get

COPY . .

RUN mix compile

RUN mix release

USER app

ENV EBB_PORT=4000
ENV EBB_DATA_DIR=/app/data

CMD ["_build/release/rel/ebb_server/bin/ebb_server", "start"]
