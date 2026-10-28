<p align="center">
  <img src="packages/www/public/github-avatar.svg" width="80" height="80" alt="ebb logo" />
</p>

<h1 align="center">ebb</h1>

<p align="center">Build apps that are fast, work offline, and just sync.</p>

<p align="center">
  <img src="https://img.shields.io/badge/status-pre--alpha-orange" alt="Status: pre-alpha" />
  <a href="LICENSE.txt"><img src="https://img.shields.io/badge/license-Apache%202.0-blue" alt="License: Apache 2.0" /></a>
  <a href="https://ebbjs.com"><img src="https://img.shields.io/badge/website-ebbjs.com-stone" alt="Website" /></a>
</p>

---

> [!WARNING]
> **Pre-alpha.** Ebb is under active development and not yet ready for production use. The marketing copy below describes the _target_ product. **See [Current State](#current-state) below for what's in the repo today.**

Ebb is an open-source, local-first backend framework. Every client gets a local replica for instant reads, optimistic writes, and full offline support. Changes sync to all connected users in real-time with conflict resolution, presence, and multiplayer built in. The server is self-hostable — deploy to a VPS or run it on bare metal.

## Project Goals

- **Incredible DX** — A declarative, type-safe API that helps humans and agents get things right the first time. Define your data model, query with a type-safe ORM, react when data changes.
- **Fully open source** — No vendor lock-in. Designed to self-host from day one. Run the full stack with a single Docker image.
- **Fast, reactive, and multiplayer** — Data lives on the device, can be edited offline, and stays in sync with others. No polling, no spinners, no plumbing.

## Current State

What's actually in the repo today (last meaningful server work: Oct 2026).

| Area                               | State            | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Elixir sync server (`ebb_server/`) | **Working**      | RocksDB action log, single Writer GenServer, on-demand SQLite materialization, permissions, handshake, SSE live sync, paginated catch-up, presence broadcast, and a writer failure policy that abandons + resolves a failed commit so fan-out never stalls. See [`ebb_server/README.md`](ebb_server/README.md) for the architecture.                                                                                                                                                                                                                                                                      |
| `@ebbjs/core`                      | **Working**      | TypeBox schemas, HLC implementation, MessagePack codec, `createAction`, ID generation. 108 tests pass.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `@ebbjs/storage`                   | **Working**      | `StorageAdapter` with in-memory and IndexedDB implementations: ActionLog, DirtyTracker, EntityStore (lazy materialization, HLC + lexicographic tiebreak), CursorStore, durable OutboxStore. 214 tests pass (1 skipped).                                                                                                                                                                                                                                                                                                                                                                                   |
| `@ebbjs/server` (TS)               | **Harness only** | Spawns the Elixir release as a child process and exposes a `seed()` helper for E2E tests. One e2e test (handshake after seed).                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `@ebbjs/client`                    | **Working**      | Local-first sync SDK: handshake, live SSE, paginated catch-up, a typed query engine (`client.<entity>.query()` with `where` / `or` / `orderBy` / `limit` and one-level `with` joins), namespace write verbs (`create` / `update` / `delete` / `link` / `unlink`), `client.atomic` and `defineAction` for multi-entity writes, presence, and causal-tree collaborative text. `query()` is the public read root; `get()`, the async row accessors, and `subscribe(filter, cb)` are internal. Writes funnel through an in-memory Outbox seam; the durable/offline queue is tracked in #225. 1119 tests pass. |
| Auth & permissions                 | **Working**      | `AuthPlug` (bypass + external modes), Group/GroupMember/Relationship system entities, in-memory permission checks.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Self-hosting (Docker)              | **Working**      | Multi-stage image on `debian:bookworm-slim` running the assembled release as uid 10001, published to `ghcr.io/ebbjs/ebb_server` (`linux/amd64` only for now). Unauthenticated `GET /healthz` backs the container healthcheck, `EBB_AUTH_MODE` is required at boot (no silent `:bypass`), and `/app/data` is a named volume. CI builds the image and smoke-tests boot, auth gating, and persistence. Build locally from the repo root with `docker build -f ebb_server/Dockerfile .`; see [`docs/self-hosting.md`](docs/self-hosting.md).                                                                  |
| Real-time presence                 | **Working**      | `POST /sync/presence` endpoint and fan-out path are wired and tested.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| React bindings                     | **Partial**      | `@ebbjs/react` ships `EbbProvider`, `useClient`, `useConnection`, `useQuery` (the reactive read root), and `useEntityMutations`; writes and actions go through `useClient`. SSR / Suspense are out of scope.                                                                                                                                                                                                                                                                                                                                                                                              |
| Server functions                   | **Not started**  | Slice 5 spec exists; would run on a separate Bun runtime.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Collaborative text                 | **Working**      | Causal-tree text over Action/Update primitives with HLC ordering (**not** Yjs — [devlog](packages/www/src/content/devlog/how-collaborative-editing-works.mdx)). `TextDocument` in `@ebbjs/client`, `@ebbjs/codemirror` bridge, two-tab demo.                                                                                                                                                                                                                                                                                                                                                              |
| CLI tooling                        | **Not started**  |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Observability hooks                | **Partial**      | `EbbServer.Telemetry` publishes the `ebb.*` event catalogue, and the opt-in `onAction` Action exporter ships for analytics, audit logs, and warehouse sinks ([#125](https://github.com/ebbjs/ebbjs/issues/125)); client sync observables (`client.status`, outbox depth, conflicts) also ship. OpenTelemetry export is a follow-up. See [`ebb_server/README.md`](ebb_server/README.md#observability).                                                                                                                                                                                                     |
| Peer replication                   | **Not started**  | Slice 6 design exists; no implementation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

For a more detailed breakdown, see [`ebb_server/README.md`](ebb_server/README.md) (server architecture) and the per-package READMEs under `packages/*/`.

### Self-hosting

`ebb_server` runs from a container image: `docker build -f ebb_server/Dockerfile .` builds one locally, and CI builds and smoke-tests the same image on every PR. [`docs/self-hosting.md`](docs/self-hosting.md) has the copy-pasteable commands, the required auth configuration, the compose profiles, and the backup and upgrade procedure.

## Performance

Server figures are single-node, measured through the real server pipeline (not a storage primitive) on a 4-scheduler VM. Full tables, reproduction commands, and caveats: [`ebb_server/bench/RESULTS.md`](ebb_server/bench/RESULTS.md). Client replica figures come from the client benchmark (`pnpm client:benchmark`); tables, method, and caveats: [`docs/research/503-replica-read-model.md`](docs/research/503-replica-read-model.md).

- **Writes:** ~21,000 Actions/sec over HTTP (batch 100, `sync: true`) and ~26,000/sec calling the Writer directly. There is one Writer per server, so every room shares that budget.
- **Batching dominates.** 100 Actions per request is the sweet spot; one Action per request is roughly an order of magnitude slower. The client outbox already debounces bursts.
- **Fan-out:** post-apply → broadcast is **~31 ms at 1,000 subscribers** writing 1,000 Actions/sec when the 1,000 in-process consumers share the same 4-scheduler box. A count-only consumer measures the same server path at **~9 ms** (no-op consumer ~5 ms), and the floor is **~2.7 ms at one subscriber**. The server's per-range work is small; per-delivery consumer work dominates the same-box number. The server dispatches on the order of **a million deliveries/sec** in-process. A _delivery_ is one Action reaching one subscriber, and it is the number that matters: `room load = edits/second × subscribers`.
- **Reads (client replica):** a 10,000-document workspace holds **~41 MB** of metadata on the client — 29 MB of row objects plus 12 MB of replica structures, 10 MB of which is the adjacency indices that earlier estimates left out — 13% of the 323 MB it would weigh with every document body resident; those bodies (306 MB) stay windowed and open in ~3.6 µs. A relationship or membership traversal reads its adjacency index in 0.5–0.9 µs with no type scan (rows examined stay at the row's degree); the public accessors built on it cost 1.5–12 µs. A full scan of all 10,000 held pages — the shape a search over resident pages would use — is 1.5–2.8 ms, against 42.5 ms per keystroke on the old async scan, and a one-pass projection build (hydrating the replica) is ~150–180 ms.

Rough scale to expect on one box:

| Shape                                               | Verdict                                                                                                                                                                                           |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Documents / rooms with dozens to hundreds of people | Comfortable                                                                                                                                                                                       |
| 1,000-person room, low write rate                   | Fine                                                                                                                                                                                              |
| 1,000-person room, many people editing at once      | Fine through ~1,000 edits/sec (1M deliveries/sec): server path ~9 ms p50 with cheap consumers, ~31 ms when 1,000 consumers share the box. Per-delivery consumer work is the first same-box limit. |
| Hundreds of small rooms                             | Bounded by the shared ~21k Actions/sec write budget                                                                                                                                               |

Presence and cursor updates ride the same fan-out path — throttle them. The server amortises one message per subscriber per committed range, so batching and consumer-side work matter more than the byte count; reducing payload size helps the network leg.

> These are single-node, 4-scheduler figures. The fan-out number includes 1,000 in-process consumers on the same cores; real remote clients move decode/apply off the server but add socket and network transit. Treat both as bounds, not guarantees.

## Packages

| Package              | Description                                                                                                                            | State   | Distribution          |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------- | --------------------- |
| `@ebbjs/core`        | TypeBox schemas, HLC, MessagePack codec, `createAction` helper.                                                                        | Working | npm                   |
| `@ebbjs/storage`     | `StorageAdapter` interface + in-memory and IndexedDB implementations (ActionLog, DirtyTracker, EntityStore, CursorStore, OutboxStore). | Working | npm                   |
| `@ebbjs/server` (TS) | E2E test harness — spawns the Elixir release, `seed()` helper for fixtures.                                                            | Working | private (in-repo)     |
| `ebb_server/`        | Elixir/OTP sync server: RocksDB action log, SQLite materialization, HTTP API, SSE fan-out, permissions, presence.                      | Working | `mix release`, Docker |
| `@ebbjs/client`      | Local-first sync client (handshake, SSE, catch-up, `query()` read root, namespace write verbs, in-memory outbox).                      | Working | npm                   |
| `@ebbjs/react`       | React bindings — `EbbProvider`, `useClient`, `useConnection`, `useQuery`, `useEntityMutations`.                                        | Partial | npm                   |
| `@ebbjs/codemirror`  | CodeMirror 6 bridge for causal-tree collaborative text.                                                                                | Working | npm                   |
| `@ebbjs/www`         | Astro docs site.                                                                                                                       | Working | private (in-repo)     |

The npm packages (`@ebbjs/core`, `@ebbjs/storage`, `@ebbjs/client`,
`@ebbjs/react`, `@ebbjs/codemirror`) are published in lockstep at one shared
version and require Node `>=22.8.0`. `@ebbjs/server` and `@ebbjs/www` are
workspace-only.

A Bun-based server-function runtime and a CLI are not in the repo yet but are described in the public docs as the planned v1 surface.

## Roadmap

### Shipped

- Core storage engine — RocksDB action log (single Writer GenServer, `enable_pipelined_write: true` on the DB), on-demand SQLite materialization. Measured through the real server: **~21k Actions/sec sustained** over HTTP (batch 100, single Writer, `sync: true`, 2-Update Actions; ~26k calling the Writer directly) — see [`ebb_server/bench/RESULTS.md`](ebb_server/bench/RESULTS.md). The older ~108k figure was a 2-writer raw-RocksDB primitive, never the server (see [devlog](packages/www/src/content/devlog/a-rocksdb-solid-start.md)).
- Sync protocol — handshake, per-group paginated catch-up, live SSE streaming, watermark-gated fan-out
- Auth & group-based permissions — `AuthPlug` (bypass + external modes), in-memory Group/GroupMember/Relationship cache
- Real-time presence — ephemeral broadcasts via `POST /sync/presence`, fanned out over SSE
- Self-hosting — multi-stage `debian:bookworm-slim` image published to `ghcr.io/ebbjs/ebb_server`, unauthenticated `GET /healthz` readiness, explicit auth configuration required at boot, named-volume persistence ([guide](docs/self-hosting.md))
- Client SDK (`@ebbjs/client`) — handshake, live SSE, paginated catch-up, typed query engine (`client.<entity>.query()`, one-level `with` joins, cached reactive results), namespace write verbs, `client.atomic` / `defineAction`, presence
- Durable pending-action store on `@ebbjs/storage` (in-memory + IndexedDB)
- React bindings (`@ebbjs/react`) — provider, `useConnection`, `useQuery`, `useEntityMutations`
- Writer failure policy — a failed commit abandons + resolves its GSN range so live fan-out never stalls ([#282](https://github.com/ebbjs/ebbjs/issues/282))
- Server telemetry and the `onAction` Action exporter — the `ebb.*` event catalogue plus an opt-in post-commit Action sink for analytics, audit logs, and data warehouses ([#125](https://github.com/ebbjs/ebbjs/issues/125)); see [`ebb_server/README.md`](ebb_server/README.md#action-export-the-onaction-hook)

### In Progress

- Durable client outbox — the storage-side `OutboxStore` has landed; the client-side queue, retry, and ack are tracked in [#225](https://github.com/ebbjs/ebbjs/issues/225).

### Planned

- Server functions (`defineFunction`) — requires a Bun runtime alongside the Elixir server
- Server-side SDK for SSR frameworks and external processes
- CLI tooling — `ebb deploy`, function management, schema migrations, scaffolding
- Horizontal scaling — multi-master peer replication (slice 6 design exists)

See the website [roadmap](https://ebb.dev/#roadmap) for the marketing-facing version of this list.

## Development

Consumers install the published packages from npm:

```bash
npm install @ebbjs/client
```

The commands below are for working in this repository.

```bash
pnpm install          # install dependencies and wire git hooks
pnpm setup:ebb-server # install Elixir system dependencies (first time only)
pnpm build            # build every package — required before testing
pnpm test             # run the test suite
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full local-setup notes.

## Repository Layout

```
packages/
  core/        # @ebbjs/core — schemas, HLC, msgpack
  storage/     # @ebbjs/storage — adapter interface + memory/IndexedDB implementations
  server/      # @ebbjs/server (TS) — e2e test harness
  client/      # @ebbjs/client — local-first sync client SDK
  react/       # @ebbjs/react — React bindings
  codemirror/  # @ebbjs/codemirror — collaborative-text editor bridge
  www/         # Astro docs site (docs + devlog content under src/content/)
ebb_server/    # Elixir sync server (RocksDB + SQLite + OTP)
examples/      # Runnable demos (issue tracker, collaborative-text demo, client smoke test)
experiment/    # Proof-of-concept code (e.g., collaborative-text)
```
