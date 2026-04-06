# Ebb Server

Elixir/OTP backend for the ebb local-first collaborative platform. Handles persistent storage, sync protocol, real-time fan-out, permission enforcement, and HTTP API.

## Quick Start

```bash
# Install dependencies
mix deps.get

# Run tests
mix test

# Start dev server (http://localhost:4000)
mix dev
```

## Code Quality

```bash
# Format code
mix format

# Check formatting
mix format --check-formatted

# Run credo linter
mix credo --strict

# Run tests
mix test
```

## Docker

```bash
# Build
docker build -t ebb_server .

# Run
docker run -p 4000:4000 ebb_server

# Override environment
docker run -e EBB_PORT=5000 -e EBB_DATA_DIR=/data -v /path/to/data:/data ebb_server
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `EBB_PORT` | `4000` | HTTP listen port |
| `EBB_DATA_DIR` | `/app/data` | RocksDB + SQLite data directory |

For full architecture documentation, see [docs/ebb_server/README.md](../docs/ebb_server/README.md).
