#!/bin/bash
#
# Install system dependencies required to build ebb_server.
# Single source of truth for the Elixir build environment.
# Called by:
#   - `pnpm setup:ebb-server` for local dev (interactive)
#   - `ebb_server/Dockerfile` for image builds (root, non-interactive)
#   - `.github/workflows/ci.yml` Elixir jobs (root, non-interactive)
#
# The macOS branch is for local dev only; CI and Docker are Linux.
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
  # Runner images ship third-party apt sources (Microsoft, Azure CLI) that this
  # build never uses. When one of them is unreachable from CI egress, its
  # missing Release file makes `apt-get update` exit non-zero, which the
  # integration job sees as a 15-minute hang and a red main. Drop those
  # sources so the update stays strict about the distribution archives, which
  # are what actually provide the packages below.
  rm -f /etc/apt/sources.list.d/microsoft* \
        /etc/apt/sources.list.d/azure* \
        /etc/apt/sources.list.d/*.microsoft* 2>/dev/null || true

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
