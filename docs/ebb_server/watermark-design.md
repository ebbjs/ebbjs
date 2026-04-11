# Watermark APIs — Design Notes

## Status

**Implemented.** Unit tests are passing.

- `WatermarkTracker` module created with full implementation
- Unit tests written and passing (10 tests)
- `WatermarkTracker` added to `Storage.Supervisor` children list
- Documentation references to `SystemCache.get_group_entities` updated to `RelationshipCache.get_group_entities`

---

## Background

Live sync requires knowing which GSNs have been fully committed and flushed to storage. The current `ebb_server` has GSN tracking via `SystemCache` (`:atomics` for the counter, `:persistent_term` for fast reads) but lacks the watermark APIs needed to track committed _ranges_.

---

## Design Decision: Separate `WatermarkTracker` Module

**Decision:** Watermark APIs belong in a new `WatermarkTracker` module, not in `SystemCache`.

**Rationale:**

- `WatermarkTracker` follows the established pattern: `DirtyTracker`, `GroupCache`, `RelationshipCache` are all separate modules with single responsibilities
- Testing watermark in isolation requires no startup of RocksDB, SQLite, or other storage children
- Watermark logic (CAS loops, ETS scanning) is complex — keeping it separate preserves clarity of `SystemCache`'s role as a supervisor/aggregator
- Can be evolved independently without touching `SystemCache`
- TDD workflow is cleaner — tests run fast without infrastructure dependencies

**Updated structure:**

```
Storage.Supervisor
├── RocksDB
├── SQLite
├── SystemCache (supervisor)
│   ├── DirtyTracker
│   ├── GroupCache
│   └── RelationshipCache
├── WatermarkTracker  ← NEW
└── Writer
```

---

## Data Structures

### `:persistent_term {name, :gsn_ref}`

- An `:atomics` reference storing the current committed watermark (the highest GSN known to be fully committed)
- O(1) reads via `persistent_term`
- Key is `{instance_name, :gsn_ref}` where `instance_name` is the registered name (defaults to `EbbServer.Storage.WatermarkTracker`)
- Updated atomically via CAS loop in `advance_watermark/0`

### `:persistent_term {name, :committed_ranges}`

- Stores the ETS table name for the committed ranges table
- Key is `{instance_name, :committed_ranges}`

### `:ets {table_name}`

- Table type: `:ordered_set`
- Key: `{gsn, pid}` tuple (GSN is the ordering key, pid disambiguates same GSN from concurrent writers)
- Value: `true`
- Stores individual committed GSNs awaiting advancement to the watermark
- `advance_watermark/0` scans this table to find the contiguous frontier

---

## Public API

```elixir
# In EbbServer.Storage.WatermarkTracker

@type gsn :: non_neg_integer()

@doc "Returns the current committed watermark (0 if never advanced)"
@spec committed_watermark(GenServer.name()) :: gsn()
def committed_watermark(name \\ EbbServer.Storage.WatermarkTracker)

@doc "Marks a range of GSNs as committed (inserts into ETS, does not advance watermark)"
@spec mark_range_committed(first :: gsn(), last :: gsn(), GenServer.name()) :: :ok
def mark_range_committed(first, last, name \\ EbbServer.Storage.WatermarkTracker)

@doc "Advances the watermark to the highest contiguous GSN in the committed ranges table"
@spec advance_watermark(GenServer.name()) :: gsn()
def advance_watermark(name \\ EbbServer.Storage.WatermarkTracker)
```

### RocksDB dependency

```elixir
# To be implemented in EbbServer.Storage.RocksDB

@doc "Returns an iterator over the key-value store for the given key range"
@spec range_iterator(first_key :: binary(), last_key :: binary(), opts :: keyword()) :: iterator
```

This is needed to seed the watermark on startup (see Startup Behavior below).

---

## `advance_watermark/0` Logic

The function performs a CAS loop:

1. Read current watermark from `:persistent_term :committed_watermark`
2. Scan `:ets :committed_ranges` starting from `watermark + 1`
3. Walk the ordered set, accumulating GSNs until a gap is hit
4. If no advancement possible (next GSN is gap), return current watermark
5. Atomically CAS the atomics ref to the new watermark value
6. If CAS fails (concurrent writer), retry from step 1
7. Return the new watermark

Key invariants:

- The watermark only ever moves forward
- Gaps in the GSN sequence stop advancement (other ranges may still be in-flight)

---

## Startup Behavior

On `WatermarkTracker.init/1`, the watermark is seeded from RocksDB:

```
watermark = max(RocksDB.get_max_gsn(), 0)
:atomics.put(gsn_ref, watermark)
```

This uses the same startup pattern as GSN counter seeding. No separate initialization step required.

---

## Existing Code — No Changes Needed

`EbbServer.Storage.RelationshipCache` already implements:

- `get_entity_group(entity_id)`
- `get_group_entities(group_id)`

The live sync docs previously referenced `SystemCache` for these functions. Those references have been updated to point to `RelationshipCache`.

---

## Test Cases

### Unit tests — `WatermarkTracker`

**`committed_watermark/0`**

- Returns `0` when never advanced
- Returns N after `mark_range_committed/2` + `advance_watermark/0`

**`mark_range_committed/2`**

- Inserts single GSN into ETS
- Inserts multiple GSNs (verifies ETS contents)
- Idempotent: inserting same GSN twice does not corrupt

**`advance_watermark/0`**

- Returns current watermark when ETS is empty
- Advances past contiguous range `[1, 2, 3]` → returns `3`
- Stops at gap: given `[1, 2, 4]`, returns `2`
- Idempotent: calling twice with same range returns same value
- Concurrent: CAS loop handles concurrent calls correctly

### Integration tests — after Writer extension

Once `EbbServer.Storage.Writer` is extended to notify the watermark after a successful commit:

- Verify watermark advances after a write completes
- Verify watermark reflects max GSN in RocksDB after restart

---

## Out of Scope

- Range eviction or compaction of the ETS table (handled separately if needed)
- Cross-node watermark coordination (single-node only)
- Exposing watermark to clients (future concern)
