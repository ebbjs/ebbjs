# Agents

## Dev Commands

### TypeScript (packages/\*)

```bash
pnpm build              # Build all packages (vite build)
pnpm test               # Run all tests (vitest --run --passWithNoTests)
pnpm tsc --noEmit       # Typecheck (root-level project references)
pnpm lint               # oxlint
pnpm fmt                # oxfmt
pnpm fmt:check          # oxfmt --check
pnpm core build         # Build single package
pnpm --filter @ebbjs/core test  # Run tests for single package
```

### Elixir (ebb_server/)

```bash
cd ebb_server
mix test               # Run tests
mix format --check-formatted  # Check formatting
mix credo --strict     # Lint
mix dev                # Start dev server on port 4000
mix openapi.gen.spec   # Generate openapi.yaml from router annotations
```

Requires Elixir 1.17 + OTP 27 and system deps: `cmake libsnappy-dev libsqlite3-dev libz-dev libbz2-dev liblz4-dev libzstd-dev`

## Architecture

- **packages/** — TypeScript monorepo (pnpm workspace)
  - `@ebbjs/core` — Schema, data model, shared types (src/index.ts)
  - `@ebbjs/client` — Local-first client with offline writes, outbox, sync
  - `@ebbjs/server` — Server function runtime (`defineFunction`)
  - `@ebbjs/www` — Docs site (Astro)
- **ebb_server/** — Elixir/OTP sync & storage server (RocksDB + SQLite)

## CI Order

TypeScript: `typecheck → lint → format → test`
Elixir: `format → credo → test`

## Pre-commit Hooks

lefthook runs on staged `.ts/.tsx` files: `oxlint --fix` then `oxfmt --write`. For Elixir: `mix format --check-formatted`, `mix credo --strict`, `mix test`.

## Key Config Files

- `tsconfig.base.json` — ES2022, bundler module resolution, strict mode
- `vitest.config.ts` — `globals: true`, `environment: "node"`
- `packages/*/vite.config.ts` — Vite library build with `dts` plugin (rollupTypes: false)

## Dependencies

- Node >= 22.8.0, pnpm 10.30.1
- `better-sqlite3` and `lefthook` require native build (listed in `pnpm.onlyBuiltDependencies`)
