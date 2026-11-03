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


# Bun runs function bundles. It is only needed for the functions integration
# tests and for local function authoring, so a missing Bun is a warning rather
# than a setup failure: `mix test` must stay green without it. The version is
# pinned in `.bun-version` at the repo root and installed by the CI Bun job.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PINNED_BUN="$(tr -d '[:space:]' < "$REPO_ROOT/.bun-version" 2>/dev/null || true)"

if command -v bun >/dev/null 2>&1; then
  INSTALLED_BUN="$(bun --version)"
  if [ -n "$PINNED_BUN" ] && [ "$INSTALLED_BUN" != "$PINNED_BUN" ]; then
    echo "Warning: Bun $INSTALLED_BUN is installed, but .bun-version pins $PINNED_BUN."
    echo "         Function integration tests may not match CI."
  else
    echo "Bun $INSTALLED_BUN is installed."
  fi
else
  echo "Warning: Bun is not installed; functions integration tests are skipped."
  if [ -n "$PINNED_BUN" ]; then
    echo "         Install Bun $PINNED_BUN from https://bun.sh to run them."
  else
    echo "         Install Bun from https://bun.sh to run them."
  fi
fi

echo "ebb_server system dependencies installed."
echo "Next: install Elixir 1.17 + OTP 27 (see ebb_server/.tool-versions)."
