FROM elixir:1.17-otp-27

RUN apt-get update && apt-get install -y \
    cmake libsnappy-dev libsqlite3-dev libz-dev \
    libbz2-dev liblz4-dev libzstd-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app