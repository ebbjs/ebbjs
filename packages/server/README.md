# @ebbjs/server

> **TS package — e2e test harness only.** This is not a runtime. It
> spawns the `ebb_server` Elixir release as a child process, waits until
> it accepts HTTP requests, and seeds fixtures through the same action
> write path real clients use.

See [`docs/`](./docs/) for the contributor docs — the
[harness](./docs/components/harness.md),
[seed client](./docs/components/seed-client.md), and the
[integration test guide](./docs/integration-tests.md).

## Public exports

Everything below is re-exported from [`src/index.ts`](./src/index.ts):

| Export                                                   | Kind     | Purpose                                                                 |
| -------------------------------------------------------- | -------- | ----------------------------------------------------------------------- |
| `RELEASE_BIN_PATH`                                       | const    | Absolute path to the bundled `ebb_server` release binary under `dist/`. |
| `startServer`                                            | function | Spawn the release and resolve a `RunningServer` once it is ready.       |
| `waitForReady`                                           | function | Poll a base URL until the server answers routed requests (or time out). |
| `ServerOptions`                                          | type     | `{ dataDir, port?, env? }` accepted by `startServer`.                   |
| `RunningServer`                                          | type     | `{ pid, port, url, dataDir, kill() }` returned by `startServer`.        |
| `seed`                                                   | function | POST a `SeedData` fixture to `/sync/actions`.                           |
| `buildSeedAction`                                        | function | Build the `Action` that `seed` sends, without doing HTTP.               |
| `GroupSeed`, `GroupMemberSeed`, `EntitySeed`, `SeedData` | types    | Shape of the fixture data `seed` accepts.                               |
| `Action`                                                 | type     | Re-exported from `@ebbjs/core`.                                         |

The implementations live in [`src/harness.ts`](./src/harness.ts) and
[`src/seed-client.ts`](./src/seed-client.ts). `SeedData.relationships`
accepts a `RelationshipSeed` defined in [`src/types.ts`](./src/types.ts);
it is not currently re-exported from `src/index.ts`.

## Quick start

`startServer` resolves with a live server; `seed` writes fixtures over HTTP
and throws if the server rejects them.

```typescript
import { startServer, seed } from "@ebbjs/server";

const server = await startServer({
  dataDir: "/tmp/ebb-data",
  port: 4000,
});

try {
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
          {
            fields: {
              title: { value: "Todo", update_id: "upd_1", hlc: "1700000000000001" },
            },
          },
        ],
      },
    ],
  });

  const response = await fetch(`${server.url}/sync/handshake`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-ebb-actor-id": "actor_test",
    },
    body: JSON.stringify({ cursors: {} }),
  });

  console.log(await response.json());
} finally {
  await server.kill();
}
```

`startServer` calls `waitForReady` internally. Import `waitForReady`
directly only when you manage the server process yourself.

## Running the e2e tests

```bash
# Bundles the Elixir release, then builds the TypeScript (requires
# Elixir 1.17+ and OTP 27 for `mix release`).
pnpm --filter @ebbjs/server test
```

`test`'s `pretest` hook runs the build first; `scripts/build-release.sh`
reuses an existing `dist/ebb_server/` bundle instead of rebuilding it. The
Quick start above mirrors the suite: `src/test/e2e/setup.ts` starts one
server for the file and `src/test/e2e/sync.test.ts` seeds it through
`src/test/e2e/seeds/single-entity.ts`. Set `EBB_SERVER_DATA_DIR` to choose
where the server stores its data.
