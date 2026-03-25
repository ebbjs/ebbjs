# Storage Architecture v2: RocksDB + SQLite + On-Demand Materialization

> **Status:** Active — this is the current storage architecture.
>
> **Supersedes:** `storage-architecture-proposal.md`, `native-storage-engine-exploration.md`, `rust-nif-optimization.md`, `sqlite-throughput-experiment.md`, `sqlite-throughput-results.md`. Those documents are retained for historical context but should not be used for implementation decisions.

## Problem Statement

Ebb needs a server architecture that can:

- Handle 1,000 collaborative documents with 10 concurrent editors each
- Support 10,000 concurrent client connections per server instance
- Sustain 10,000-20,000 Action writes/second (benchmarked: ~60k single-writer, ~108k with 2 writers + pipelined writes)
- Scale horizontally via multi-master replication
- Guarantee durability: never sync an Action to clients before it's on disk
- Provide zero-staleness reads for server functions

Cursor/presence updates are ephemeral broadcasts only — not persisted to storage.

## Key Design Decisions

This architecture differs from the original proposal (`storage-architecture-proposal.md`) in four fundamental ways:

1. **Dual-store CQRS.** RocksDB (LSM-tree) handles the write-heavy Action log; SQLite (B-tree) serves as the read-optimized materialized entity cache. Each engine is used for what it's best at.
2. **On-demand materialization.** Entity state is materialized lazily — only when a server function reads it — not eagerly on every write. This decouples write throughput from materialization cost.
3. **Elixir owns all storage.** Both RocksDB and SQLite are accessed exclusively by Elixir. Bun is a stateless function runtime that reads and writes via Elixir HTTP. No shared database files between processes.
4. **`rocksdb` hex package.** No custom Rust NIFs. The existing `rocksdb` Erlang NIF (v2.5.0, RocksDB 10.7.5) provides WriteBatch, column families, iterators, snapshots, and compaction filters out of the box.

## Architecture Overview

The system consists of three co-located servers:

- **Elixir Sync/Storage Server** — the core: sync protocol, Action log (RocksDB), materialized entity cache (SQLite), on-demand materialization, real-time fan-out
- **Auth Server** — developer-provided (Clerk, Better Auth, custom JWT, etc.), called via HTTP during handshake
- **Bun Application Server** — stateless function runtime for `defineFunction` handlers, all data access via Elixir HTTP

```
┌─────────────────┐   ┌──────────────────────────────────────┐   ┌─────────────────┐
│   Auth Server    │   │       Elixir Sync/Storage Server     │   │ Bun Application │
│                  │   │                                      │   │ Server          │
│  Clerk,          │   │  ┌────────────────────────────────┐  │   │                 │
│  Better Auth,    │◄──│  │          Sync Server           │  │   │ defineFunction  │
│  custom JWT,     │   │  │                                │  │──►│ handlers        │
│  etc.            │   │  │  HTTP Handlers                 │  │   │                 │
│                  │   │  │  - Handshake (calls auth URL)  │  │   │ All data access │
│  Developer-      │   │  │  - Catch-up reads              │  │   │ via Elixir HTTP │
│  provided        │   │  │  - Action writes               │  │   │ (no direct DB   │
└─────────────────┘   │  │  - Entity reads (for Bun)       │  │   │  access)        │
                      │  │  - Permission checks            │  │   └─────────────────┘
                      │  │                                │  │
                      │  │  Fan-out Router + Group procs   │  │
                      │  │  - Per-Group GenServers         │  │
                      │  │  - Per-client SSE connections   │  │
                      │  │  - Presence broadcasting        │  │
                      │  └──────────┬─────────┬───────────┘  │
                      │             │ msg pass│ ETS reads     │
                      │  ┌──────────▼─────────▼───────────┐  │
                      │  │       Storage Engine            │  │
                      │  │                                │  │
                      │  │  Writer GenServer               │  │
                      │  │  → RocksDB (Action log)         │  │
                      │  │  → ETS (dirty set + permissions)│  │
                      │  │                                │  │
                      │  │  EntityStore                    │  │
                      │  │  → On-demand materialization    │  │
                      │  │  → SQLite (entity cache)        │  │
                      │  │                                │  │
                      │  │  Background Warmer (optional)   │  │
                      │  └────────────────────────────────┘  │
                      └──────────────────────────────────────┘
```

---

## Storage Engines

### RocksDB — Action Log (Source of Truth)

RocksDB is an embedded LSM-tree key-value store. Its write-optimized architecture (memtable → sorted runs → background compaction) absorbs high-throughput appends without per-write B-tree rebalancing. Ebb uses the `rocksdb` hex package (v2.5.0), which wraps RocksDB 10.7.5 via a mature Erlang C++ NIF.

**Why RocksDB over SQLite for the Action log:**

The previous architecture used SQLite for everything. Benchmarks showed the dominant write bottleneck was index maintenance — 7 B-tree updates per INSERT across `actions` and `updates` tables, capping sustained throughput at ~5.8-9.5k Actions/sec. RocksDB's LSM-tree absorbs writes into an in-memory memtable and flushes to disk in sorted runs, amortizing the index cost via background compaction. This removes index maintenance from the write hot path.

**Why RocksDB over Fjall:**

The previous exploration (`native-storage-engine-exploration.md`) recommended Fjall as the write engine. RocksDB was chosen instead because:

- The `rocksdb` hex package provides a complete Erlang NIF with WriteBatch, column families, iterators, snapshots, transactions, and compaction filters — no Rust code required.
- Fjall would have required writing a custom Rustler NIF from scratch (~4-8 weeks).
- RocksDB is battle-tested at Facebook/Meta, CockroachDB, TiKV, and Kafka Streams scale.
- RocksDB's `enable_pipelined_write` option enables near-linear scaling with concurrent writers (benchmarked: 1.9x with 2 writers).
- The team does not know Rust (a hard constraint from `native-storage-engine-exploration.md`).

### SQLite — Materialized Entity Cache

SQLite serves as a read-optimized query layer for materialized entity state. It retains its strengths from the original design: full SQL with JOINs, `json_extract()` predicates, generated columns, partial indexes, and well-understood operational tooling.

**What changed:** SQLite is no longer on the write hot path. The Writer GenServer never touches SQLite. Instead, SQLite is populated lazily by the EntityStore during on-demand materialization. This means SQLite write throughput is no longer a bottleneck — writes only happen when entities are read, and they're amortized across reads.

### ETS — Hot-Path Caches

Three ETS tables serve the highest-frequency code paths:

| Table | Contents | Updated By | Read By |
|-------|----------|------------|---------|
| `dirty_set` | `{entity_id => true}` — entities with unmaterialized updates | Writer GenServers (on every write) | EntityStore (on every read) |
| `group_members` | `{actor_id => [group_ids]}` — actor group memberships | Writer GenServers (on system entity writes) | Permission checks, fan-out |
| `relationships` | `{source_id => group_id, target_id => [entity_ids]}` | Writer GenServers (on system entity writes) | Fan-out routing, catch-up filtering |
| `committed_watermark` | Highest GSN where all prior GSNs are durable | Writer GenServers (after each batch commit) | Catch-up reads, fan-out gating |

**Why ETS for permissions (not RocksDB):** Permission checks and fan-out routing happen on every request and every Action push. ETS lookups are ~0.5-1us. RocksDB lookups are ~1-5us (hot block cache) to ~50-200us (cold). At 10k+ concurrent connections, the 2-5x ETS advantage compounds into meaningful latency reduction on the most critical path.

**What was removed:** The original architecture had ETS tables for `entity_index`, `gsn_index`, and `action_id_index`. These are now RocksDB column families. The `action_id_index` ETS table (for replication dedup) was replaced by the `cf_action_dedup` column family — dedup is not on the hot client path, so RocksDB's lookup latency is acceptable.

---

## RocksDB Column Family Layout

```
cf_actions:          <<gsn::64-big>>                    → Action binary (ETF)
cf_updates:          <<action_id::binary, upd_id::binary>> → Update binary (ETF)
cf_entity_actions:   <<entity_id::binary, gsn::64-big>>  → action_id (for on-demand materialization)
cf_type_entities:    <<type::binary, entity_id::binary>>  → <<>> (for ctx.query type listing)
cf_action_dedup:     <<action_id::binary>>                → <<gsn::64-big>> (for replication dedup)
```

All five column families are written atomically via `WriteBatch` on every Action append. RocksDB's LSM-tree absorbs these into a single memtable flush.

### Serialization Strategy

The serialization format at each layer is chosen to match the consumer and optimize for the dominant operation:

| Layer | Format | Consumer | Why |
|-------|--------|----------|-----|
| Client ↔ Server (wire) | MessagePack | Browser SDK, server SDK, external clients | Compact (~30% smaller than JSON), cross-language, fast encode/decode in JS and Elixir |
| RocksDB (Action log) | ETF (Erlang Term Format) | Elixir only | Fastest possible encode/decode from Elixir — `:erlang.term_to_binary` is a C BIF in the BEAM VM, ~5-10x faster than MessagePack or JSON encoding in Elixir userland |
| SQLite (entity cache) | JSON | SQLite `json_extract()` queries | Required for generated columns, partial indexes, and `ctx.query()` filter predicates |

**Why ETF for RocksDB:** In the v2 architecture, Elixir is the exclusive owner of RocksDB — no other process reads or writes it. Since serialization throughput is the primary CPU bottleneck on the write path, using the BEAM's native binary format eliminates Elixir-level encoding entirely. Each `:erlang.term_to_binary` call takes ~0.5-2μs (C implementation), compared to ~3-10μs for MessagePack encoding via `Msgpax` (pure Elixir). At 100k Actions/sec, this is the difference between ~30% of a CPU core (ETF) and >100% of a core (MessagePack) spent on serialization alone.

**Trade-offs of ETF in RocksDB:**
- RocksDB data is only readable by Erlang/Elixir. This is acceptable because Elixir owns RocksDB exclusively. The human-readable view of data is SQLite (the entity cache) or JSON over HTTP.
- ETF binaries are ~20-40% larger than MessagePack. RocksDB's built-in compression (Snappy/LZ4 per SST file) mitigates this on disk. The memtable overhead is bounded by RocksDB's configured `write_buffer_size`.
- ETF format is tied to BEAM/OTP, but is stable and backward-compatible across releases. If Elixir were ever replaced (extremely unlikely), a migration step would be needed.
- Use `binary_to_term(binary, [:safe])` on reads to prevent atom table pollution — stored map keys should be strings, not atoms.

**Wire format:** Clients send MessagePack over HTTP. Elixir decodes the incoming MessagePack payload into Elixir terms (for permission checks, GSN assignment, and key construction), then encodes via `:erlang.term_to_binary` for RocksDB storage. The client-facing `data` field in each Update is stored opaquely — the Writer does not re-encode it field-by-field, only wraps the already-decoded Elixir term in ETF. On the read path (materialization), `:erlang.binary_to_term` reconstructs the Elixir terms, which are then JSON-encoded for SQLite storage and HTTP responses.

### Key Encoding

Keys use big-endian byte encoding for correct lexicographic ordering in RocksDB:

- GSN keys: `<<gsn::64-big>>` — ensures sequential scan order matches GSN order
- Composite keys: `<<entity_id::binary, gsn::64-big>>` — groups all GSNs for an entity together, ordered by GSN within each entity

### RocksDB Configuration

```elixir
db_opts = [
  create_if_missing: true,
  create_missing_column_families: true,
  max_background_jobs: 4,
  enable_pipelined_write: true      # Critical: enables 1.9x scaling with 2 writers
]
```

**`enable_pipelined_write: true`** — overlaps WAL writes and memtable writes across successive write groups. Without this, Writer 2 must wait for Writer 1 to finish both WAL and memtable writes before starting. With pipelining, Writer 2 starts its WAL write as soon as Writer 1's WAL write completes, while Writer 1's memtable write runs in the background. Benchmarked at 1.9x scaling with 2 writers (108k vs 57k single-writer). See `rocksdb-throughput-results.md` for full experiment data.

**Note:** `enable_pipelined_write` is mutually exclusive with `allow_concurrent_memtable_write` (which is `true` by default). Enabling pipelined writes implicitly disables concurrent memtable inserts within a write group. This is the correct trade-off — inter-group WAL/memtable overlap is more valuable than intra-group memtable parallelism when each write group is a single large WriteBatch.

---

## Write Path

The write path uses **2 Writer GenServers** writing to a single shared RocksDB instance with `enable_pipelined_write: true`. This achieves ~108k Actions/sec (benchmarked) — 1.9x scaling from the single-writer baseline of ~60k. GSN assignment uses a shared `:atomics` counter for lock-free gap-free ordering.

```
Client / Server Function
        │
        ▼
   Elixir (HTTP)
   • Authenticate
   • Permission check (ETS: group_members, relationships)
   • Validate Action structure
        │
        ▼
   Route to Writer GenServer 1 or 2 (round-robin or Group-based)
        │
        ▼
   Writer GenServer (one of 2)
   1. Claim GSN range: :atomics.add_get(gsn_counter, 1, batch_size)   ← lock-free
   2. Encode each Action/Update via :erlang.term_to_binary             ← ~1μs per term (C BIF)
   3. WriteBatch across all 5 column families:
        cf_actions:        GSN → Action ETF binary
        cf_updates:        (action_id, upd_id) → Update ETF binary
        cf_entity_actions: (entity_id, GSN) → action_id  (per touched entity)
        cf_type_entities:  (type, entity_id) → <<>>       (per touched entity)
        cf_action_dedup:   action_id → GSN
      Commit with sync: true                               ← durable
   4. Mark touched entity_ids dirty in ETS dirty_set       ← O(1) per entity
   5. For system entity Updates (group, groupMember, relationship):
        Update ETS permission caches inline                ← O(1) per update
   6. Advance committed GSN watermark                      ← see below
   7. Notify fan-out: {:batch_committed, from_gsn, to_gsn}
   8. Reply {:ok, gsn} to caller

   No SQLite write. No materialization. Full RocksDB throughput.
   Two writers run steps 1-8 concurrently on separate BEAM schedulers.
```

### Batching Strategy

Each Writer GenServer independently batches incoming Actions:

- Actions arrive via message passing from HTTP handlers (routed to Writer 1 or 2)
- First Action starts a 10ms timer (`Process.send_after`)
- Subsequent Actions buffer in GenServer state
- Batch flushes when timer fires OR 1000 Actions accumulated (whichever first)
- At flush time: claim GSN range atomically → encode terms via ETF → build WriteBatch → commit with sync → update ETS → advance watermark → notify callers

Under low load, individual Actions commit immediately via `handle_call` (no batching overhead). Under high load, batching amortizes the RocksDB sync cost across hundreds or thousands of Actions. With 2 writers and pipelined writes, both writers can flush concurrently with minimal contention.

### GSN Assignment and Committed Watermark

GSN assignment uses a shared `:atomics` counter:

```elixir
# Shared across all writers — lock-free, gap-free
gsn_counter = :atomics.new(1, signed: false)

# Each writer claims a range atomically before batch construction:
gsn_end = :atomics.add_get(gsn_counter, 1, batch_size)
gsn_start = gsn_end - batch_size + 1
# This writer owns GSNs gsn_start..gsn_end exclusively
```

**The ordering subtlety:** Writer 2 may claim GSNs 1001-2000 and commit before Writer 1 finishes committing GSNs 1-1000. A catch-up reader scanning by GSN would see a gap. The **committed GSN watermark** solves this — it tracks the highest GSN where all prior GSNs are confirmed durable:

```elixir
# After each batch commit, the writer advances the watermark:
mark_range_committed(gsn_start, gsn_end)
advance_watermark()  # CAS loop: advance past contiguous committed ranges
```

Catch-up reads and fan-out use the watermark (not the raw max GSN) as the upper bound for safe operations.

### Ordered Fan-Out

The Fan-out Router uses the committed GSN watermark to gate pushes, ensuring Actions are streamed to SSE clients in GSN order even though 2 writers commit independently:

```
Writer 2 commits GSNs 1001-2000 → notifies fan-out
Fan-out checks watermark: still 0 (Writer 1 hasn't committed GSNs 1-1000)
Fan-out buffers notification

Writer 1 commits GSNs 1-1000 → notifies fan-out, watermark advances to 2000
Fan-out pushes GSNs 1-2000 in order to SSE subscribers
```

**Latency impact:** Worst case, one batch waits for the other writer's batch to commit. With 2 writers at ~18ms p50 per batch, streaming latency is ~18-36ms p50 (vs ~17ms single-writer). Still sub-50ms.

### Durability Notifications

After each flush:
1. `{:durable, gsn}` → each waiting HTTP handler process (unblocks HTTP response)
2. `{:batch_committed, from_gsn, to_gsn}` → Fan-out Router (gated by watermark before SSE push)

---

## Read Path: On-Demand Materialization

Entity state is materialized lazily — only when a read request arrives and the entity is dirty. The EntityStore module provides a unified interface that hides the materialization details from callers.

### EntityStore Interface

```elixir
defmodule EbbServer.Storage.EntityStore do
  @doc "Point lookup with permission check. Materializes if dirty."
  def get(entity_id, actor_id)

  @doc "Type scan with optional filter and permission check. Materializes dirty entities first."
  def query(type, filter, actor_id)
end
```

### Read Flow: `ctx.get(id)`

```
Bun server function calls ctx.get("todo_123")
  │
  ▼
HTTP request to Elixir: GET /entities/todo_123?actor_id=...
  │
  ▼
EntityStore.get("todo_123", actor_id)
  │
  ├── 1. Check ETS dirty_set for "todo_123"         ← O(1)
  │
  ├── [CLEAN] → SELECT from SQLite (cached)
  │              + permission check (ETS group_members + relationships)
  │              → return entity
  │
  └── [DIRTY] → Read delta updates from RocksDB:
                  Iterator on cf_entity_actions prefix "todo_123"
                  where GSN > entity's last_gsn in SQLite
                → Fetch full Updates from cf_updates
                → Per-field typed merge in Elixir (dispatch on each field's type tag)
                → UPSERT into SQLite (entities table)
                → Clear dirty bit in ETS
                → Permission check
                → return entity
```

### Read Flow: `ctx.query(type, filter)`

```
Bun server function calls ctx.query("todo", { completed: true })
  │
  ▼
HTTP request to Elixir: POST /entities/query { type: "todo", filter: {...}, actor_id: "..." }
  │
  ▼
EntityStore.query("todo", filter, actor_id)
  │
  ├── 1. Get dirty entity_ids for type "todo" from ETS dirty_set   ← O(N dirty)
  │
  ├── 2. Batch materialize all dirty "todo" entities               ← parallelizable
  │      (same flow as get: read RocksDB delta → per-field typed merge → upsert SQLite → clear dirty)
  │
  └── 3. SELECT from SQLite with permission JOINs + json_extract filter
         → return entities
```

### Materialization Details

**Per-field typed merge:**

Each entity's `data` field contains self-describing typed field values. Each field carries a `type` tag that tells the materialization engine which merge function to use:

```json
{
  "fields": {
    "title":     { "type": "lww", "value": "My Todo", "hlc": 1711234567890000 },
    "completed": { "type": "lww", "value": false, "hlc": 1711234567890000 },
    "likes":     { "type": "counter", "value": { "alice": 3, "bob": 1 } },
    "body":      { "type": "crdt", "value": "<base64 yjs state>" }
  }
}
```

During materialization, incoming PATCH Updates are merged field-by-field. For each field, the merge function is determined by the field's `type` tag:

- **`lww`** — Last-write-wins. The value with the higher HLC wins. Commutative and idempotent.
- **`counter`** — G-Counter CRDT. Per-actor counts are merged by taking the max per actor. The total is the sum of all actors' counts. No HLC comparison needed — the merge is commutative and conflict-free.
- **`crdt`** — Yjs CRDT merge via `y_ex` (Elixir Yjs NIF). Yjs update blobs are merged using Yjs's built-in algorithm. The merged state is stored as a binary blob. Server functions receive the merged blob and decode it via `yjs` on the JS side.

The server is schema-agnostic — it reads the `type` tag from the stored field values rather than consulting an external schema registry. The client SDK enforces type consistency (a field declared as `e.counter()` always writes `"type": "counter"` patches).

**Incremental Merge:**

The EntityStore tracks `last_gsn` per entity in the SQLite `entities` table. On-demand materialization only reads Updates with GSN > `last_gsn` — it never replays the full history. This makes repeated reads of the same entity O(delta), not O(history).

### Background Warmer (Optional, Tunable)

A low-priority GenServer that tails the dirty set and pre-materializes entities that haven't been read yet. This is a tuning knob, not a required component:

- **Off** (default) → pure on-demand, maximum write throughput, pay-on-read
- **Moderate** → pre-materialize recently dirtied entities during idle periods
- **Aggressive** → approaches eager materialization, `ctx.query()` rarely hits dirty entities

The warmer is the escape hatch for workloads where `ctx.query()` frequently scans large numbers of dirty entities. It can be tuned based on observed read patterns without architectural changes.

```elixir
defmodule EbbServer.Storage.BackgroundWarmer do
  use GenServer

  # Periodically pop entity_ids from the dirty set and materialize them.
  # Rate-limited to avoid competing with real reads.
  # Configurable: interval, batch_size, enabled.
end
```

---

## Read Path: Sync Catch-Up

Client catch-up reads raw Actions from RocksDB — not materialized entities. The client materializes locally. This path does not touch SQLite or the EntityStore.

```
Client catch-up request: GET /sync/groups/{group_id}?offset={gsn}
  │
  ▼
Elixir (HTTP)
  1. Authenticate, validate cursor
  2. ETS: Which entities belong to this Group? (relationships cache)
  3. RocksDB: Iterator on cf_entity_actions for each entity_id, GSN > cursor
  4. RocksDB: Fetch full Action payloads from cf_actions
  5. Return paginated Actions (200 per page) + Stream-Next-Offset header
```

Server-to-server replication uses the same path but unfiltered: `GET /sync/replication?offset={gsn}` iterates `cf_actions` directly by GSN range.

---

## SQLite Schema (Entity Cache)

SQLite serves as the materialized entity cache. The schema is simplified from the original — it only contains entities and supporting tables, not the Action log.

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA cache_size = -64000;        -- 64MB page cache
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;

-- Materialized entity state (populated lazily by EntityStore)
CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  data TEXT,                        -- JSON blob (current materialized state, with per-field type tags)
  created_hlc INTEGER NOT NULL,
  updated_hlc INTEGER NOT NULL,
  deleted_hlc INTEGER,              -- tombstone marker
  deleted_by TEXT,
  last_gsn INTEGER NOT NULL,        -- GSN of the most recent Update applied (for incremental merge)

  -- Generated columns for system entity queries
  source_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.source_id')) STORED,
  target_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.target_id')) STORED,
  rel_type TEXT GENERATED ALWAYS AS (json_extract(data, '$.type')) STORED,
  rel_field TEXT GENERATED ALWAYS AS (json_extract(data, '$.field')) STORED,
  actor_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.actor_id')) STORED,
  group_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.group_id')) STORED,
  permissions TEXT GENERATED ALWAYS AS (json_extract(data, '$.permissions')) STORED
);

-- Indexes for permission-scoped queries
CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type) WHERE deleted_hlc IS NULL;
CREATE INDEX IF NOT EXISTS idx_entities_type_gsn ON entities(type, last_gsn);
CREATE INDEX IF NOT EXISTS idx_entities_source ON entities(source_id) WHERE type = 'relationship' AND deleted_hlc IS NULL;
CREATE INDEX IF NOT EXISTS idx_entities_target ON entities(target_id) WHERE type = 'relationship' AND deleted_hlc IS NULL;
CREATE INDEX IF NOT EXISTS idx_entities_actor_group ON entities(actor_id, group_id) WHERE type = 'groupMember' AND deleted_hlc IS NULL;

-- Actor identity records (auto-created on first authentication)
CREATE TABLE IF NOT EXISTS actors (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

-- Function versions (deployed server function code)
CREATE TABLE IF NOT EXISTS function_versions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  code TEXT NOT NULL,
  input_schema TEXT,
  output_schema TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  activated_at INTEGER,
  UNIQUE(name, version)
);
CREATE INDEX IF NOT EXISTS idx_function_active ON function_versions(name, status) WHERE status = 'active';
```

**What was removed from the original schema:**

- `actions` and `updates` tables → replaced by RocksDB column families
- `snapshots` table → replaced by `last_gsn` on the entities table (incremental merge)
- `cold_action_index` table → unnecessary (RocksDB handles its own compaction)
- All indexes on the action/update tables → RocksDB column families serve as indexes
- `format` column on entities → replaced by per-field `type` tags in the stored `data` blob (merge strategy is now per-field, not per-entity)

---

## Bun Application Server

Bun is a **stateless function runtime**. It has no direct database access. All data operations go through Elixir HTTP endpoints on localhost.

```
ctx.get(id)          → GET  /entities/{id}?actor_id=...         → Elixir EntityStore.get
ctx.query(type, f)   → POST /entities/query                     → Elixir EntityStore.query
ctx.create(type, d)  → POST /sync/actions                       → Elixir Writer GenServer
ctx.update(ref, d)   → POST /sync/actions                       → Elixir Writer GenServer
ctx.delete(ref)      → POST /sync/actions                       → Elixir Writer GenServer
ctx.relate(s, n, t)  → POST /sync/actions                       → Elixir Writer GenServer
ctx.unrelate(s, n, t)→ POST /sync/actions                       → Elixir Writer GenServer
```

**Latency impact:** Each `ctx.get()` / `ctx.query()` call adds ~0.2-0.3ms of localhost HTTP overhead compared to direct SQLite access. For a clean (cached) entity, total latency is ~0.3-0.5ms. For a dirty entity requiring materialization, ~0.5-2ms. Both are sub-millisecond to low-single-digit milliseconds.

For server functions that make many sequential point reads, a batch API (`ctx.getBatch([id1, id2, ...])`) can reduce the per-call overhead to a single HTTP round-trip.

**What changed from the original architecture:**

- Bun no longer reads SQLite directly
- Bun no longer runs the Materializer
- Bun no longer needs the `bun:sqlite` dependency for entity access
- The Bun Materializer process and its SSE subscription are eliminated entirely
- The staleness window (Bun sees stale data because materialization is async) is eliminated — EntityStore guarantees fresh data

---

## System Entity Cache

Elixir maintains a permanent in-memory ETS cache of all system entities (Groups, GroupMembers, Relationships). This is unchanged from the original architecture in purpose, but simplified in implementation.

### Startup Population

On startup, the system entity cache is populated from RocksDB:

```elixir
# Iterate cf_type_entities for system entity types
# For each entity_id, materialize via EntityStore (which reads from RocksDB and populates SQLite)
# Build ETS indexes from the materialized state

for type <- ["group", "groupMember", "relationship"] do
  # Use RocksDB iterator on cf_type_entities with prefix type
  entity_ids = RocksDB.prefix_iterator(cf_type_entities, type)

  for entity_id <- entity_ids do
    entity = EntityStore.materialize(entity_id)  # RocksDB → per-field typed merge → SQLite
    SystemCache.apply_entity(entity)              # Populate ETS
  end
end
```

The server does not accept connections until startup population completes.

### Runtime Updates

After each batch flush, each Writer GenServer extracts system entity state from Action payloads and updates the ETS caches inline — before replying to callers and before notifying fan-out. This ensures permission grants and revocations take effect immediately.

### Consistency Guarantee

All system entity mutations flow through one of the Writer GenServers, which update ETS synchronously. System entity cache updates are commutative (each update sets the current state, not a delta), so interleaving from 2 concurrent writers is safe — ETS guarantees atomicity for single-key writes. During multi-server replication, replicated Actions containing system entity changes also flow through a Writer.

---

## Performance Characteristics

### Write Throughput

| Metric | SQLite (previous) | RocksDB + ETF (this architecture) |
|--------|-------------------|----------------------------------|
| Bottleneck | 7 B-tree updates per INSERT | Elixir CPU (serialization + key construction) |
| Single-writer throughput | 5.8-9.5k Actions/sec | **~60k Actions/sec** (benchmarked) |
| 2-writer throughput (pipelined) | N/A | **~108k Actions/sec** (benchmarked) |
| Fsync control | PRAGMA synchronous | WriteBatch sync option |
| Index maintenance on write | Synchronous (per-write) | Asynchronous (background compaction) |
| Serialization cost (1000-Action batch) | ~10-20ms (JSON) | **~1.4ms (ETF)** |

**Benchmark results (from `rocksdb-throughput-results.md`):**

| Configuration | Actions/sec | vs SQLite baseline | Notes |
|---|---|---|---|
| SQLite (all indexes, sync) | 5,838 | 1x | Previous architecture |
| RocksDB + ETF (1 writer, sync) | ~60,000 | **10x** | Single-writer ceiling — Elixir CPU bound |
| RocksDB + ETF (2 writers, pipelined, sync) | **~108,000** | **18x** | `enable_pipelined_write: true`. Near-linear 1.9x scaling. |
| RocksDB + MessagePack (1 writer, sync) | ~52,000 | 9x | ETF is 15% faster on full write path |
| RocksDB + JSON (1 writer, sync) | ~47,000 | 8x | ETF is 28% faster on full write path |

**Caveat:** The 108k number is from a 15-second benchmark run that includes initial burst throughput. Sustained throughput over 60+ seconds may be ~85-100k due to memtable flush and compaction overhead. A longer validation run is recommended.

**What we tested and ruled out:**
- **Bulk NIF (`write_multi`):** Reduced 8,000 NIF boundary crossings to 1. No improvement — the bottleneck is Elixir computation (key construction, data structure manipulation), not NIF overhead.
- **Writer sharding (default config):** 2 writers on single RocksDB. Only 1.3x scaling — RocksDB's WAL serialization limits default multi-writer throughput.
- **3 writers (pipelined):** ~140k/sec (2.37x scaling), but per-writer efficiency drops to 79% (vs 92% with 2 writers), p99 latency jumps from 27ms to 37ms, and the additional watermark/fan-out complexity isn't justified when 2 writers already exceeds the 100k target. See `rocksdb-throughput-results.md` for full data.
- **`unordered_write`:** 105k with 2 writers — slightly behind pipelined (108k) while sacrificing snapshot immutability. Not worth the trade-off.

The Rust NIF path remains available as a future optimization for >200k Actions/sec. It would only be needed if the 2-writer pipelined configuration is insufficient.

### Read Latency

| Operation | Clean (cached) | Dirty (materialization needed) |
|-----------|---------------|-------------------------------|
| `ctx.get(id)` | ~0.3-0.5ms | ~0.5-2ms |
| `ctx.query(type)`, 100 results | ~1.3-2.5ms | ~2-5ms (depends on dirty count) |
| `ctx.query(type)` + permission JOINs | ~2.3-5.5ms | ~3-8ms |
| Sync catch-up (GSN range scan) | ~1-5ms per page | N/A (reads RocksDB directly) |

The ~0.2-0.3ms per call is the localhost HTTP round-trip overhead from Bun → Elixir. Clean reads add this on top of the SQLite query time. Dirty reads add the materialization cost (RocksDB read + ETF decode + per-field typed merge + SQLite upsert), which dominates the HTTP overhead. ETF decode (`:erlang.binary_to_term`) is equally fast as encode (~0.5-2μs per term), so the read path also benefits.

---

## Operational Model

### Deployment

- **RocksDB:** Single directory of SST files, WAL, and MANIFEST. Managed entirely by the `rocksdb` hex package.
- **SQLite:** Single file. Managed by `exqlite`.
- **Both co-located** in the configured `data_dir`.

### Backup

- **RocksDB:** Use the `checkpoint` API (online backup — creates a hard-link snapshot without stopping writes).
- **SQLite:** File copy (safe in WAL mode when no writes are in progress) or `VACUUM INTO` for a consistent snapshot.

### Monitoring

- **RocksDB:** The `rocksdb` hex package exposes 45+ statistics tickers and 13+ histograms (compaction stats, block cache hit rate, write amplification, etc.).
- **SQLite:** Standard SQLite pragmas (`PRAGMA page_count`, `PRAGMA freelist_count`, etc.).
- **ETS:** `:ets.info/2` for memory usage of each cache table.
- **Application-level:** Dirty set size, materialization latency histogram, cache hit rate, committed GSN watermark lag (distance between max assigned GSN and watermark), per-writer batch latency histograms.

### Crash Recovery

- **RocksDB:** Built-in WAL + MANIFEST recovery. Automatic on restart.
- **SQLite:** WAL mode recovery. Automatic on restart.
- **ETS:** Repopulated from RocksDB on startup (system entity cache). Dirty set starts empty (conservatively assumes all entities need rematerialization on first read).

---

## Sync Protocol

The sync protocol (handshake, catch-up, live SSE, presence, fan-out) is **unchanged** from `storage-architecture-proposal.md`, except:

- Catch-up reads come from RocksDB (not SQLite or a custom Action log file)
- Fan-out routing reads affected Groups from the ETS relationships cache (unchanged)
- The Bun Materializer SSE subscription is eliminated
- Server function reads go through Elixir HTTP (not direct SQLite from Bun)

All sync protocol endpoints, message formats, and client behavior remain the same. See `storage-architecture-proposal.md` sections: "Sync Protocol", "Fan-out Architecture", "Presence Broadcasting", "Server-to-Server Replication", and "Write Flow (End-to-End)" for the full specification. Those sections remain valid.

---

## OTP Supervision Tree

```
Application Supervisor (one_for_one)
│
├── Storage Supervisor (rest_for_one)
│   ├── SystemCache GenServer      (permanent) — owns ETS tables, startup population
│   ├── Writer GenServer 1         (permanent) — RocksDB writes, ETS updates
│   ├── Writer GenServer 2         (permanent) — RocksDB writes, ETS updates
│   ├── EntityStore GenServer      (permanent) — on-demand materialization, SQLite
│   └── BackgroundWarmer           (permanent, optional) — pre-materialization
│
│   Shared state (owned by SystemCache, read by Writers):
│     :atomics — gsn_counter (GSN assignment)
│     :atomics — committed_watermark (safe read boundary)
│
├── Sync Supervisor (one_for_one)
│   ├── Fan-out Router             (permanent) — watermark-gated SSE push
│   ├── Group DynamicSupervisor    (permanent)
│   │   ├── Group "A" GenServer    (transient)
│   │   ├── Group "B" GenServer    (transient)
│   │   └── ...started/stopped dynamically
│   └── SSE ConnectionSupervisor   (permanent)
│       ├── SSE conn 1             (temporary)
│       ├── SSE conn 2             (temporary)
│       └── ...one per connected client
│
└── Replication Supervisor (one_for_one)
    ├── Peer "X" Manager           (permanent)
    ├── Peer "Y" Manager           (permanent)
    └── ...one per configured peer
```

**Changes from the original tree:**

- `Checkpoint Manager` → removed (RocksDB handles its own checkpointing)
- `Compactor` → removed (RocksDB handles its own compaction)
- `EntityStore` → added (on-demand materialization)
- `BackgroundWarmer` → added (optional pre-materialization)
- `SystemCache` → added (ETS table owner, startup population, shared atomics)
- `Writer GenServer` → **2 instances** (concurrent pipelined writes for ~108k throughput)
- `Fan-out Router` → updated to use committed GSN watermark for ordered SSE push

---

## What Was Eliminated

| Original Component | Replaced By |
|--------------------|-------------|
| Custom binary Action log format | RocksDB column families |
| CRC32 framing and crash recovery | RocksDB built-in WAL recovery |
| ETS `entity_index` (entity → [GSNs]) | RocksDB `cf_entity_actions` column family |
| ETS `gsn_index` (GSN → file offset) | RocksDB `cf_actions` (GSN key → value) |
| ETS `action_id_index` (dedup) | RocksDB `cf_action_dedup` column family |
| File rotation + manifest | RocksDB SST file management |
| Segment compaction + rewriting | RocksDB built-in compaction |
| Index checkpointing | RocksDB MANIFEST + WAL |
| Memory management (soft/hard limits) | RocksDB block cache + OS page cache |
| Cold-tier SQLite index | Unnecessary (RocksDB keeps all data) |
| Bun Materializer process | EntityStore on-demand materialization in Elixir |
| SSE stream to Materializer | Eliminated |
| `actions` and `updates` SQLite tables | RocksDB column families |
| `snapshots` SQLite table | `last_gsn` field on entities table |
| Custom Rust NIF (Fjall) | `rocksdb` hex package (existing Erlang NIF) |
| Bun direct SQLite access | Elixir HTTP endpoints |
| Async materialization staleness window | Zero-staleness on-demand materialization |
| Entity-level `format` column (`json`/`crdt`) | Per-field `type` tags in stored data blob (merge strategy per field) |

---

## Implementation Plan

### Dependencies

```elixir
# mix.exs
defp deps do
  [
    {:rocksdb, "~> 2.5"},       # RocksDB Erlang NIF
    {:exqlite, "~> 0.27"},      # SQLite3 NIF (for entity cache)
    {:msgpax, "~> 2.4"},        # MessagePack (client ↔ server wire format; RocksDB uses ETF internally)
    {:plug_cowboy, "~> 2.7"},   # HTTP server
    {:jason, "~> 1.4"},         # JSON (for HTTP API responses)
    {:nanoid, "~> 2.1"},        # ID generation
  ]
end
```

### Components

| ID | Component | Description |
|----|-----------|-------------|
| C1 | Elixir Project Scaffold | Mix project, OTP application, supervision tree skeleton |
| C2 | RocksDB Setup | Open database, create column families, configure options |
| C3 | SQLite Schema | Entity cache tables (entities, actors, function_versions) |
| C4 | Writer GenServers (×2) | WriteBatch across column families, shared atomic GSN assignment, ETS dirty set updates, system entity cache updates, committed GSN watermark advancement |
| C5 | System Entity Cache + Shared Atomics | ETS tables for group_members and relationships, startup population from RocksDB, `:atomics` for GSN counter and committed watermark |
| C6 | EntityStore | On-demand materialization: dirty check → RocksDB read → per-field typed merge → SQLite upsert → clear dirty |
| C7 | Permission Checks | Structural validation, HLC drift, ETS-based authorization |
| C8 | Action Write Endpoint | `POST /sync/actions` — validate, permission-check, write, confirm durability |
| C9 | Entity Read Endpoints | `GET /entities/{id}`, `POST /entities/query` — for Bun server functions |
| C10 | ActionReader | Query Actions from RocksDB by GSN range, by entity, for catch-up |
| C11 | Auth Integration | HTTP callback to developer's auth URL |
| C12 | Handshake Endpoint | `POST /sync/handshake` |
| C13 | Catch-up Endpoint | `GET /sync/groups/{id}?offset={gsn}` |
| C14 | Fan-out Router + Group GenServers | Per-Group fan-out, watermark-gated ordered SSE push |
| C15 | Live SSE Endpoint | `GET /sync/live?groups=...&cursors=...` |
| C16 | Presence | Ephemeral broadcasting |
| C17 | Background Warmer | Optional pre-materialization GenServer |
| C18 | Bun Application Server | Stateless function runtime, HTTP-based data access |

### Suggested Build Order

**1. Core storage** — C1 → C2 → C3 → C4 → C5 → C6 → C7 → C8 → C9

Get the full write + read path working: Actions written to RocksDB, entities materialized on demand from SQLite, permission-checked, exposed via HTTP.

**2. Real-time delivery** — C10, C11, C14, then C15, C16

Catch-up reads from RocksDB, auth integration, fan-out infrastructure.

**3. Client-facing sync** — C12 → C13

Handshake and per-Group catch-up.

**4. Server functions** — C18

Bun runtime pointing at Elixir HTTP endpoints.

**5. Tuning** — C17

Background warmer, if needed based on observed read patterns.

---

## Alternatives Considered

| Alternative | Why not |
|---|---|
| **SQLite for everything** | Index maintenance caps write throughput at ~9.5k/sec. Async materialization introduces staleness. |
| **Custom Elixir Action log + ETS indexes** | Significant implementation effort (CRC32 framing, file rotation, segment compaction, checkpointing). RocksDB provides all of this out of the box. |
| **Fjall (Rust LSM-tree)** | Requires custom Rustler NIF (~4-8 weeks). Team does not know Rust. |
| **Native Rust storage engine** | Same Rust constraint. Maximum implementation effort for marginal benefit over RocksDB. |
| **SurrealDB** | General-purpose database that doesn't fit ebb's event-sourced + custom merge architecture. No fsync control, no embedded Elixir SDK, MVCC overhead wasted on append-only log. |
| **Eager synchronous materialization** | Caps write throughput at ~3-4k/sec (SQLite upsert on every write). On-demand materialization decouples write throughput from read patterns. |
| **Async Bun Materializer** | Introduces staleness window. Requires SSE subscription, separate process, cross-language coordination. On-demand materialization in Elixir is simpler and zero-staleness. |
| **Bun direct SQLite access** | Requires shared database file between processes, WAL-mode multi-reader coordination, and doesn't solve materialization staleness. Moving all storage behind Elixir eliminates an entire class of cross-process coordination problems. |
| **LMDB/heed for read store** | 4-7x faster reads than SQLite, but loses SQL query language. Permission-scoped JOINs would need hand-coded KV lookups. Worth revisiting if SQLite read performance becomes a bottleneck. |
| **Pebble (CockroachDB's LSM-tree)** | Written in Go with no C API or cross-language bindings. Using it from Elixir would require embedding Go's runtime inside the BEAM VM (two GCs, two schedulers, Go panic kills BEAM). CockroachDB built Pebble specifically to escape the CGo boundary — using it from Elixir reintroduces a worse version of that problem. Also missing column families, which ebb uses for atomic cross-index writes. |
| **MessagePack for RocksDB storage** | ~5-10x slower than ETF for encode/decode because encoding happens in Elixir userland rather than as a C BIF. Would cap practical throughput at ~30-50k Actions/sec due to serialization CPU cost. MessagePack is still used on the wire (client ↔ server) where cross-language support matters. |

---

## Success Metrics

- ~60,000 Actions/second with single writer (benchmarked)
- ~108,000 Actions/second with 2 writers + pipelined writes (benchmarked, 15s burst — sustained may be ~85-100k)
- Further ceiling of 200,000+ Actions/second with Rust NIF batch serialization (future optimization, if needed)
- Zero SQLite writes on the write hot path
- Zero materialization staleness for server function reads
- Durability guarantee preserved: `sync: true` on every WriteBatch commit, no Action acknowledged until on disk
- Monotonic gap-free GSN ordering via shared `:atomics` counter
- Ordered SSE delivery via committed GSN watermark (streaming latency ~18-36ms p50 with 2 writers)
- `ctx.get(id)`: <2ms p99 (including materialization for dirty entities)
- `ctx.query(type)`: <10ms p99 for permission-scoped query at 100k entities
- 10,000 concurrent client connections per server instance
- Dirty set size as the key operational metric — if it grows unbounded, enable the warmer
- Committed GSN watermark lag as the key multi-writer health metric — should stay <1 batch (~18ms)
