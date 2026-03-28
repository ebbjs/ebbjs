# SQLite Throughput Experiment: Synchronous Materialization

> **Deprecated:** This experiment and its results (`sqlite-throughput-results.md`) informed the decision to move away from SQLite-only storage. The v2 architecture (`storage-architecture-v2.md`) uses RocksDB for the Action log and SQLite only as a materialized entity cache. The benchmark findings — particularly that index maintenance is the dominant write bottleneck — were a key input to the v2 design.

## Hypothesis

SQLite in WAL mode, with batched transactions and `synchronous=NORMAL`, can sustain **100k+ Actions/sec** with **synchronous LWW materialization** — eliminating the need for a custom storage engine, async Bun Materializer, and ETS system entity cache.

If true, this dramatically simplifies the Ebb server architecture:

- SQLite becomes the single storage system (Action log + materialized entities + indexes)
- Elixir writes Actions AND materializes entities in the same transaction
- Bun reads directly from the same SQLite file via `bun:sqlite` (WAL multi-process)
- No async materialization lag
- No ETS cache to maintain
- No Bun Materializer process
- Permission queries are SQL JOINs (evolvable, not hard-coded indexes)

## Why This Might Work

The "SQLite caps at 3k writes/sec" number comes from per-statement autocommit with `synchronous=FULL`. But:

- `synchronous=NORMAL` fsyncs at checkpoint, not on every commit
- Batched transactions (1000 Actions per transaction) amortize commit overhead
- WAL mode means commits are sequential appends to the WAL file
- All reads within the transaction hit the page cache (microseconds)
- The existing Writer GenServer already batches in 10ms windows

## What We Need to Prove

### Test 1: Raw Batched Write Throughput

**Question:** How many INSERT statements can SQLite sustain per second in batched transactions with `synchronous=NORMAL`?

**Setup:**

- SQLite in WAL mode, `synchronous=NORMAL`, `cache_size=-64000` (64MB)
- Use the exact schema from `storage-architecture-proposal.md` (actions, updates, entities tables with all indexes and generated columns)
- Elixir process using `exqlite`

**Workload:**

- Generate realistic Actions: 1 Action with 2 Updates each (one entity mutation + one relationship)
- Batch sizes: 100, 500, 1000, 2000 Actions per transaction
- Each batch = 1 BEGIN + N Action INSERTs + 2N Update INSERTs + COMMIT
- Run for 60 seconds sustained at each batch size

**Durability modes (test both):**

- **Mode A: `synchronous=NORMAL`, no explicit fsync** — commit returns when data is in OS page cache. Survives application crash. Does NOT guarantee durability on power loss.
- **Mode B: `synchronous=NORMAL` + explicit fsync after each batch commit** — call `os.fsync(fd)` or `PRAGMA wal_checkpoint(PASSIVE)` after COMMIT, before notifying fan-out. Guarantees durability on power loss. This is the mode we'd use in production (only sync Actions to clients after fsync confirms durability).

**Measure:**

- Actions committed per second (sustained, not burst) — for both modes
- Transaction commit latency (p50, p95, p99) — for both modes
- fsync latency (Mode B only)
- WAL file growth rate
- CPU usage

**Success criteria:**

- Mode A: ≥100k Actions/sec at batch size 1000 (establishes ceiling)
- Mode B: ≥50k Actions/sec at batch size 1000 (production-realistic target)

---

### Test 2: Batched Writes + Synchronous LWW Materialization

**Question:** What's the throughput when we add LWW materialization inside the same transaction?

**Setup:** Same as Test 1, plus:

- For each Update in the batch, read current entity state from `entities` table
- Apply field-level LWW merge in Elixir (compare HLC timestamps per field)
- UPSERT the merged entity back to `entities` table
- All within the same transaction

**Workload:**

- Same Action generation as Test 1
- Two scenarios:
  - **Cold entities:** Each Action creates a new entity (INSERT, no prior state to read)
  - **Hot entities:** Each Action patches an existing entity (SELECT + LWW merge + UPDATE)
- Mix: 20% creates, 80% patches (realistic steady-state)

**Per-Action operations (hot path):**

```
1x INSERT INTO actions
2x INSERT INTO updates
2x SELECT FROM entities WHERE id = ?     (read current state)
2x LWW merge in Elixir                   (compare HLC per field)
2x INSERT OR REPLACE INTO entities        (write merged state)
─────────────────────────────────────────
= 7 SQL operations + 2 Elixir merges per Action
```

**Measure:**

- Actions committed per second (sustained)
- Transaction commit latency (p50, p95, p99)
- Time spent in LWW merge vs SQLite operations (breakdown)
- WAL file growth rate

**Success criteria:** ≥50k Actions/sec (with materialization overhead, 50% of raw throughput is acceptable — still 5x the original target of 10-20k)

---

### Test 3: Concurrent Reads During Writes (Multi-Process)

**Question:** Can a separate Bun process read from SQLite with acceptable latency while Elixir is writing batches?

**Setup:**

- Elixir process writing batched transactions (from Test 2)
- Separate Bun process reading via `bun:sqlite` in read-only mode
- Same SQLite file, WAL mode

**Workload (Bun reader):**

- `ctx.get(id)`: Point lookup by entity ID — `SELECT * FROM entities WHERE id = ?`
- `ctx.query(type, filter)`: Type scan with filter — `SELECT * FROM entities WHERE type = ? AND json_extract(data, '$.field') = ?`
- Permission-scoped query: `SELECT e.* FROM entities e JOIN entities gm ON gm.type = 'groupMember' AND gm.actor_id = ? AND gm.deleted_hlc IS NULL JOIN entities r ON r.type = 'relationship' AND r.source_id = e.id AND r.target_id = gm.group_id AND r.deleted_hlc IS NULL WHERE e.type = ? AND e.deleted_hlc IS NULL`
- Run reads continuously while Elixir writes at peak throughput

**Measure:**

- Read latency (p50, p95, p99) for each query type
- Read latency with and without concurrent writes (isolation)
- How quickly Bun sees committed writes (staleness)
- Whether reads ever block or timeout

**Success criteria:**

- Point lookup: <1ms p99
- Type query: <5ms p99
- Permission-scoped query: <10ms p99
- Bun sees writes within <50ms of Elixir commit
- No read failures or timeouts during sustained writes

---

### Test 4: Yjs Materialization via y_ex

**Question:** Can y_ex (Elixir Yjs NIF) merge Yjs updates fast enough to not bottleneck the write path?

**Setup:**

- Elixir process with y_ex dependency
- Simulate CRDT entity updates within the batched transaction

**Workload:**

- Generate realistic Yjs update blobs (text insertions, ~100 bytes each)
- For each CRDT Update in the batch:
  1. Read current Yjs state blob from `entities` table
  2. Create Y.Doc via y_ex, apply stored state
  3. Apply incoming update blob
  4. Encode merged state via `encodeStateAsUpdate`
  5. Write merged blob back to `entities` table

**Measure:**

- Time per Yjs merge operation (y_ex NIF call)
- Impact on overall batch throughput vs JSON-only batches
- Memory usage of y_ex Doc objects during batch processing

**Success criteria:**

- Yjs merge: <100μs per operation
- Overall throughput degradation: <30% vs JSON-only batches

---

### Test 5: Permission Query Performance at Scale

**Question:** Can SQL JOINs for permission-scoped queries stay fast at realistic data volumes?

**Setup:**

- Pre-populate SQLite with realistic data:
  - 100,000 entities across 500 groups
  - 10,000 actors
  - 50,000 group memberships (actors belong to ~5 groups each)
  - 200,000 relationships (entities belong to groups)

**Workload:**

- Permission-scoped queries for actors with varying group membership counts:
  - Actor in 1 group (~200 entities visible)
  - Actor in 5 groups (~1,000 entities visible)
  - Actor in 20 groups (~4,000 entities visible)
- Query patterns:
  - `ctx.get(id)` with permission check
  - `ctx.query(type)` with permission filter (return all of type visible to actor)
  - `ctx.query(type, { field: value })` with permission filter + field filter

**Measure:**

- Query latency for each pattern at each group membership level
- Query plan (EXPLAIN QUERY PLAN) — verify indexes are used
- Impact of generated column indexes vs json_extract in WHERE clauses

**Success criteria:**

- `ctx.get(id)`: <1ms regardless of group count
- `ctx.query(type)`: <10ms for actor in 5 groups
- `ctx.query(type, filter)`: <10ms for actor in 5 groups

---

## Test Environment

- **Hardware:** Match target deployment (e.g., 4-core, 8GB RAM cloud VM, NVMe SSD)
- **Also test on:** Apple Silicon (development machine) for comparison
- **SQLite version:** Latest stable (3.51.x)
- **Elixir:** Latest stable, using `exqlite` NIF
- **Bun:** Latest stable, using `bun:sqlite`

## SQLite Configuration

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA cache_size = -64000;        -- 64MB page cache
PRAGMA busy_timeout = 5000;        -- 5s busy wait (for multi-process)
PRAGMA wal_autocheckpoint = 1000;  -- checkpoint every 1000 pages
PRAGMA mmap_size = 268435456;      -- 256MB mmap (for read performance)
```

## Schema Under Test

Use the exact schema from `storage-architecture-proposal.md`:

- `actions` table with GSN, HLC, actor_id indexes
- `updates` table with action_id, subject_id, subject_type indexes
- `entities` table with generated columns for source_id, target_id, actor_id, group_id, permissions
- All indexes as specified (type, source, target, actor_group)
- `snapshots` table

## Data Generation

**Realistic Action shape:**

```json
{
  "id": "act_abc123",
  "actor_id": "a_user456",
  "hlc": 1711234567890001,
  "updates": [
    {
      "id": "upd_def789",
      "subject_id": "todo_ghi012",
      "subject_type": "todo",
      "method": "PATCH",
      "data": "{\"title\": \"Updated title\", \"completed\": true}"
    },
    {
      "id": "upd_jkl345",
      "subject_id": "rel_mno678",
      "subject_type": "relationship",
      "method": "PUT",
      "data": "{\"source_id\": \"todo_ghi012\", \"target_id\": \"grp_pqr901\", \"type\": \"todo\", \"field\": \"list\"}"
    }
  ]
}
```

**Entity state shape (for LWW merge testing):**

```json
{
  "fields": {
    "title": { "value": "My Todo", "hlc": 1711234567890000 },
    "completed": { "value": false, "hlc": 1711234567890000 },
    "description": { "value": "Some text", "hlc": 1711234567889000 }
  }
}
```

## What Each Result Means

| Result                      | Implication                                                              |
| --------------------------- | ------------------------------------------------------------------------ |
| Test 1 ≥ 100k               | Raw SQLite throughput is sufficient                                      |
| Test 2 ≥ 50k                | Synchronous materialization is viable                                    |
| Test 2 < 20k                | Materialization is too expensive inline; need async path or optimization |
| Test 3 passes               | Multi-process architecture works; Bun reads are fast during writes       |
| Test 3 fails (high latency) | May need Unix Domain Socket proxy instead of direct file access          |
| Test 4 passes               | y_ex is fast enough for inline Yjs merging                               |
| Test 4 fails                | Yjs entities need a separate async materialization path                  |
| Test 5 passes               | SQL JOINs for permissions are viable at scale                            |
| Test 5 fails                | Need denormalized permission indexes or caching layer                    |

## If the Experiment Succeeds

The architecture simplifies to:

```
┌─────────────────────────────────────────────────────────────────┐
│                    Elixir Sync/Storage Server                    │
│                                                                 │
│  Sync Protocol · Auth · Permission Checks · Fan-out · Presence  │
│                                                                 │
│  Writer GenServer:                                              │
│    Batch Actions (10ms / 1000)                                  │
│    → BEGIN transaction                                          │
│    → INSERT actions + updates                                   │
│    → LWW merge (Elixir) / Yjs merge (y_ex)                     │
│    → UPSERT entities                                            │
│    → COMMIT                                                     │
│    → Notify fan-out                                             │
│                                                                 │
│  Permission checks: SQL queries against entities table          │
│  (no separate ETS cache needed)                                 │
│                                                                 │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                    SQLite (WAL mode)
                    Single file, multi-process
                           │
┌──────────────────────────┴──────────────────────────────────────┐
│                    Bun Application Server                        │
│                                                                 │
│  ctx.get() / ctx.query()                                        │
│    → bun:sqlite (read-only, same file)                          │
│    → Permission-scoped SQL queries                              │
│    → Zero materialization lag                                   │
│                                                                 │
│  ctx.create() / ctx.update() / ctx.delete()                     │
│    → POST /sync/actions to Elixir (localhost)                   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**What goes away vs current proposal:**

- Custom binary Action log format → SQLite table
- ETS indexes (entity_index, gsn_index, action_id_index) → SQLite indexes
- ETS system entity cache → SQLite queries
- Bun Materializer process → Elixir materializes inline
- SSE stream to Materializer → gone
- Checkpoint Manager → SQLite WAL checkpoints
- Cold-tier SQLite index → not needed (SQLite IS the index)
- CRC32 crash recovery → SQLite WAL recovery

**What stays the same:**

- Writer GenServer batching model (10ms / 1000 Actions)
- Sync protocol (handshake, catch-up, live SSE)
- Fan-out architecture (process per Group)
- Permission model (group membership based)
- Elixir owns writes, Bun reads directly

## If the Experiment Fails

Specific failure modes and fallback paths:

1. **Raw throughput too low (Test 1 fails):** Revisit custom Action log for writes, keep SQLite for materialized reads only. This is the current proposal's architecture.

2. **Materialization too expensive (Test 2 fails):** Consider materializing only system entities inline (for permissions), keep user entities async. Hybrid approach.

3. **Multi-process reads too slow (Test 3 fails):** Add a thin Unix Domain Socket proxy in the Elixir process. Bun sends SQL queries over UDS, Elixir executes them. Adds ~20-50μs per query.

4. **Yjs too slow inline (Test 4 fails):** Materialize CRDT entities asynchronously (small subset of entities). JSON entities still materialize inline.

5. **Permission queries too slow (Test 5 fails):** Add a lightweight in-memory cache for group memberships only (much simpler than the full ETS system entity cache). Or denormalize permission data into the entities table.

## Next Steps

- [ ] Set up Elixir test project with exqlite + y_ex
- [ ] Implement data generators (Actions, Updates, Entities)
- [ ] Run Test 1 (raw throughput baseline)
- [ ] Run Test 2 (materialization overhead)
- [ ] Run Test 3 (multi-process reads)
- [ ] Run Test 4 (Yjs via y_ex)
- [ ] Run Test 5 (permission queries at scale)
- [ ] Document results and decide on architecture
