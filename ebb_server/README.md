# Ebb Server

Elixir/OTP backend for the ebb local-first collaborative platform. Handles persistent storage, sync protocol, real-time fan-out, permission enforcement, and HTTP API.

## Quick Start

```bash
# Install dependencies
mix deps.get

# Run tests
mix test

# Start dev server (http://localhost:4000) with lib/ auto-reload
mix dev
```

`mix dev` runs the application under `MIX_ENV=dev`. There is no file
watcher — restart with `mix dev` after editing anything under `lib/`
or `config/`.

From the repo root, `pnpm dev` runs `mix dev` plus the
`collaborative-text-demo` Vite app in the same terminal pane.

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

## OpenAPI Spec

The HTTP API is documented with an OpenAPI 3.1 spec.

```bash
# Generate openapi.yaml from router annotations
mix openapi.gen.spec
```

## Configuration

| Variable       | Default     | Description                     |
| -------------- | ----------- | ------------------------------- |
| `EBB_PORT`     | `4000`      | HTTP listen port                |
| `EBB_DATA_DIR` | `/app/data` | RocksDB + SQLite data directory |

For full architecture documentation, see [docs/ebb_server/README.md](../docs/ebb_server/README.md).
