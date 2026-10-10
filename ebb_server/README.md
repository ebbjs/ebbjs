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

`enable_pipelined_write: true` is set on the RocksDB instance. The
historical ~108k Actions/sec figure is a 2-writer, raw-RocksDB primitive
(see [#130](https://github.com/ebbjs/ebbjs/issues/130)); measured through
the real server, the production single-Writer configuration sustains
**~15k Actions/sec** (`sync: true`, 2-Update Actions). Writer batch
coalescing ([#332](https://github.com/ebbjs/ebbjs/issues/332)) leaves that
batch-100 rate flat — it is per-Action-bound — and roughly triples batch-1
direct-write throughput; see
[`bench/RESULTS.md`](bench/RESULTS.md). Production runs a single Writer;
multi-Writer pipelining is gated behind committed-watermark and
ordered-fanout coordination that is not yet built
([#287](https://github.com/ebbjs/ebbjs/issues/287)).

### Module map

| Module                                                                           | Purpose                                                            |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `EbbServer.Storage.RocksDB`                                                      | DB lifecycle, column families, key encoding, low-level I/O         |
| `EbbServer.Storage.SQLite`                                                       | Entity cache: schema DDL, UPSERT, filtered query with permissions  |
| `EbbServer.Storage.SystemCache` (sup.)                                           | ETS + `:atomics` for GSN, watermark, dirty set, group/relationship |
| `EbbServer.Storage.Writer`                                                       | Single serialization point: GSN assignment, perm check, WriteBatch |
| `EbbServer.Storage.EntityStore`                                                  | Read API with on-demand materialization                            |
| `EbbServer.Storage.PermissionChecker`                                            | Action validation + per-Update ETS-based permission decision       |
| `EbbServer.Storage.WatermarkTracker`                                             | Resolution-frontier ETS + `:atomics` (SSE fan-out gating)          |
| `EbbServer.Storage.{DirtyTracker,GroupCache,EntityGroupCache,RelationshipCache}` | In-memory state children of `SystemCache`                          |
| `EbbServer.Storage.GSNCounter`                                                   | Lock-free GSN claiming + restart reconcile (`:atomics`)            |
| `EbbServer.Telemetry.Sampler`                                                    | Periodic `ebb.watermark.lag` / `ebb.dirty_set.size` gauges         |
| `EbbServer.Sync.AuthPlug`                                                        | Actor identity extraction (bypass + external modes)                |
| `EbbServer.Sync.Router`                                                          | HTTP plug router                                                   |
| `EbbServer.Sync.CatchUp`                                                         | Paginated catch-up                                                 |
| `EbbServer.Sync.SSEHandler`                                                      | The SSE wire format                                                |
| `EbbServer.Sync.FanOutRouter`                                                    | Watermark-gated routing to per-group `GroupServer`                 |
| `EbbServer.Sync.FanOutFrontier`                                                  | Last-pushed GSN persisted across a Router restart                  |
| `EbbServer.Sync.GroupServer`                                                     | Per-group fan-out; holds subscribers' senders                      |
| `EbbServer.Sync.SSEConnection`                                                   | Per-live-subscription pid; receives pushes via its `GroupServer`   |
| `EbbServer.Storage.BackgroundWarmer` (optional)                                  | Pre-materializes dirty entities during idle periods                |

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
│   │   ├── Storage.EntityGroupCache
│   │   └── Storage.RelationshipCache
│   ├── Storage.WatermarkTracker           — resolution-frontier ETS + :atomics
│   └── Storage.Writer                     — serialization point (last child)
├── Telemetry.Sampler                      — 1 Hz watermark-lag + dirty-set gauges
├── Sync Supervisor (one_for_one)
│   ├── Sync.FanOutFrontier                — persisted last-pushed frontier
│   ├── Sync.FanOutRouter
│   ├── Sync.GroupDynamicSupervisor (per-group GroupServers)
│   └── Sync.SSEConnectionSupervisor (per-live-connection pids)
└── Bandit HTTP listener, plug: Sync.Router
```

`Storage.Writer` is deliberately the **last** child of the `rest_for_one`
Storage supervisor. A `SystemCache` (or `WatermarkTracker`) failure therefore
rebuilds the caches and the watermark and restarts the Writer, which
reconciles against the fresh frontier on `init/1`; a Writer-only crash
restarts the Writer alone. Any RocksDB crash still restarts the whole
storage tree in order, because SystemCache populates from RocksDB on init
and the Writer coordinates through cache state.

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

| Key                        | Description                                                       | Default     |
| -------------------------- | ----------------------------------------------------------------- | ----------- |
| `:port`                    | HTTP listen port                                                  | 4000        |
| `:data_dir`                | Directory for RocksDB + SQLite files                              | `./data`    |
| `:auth_mode`               | Auth mode (`:bypass` / `:external`)                               | `:external` |
| `:auth_url`                | Developer's auth endpoint URL                                     | (required)  |
| `:writer_batch_max_size`   | Buffered Actions before an immediate commit (`<= 0` = no trigger) | 1000        |
| `:writer_batch_timeout_ms` | Coalescing window (`0` = burst-drain, no timer)                   | 0           |

The periodic metric sampler is configured under its own key,
`Application.get_env(:ebb_server, EbbServer.Telemetry.Sampler)`:

| Sampler key          | Description                                         | Default                              |
| -------------------- | --------------------------------------------------- | ------------------------------------ |
| `:enabled`           | Emit the periodic gauges                            | `true` (`false` in `MIX_ENV=test`)   |
| `:interval_ms`       | Sampling interval in milliseconds                   | `1000`                               |
| `:rocks_name`        | RocksDB instance to read `max_gsn` from             | `EbbServer.Storage.RocksDB`          |
| `:watermark_tracker` | WatermarkTracker instance to read the frontier from | `EbbServer.Storage.WatermarkTracker` |
| `:dirty_set`         | Dirty-set ETS table name                            | resolved from `DirtyTracker`         |

The HTTP request-metric translator is configured under its own key,
`Application.get_env(:ebb_server, EbbServer.Telemetry.HTTP)`:

| HTTP key   | Description                               | Default |
| ---------- | ----------------------------------------- | ------- |
| `:enabled` | Attach the Bandit request-span translator | `true`  |

Several keys that appeared in earlier docs — `:writer_count`, `:warmer_*`,
and `:replication_peers` — are **read by nothing in `lib/` or `config/`**.
Production runs a single `EbbServer.Storage.Writer` GenServer with batch
coalescing controlled by the two `:writer_batch_*` knobs above; multi-Writer
is gated on [#287](https://github.com/ebbjs/ebbjs/issues/287). Benchmarking
the real write path is what forced the table above to describe what actually
runs (see [`bench/RESULTS.md`](bench/RESULTS.md)).

### Observability

`:telemetry` is a direct dependency and `EbbServer.Telemetry` fixes the event
naming and payload conventions that per-subsystem instrumentation builds on.
The instrumented events are still being built
([#125](https://github.com/ebbjs/ebbjs/issues/125)) — the
`ebb.watermark.lag` and `ebb.dirty_set.size` gauges are live, sampled by
`EbbServer.Telemetry.Sampler`, and `ebb.http.request_latency_ms` is live too,
emitted by `EbbServer.Telemetry.HTTP` from Bandit's request span (attached at
boot, before Bandit accepts requests). The rest of the catalogue is still
being built.
The developer-facing `onAction` hook is likewise unbuilt. The table after the
conventions is the **target** metric set, not current behavior.

`ebb.http.request_latency_ms` is emitted once per completed request with
`method`, `route`, and `status`. The `GET /sync/live` SSE route is deliberately
excluded because its span lasts the whole connection; see
`EbbServer.Telemetry.HTTP` for the full rationale.

#### Telemetry conventions

Every event is `[:ebb, subsystem, event]`, written `ebb.<subsystem>.<event>` in
reporters:

- **Names** are `ebb.<subsystem>.<event>`, lower snake case: past tense for
  things that happened (`ebb.writer.range_resolved`), a noun for gauges
  (`ebb.watermark.lag`).
- **Measurements carry numbers only** — counts, sizes, durations, ratios.
  Durations are native time units (`System.monotonic_time/0` deltas, as
  `span/3` emits them); the `_ms` in a latency event name marks it as a latency
  metric, and reporters convert with `unit: {:native, :millisecond}`.
- **Metadata carries identifiers and status** — `gsn`, `group_id`, `actor_id`,
  `subject_id`, `status`, `reason`. It never carries Action payloads or entity
  field values.
- **Start/stop pairs** go through `EbbServer.Telemetry.span/3`, which emits
  `<event>.start`, `<event>.stop`, and `<event>.exception` (via
  `:telemetry.span/3`).

Emit through `EbbServer.Telemetry.execute/3` and `span/3` so the `[:ebb]` root
and the measurement/metadata split stay in one place:

```elixir
EbbServer.Telemetry.execute(
  [:writer, :batch_size],
  %{count: length(batch)},
  %{gsn_start: from, gsn_end: to}
)
```

Attach with `:telemetry.attach_many/4` as usual; the full event catalogue lives
in `EbbServer.Telemetry`:

```elixir
:telemetry.attach_many(
  "ebb-logger",
  [[:ebb, :writer, :batch_size]],
  fn event, measurements, metadata, _config ->
    Logger.info("#{inspect(event)} #{inspect(measurements)} #{inspect(metadata)}")
  end,
  nil
)
```

Tests assert on emitted events with `EbbServer.TestHelpers.attach_telemetry/1`
and `telemetry_events/2`.

| Planned metric                            | Source       | Type                          |
| ----------------------------------------- | ------------ | ----------------------------- |
| `ebb.writer.batch_size`                   | Writer       | Histogram                     |
| `ebb.writer.batch_latency_ms`             | Writer       | Histogram                     |
| `ebb.writer.actions_per_sec`              | Writer       | Counter                       |
| `ebb.writer.range_resolved`               | Writer       | Counter (alert on abandon)    |
| `ebb.writer.commit_failed`                | Writer       | Counter                       |
| `ebb.watermark.lag`                       | System Cache | Gauge (`max_gsn - watermark`) |
| `ebb.dirty_set.size`                      | System Cache | Gauge                         |
| `ebb.entity_store.materialize_latency_ms` | Entity Store | Histogram                     |
| `ebb.entity_store.cache_hit_rate`         | Entity Store | Ratio                         |
| `ebb.fanout.push_latency_ms`              | Fan-Out      | Histogram                     |
| `ebb.fanout.active_connections`           | Fan-Out      | Gauge                         |
| `ebb.fanout.active_groups`                | Fan-Out      | Gauge                         |
| `ebb.http.request_latency_ms`             | HTTP API     | Histogram (per endpoint)      |
| `ebb.sync.catch_up`                       | Sync         | Counter                       |

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

- **Writer**: a `POST /sync/actions` batch is committed with a single
  `RocksDB.write_batch/2` attempt — there is no server retry. On failure
  the Writer **abandons** the claimed GSN range: it marks the range
  resolved (the watermark, a _resolution frontier_ of committed ∪
  deliberately abandoned GSNs, advances over the hole), nudges
  `FanOutRouter` with `{:range_resolved, from, to}` so gated batches can
  drain, and replies `{:error, {:rocksdb_write_failed, reason}}`; the
  HTTP layer maps that to `503 {"error":"write_failed"}`. The client
  outbox is the only retry, undurable data is never acked, and GSNs are
  never rewound or reused. Permanent GSN holes are acceptable.
- **Writer startup reconcile**: `Writer.init/1` raises the GSN counter to
  `max(counter, RocksDB.get_max_gsn/1)` and resolves the remaining tail,
  healing a Writer-only restart that crashed between claim and resolve.
- **Post-commit cache failure**: once `write_batch` returns `:ok` the
  range is durable — the Writer marks it committed and advances the
  frontier before dirty/cache bookkeeping. If a cache or dirty-set update
  then raises, the Writer replies success (the data is durable) and
  abnormally terminates `SystemCache`; the `rest_for_one` supervisor
  rebuilds the caches, the watermark, and the Writer, which reconciles
  against the log. Committed Actions are never reported as lost.
- **Entity Store**: Materialization failures (corrupt RocksDB data,
  merge errors) return `{:error, reason}` to the HTTP handler, which
  responds with `500`. The dirty bit is **not** cleared on failure.
- **HTTP API**: All endpoints return structured error responses —
  `{:error, :unauthorized}` → `401`, `{:error, :not_found}` → `404`,
  `{:error, :validation_failed, details}` → `422`,
  `{:error, {:rocksdb_write_failed, reason}}` → `503`.
- **Fan-Out**: If a `GroupServer` crashes, it restarts (transient) and
  clients reconnect via SSE retry. No data loss — clients catch up from
  their last cursor.
- **Router restart**: `Sync.FanOutFrontier` persists the highest GSN the
  `FanOutRouter` has pushed across the Router's lifetime — it is a sibling
  process under `Sync.Supervisor`, so it survives a Router restart, not a
  node restart. A Router-only restart (or a commit that
  landed while the Router was down, whose notification the Writer's
  `Process.whereis/1` guard dropped) resumes from that frontier,
  re-deriving the un-pushed committed ranges from
  `cf_actions`/`cf_group_actions` and re-pushing once the watermark
  allows. Cold boot does not replay history: it seeds the frontier from
  the current watermark, and connecting clients catch up from the log.
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

Measured on the bench host described in
[`bench/RESULTS.md`](bench/RESULTS.md) (a 4-scheduler VM, single Writer,
`sync: true`). Rows that are not measured state why.

| Target                                                   | Status                    | Notes                                                                                                                                                            |
| -------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10,000 concurrent client connections per server instance | Not measured              | Separate connection/load test; out of scope for the write-path benchmark (#328).                                                                                 |
| 1,000 collaborative documents with 10 concurrent editors | Not measured              | Workload-level target; not exercised by the write-path benchmark.                                                                                                |
| 10,000–20,000 Action writes/sec sustained                | **Measured: ~15,100/sec** | Single Writer, `sync: true`, 2-Update Actions, 100 Actions/request, 8 concurrent clients; steady 61–120s. See [`bench/RESULTS.md`](bench/RESULTS.md).            |
| 108k burst                                               | Superseded                | A 2-writer raw-RocksDB primitive from [#130](https://github.com/ebbjs/ebbjs/issues/130), never measured through `ebb_server`. Measured server burst ~15,600/sec. |
| `ctx.get(id)`: <2ms p99                                  | Not measured              | Read path; the harness measures writes only.                                                                                                                     |
| `ctx.query(type)`: <10ms p99 at 100k entities            | Not measured              | Read path.                                                                                                                                                       |
| SSE streaming latency: <50ms p50                         | Not measured              | No commit timestamp exists without `:telemetry` ([#125](https://github.com/ebbjs/ebbjs/issues/125)); T3 delivery lag is a client-side upper bound.               |

### Benchmarking

`mix bench.actions` runs a reproducible Actions/sec benchmark for the
write path (tiers T0–T3: direct `Writer`, HTTP, concurrent HTTP, and HTTP
with live in-process SSE subscribers). It boots an isolated storage +
sync tree in a temp directory and writes a Markdown report to
`bench/results/`. The harness is compiled in dev only — never for
`mix test` or prod — and is not wired into `mix test`.

```sh
cd ebb_server
mix bench.actions --tier t2 --duration 120 --warmup 5 --concurrency 8 \
  --batch-size 100 --updates-per-action 2 --distribution hot
```

Published numbers, sweeps, and methodology:
[`bench/RESULTS.md`](bench/RESULTS.md).

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
