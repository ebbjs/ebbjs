# @ebbjs/server

Server runtime tooling for TypeScript — spawns and manages `ebb_server` processes, seeds data via HTTP, and provides integration test infrastructure.

## What it does

- **Spawns the Elixir server** as a subprocess using the bundled release
- **Seeds data** via HTTP using the same write path as real clients
- **Provides test harness** for integration tests that run against a real server

## Why a separate package?

Both integration tests and CLI commands need to run and interact with the `ebb_server`. By extracting the lifecycle management into `@ebbjs/server`, we avoid duplicating server spawning, seeding, and shutdown logic across:

- Client integration tests
- Server integration tests
- Future CLI tools (`ebb dev`, `ebb start`, `ebb seed`)

## Components

| Component                                 | Purpose                                           |
| ----------------------------------------- | ------------------------------------------------- |
| [Harness](components/harness.md)          | Spawn, monitor, and kill the `ebb_server` process |
| [Seed Client](components/seed-client.md)  | Seed data via HTTP POST to `/sync/actions`        |
| [Integration Tests](integration-tests.md) | Guide for writing e2e tests using the harness     |

## Bundled Release

The package includes a pre-built `ebb_server` release in `dist/ebb_server/`. This is built automatically during `pnpm build` by running `mix release` in the `ebb_server/` directory and copying the output.

See [Harness](components/harness.md#build-and-caching) for details on how the build and caching work.

## Quick Start

### Start a server

```typescript
import { startServer } from "@ebbjs/server";

const server = await startServer({
  dataDir: "/tmp/ebb-data",
  port: 4000,
});

console.log(`Server running at ${server.url}`);

// When done:
await server.kill();
```

### Seed data

```typescript
import { seed } from "@ebbjs/server";

await seed(server.url, "actor_test", {
  groups: [{ id: "grp_001", name: "Test Group" }],
  groupMembers: [
    {
      id: "gm_001",
      actorId: "actor_test",
      groupId: "grp_001",
      permissions: ["read", "write"],
    },
  ],
  entities: [
    {
      id: "ent_001",
      type: "todo",
      patches: [
        { fields: { title: { value: "Todo", updateId: "u1", hlc: "1700000000000001" } } },
        { fields: { status: { value: "open", updateId: "u2", hlc: "1700000000000002" } } },
      ],
    },
  ],
});
```

## Architecture

```
                    ┌─────────────────────────────────┐
                    │         @ebbjs/server           │
                    │                                 │
                    │  ┌─────────────────────────┐   │
                    │  │  Harness                │   │
                    │  │  startServer()          │   │
                    │  │  waitForReady()         │   │
                    │  └─────────────────────────┘   │
                    │                                 │
                    │  ┌─────────────────────────┐   │
                    │  │  Seed Client            │   │
                    │  │  seed()                 │   │
                    │  │  buildSeedAction()      │   │
                    │  └─────────────────────────┘   │
                    └─────────────────────────────────┘
                                    │
                    ┌───────────────┴───────────────┐
                    │                               │
           ┌────────▼────────┐          ┌──────────▼──────────┐
           │  Client Tests   │          │  CLI (future)       │
           │  e2e/sync.test  │          │  ebb dev, ebb start │
           └─────────────────┘          └─────────────────────┘
```

## Dependencies

- `@ebbjs/core` — for `Action` type and MsgPax encoding
- Node.js built-ins — `child_process`, `http` (no additional runtime deps)

## Build Requirements

Building this package requires **Elixir 1.17+ and OTP 27** (for `mix release`). These must be available in the build environment.

The `pnpm build` script:

1. Runs `vite build` for TypeScript compilation
2. Runs `scripts/build-release.js` to build and bundle the Elixir release

Incremental builds check if source `.ex` files have changed before re-running `mix release`.

## Constraints

- Server must be running in `:bypass` auth mode for tests (set via `EBB_SERVER_AUTH_MODE=bypass` — automatically set by harness)
- Seeding requires the server to be running and accessible at the given `baseUrl`
