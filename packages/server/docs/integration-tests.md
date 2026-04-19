# Integration Test Approach

## Overview

Integration tests run against a real `ebb_server` process (not mocked) to validate end-to-end behavior. The test harness starts the server, seeds it, runs tests, then tears down the server.

The `ebb_server` release is bundled into `@ebbjs/server` during its build step — tests don't need to build or locate an external release.

## Architecture

```
packages/server/
  docs/
    README.md              # This file
    components/
      harness.md           # Server lifecycle management
      seed-client.md       # HTTP-based seeding
  src/
    harness.ts             # startServer, waitForReady
    seed-client.ts         # seed function
    index.ts               # exports
  scripts/
    build-release.js       # Builds and caches the Elixir release
  test/
    e2e/
      setup.ts             # beforeAll/afterAll server lifecycle
      sync.test.ts         # integration tests
      seeds/
        single-entity.ts   # Seed data builders
```

## Test Flow

```
1. Build: pnpm build → vite build + mix release (cached if source unchanged)
2. Seed: startServer() → seed() → kill (one-time to produce seeded data dir)
3. Run: startServer() → run tests → killServer()
```

The seeded data dir can be produced once and reused across test runs (unless seed data changes). Alternatively, tests can seed fresh each run.

## Setup and Teardown

```typescript
// test/e2e/setup.ts
import { startServer } from "@ebbjs/server";
import type { RunningServer } from "@ebbjs/server";

let server: RunningServer;

beforeAll(async () => {
  server = await startServer({
    dataDir: process.env.EBB_SERVER_DATA_DIR!,
    port: 4000,
  });
});

afterAll(async () => {
  await server.kill();
});

export { server };
```

```typescript
// test/e2e/sync.test.ts
import { describe, test, expect, beforeAll } from "vitest";
import { server } from "./setup";
import { seed } from "@ebbjs/server";
import { buildSingleEntitySeed } from "./seeds";

beforeAll(async () => {
  await seed(server.url, "actor_test", buildSingleEntitySeed());
});

test("handshake returns group membership", async () => {
  const response = await fetch(`${server.url}/sync/handshake`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-ebb-actor-id": "actor_test",
    },
    body: JSON.stringify({ cursors: {} }),
  });

  const data = await response.json();
  expect(data.actor_id).toBe("actor_test");
  expect(data.groups).toContainEqual(expect.objectContaining({ id: "grp_001" }));
});
```

## Seed Data Builders

```typescript
// test/e2e/seeds/single-entity.ts
import type { SeedData } from "@ebbjs/server";

export const buildSingleEntitySeed = (): SeedData => ({
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
        {
          fields: {
            title: { value: "Test Todo", updateId: "upd_ent_001_1", hlc: "1700000000000001" },
          },
        },
        {
          fields: {
            description: {
              value: "A description",
              updateId: "upd_ent_001_2",
              hlc: "1700000000000002",
            },
          },
        },
        {
          fields: {
            status: { value: "open", updateId: "upd_ent_001_3", hlc: "1700000000000003" },
          },
        },
      ],
    },
  ],
});
```

## Running Tests

```bash
# Build package (includes Elixir release)
cd packages/server
pnpm build

# Run integration tests (uses bundled release)
pnpm test:e2e
```

The harness resolves the release path internally — no environment variables for release location needed.

## CI Integration

In CI, the build and test flow is:

```yaml
# .github/workflows/e2e.yml
- name: Build @ebbjs/server
  run: |
    cd packages/server
    pnpm build

- name: Run e2e tests
  run: |
    cd packages/server
    EBB_SERVER_DATA_DIR=/tmp/ebb-test pnpm test:e2e
```

No separate `mix release` step — the release is built as part of `pnpm build`.

## Key Principles

1. **Server is a black box** — tests interact only via HTTP. No accessing GenServers or internal state.
2. **Bundled release** — the harness uses the release bundled in `node_modules/@ebbjs/server/dist/ebb_server/`. Callers don't pass a release path.
3. **One server per test suite** — `beforeAll` starts the server, `afterAll` kills it. All tests share the same server instance.
4. **Tests are isolated from each other** — if tests modify server state, each test should reset via a clean seed copy or restart.
5. **Port conflicts are avoided** — CI should use a dedicated port.

## Open Questions

- Should each test get its own seeded data dir copy (via `cp -r`) for full isolation, or share one and accept that tests must be order-independent?
- Should there be a `beforeEach` that resets the server's DirtyTracker by touching an entity, forcing re-materialization?
- How do tests verify entity materialization — do they go through the EntityCache (like real clients) or directly through `storage.entities.get()`?
