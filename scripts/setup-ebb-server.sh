#!/bin/bash
#
# Install system dependencies required to build ebb_server.
# Canonical source of truth for the Elixir build environment;
# the Dockerfile and .github/workflows/ci.yml keep their own
# inline apt-get invocations but defer to this list.
#
set -e

if [ "$(uname -s)" = "Darwin" ]; then
  if ! command -v brew >/dev/null 2>&1; then
    echo "Error: Homebrew is required on macOS. Install from https://brew.sh"
    exit 1
  fi
  brew update
  brew install cmake pkg-config snappy sqlite zstd lz4 xz
else
  if [ "$(id -u)" -ne 0 ]; then
    echo "Error: re-run with sudo (apt-get requires root)"
    exit 1
  fi
  apt-get update
  apt-get install -y \
    cmake \
    libsnappy-dev \
    libsqlite3-dev \
    libz-dev \
    libbz2-dev \
    liblz4-dev \
    libzstd-dev
  rm -rf /var/lib/apt/lists/*
fi

echo "ebb_server system dependencies installed."
echo "Next: install Elixir 1.17 + OTP 27 (see ebb_server/.tool-versions)."
