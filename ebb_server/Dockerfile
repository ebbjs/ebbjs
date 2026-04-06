FROM elixir:1.17-otp-27

RUN apt-get update && apt-get install -y \
    cmake libsnappy-dev libsqlite3-dev libz-dev \
    libbz2-dev liblz4-dev libzstd-dev \
    && rm -rf /var/lib/apt/lists/*

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
