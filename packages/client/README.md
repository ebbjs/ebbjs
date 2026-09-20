# @ebbjs/client

Local-first sync client for the ebbjs stack. Performs handshake, catch-up,
and live SSE streaming against an `ebb_server`, with an outbox for offline
writes and a query layer over materialized entities.

## Status

Working in development. The README will fill out as the SDK stabilizes.
Today: handshake, catch-up, live SSE, outbox, presence. The React bindings,
query layer ergonomics, and server functions are still being designed.

## Testing

Three scripts:

- `pnpm --filter @ebbjs/client test` — unit tests only. Fast, no server
  needed. 213 tests across `src/sync/`, `src/fields/`,
  `src/presence/`, and the storage layer. Runs in CI on every PR.
- `pnpm --filter @ebbjs/client test:watch` — same as `test`, in watch mode.
- `pnpm --filter @ebbjs/client test:integration` — round-trip integration
  tests under `src/__tests__/integration/` against a live `ebb_server`.
  Not run by default.

### Running integration tests locally

1. Build the release once:

   ```bash
   bash packages/server/scripts/build-release.sh
   ```

2. Start `ebb_server` on the default port (4000):

   ```bash
   ./packages/server/dist/ebb_server/bin/ebb_server start
   ```

   Or run from source: `cd ebb_server && MIX_ENV=dev mix run --no-halt`.

3. In another shell:

   ```bash
   pnpm --filter @ebbjs/client test:integration
   ```

   Override the server URL with `EBB_TEST_URL=http://localhost:4001` for
   a non-default port.

### Integration test layout

`src/__tests__/integration/` contains two files:

- `ebb-server.test.ts` — self-seeding. Creates a unique group + members
  per run and exercises the full client ↔ server round-trip (handshake,
  catchUp, write, presence, permission rejection).
- `presence.test.ts` — requires a pre-seeded `grp_demo` group with a
  `demo-seeder` member that this package does not bootstrap. The test
  probes for that fixture at load time and skips cleanly with a warning
  when it's missing. Seed the demo fixtures locally if you want to run
  it end-to-end.

The CI integration job (`elixir-integration-tests` in
`.github/workflows/ci.yml`) boots the cached release and runs
`test:integration`. `presence.test.ts` skips there because the demo
fixture is not seeded.
