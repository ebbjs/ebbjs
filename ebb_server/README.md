# Ebb Server

Elixir/OTP backend for the ebb local-first collaborative platform.
Handles persistent storage, sync protocol, real-time fan-out,
permission enforcement, and HTTP API.

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

## Architecture

The Elixir server is the system of record. It owns all persistent
storage, the sync protocol, real-time fan-out, permission enforcement,
and the HTTP API that both browser clients and (eventually) the Bun
Application Server use to read and write data.

### Storage architecture

A dual-store CQRS pattern:

- **RocksDB** (LSM-tree, the `rocksdb` Erlang NIF) holds the Action log
  — the source of truth. Every committed Action goes through
  `EbbServer.Storage.Writer` and is durable on disk before its GSN is
  returned to the caller.
- **SQLite** (B-tree, via `exqlite`) serves as the read-optimized
  materialized entity cache. Entity state is materialized on demand by
  `EbbServer.Storage.EntityStore` when reads request dirty entities —
  never eagerly on every write.

`enable_pipelined_write: true` is set on the RocksDB instance; a
2-writer pipelined benchmark hit ~108k Actions/sec with full durability
(see [Epic #111](https://github.com/ebbjs/ebbjs/issues/111) and
[#130](https://github.com/ebbjs/ebbjs/issues/130) for the architectural
rationale and benchmark details). Production currently runs a single
Writer; multi-Writer pipelining is gated behind a committed-watermark
and ordered-fanout coordination work that is not yet built.

### Module map

| Module                                                                     | Purpose                                                            |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `EbbServer.Storage.RocksDB`                                                | DB lifecycle, column families, key encoding, low-level I/O         |
| `EbbServer.Storage.SQLite`                                                 | Entity cache: schema DDL, UPSERT, filtered query with permissions  |
| `EbbServer.Storage.SystemCache` (sup.)                                     | ETS + `:atomics` for GSN, watermark, dirty set, group/relationship |
| `EbbServer.Storage.Writer`                                                 | Single serialization point: GSN assignment, perm check, WriteBatch |
| `EbbServer.Storage.EntityStore`                                            | Read API with on-demand materialization                            |
| `EbbServer.Storage.PermissionChecker`                                      | Action validation + per-Update ETS-based permission decision       |
| `EbbServer.Storage.WatermarkTracker`                                       | Committed-watermark ETS + `:atomics` (SSE fan-out gating)          |
| `EbbServer.Storage.{DirtyTracker,GroupCache,RelationshipCache,GSNCounter}` | In-memory state children of `SystemCache`                          |
| `EbbServer.Sync.AuthPlug`                                                  | Actor identity extraction (bypass + external modes)                |
| `EbbServer.Sync.Router`                                                    | HTTP plug router                                                   |
| `EbbServer.Sync.CatchUp`                                                   | Paginated catch-up                                                 |
| `EbbServer.Sync.SSEHandler`                                                | The SSE wire format                                                |
| `EbbServer.Sync.FanOutRouter`                                              | Watermark-gated routing to per-group `GroupServer`                 |
| `EbbServer.Sync.GroupServer`                                               | Per-group fan-out; holds subscribers' senders                      |
| `EbbServer.Sync.SSEConnection`                                             | Per-live-subscription pid; receives pushes via its `GroupServer`   |
| `EbbServer.Storage.BackgroundWarmer` (optional)                            | Pre-materializes dirty entities during idle periods                |

Each module's `@moduledoc` documents the load-bearing decisions and the
hot-path behavior. Read those before making non-trivial changes.

### HTTP endpoint table

| Method | Path                              | Purpose                                                                |
| ------ | --------------------------------- | ---------------------------------------------------------------------- |
| `POST` | `/sync/handshake`                 | Actor identity + group membership (requires `x-ebb-actor-id` header)   |
| `GET`  | `/sync/groups/:group_id?offset=N` | Paginated catch-up (`stream-next-offset`, `stream-up-to-date` headers) |
| `GET`  | `/sync/live?groups=...&cursor=N`  | SSE stream of new actions                                              |
| `POST` | `/sync/actions`                   | Write actions (MessagePack body)                                       |
| `POST` | `/sync/presence`                  | Broadcast ephemeral presence data on an entity                         |
| `GET`  | `/entities/:id`                   | Materialized entity (requires `actor_id` query param or header)        |
| `POST` | `/entities/query`                 | Query entities by type with optional filter/limit/offset               |

The OpenAPI 3.1 spec is generated from router annotations via
`mix openapi.gen.spec` and lives at `ebb_server/openapi.yaml`.

### Supervision tree

```
EbbServer.Supervisor (one_for_one)
├── Storage Supervisor (rest_for_one)
│   ├── Storage.RocksDB                    — opens DB, creates column families
│   ├── Storage.SQLite                     — opens DB, runs DDL
│   ├── Storage.SystemCache                — creates ETS tables, populates from RocksDB
│   │   ├── Storage.DirtyTracker
│   │   ├── Storage.GroupCache
│   │   ├── Storage.RelationshipCache
│   │   ├── Storage.WatermarkTracker
│   │   └── Storage.GSNCounter
│   ├── Storage.Writer                     — serialization point
│   ├── Storage.EntityStore                — read API
│   └── Storage.BackgroundWarmer (optional)
├── Sync Supervisor (one_for_one)
│   ├── Sync.FanOutRouter
│   ├── Sync.GroupDynamicSupervisor (per-group GroupServers)
│   └── Sync.SSEConnectionSupervisor (per-live-connection pids)
└── Bandit HTTP listener, plug: Sync.Router
```

`rest_for_one` on the Storage supervisor means any RocksDB crash
restarts the entire storage tree in order. This is intentional —
System Cache populates from RocksDB on init, and Writers coordinate
through cache state.

## Cross-cutting concerns

### Serialization formats

| Layer                  | Format            | Library                                 |
| ---------------------- | ----------------- | --------------------------------------- |
| Client ↔ Server (wire) | MessagePack       | `Msgpax`                                |
| RocksDB (storage)      | ETF (Erlang Term) | `:erlang.term_to_binary/binary_to_term` |
| SQLite (entity cache)  | JSON              | `Jason`                                 |

**Every** component reading from RocksDB uses `binary_to_term(binary, [:safe])`
to prevent atom-table pollution. Stored map keys should be strings,
not atoms.

### Configuration

All runtime configuration flows through `Application.get_env(:ebb_server, key)`:

| Key                        | Description                          | Default    |
| -------------------------- | ------------------------------------ | ---------- |
| `:port`                    | HTTP listen port                     | 4000       |
| `:data_dir`                | Directory for RocksDB + SQLite files | `./data`   |
| `:auth_url`                | Developer's auth endpoint URL        | (required) |
| `:writer_count`            | Number of Writer GenServers          | 2          |
| `:writer_batch_timeout_ms` | Batch flush timer                    | 10         |
| `:writer_batch_max_size`   | Max Actions per batch                | 1000       |
| `:warmer_enabled`          | Enable Background Warmer             | false      |
| `:warmer_interval_ms`      | Warmer poll interval                 | 1000       |
| `:warmer_batch_size`       | Entities per warmer cycle            | 100        |
| `:replication_peers`       | List of peer server URLs             | []         |

### Observability

Every component emits `:telemetry` events. Key metrics:

| Metric                                    | Source       | Type                          |
| ----------------------------------------- | ------------ | ----------------------------- |
| `ebb.writer.batch_size`                   | Writer       | Histogram                     |
| `ebb.writer.batch_latency_ms`             | Writer       | Histogram                     |
| `ebb.writer.actions_per_sec`              | Writer       | Counter                       |
| `ebb.watermark.lag`                       | System Cache | Gauge (`max_gsn - watermark`) |
| `ebb.dirty_set.size`                      | System Cache | Gauge                         |
| `ebb.entity_store.materialize_latency_ms` | Entity Store | Histogram                     |
| `ebb.entity_store.cache_hit_rate`         | Entity Store | Ratio                         |
| `ebb.fanout.push_latency_ms`              | Fan-Out      | Histogram                     |
| `ebb.fanout.active_connections`           | Fan-Out      | Gauge                         |
| `ebb.fanout.active_groups`                | Fan-Out      | Gauge                         |
| `ebb.http.request_latency_ms`             | HTTP API     | Histogram (per endpoint)      |

### ID generation

All IDs use `Nanoid` with type prefixes: `act_` (Action), `upd_`
(Update), `a_` (Actor). Entity IDs are prefixed by their type (e.g.,
`todo_abc123`). The client SDK generates IDs; the server validates
format but does not generate entity IDs (except for server-function
`ctx.generateId()`, which is part of [Epic #112](https://github.com/ebbjs/ebbjs/issues/112)).

### HLC (Hybrid Logical Clock)

HLCs are 64-bit integers (upper 48 bits = logical time in ms, lower
16 bits = counter) assigned by the originating node and preserved
across replication. The server validates incoming client HLCs: reject
if logical time > now + 120s (future drift) or < now - 24h (stale
clock). The server does not generate or assign HLCs. HLCs are used for
LWW conflict resolution during materialization, with lexicographic
update ID comparison as a tiebreaker when HLCs are equal. Replicated
Actions skip HLC validation (trust-and-apply). See the
[v1 HLC issue #120](https://github.com/ebbjs/ebbjs/issues/120) for the
full generation algorithm.

### Error handling

- **Writer GenServers**: If a WriteBatch commit fails, the batch is
  retried once. If it fails again, the GenServer crashes and the
  `rest_for_one` supervisor restarts the storage tree. Callers receive
  `{:error, :storage_unavailable}`.
- **Entity Store**: Materialization failures (corrupt RocksDB data,
  merge errors) return `{:error, reason}` to the HTTP handler, which
  responds with `500`. The dirty bit is **not** cleared on failure.
- **HTTP API**: All endpoints return structured error responses —
  `{:error, :unauthorized}` → `401`, `{:error, :not_found}` → `404`,
  `{:error, :validation_failed, details}` → `422`,
  `{:error, :storage_unavailable}` → `503`.
- **Fan-Out**: If a `GroupServer` crashes, it restarts (transient) and
  clients reconnect via SSE retry. No data loss — clients catch up from
  their last cursor.
- **SSE connections**: Temporary restart — if a connection process
  dies, the client reconnects automatically (SSE built-in retry).

## Constraints and assumptions

### Hard constraints

- **Elixir/OTP only** for the server. No custom NIFs; we use the
  `rocksdb` hex package (v2.5.0).
- **Durability guarantee.** No Action is acknowledged to a client
  until it is on disk (`sync: true` on every WriteBatch commit).
- **Zero-staleness reads.** Server-function reads (`ctx.get`,
  `ctx.query`) always return fully materialized state — no eventual
  consistency window.

### Performance targets

- 10,000 concurrent client connections per server instance.
- 1,000 collaborative documents with 10 concurrent editors each.
- 10,000–20,000 Action writes/sec sustained; 108k burst benchmarked.
- `ctx.get(id)`: <2ms p99.
- `ctx.query(type)`: <10ms p99 at 100k entities.
- SSE streaming latency: <50ms p50.

### Assumptions

- **Single-node first.** Multi-master replication is designed but not
  built ([Epic #113](https://github.com/ebbjs/ebbjs/issues/113)).
- **Bun Application Server is separate** ([Epic #112](https://github.com/ebbjs/ebbjs/issues/112)).
  Bun is a stateless HTTP client of this server.
- **Auth is external.** The server calls a developer-provided auth URL
  during handshake; it does not implement authentication itself.
- **Schema-agnostic server.** The server reads per-field `type` tags
  from stored data to determine merge strategy. The client SDK enforces
  type consistency.
- **MessagePack on the wire.** Clients send MessagePack-encoded
  payloads. The HTTP API decodes MessagePack for Action writes and
  encodes JSON for entity read responses.
- **ETS tables are not persisted.** They are rebuilt from RocksDB on
  startup. Startup time scales with the number of system entities
  (Groups, GroupMembers, Relationships).

## Build history

The architecture was built in vertical slices; each slice ended with
passing integration tests. Slices 1–4 shipped; slices 5–6 are not built.
Forward-looking slice write-ups for the deferred work live on GitHub
([Epic #112](https://github.com/ebbjs/ebbjs/issues/112) for slice 5 —
server functions; [Epic #113](https://github.com/ebbjs/ebbjs/issues/113)
for slice 6 — peer replication).

## References

- [Epic #111](https://github.com/ebbjs/ebbjs/issues/111) — Storage
  architecture (historical context + dual-store rationale).
- [#130](https://github.com/ebbjs/ebbjs/issues/130) — RocksDB throughput
  benchmarks.
- [Epic #112](https://github.com/ebbjs/ebbjs/issues/112) — Server
  functions (`defineFunction`).
- [Epic #113](https://github.com/ebbjs/ebbjs/issues/113) — Peer
  replication (slice 6).
