# Devlog Post Outline: How We Designed Ebb's Storage Architecture

## Working Title

"Why Our Sync Engine Uses Two Databases (and Zero at Write Time)"

---

## 1. What Ebb Is (30 seconds of context)

- Local-first sync framework — think Linear/Figma-style collaboration for any app
- Clients hold a full replica in SQLite, sync Actions (atomic units of change) through the server
- Server's job: durable append, permission-scoped fan-out, materialized views for server-side queries
- The data model: Actions contain Updates, Updates target Entities, Entities belong to Groups. Field-level Last-Writer-Wins (HLC timestamps) resolves conflicts. Yjs CRDTs for rich text.

---

## 2. The Naive Starting Point: "Just Use SQLite"

- SQLite is the default answer for embedded storage — battle-tested, zero-config, SQL
- Our initial plan: SQLite for everything. Action log, materialized entities, indexes, permission queries. One file, shared between Elixir (writes) and Bun (reads) via WAL mode.
- This is roughly what CouchDB did — append-only B-tree with materialized views. Simple, proven pattern.
- Inspiration: Turso/libSQL, LiteFS, Litestream — the "SQLite is the new Postgres" wave

---

## 3. What the Benchmarks Actually Showed

- Built a real benchmark suite (not synthetic — realistic Action shapes, LWW merge, permission JOINs)
- **Finding 1:** Sustained throughput capped at ~5.8k Actions/sec with full indexes, ~9.5k with minimal indexes. Ceiling of ~15k with all durability removed.
- **Finding 2:** The bottleneck wasn't I/O or WAL checkpointing — it was **B-tree index maintenance**. 7 B-trees updated per INSERT across two tables. Dropping secondary indexes gave +62% throughput instantly.
- **Finding 3:** Adding synchronous LWW materialization (SELECT → merge → UPSERT per entity) dropped throughput to ~3-4k Actions/sec. The entity upsert on every write was the new ceiling.
- **The lesson:** SQLite is a B-tree engine. B-trees are read-optimized. We were fighting the data structure on the write path.

---

## 4. Exploring the Alternatives

### The Custom Engine Path

- Inspired by SpacetimeDB's approach: purpose-built storage engine for a specific access pattern
- Also inspired by TigerBeetle: if you know your workload, you can beat general-purpose databases by 100x
- We designed a full native storage engine: append-only log + ETS indexes + Rust NIF with dual Elixir/Bun bindings
- Evaluated Fjall, RocksDB, redb, LMDB as foundations
- **Why we pulled back:** The team doesn't know Rust. Building a custom NIF with dual-language bindings was 4-8 weeks of work on a component that doesn't ship user-visible features. The "no Rust authorship" constraint was a hard blocker.

### The SurrealDB Detour

- Briefly evaluated SurrealDB — multi-model (document + graph + relational), live queries, materialized views, embeddable in Rust
- Appealing on paper: built-in materialized views could handle our LWW merge, graph model fits our permission structure
- **Why it didn't fit:** Ebb's storage is event-sourced with custom merge semantics. SurrealDB's materialized views only support standard SQL aggregates, not per-field HLC comparison. No fsync control for our durability guarantee. No Elixir SDK. Would require the same Rust NIF work as the custom engine.
- Fundamental misfit: general-purpose database for a very specific access pattern

### The Insight: Separate the Write Problem from the Read Problem

- CockroachDB uses Pebble (LSM-tree, forked from RocksDB) under a SQL query layer
- TiDB pairs TiKV (LSM-tree) with TiFlash (columnar) for HTAP workloads
- Even SQLite's own WAL mode is this pattern: append to WAL (sequential), read from B-tree (indexed)
- **The principle:** LSM-trees absorb writes into memory and flush sorted runs in the background. B-trees maintain sorted structure on every write but enable fast point lookups and range scans. Use each where it's strongest.

---

## 5. The Architecture We Landed On

### RocksDB for Writes (the Action Log)

- `rocksdb` hex package — existing Erlang NIF, no Rust needed. WriteBatch, column families, iterators, compaction filters. Battle-tested at Facebook/CockroachDB/TiKV scale.
- 5 column families written atomically per Action. Memtable absorbs writes; compaction happens in the background.
- Write path never touches SQLite. Full RocksDB throughput on the hot path.

### SQLite for Reads (the Entity Cache)

- Materialized entity state lives in SQLite — permission JOINs, `json_extract()` predicates, generated columns, partial indexes
- SQLite's B-tree is perfect here: read-optimized, rich query language, decades of tooling
- But it's a cache, not the source of truth. RocksDB is the source of truth.

### On-Demand Materialization (the Key Insight)

- Entity state is materialized **only when something reads it**
- Dirty set in ETS tracks which entities have unmaterialized updates
- Clean reads hit SQLite directly (~0.3ms). Dirty reads trigger materialization from RocksDB (~1-2ms). Both are sub-millisecond to low-single-digit.
- Background warmer available as a tuning knob — from pure on-demand to near-eager
- **Why this matters:** Write throughput is completely decoupled from read patterns. You only pay for materialization when someone actually reads.

### Elixir Owns Everything

- Both databases accessed exclusively by Elixir. Bun is a stateless function runtime.
- No shared files between processes. No WAL-mode multi-reader coordination. No cross-language materialization pipeline.
- Trade-off: +0.2ms per read from Bun (localhost HTTP hop). Worth it for the architectural simplification.

---

## 6. What We Learned

- **Benchmark before you architect.** The SQLite benchmarks killed two assumptions: that batched transactions would reach 100k/sec, and that synchronous materialization was free. Both were wrong, and knowing that early saved weeks.
- **The "one database" instinct is strong but sometimes wrong.** SQLite-for-everything is elegant. But when your write pattern (append-only log) and your read pattern (indexed queries with JOINs) are fundamentally different, using one engine for both means one side suffers.
- **Lazy beats eager when you don't know your workload.** On-demand materialization is the right default for a greenfield project. You defer the hard decision (how much to pre-compute) until you have real usage data.
- **Use what exists.** The `rocksdb` hex package saved us from writing a Rust NIF. The Elixir ecosystem had the right tool; we just needed to look past "SQLite for everything."

---

## Tone / Style Notes

- Honest about the false starts — don't present the final architecture as obvious from the beginning
- Show the benchmarks that changed our thinking (include numbers)
- Credit the inspirations explicitly
- Keep it practical — other teams building sync engines / event-sourced systems can apply these patterns
- ~1500-2000 words
