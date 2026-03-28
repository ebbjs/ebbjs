# Ebb Server Architecture

## Summary

Ebb Server is the Elixir/OTP core of the ebb local-first collaborative backend. It owns all persistent storage, the sync protocol, real-time fan-out, permission enforcement, and the HTTP interface that both browser clients and the Bun Application Server use to read and write data.

The architecture follows a dual-store CQRS pattern: RocksDB (LSM-tree) handles the write-heavy Action log as the source of truth, while SQLite (B-tree) serves as a read-optimized materialized entity cache populated lazily on demand. Two Writer GenServers write concurrently to a shared RocksDB instance with pipelined writes, achieving ~108k Actions/sec. Entity state is materialized only when read, decoupling write throughput from materialization cost. ETS tables serve the hottest code paths -- permission checks, dirty tracking, and fan-out routing -- at sub-microsecond latency.

The server exposes an HTTP API for Action writes, entity reads, sync handshake, paginated catch-up, live SSE subscriptions, presence broadcasting, server function invocation, and peer-to-peer replication. Bun is a stateless function runtime that accesses all data through these HTTP endpoints. The canonical specification is `docs/storage-architecture-v2.md`; the sync protocol, fan-out, presence, and replication details in `docs/storage-architecture-proposal.md` remain valid.

## Components

| Component                                              | Purpose                                                                                                                                            |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| [RocksDB Store](components/rocksdb-store.md)           | Manages the RocksDB instance, column families, key encoding, and low-level read/write primitives                                                   |
| [SQLite Store](components/sqlite-store.md)             | Manages the SQLite entity cache -- schema DDL, entity UPSERT, filtered queries with permission JOINs                                               |
| [System Cache](components/system-cache.md)             | ETS table owner for permission caches and dirty tracking; shared `:atomics` for GSN counter and watermark; startup population                      |
| [Writer](components/writer.md)                         | 2 GenServers that serialize Action writes -- GSN assignment, ETF encoding, WriteBatch, ETS updates, watermark advancement, durability notification |
| [Entity Store](components/entity-store.md)             | On-demand materialization -- dirty check, RocksDB delta read, per-field typed merge, SQLite upsert, clear dirty                                    |
| [Permission Checker](components/permission-checker.md) | Validates Action structure, HLC drift, actor identity, and ETS-based Group/Relationship authorization                                              |
| [HTTP API](components/http-api.md)                     | Plug/Cowboy router -- all client-facing and internal HTTP endpoints                                                                                |
| [Fan-Out](components/fan-out.md)                       | Router + per-Group GenServers + SSE connection processes -- watermark-gated ordered delivery to live subscribers                                   |
| [Replication](components/replication.md)               | Per-peer Manager processes -- catch-up + live SSE from peers, dedup, trust-and-apply writes                                                        |
| [Background Warmer](components/background-warmer.md)   | Optional GenServer that pre-materializes dirty entities during idle periods                                                                        |

## Dependencies

```
HTTP API ──────→ Permission Checker ──→ System Cache (group_members, relationships)
           │
           ├──→ Writer ──→ RocksDB Store (WriteBatch across 5 CFs)
           │            ──→ System Cache  (dirty_set, group_members, relationships, watermark)
           │            ──→ Fan-Out       ({:batch_committed, from_gsn, to_gsn} notification)
           │
           ├──→ Entity Store ──→ RocksDB Store (cf_entity_actions, cf_updates iterator)
           │                 ──→ SQLite Store  (entity UPSERT + SELECT)
           │                 ──→ System Cache  (dirty_set read/clear)
           │
           └──→ Fan-Out ──→ System Cache  (relationships for Group routing, watermark for gating)
                        ──→ RocksDB Store (read Action payloads for SSE push)

Replication ──→ Writer      (trust-and-apply writes, skip permission check)
            ──→ RocksDB Store (cf_action_dedup for dedup check)

Background Warmer ──→ Entity Store (materialize dirty entities)
                  ──→ System Cache  (read dirty_set)
```

**Supervision tree ownership:**

```
EbbServer.Supervisor (one_for_one)
├── Storage Supervisor (rest_for_one)
│   ├── RocksDB Store    — opens DB, creates column families
│   ├── SQLite Store     — opens DB, runs DDL
│   ├── System Cache     — creates ETS tables, populates from RocksDB, owns :atomics
│   ├── Writer 1         — RocksDB writes, ETS updates
│   ├── Writer 2         — RocksDB writes, ETS updates
│   ├── Entity Store     — on-demand materialization
│   └── Background Warmer (optional)
│
├── Sync Supervisor (one_for_one)
│   ├── Fan-Out Router
│   ├── Group DynamicSupervisor
│   │   └── Group GenServers (transient, dynamic)
│   └── SSE ConnectionSupervisor
│       └── SSE connections (temporary, one per client)
│
└── Replication Supervisor (one_for_one)
    └── Peer Managers (one per configured peer)
```

The `rest_for_one` strategy on Storage Supervisor ensures that if RocksDB Store crashes, everything downstream (System Cache, Writers, Entity Store) restarts in order.

## Vertical Slices

| #   | Slice                                                                    | Components Involved                                                       | Purpose                                                                          |
| --- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 1   | [Single Action Write + Read-Back](slices/01-single-action-write-read.md) | RocksDB Store, SQLite Store, System Cache, Writer, Entity Store, HTTP API | Thinnest end-to-end: write an Action via HTTP, read the materialized entity back |
| 2   | [Permission-Checked Write](slices/02-permission-checked-write.md)        | + Permission Checker                                                      | Adds authorization -- Group bootstrap, membership check, relationship lookup     |
| 3   | [Live Sync (Catch-Up + SSE)](slices/03-live-sync.md)                     | + Fan-Out, HTTP API (SSE)                                                 | Client handshake, paginated catch-up from RocksDB, live SSE subscription         |
| 4   | [Multi-Writer Concurrent Writes](slices/04-multi-writer.md)              | Writer (x2), System Cache (watermark), Fan-Out                            | Validates 2-writer pipelining, GSN watermark correctness, ordered fan-out        |
| 5   | [Server Function Invocation](slices/05-server-function-invocation.md)    | HTTP API, Entity Store, Writer                                            | Bun calls `ctx.get`/`ctx.query`/`ctx.create` via Elixir HTTP endpoints           |
| 6   | [Peer Replication](slices/06-peer-replication.md)                        | Replication, Writer, RocksDB Store                                        | Server-to-server catch-up + live stream, dedup, trust-and-apply                  |

Slices are ordered from simplest to most complex. Build and validate them in order.

## Cross-Cutting Concerns

### Serialization

Three formats at three layers, each optimized for its consumer:

| Layer                    | Format                   | Library                                         |
| ------------------------ | ------------------------ | ----------------------------------------------- |
| Client <-> Server (wire) | MessagePack              | `Msgpax`                                        |
| RocksDB (storage)        | ETF (Erlang Term Format) | `:erlang.term_to_binary/1` / `binary_to_term/2` |
| SQLite (entity cache)    | JSON                     | `Jason`                                         |

**Every component** that reads from RocksDB must use `binary_to_term(binary, [:safe])` to prevent atom table pollution. Map keys in stored terms should be strings, not atoms.

### Error Handling

- **Writer GenServers**: If a WriteBatch commit fails, the batch is retried once. If it fails again, the GenServer crashes and the `rest_for_one` supervisor restarts the storage tree. Callers receive `{:error, :storage_unavailable}`.
- **Entity Store**: Materialization failures (corrupt RocksDB data, merge errors) return `{:error, reason}` to the HTTP handler, which responds with 500. The dirty bit is NOT cleared on failure.
- **HTTP API**: All endpoints return structured error responses: `{:error, :unauthorized}` -> 401, `{:error, :not_found}` -> 404, `{:error, :validation_failed, details}` -> 422, `{:error, :storage_unavailable}` -> 503.
- **Fan-Out**: If a Group GenServer crashes, it restarts (transient) and clients reconnect via SSE retry. No data loss -- clients catch up from their last cursor.
- **SSE connections**: Temporary restart -- if a connection process dies, the client reconnects automatically (SSE built-in retry).

### Configuration

All configuration flows through `Application.get_env(:ebb_server, key)`:

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

| Metric                                    | Source       | Type                        |
| ----------------------------------------- | ------------ | --------------------------- |
| `ebb.writer.batch_size`                   | Writer       | Histogram                   |
| `ebb.writer.batch_latency_ms`             | Writer       | Histogram                   |
| `ebb.writer.actions_per_sec`              | Writer       | Counter                     |
| `ebb.watermark.lag`                       | System Cache | Gauge (max_gsn - watermark) |
| `ebb.dirty_set.size`                      | System Cache | Gauge                       |
| `ebb.entity_store.materialize_latency_ms` | Entity Store | Histogram                   |
| `ebb.entity_store.cache_hit_rate`         | Entity Store | Ratio                       |
| `ebb.fanout.push_latency_ms`              | Fan-Out      | Histogram                   |
| `ebb.fanout.active_connections`           | Fan-Out      | Gauge                       |
| `ebb.fanout.active_groups`                | Fan-Out      | Gauge                       |
| `ebb.http.request_latency_ms`             | HTTP API     | Histogram (per endpoint)    |
| `ebb.replication.lag_gsn`                 | Replication  | Gauge (per peer)            |

### ID Generation

All IDs use `Nanoid` with type prefixes: `act_` (Action), `upd_` (Update), `a_` (Actor). Entity IDs are prefixed by their type (e.g., `todo_abc123`). The client SDK generates IDs; the server validates format but does not generate entity IDs (except for server function `ctx.generateId()`).

### HLC (Hybrid Logical Clock)

HLCs are 64-bit integers (upper 48 bits = logical time in ms, lower 16 bits = counter) assigned by the originating node and preserved across replication. The server validates incoming client HLCs: reject if logical time > now + 120s (future drift) or < now - 24h (stale clock). The server does not generate or assign HLCs. HLCs are used for LWW conflict resolution during materialization, with lexicographic update ID comparison as a tiebreaker when HLCs are equal. Replicated Actions skip HLC validation (trust-and-apply). See the [clock spec](../../packages/www/src/content/docs/clock.md) for the full generation algorithm.

## Constraints and Assumptions

### Hard Constraints

- **Elixir/OTP only** for the server. The team does not know Rust -- no custom NIFs.
- **`rocksdb` hex package (v2.5.0)** -- existing Erlang NIF, no custom C++ code.
- **Durability guarantee**: No Action is acknowledged to a client until it is on disk (`sync: true` on every WriteBatch commit).
- **Zero-staleness reads**: Server function reads (`ctx.get`, `ctx.query`) always return fully materialized state. No eventual consistency window.

### Performance Targets

- 10,000 concurrent client connections per server instance
- 1,000 collaborative documents with 10 concurrent editors each
- 10,000-20,000 Action writes/sec sustained (108k burst benchmarked)
- `ctx.get(id)`: <2ms p99
- `ctx.query(type)`: <10ms p99 at 100k entities
- SSE streaming latency: <50ms p50

### Assumptions

- **Single-node first.** Multi-master replication is designed but built last (Slice 6). The architecture works correctly on a single node.
- **Bun Application Server is separate.** This architecture covers the Elixir server only. The Bun server is a stateless HTTP client.
- **Auth is external.** The server calls a developer-provided auth URL during handshake. It does not implement authentication itself.
- **Schema-agnostic server.** The server reads per-field `type` tags from stored data to determine merge strategy. It does not consult an external schema registry. The client SDK enforces type consistency.
- **MessagePack on the wire.** Clients send MessagePack-encoded payloads. The HTTP API decodes MessagePack for Action writes and encodes JSON for entity read responses.
- **ETS tables are not persisted.** They are rebuilt from RocksDB on startup. This means startup time scales with the number of system entities (Groups, GroupMembers, Relationships).
