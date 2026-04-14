# SQLite Throughput Experiment: Results

> **Deprecated:** These results informed the decision to move away from SQLite-only storage. See `storage-architecture-v2.md` for the current architecture. Key finding carried forward: index maintenance on the action/update tables is the dominant write bottleneck (~62% throughput improvement when indexes are dropped), which motivated moving the Action log to RocksDB's LSM-tree.

## Executive Summary

SQLite in WAL mode can sustain **~9.5k Actions/sec** with minimal indexes and full durability on Apple Silicon — comfortably above the 1-3k MVP estimate, but well below the aspirational 100k target. The throughput bottleneck is **index maintenance on the log tables**, not I/O or WAL checkpointing. The ATTACH split architecture provides no benefit. The simplified SQLite-only architecture is viable for the MVP, with a clear path to scale past 10k via deferred indexing.

---

## Test Environment

- **Hardware:** Apple Silicon (M-series), NVMe SSD
- **Elixir:** 1.19.5 on OTP 28
- **SQLite:** via exqlite 0.35.0 (precompiled NIF)
- **Bun:** 1.2.19

---

## Methodology

All benchmarks use:

- **Pre-generated data pools** stored as tuples (O(1) access) — data generation overhead (~7ms/batch, 13% of combined time) is excluded from timing
- **Pre-built SQL strings** — SQL string construction overhead (~6ms/batch) is excluded from timing
- **Multi-row VALUES INSERTs** — a single `INSERT INTO ... VALUES (...), (...), ...` per table per batch, reducing NIF boundary crossings from 9,000 to 4 per batch of 1,000 Actions
- **Foreign keys OFF** — removed from the write hot path

Each batch of 1,000 Actions generates:

- 1,000 rows into `actions` (5 columns, PK + indexes)
- 2,000 rows into `updates` (6 columns, PK + indexes)
- = 3,000 total rows per batch

Throughput numbers are **cumulative** (total Actions / total elapsed), so they include the ramp-up period when the DB is small and fast. Sustained steady-state throughput at scale is lower than the reported average.

---

## Finding 1: NIF Boundary Crossings Are a 2x Tax

The original approach used `bind/step/reset` per row — 3 NIF calls per SQL statement, 9,000 NIF crossings per batch. Switching to multi-row VALUES reduces this to 4 NIF calls per batch (BEGIN + 2 INSERTs + COMMIT).

| Strategy                            | Throughput (in-memory) | NIF calls/batch |
| ----------------------------------- | ---------------------- | --------------- |
| bind/step/reset per row             | 21,700/sec             | 9,000           |
| Multi-row VALUES (single INSERT)    | **44,100/sec**         | 4               |
| Chunked multi-row (100 rows/INSERT) | 29,500/sec             | 64              |
| exec multi-statement string         | 39,000/sec             | 4               |

**Implication:** Any Elixir NIF-based SQLite integration should batch SQL into as few NIF calls as possible. The bind/step/reset pattern is convenient but halves throughput. In production, the Writer GenServer should build multi-row VALUES strings from each batch before executing.

---

## Finding 2: Data Generation Is Not the Bottleneck

Per batch of 1,000 Actions:

| Component                                    | Time  | % of combined |
| -------------------------------------------- | ----- | ------------- |
| Data generation (Elixir maps, JSON, nanoids) | ~7ms  | 13%           |
| SQL string building (iodata → binary)        | ~6ms  | 11%           |
| SQLite INSERT statements                     | ~26ms | 46%           |
| COMMIT (WAL flush)                           | ~24ms | 42%           |

Pre-generating data gives a ~15% throughput improvement (17.5k → 20k on the diagnostic, less on sustained runs). Worth doing in benchmarks for accuracy, but not the lever that changes the architecture decision.

---

## Finding 3: Indexes Are the Dominant Bottleneck

Six configurations tested over 15 seconds each, all using multi-row VALUES with pre-built SQL:

| Config                                           | Sustained Actions/sec | p50 batch latency | vs Baseline |
| ------------------------------------------------ | --------------------- | ----------------- | ----------- |
| 1. Baseline (all 7 indexes, auto checkpoint)     | 5,838                 | 186ms             | —           |
| 2. Minimal indexes (PK + GSN only)               | **9,466**             | 114ms             | **+62%**    |
| 3. ATTACH split (log.db + state.db, all indexes) | 9,460                 | 114ms             | +62%        |
| 4. ATTACH + minimal log indexes                  | 9,489                 | 115ms             | +63%        |
| 5. No auto checkpoint (wal_autocheckpoint=0)     | 6,816                 | 161ms             | +17%        |
| 6. Ceiling (MEMORY journal, synchronous=OFF)     | **15,062**            | 75ms              | +158%       |

### Analysis

**Index maintenance is the primary bottleneck.** Dropping 5 secondary indexes from the log tables (keeping only PK + GSN) gives a 62% throughput improvement. The full schema has:

- `actions`: PK + `idx_actions_gsn` + `idx_actions_actor` (3 B-trees)
- `updates`: PK + `idx_updates_action` + `idx_updates_subject` + `idx_updates_subject_type` (4 B-trees)

Every INSERT into `updates` must update 4 separate B-trees. Dropping to PK-only reduces this to 1 B-tree per table, and the speedup is proportional.

**ATTACH split provides zero benefit.** Configs 2, 3, and 4 are statistically identical (~9.5k). Splitting log and state into separate files doesn't help because:

- ATTACH databases share the same connection and page cache
- The bottleneck is B-tree maintenance CPU, not file I/O contention
- Both databases still fsync through the same WAL mechanism

**WAL checkpointing is secondary.** Disabling auto-checkpoint gives +17%. Worth tuning (larger intervals, background timer) but not the primary lever.

**The absolute SQLite ceiling is ~15k sustained.** With all durability removed (MEMORY journal, synchronous=OFF, no fsync ever), throughput caps at 15k. This is the raw CPU cost of SQLite's B-tree engine parsing and inserting 3,000 rows per batch. The gap from 9.5k (minimal indexes, full durability) to 15k (no durability) represents the actual I/O cost.

---

## Finding 4: Throughput Degrades as the DB Grows

All configurations show the same pattern: high throughput on the first few batches (100k+ Actions/sec when the DB is nearly empty), steadily declining as rows accumulate. This is fundamental to B-tree storage:

| Rows in DB | Approximate throughput (baseline) |
| ---------- | --------------------------------- |
| 0-3k       | 100k+ Actions/sec                 |
| 10k        | 35k Actions/sec                   |
| 30k        | 14k Actions/sec                   |
| 60k        | 8k Actions/sec                    |
| 90k        | 6k Actions/sec                    |

The degradation curve flattens — by 90k rows the per-batch cost stabilizes as the B-tree depth settles. The "sustained" numbers (87k rows at 15s) are representative of steady-state behavior for a DB with tens of thousands of entities.

---

## Finding 5: Peak Throughput Confirms the Hypothesis (Conditionally)

The experiment's core hypothesis was: _SQLite can sustain 100k+ Actions/sec with batched transactions._

**Confirmed for small/warm DBs.** The first batch consistently hits 100-160k Actions/sec across all configs. SQLite's raw engine is fast enough when the working set fits in the page cache.

**Not confirmed for sustained load at scale.** By the time the DB holds a realistic number of rows (tens of thousands of entities), throughput is 6-10k. The 100k target assumed the batch amortization would dominate, but index maintenance grows with O(log N) per insert per index, and with 7 indexes that adds up.

---

## Architectural Implications

### What this means for the Ebb MVP

The simplified SQLite-only architecture from the experiment proposal is **viable for the MVP**:

| Metric                              | Target (proposal)     | Measured                | Status                                       |
| ----------------------------------- | --------------------- | ----------------------- | -------------------------------------------- |
| MVP write throughput                | 1-3k Actions/sec      | 5.8-9.5k                | Well exceeded                                |
| Synchronous materialization viable? | Yes if >10k           | ~3-5k (from Test 2)     | Marginal — see below                         |
| Multi-process reads                 | <1ms p99 point lookup | Not yet tested at scale | Likely passes (WAL readers are non-blocking) |

The **9.5k Actions/sec** with minimal indexes is 3-10x the MVP target. Even the baseline of 5.8k with all indexes is sufficient.

### What to defer

The experiment proposal listed several things that "go away" if SQLite can sustain 100k:

- Custom binary Action log → **Still goes away for MVP.** SQLite at 6-10k is enough.
- ETS indexes → **Still goes away for MVP.** SQLite indexes handle the read patterns.
- Bun Materializer process → **Partially.** Synchronous materialization adds significant overhead (Test 2 showed ~3k with full LWW merge). For MVP volumes this is fine. At scale, async materialization may be needed.
- ETS system entity cache → **Can go away if permission queries are fast enough.** Test 5 (not yet run) will confirm this.

### Recommendations for the write path

1. **Drop secondary log indexes from the write path.** Keep only PK + GSN on `actions` and PK on `updates`. This is the single biggest optimization: +62% throughput for free. The `idx_actions_actor`, `idx_updates_subject`, and `idx_updates_subject_type` indexes are only needed for catch-up query filtering — they can be built lazily or on a read connection.

2. **Use multi-row VALUES INSERTs.** Build the batch into 2 SQL strings (one per table) and execute each in a single NIF call. This is 2x faster than per-row bind/step/reset.

3. **Tune WAL checkpoint schedule.** Set `wal_autocheckpoint = 0` and run `PRAGMA wal_checkpoint(PASSIVE)` on a background timer (every 5-10 seconds). This prevents random checkpoint-induced latency spikes during the write batch.

4. **Don't bother with ATTACH split.** It adds complexity with no throughput benefit. Keep everything in a single SQLite file.

5. **Disable foreign keys on the write path.** The Writer GenServer generates valid data; FK checks are redundant overhead.

### When to revisit

The SQLite-only approach should be reconsidered when:

- Sustained write throughput needs to exceed **~10k Actions/sec** per group
- Synchronous materialization latency (LWW merge inside the transaction) becomes unacceptable
- The action log grows past the point where a single SQLite file is practical (~10-50GB)

At that point, the fallback paths from the original storage-architecture-proposal.md apply: custom append-only action log for writes, SQLite retained for materialized reads only.

---

## Test 2: LWW Materialization (Preliminary)

Test 2 adds per-entity materialization inside the transaction: SELECT entity → LWW merge in Elixir → UPSERT entity. This is 7 SQL operations + 2 Elixir merges per Action.

Preliminary results (before multi-row VALUES optimization, 5s runs):

| Scenario            | Actions/sec |
| ------------------- | ----------- |
| Cold (100% creates) | ~4,000      |
| Hot (100% patches)  | ~2,800      |
| Mixed (20/80)       | ~2,900      |

The hot path is slower because each entity PATCH requires a SELECT (cache miss on first access), JSON decode, field-level HLC comparison, JSON encode, and UPSERT. The cold path is faster because new entities skip the SELECT+merge and go straight to INSERT.

**Note:** These numbers predate the multi-row VALUES optimization. The action/update INSERTs can be batched, but the entity SELECT/UPSERT cycle is inherently per-entity (each depends on the prior read). With optimized action/update inserts, the materialization overhead becomes the dominant cost on the hot path.

The experiment's success criterion was ≥50k Actions/sec for Test 2. At ~3-5k, synchronous materialization is viable for the MVP (~1-3k target) but not for the scale target. The hybrid approach — materialize system entities (groups, memberships, relationships) synchronously for permissions, defer user entities to async — is likely the right architecture at scale.

---

## Tests Not Yet Run

- **Test 3: Concurrent multi-process reads** — Bun reader script is implemented but not yet tested against the Elixir writer at sustained throughput.
- **Test 4: Yjs materialization via y_ex** — Requires y_ex dependency. Deferred.
- **Test 5: Permission query performance at scale** — Requires pre-populating 100k entities with realistic group/membership/relationship data. High value for validating the "SQL JOINs for permissions" approach.

---

## Benchmark Code

All benchmarks are in `experiment/sqlite_bench/`:

```
experiment/
├── sqlite_bench/
│   ├── lib/sqlite_bench/
│   │   ├── schema.ex          # DDL from storage-architecture-proposal.md
│   │   ├── data_gen.ex        # Realistic Action/Update/Entity generators
│   │   ├── hlc.ex             # Monotonic HLC for test data
│   │   ├── lww.ex             # Field-level Last-Writer-Wins merge
│   │   ├── sql_builder.ex     # Multi-row VALUES SQL string builder
│   │   ├── stats.ex           # Latency tracking, percentiles
│   │   └── reporter.ex        # Console + JSON output
│   ├── bench/
│   │   ├── test1_raw_throughput.exs        # Test 1: raw batched writes
│   │   ├── test2_lww_materialization.exs   # Test 2: writes + LWW merge
│   │   ├── test3_write_load.exs            # Test 3: writer side
│   │   ├── diagnose_overhead.exs           # Data gen vs SQLite breakdown
│   │   ├── optimize_nif.exs               # NIF crossing strategies
│   │   └── optimize_architecture.exs       # 6-config architecture comparison
│   └── test/
│       └── sqlite_bench_test.exs           # 8 unit tests
├── bun_reader/
│   └── test3_concurrent_reads.ts           # Test 3: Bun reader side
```

Run with:

```bash
cd experiment/sqlite_bench

# Quick validation (10s)
mix run bench/test1_raw_throughput.exs --duration 10 --batch-sizes 1000

# Architecture comparison (15s per config, ~2 min total)
mix run bench/optimize_architecture.exs --duration 15

# Full Test 1 (60s per config, ~8 min total)
mix run bench/test1_raw_throughput.exs

# Overhead diagnostic
mix run bench/diagnose_overhead.exs
```
