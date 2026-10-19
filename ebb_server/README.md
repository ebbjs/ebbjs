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

From the repo root, `pnpm dev:collab` runs `mix dev` plus the
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
| `EbbServer.Storage.Writer`                                                      | Sequencer: coalescing, payload pre-encode, GSN claim, group resolution, apply/notify |
| `EbbServer.Storage.Committer`                                                    | Durable half of a flush: wrapper encode, op assembly, `write_batch`                  |
| `EbbServer.Storage.PreparedAction`                                               | Immutable sequencer → committer boundary payload                   |
| `EbbServer.Storage.ActionLog`                                                    | Committed-log reader: decodes an inclusive GSN range in order      |
| `EbbServer.Storage.ActionFormat`                                                 | `cf_actions` value shape: GSN-free payload, scopes wrapper, dual-shape decode        |
| `EbbServer.ActionExport` (opt-in)                                                | Polls the committed log and invokes the `:on_action` handler       |
| `EbbServer.Storage.EntityStore`                                                  | Read API with on-demand materialization                            |
| `EbbServer.Storage.PermissionChecker`                                            | Action validation, per-Update + read-side permission decisions     |
| `EbbServer.Storage.WatermarkTracker`                                             | Resolution-frontier ETS + `:atomics` (SSE fan-out gating)          |
| `EbbServer.Storage.InFlightActions`                                              | In-flight action-id ETS (idempotent-retry concurrency guard)       |
| `EbbServer.Storage.{DirtyTracker,GroupCache,EntityGroupCache,RelationshipCache}` | In-memory state children of `SystemCache`                          |
| `EbbServer.Storage.GSNCounter`                                                   | Lock-free GSN claiming + restart reconcile (`:atomics`)            |
| `EbbServer.Telemetry.Sampler`                                                    | Periodic watermark / dirty-set / in-flight / fan-out gauges        |
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
│   ├── Storage.InFlightActions            — in-flight action-id ETS
│   └── Storage.Writer                     — sequencer: pre-encode, claim, resolve, apply
│       └── Storage.Committer              — wrapper encode + op assembly + durable write
├── Telemetry.Sampler                      — 1 Hz watermark / dirty-set / in-flight / fan-out gauges
├── Sync Supervisor (one_for_one)
│   ├── Sync.FanOutFrontier                — persisted last-pushed frontier
│   ├── Sync.FanOutRouter
│   ├── Sync.GroupDynamicSupervisor (per-group GroupServers)
│   └── Sync.SSEConnectionSupervisor (per-live-connection pids)
├── Bandit HTTP listener, plug: Sync.Router
└── ActionExport.Supervisor (opt-in, only when `:on_action` is set)
    ├── ActionExport.TaskSupervisor     — bounded handler invocations
    └── ActionExport                    — durable cursor + poll loop
```

`Storage.Writer` is deliberately the **last** child of the `rest_for_one`
Storage supervisor. A `SystemCache` (or `WatermarkTracker`) failure therefore
rebuilds the caches, the watermark, and the in-flight action-id set and
restarts the Writer, which reconciles against the fresh frontier on `init/1`;
a Writer-only crash restarts the Writer and its linked Committer together,
and the replacement Writer clears the stale in-flight ids on `init/1`. Any
RocksDB crash still restarts the whole storage tree in order, because
SystemCache populates from RocksDB on init and the Writer coordinates through
cache state.

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

| Key                        | Description                                                                            | Default     |
| -------------------------- | -------------------------------------------------------------------------------------- | ----------- |
| `:port`                    | HTTP listen port                                                                       | 4000        |
| `:data_dir`                | Directory for RocksDB + SQLite files                                                   | `./data`    |
| `:auth_mode`               | Auth mode (`:bypass` / `:external`)                                                    | `:external` |
| `:auth_url`                | Developer's auth endpoint URL                                                          | (required)  |
| `:writer_batch_max_size`   | Buffered Actions before an immediate commit (`<= 0` = no trigger)                      | 1000        |
| `:writer_batch_timeout_ms` | Coalescing window (`0` = burst-drain, no timer)                                        | 0           |
| `:on_action`               | Opt-in Action exporter handler (see [Action export](#action-export-the-onaction-hook)) | (unset)     |

The periodic metric sampler is configured under its own key,
`Application.get_env(:ebb_server, EbbServer.Telemetry.Sampler)`:

| Sampler key              | Description                                         | Default                                  |
| ------------------------ | --------------------------------------------------- | ---------------------------------------- |
| `:enabled`               | Emit the periodic gauges                            | `true` (`false` in `MIX_ENV=test`)       |
| `:interval_ms`           | Sampling interval in milliseconds                   | `1000`                                   |
| `:rocks_name`            | RocksDB instance to read `max_gsn` from             | `EbbServer.Storage.RocksDB`              |
| `:watermark_tracker`     | WatermarkTracker instance to read the frontier from | `EbbServer.Storage.WatermarkTracker`     |
| `:dirty_set`             | Dirty-set ETS table name                            | resolved from `DirtyTracker`             |
| `:in_flight_actions`     | In-flight action-id tracker to read the size from   | `EbbServer.Storage.InFlightActions`      |
| `:connection_supervisor` | Supervisor to count active SSE connections from     | `EbbServer.Sync.SSEConnectionSupervisor` |
| `:group_supervisor`      | Supervisor to count active groups from              | `EbbServer.Sync.GroupDynamicSupervisor`  |

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

`:telemetry` is a direct dependency and `EbbServer.Telemetry` is the single
place that fixes event names and payload conventions. The catalogue below is
what the emitters under `lib/` emit today; `EbbServer.Telemetry`'s moduledoc is
the authoritative source if the two ever disagree.

The developer-facing `onAction` hook is the opt-in Action exporter, documented
in [Action export](#action-export-the-onaction-hook). It is a data-egress
surface; its own events (`ebb.action_export.*`) are part of the `:telemetry`
catalogue below.

#### Event catalogue

Every event is `[:ebb, subsystem, event]`, written `ebb.<subsystem>.<event>` in
reporters. Durations are in native `:telemetry` time units
(`System.monotonic_time/0` deltas, as `:telemetry.span/3` emits them); the `_ms`
suffix marks a latency metric, not the raw unit. Reporters convert with
`unit: {:native, :millisecond}`.

| Event                                     | Measurements (unit)                                                                                  | Metadata                                                                                                     | Metric type                  | Subsystem       |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------- | --------------- |
| `ebb.writer.batch_size`                   | `count`                                                                                              | `gsn_start`, `gsn_end`, `callers`                                                                            | Histogram                    | `writer`        |
| `ebb.writer.batch_latency_ms`             | `duration` (native)                                                                                  | `gsn_start`, `gsn_end`                                                                                       | Histogram                    | `writer`        |
| `ebb.writer.commit_latency_ms`            | `duration` (native)                                                                                  | `gsn_start`, `gsn_end`                                                                                       | Histogram                    | `writer`        |
| `ebb.writer.actions_per_sec`              | `count`                                                                                              | —                                                                                                            | Counter                      | `writer`        |
| `ebb.writer.range_resolved`               | `count`                                                                                              | `gsn_start`, `gsn_end`, `reason`                                                                             | Counter                      | `writer`        |
| `ebb.writer.commit_failed`                | `count`                                                                                              | `gsn_start`, `gsn_end`, `reason`                                                                             | Counter                      | `writer`        |
| `ebb.watermark.lag`                       | `lag` (GSNs)                                                                                         | —                                                                                                            | Gauge                        | `watermark`     |
| `ebb.dirty_set.size`                      | `size` (entries)                                                                                     | —                                                                                                            | Gauge                        | `dirty_set`     |
| `ebb.writer.in_flight_action_ids`         | `size` (ids)                                                                                         | —                                                                                                            | Gauge                        | `writer`        |
| `ebb.entity_store.materialize_latency_ms` | `duration` (native), `byte_size`                                                                     | `subject_id`, `subject_type`, `path` (`:dirty_materialize`)                                                  | Histogram                    | `entity_store`  |
| `ebb.entity_store.materialize_phase_ms`   | `duration` (native)                                                                                  | `phase` (`:fetch_decode` / `:entries_scan` / `:actions_load` / `:merge` / `:encode` / `:upsert` / `:format`) | Histogram                    | `entity_store`  |
| `ebb.entity_store.read_latency_ms`        | `duration` (native), `byte_size`, `row_count`                                                        | `path` (`:clean_hit` / `:query`), `subject_id`                                                               | Histogram                    | `entity_store`  |
| `ebb.entity_store.cache_hit_rate`         | `count`                                                                                              | `result` (`:hit` / `:miss`), `path` (`:dirty_materialize` / `:clean_hit` / `:query`)                         | Counter (tagged by `result`) | `entity_store`  |
| `ebb.fanout.push_latency_ms`              | `duration` (native)                                                                                  | `group_id`                                                                                                   | Histogram                    | `fanout`        |
| `ebb.fanout.active_connections`           | `count`                                                                                              | —                                                                                                            | Gauge                        | `fanout`        |
| `ebb.fanout.active_groups`                | `count`                                                                                              | —                                                                                                            | Gauge                        | `fanout`        |
| `ebb.http.request_latency_ms`             | `duration` (native)                                                                                  | `method`, `route`, `status`                                                                                  | Histogram                    | `http`          |
| `ebb.sync.catch_up`                       | `count`                                                                                              | `group_id`, `from_offset`, `returned`, `up_to_date`                                                          | Counter                      | `sync`          |
| `ebb.action_export.batch`                 | `count`                                                                                              | `from_gsn`, `to_gsn`                                                                                         | Counter                      | `action_export` |
| `ebb.action_export.failed`                | `count`                                                                                              | `gsn`, `reason`                                                                                              | Counter                      | `action_export` |
| `ebb.action_export.filtered`              | `count`                                                                                              | —                                                                                                            | Counter                      | `action_export` |
| `ebb.action_export.lag`                   | `lag` (GSNs)                                                                                         | `cursor`                                                                                                     | Gauge                        | `action_export` |
| `ebb.system_cache.populated`              | `duration` (native), `entity_types`, `group_members`, `entity_groups`, `relationships`, `backfilled` | `outcome` (`:ok` / `:error`), `reason`                                                                       | Histogram                    | `system_cache`  |

The `ebb.watermark.lag`, `ebb.dirty_set.size`,
`ebb.writer.in_flight_action_ids`, `ebb.fanout.active_connections`, and
`ebb.fanout.active_groups` gauges have no natural event to hang off, so
`EbbServer.Telemetry.Sampler` polls them once per second (configurable above).
`ebb.writer.in_flight_action_ids` is bounded by the write-pipeline depth, not
by history: ids leave the set when their batch commits or abandons.

`ebb.fanout.push_latency_ms` is measured from the Writer's durable commit to
the GroupServer dispatching the batch to the group's subscribers: one sample
per dispatched batch per group. Ranges recovered after a Router restart carry
no commit time and are not sampled.

`ebb.http.request_latency_ms` is emitted once per completed request with
`method`, `route`, and `status`. It is produced by `EbbServer.Telemetry.HTTP`
from Bandit's request span (attached at boot, before Bandit accepts requests).
The `GET /sync/live` SSE route is deliberately excluded because its span lasts
the whole connection; see `EbbServer.Telemetry.HTTP` for the full rationale.

`ebb.sync.catch_up` is emitted once per successful catch-up with `group_id`,
`from_offset`, `returned`, and `up_to_date`. A `from_offset` of 0 marks a full
resync, so a reporter can compute the resync ratio against incremental
catch-ups. Peer-replication cursor and lag metrics are out of scope until
server-to-server replication exists.

`ebb.system_cache.populated` is emitted once per startup cache rebuild. Counts
are the entities materialized into each cache plus the `cf_type_entities` keys
repaired by the one-time backfill migration, and `outcome` is `:ok` or
`:error`. On failure the counts reached before the raise are still reported,
which is how a partial rebuild becomes visible; the node then refuses to start
serving rather than run against the half-populated caches. `reason` is the
failure class — an exception module or the atom an exit/throw carried — never
the raised value, so the event cannot carry entity content.

`ebb.entity_store.*` attributes the read path by size and phase. `byte_size` is
the JSON blob (`row.data`) before it is decoded: the pre-existing blob on a
dirty materialize, the returned blob on a clean hit, and the summed blob size
of the rows a query decoded. It is a measurement, not metadata, so a reporter
records `duration` and `byte_size` together and can bucket one by the other.
Counting a `content` map's keys would be a second O(N) walk of the decoded
value, so the catalogue does not promise it; byte size is the size proxy.
`ebb.entity_store.materialize_phase_ms` breaks one dirty materialize into
`:fetch_decode` (SQLite SELECT + `Jason.decode!`), `:entries_scan` (the RocksDB
`cf_entity_actions` prefix scan), `:actions_load` (RocksDB `multi_get` + ETF
decode), `:merge` (replay), and the `:encode` → `:upsert` → `:format` tail, so blob
JSON, the SQLite upsert, and the merge are separable.
`:upsert` includes the eight STORED `json_extract` generated columns SQLite
recomputes, which is the only place that cost is visible.
`ebb.entity_store.read_latency_ms` covers the two decode-only reads — a clean
`get` (`:clean_hit`) and the `Enum.map` over a query's rows (`:query`, one
sample per query, never per row) — so decode cost is visible without adding
per-row spans to `query/4`. Phases fire once per dirty materialize and only on
success; a phase that raises is reported through the surrounding rescue as
`:materialization_failed`.

#### Telemetry conventions

The reserved subsystems are `writer`, `watermark`, `dirty_set`, `entity_store`,
`fanout`, `http`, `sync`, `action_export`, and `system_cache`; adding a family
means changing `EbbServer.Telemetry` first.

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
  `:telemetry.span/3`). No event currently uses this; the convention is fixed
  for the first one that needs a span.

Emit through `EbbServer.Telemetry.execute/3` and `span/3` so the `[:ebb]` root
and the measurement/metadata split stay in one place:

```elixir
EbbServer.Telemetry.execute(
  [:writer, :batch_size],
  %{count: length(batch)},
  %{gsn_start: from, gsn_end: to}
)
```

#### Attaching handlers

`:telemetry.attach_many/4` with a `Logger` handler:

```elixir
:telemetry.attach_many(
  "ebb-logger",
  [
    [:ebb, :writer, :batch_latency_ms],
    [:ebb, :fanout, :push_latency_ms],
    [:ebb, :http, :request_latency_ms]
  ],
  fn event, measurements, metadata, _config ->
    Logger.info("#{inspect(event)} #{inspect(measurements)} #{inspect(metadata)}")
  end,
  nil
)
```

Add `{:telemetry_metrics, "~> 1.0"}` to aggregate the same events. Ebb names
its events and measurements independently (`duration`, `count`), so each metric
passes `event_name:` and `measurement:` explicitly rather than relying on the
metric name to infer them. `distribution/2` is `telemetry_metrics`' histogram:

```elixir
metrics = [
  Telemetry.Metrics.counter("ebb.writer.actions_per_sec",
    event_name: [:ebb, :writer, :actions_per_sec],
    measurement: :count
  ),
  Telemetry.Metrics.distribution("ebb.writer.batch_latency_ms",
    event_name: [:ebb, :writer, :batch_latency_ms],
    measurement: :duration,
    unit: {:native, :millisecond}
  ),
  Telemetry.Metrics.counter("ebb.entity_store.cache_hit_rate",
    event_name: [:ebb, :entity_store, :cache_hit_rate],
    measurement: :count,
    tags: [:result]
  ),
  Telemetry.Metrics.last_value("ebb.fanout.active_connections",
    event_name: [:ebb, :fanout, :active_connections],
    measurement: :count
  ),
  Telemetry.Metrics.distribution("ebb.fanout.push_latency_ms",
    event_name: [:ebb, :fanout, :push_latency_ms],
    measurement: :duration,
    unit: {:native, :millisecond}
  ),
  Telemetry.Metrics.distribution("ebb.http.request_latency_ms",
    event_name: [:ebb, :http, :request_latency_ms],
    measurement: :duration,
    unit: {:native, :millisecond},
    tags: [:method, :route, :status]
  )
]

children = [{Telemetry.Metrics.ConsoleReporter, metrics: metrics, interval: 5_000}]
```

Swap `ConsoleReporter` for a StatsD or Prometheus reporter to ship the same
metrics to a real backend; the metric definitions do not change.

Tests assert on emitted events with `EbbServer.TestHelpers.attach_telemetry/1`
and `telemetry_events/2`.

#### OpenTelemetry

Exporting these events to OpenTelemetry is an explicit follow-up spike tracked
by the [observability epic](https://github.com/ebbjs/ebbjs/issues/125), out of
scope here: no OTel exporter, tracer provider, or span mapping ships in
`ebb_server` today.

### Action export (the `onAction` hook)

`EbbServer.ActionExport` is the `onAction` developer hook: an opt-in process
that reads the durable Action log and hands each committed Action to an
application-supplied sink. It is how an application derives product
analytics, an audit log, a warehouse load, or webhooks from the Action stream
without instrumenting its own write paths — every write is already a
structured event.

`EbbServer.ActionExport`'s moduledoc is the authoritative source if this
section and the code ever disagree.

It is a **consumer of the committed log, not a Writer hook**. The exporter
polls `cf_actions` behind a durable cursor and invokes the handler off the
write path, so a slow, down, or hanging sink costs a commit nothing. The read
primitive (`EbbServer.Storage.ActionLog`) is shared with the future
peer-replication consumer ([#113](https://github.com/ebbjs/ebbjs/issues/113)).

#### Configuration

The exporter starts only when a handler is configured:

```elixir
# ebb_server/config/dev.exs (or your app's config)
config :ebb_server, on_action: {MyApp.WarehouseSink, :handle}
```

`{Module, :function}` is resolved with `apply/3`; a 1-arity fun is also
accepted (`on_action: &MyApp.WarehouseSink.handle/1`). With the key unset or
`nil`, no exporter process starts and the node pays nothing for the feature.

Only `:on_action` is read from application config today. The rest are options
to `EbbServer.ActionExport.start_link/1`, used by tests and direct starts:

| Option                    | Default                          | Purpose                                          |
| ------------------------- | -------------------------------- | ------------------------------------------------ |
| `:batch_size`             | `500`                            | Actions read per poll                            |
| `:poll_interval_ms`       | `1000`                           | Delay between polls once caught up               |
| `:handler_timeout_ms`     | `5000`                           | Per-invocation timeout before the task is killed |
| `:excluded_subject_types` | `["groupMember", "entityGroup"]` | Update subject types stripped before export      |
| `:cursor_name`            | `"action_export"`                | SQLite `cursors` row the exporter resumes from   |

#### Handler contract

The handler receives one Action map with string keys, called once per Action
in ascending GSN order:

```elixir
%{
  "id" => "act_...",
  "actor_id" => "a_...",
  "hlc" => 115_300_000_000_000_000,
  "gsn" => 42,
  "updates" => [
    %{
      "id" => "upd_...",
      "subject_id" => "todo_...",
      "subject_type" => "todo",
      "method" => "put",
      "data" => %{
        "fields" => %{
          "title" => %{"value" => "Buy milk", "update_id" => "upd_...", "hlc" => 115_300_000_000_000_000}
        }
      }
    }
  ]
}
```

`"method"` is `"put"`, `"patch"`, or `"delete"`; `"data"` is the client's
`fields` envelope, passed through unchanged (a `delete` normally carries
`null`). An Update whose subject type is filtered out is already absent from
`"updates"`.

- Return `:ok` (or anything that is not `{:error, _}`) to acknowledge.
- Return `{:error, reason}`, raise, throw, exit, or exceed
  `:handler_timeout_ms` to **stall** the cursor. The exporter logs the
  failure, emits `ebb.action_export.failed` with the failing `gsn` and
  `reason`, and re-delivers the batch on the next poll. The exporter process
  itself stays alive.

#### Delivery semantics

- **At-least-once, not exactly-once.** The cursor advances to the end of a
  batch only if every Action in it succeeded, so a failure re-delivers the
  successfully handled prefix too. A sink that needs exactly-once must dedup
  on the Action's stable `"id"` (an idempotent upsert keyed on `"id"` is the
  usual shape). `"id"` is the Action's identity across nodes; `"gsn"` is
  node-local, so a sink aggregating replicas keys on `"id"` and orders by
  `"hlc"`, not on `"gsn"`.
- **Durable cursor.** The cursor lives in the SQLite `cursors` table, so the
  exporter resumes where it left off after a restart instead of replaying
  history.
- **Ordering.** Actions are delivered one at a time in ascending GSN order.
  Ordering is per exporter, not per subject.
- **Egress.** The exporter reads the log directly and therefore bypasses
  group authorization. `groupMember` and `entityGroup` Updates are stripped
  by default, and an Action left with no Updates is dropped entirely.

Operators watch the backlog with `ebb.action_export.lag` (committed
watermark − cursor): a sink that keeps failing shows as a lag that never
drains. A copy-paste sink and run instructions live in
[`examples/action_export/`](../examples/action_export/).

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

| Target                                                   | Status                    | Notes                                                                                                                                                                                                                                                              |
| -------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 10,000 concurrent client connections per server instance | Not measured              | Separate connection/load test; out of scope for the write-path benchmark (#328).                                                                                                                                                                                   |
| 1,000 collaborative documents with 10 concurrent editors | Not measured              | Workload-level target; not exercised by the write-path benchmark.                                                                                                                                                                                                  |
| 10,000–20,000 Action writes/sec sustained                | **Measured: ~15,100/sec** | Single Writer, `sync: true`, 2-Update Actions, 100 Actions/request, 8 concurrent clients; steady 61–120s. See [`bench/RESULTS.md`](bench/RESULTS.md).                                                                                                              |
| 108k burst                                               | Superseded                | A 2-writer raw-RocksDB primitive from [#130](https://github.com/ebbjs/ebbjs/issues/130), never measured through `ebb_server`. Measured server burst ~15,600/sec.                                                                                                   |
| `ctx.get(id)`: <2ms p99                                  | Partially measured        | `EntityStore.get` is measured by `mix bench.materialize`: clean-read p50 0.26 ms at 100 run keys, 2.28 ms at 1,000, 10.97 ms at 5,000 (post-#514). Excludes HTTP and reports p50/p95, not p99.                                                                     |
| `ctx.query(type)`: <10ms p99 at 100k entities            | Partially measured        | `EntityStore.query` p50 2.9 ms for 50 rows at 1,000 keys and 13.5 ms for 50 rows at 5,000 keys; the decode is ~75% of the large case. Not measured at 100k entities or over HTTP.                                                                                  |
| SSE streaming latency: <50ms p50                         | Not measured              | The server-side leg (Writer commit → GroupServer dispatch) is now measurable via `ebb.fanout.push_latency_ms`. The end-to-end p50 a client observes remains unmeasured: it also includes network transit and client rendering, which no server-side metric covers. |

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

`mix bench.materialize` runs the read / materialization benchmark: it
seeds `content`-map documents of N run keys and measures the cold, dirty,
and clean `get` paths plus `query` at K rows, with a phase breakdown and a
SQLite generated-column ablation. Same isolated-boot and report shape.

```sh
cd ebb_server
mix bench.materialize --runs 5 --reps 50 \
  --sizes 100,500,1000,2000,5000 --spread-entities 50 --query-ks 1,10,50
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
