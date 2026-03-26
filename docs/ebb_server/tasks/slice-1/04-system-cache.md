# Phase 4: System Cache

> **Slice:** [01 — Single Action Write + Read-Back](../../slices/01-single-action-write-read.md)
> **Depends on:** [Phase 1 — Project Scaffold](01-project-scaffold.md)
> **Produces:** `EbbServer.Storage.SystemCache` GenServer with dirty set and GSN counter, plus unit tests

---

## Task 12. ETS tables and atomics

**Files:** `ebb_server/lib/ebb_server/storage/system_cache.ex` (create)

Create `EbbServer.Storage.SystemCache` as a GenServer.

**`init/1`:**
- Create ETS table: `:ets.new(:ebb_dirty_set, [:set, :public, :named_table])`
- Create atomics: `gsn_counter = :atomics.new(1, signed: false)`
- Store in `:persistent_term`: `:persistent_term.put(:ebb_gsn_counter, gsn_counter)`
- Accept optional `:initial_gsn` in opts (for recovery — will be read from RocksDB in Phase 10). Default to 0.
- If `initial_gsn > 0`, set the atomics: `:atomics.put(gsn_counter, 1, initial_gsn)`
- Return `{:ok, %{}}`

**`terminate/2`:**
- Delete ETS table (happens automatically when owner dies, but be explicit)
- Erase `:persistent_term` keys

**Public functions (module-level, no GenServer call — ETS and atomics are lock-free):**

- `claim_gsn_range(count)`:
  - `counter = :persistent_term.get(:ebb_gsn_counter)`
  - `gsn_end = :atomics.add_get(counter, 1, count)`
  - `gsn_start = gsn_end - count + 1`
  - Return `{gsn_start, gsn_end}`

- `mark_dirty_batch(entity_ids)`:
  - For each id: `:ets.insert(:ebb_dirty_set, {id, true})`
  - Return `:ok`

- `is_dirty?(entity_id)`:
  - `:ets.lookup(:ebb_dirty_set, entity_id) != []`

- `clear_dirty(entity_id)`:
  - `:ets.delete(:ebb_dirty_set, entity_id)`
  - Return `true`

**`start_link/1`:**
- `GenServer.start_link(__MODULE__, opts, name: __MODULE__)`

---

## Task 13. Unit tests

**Files:** `ebb_server/test/ebb_server/storage/system_cache_test.exs` (create)

Since SystemCache uses named ETS tables, tests must run sequentially. Use `setup` to start and `on_exit` to stop the GenServer.

**Test cases:**

1. **GSN claiming:**
   - Start SystemCache, `claim_gsn_range(1)` → `{1, 1}`
   - `claim_gsn_range(3)` → `{2, 4}`
   - `claim_gsn_range(1)` → `{5, 5}`
   - Verify monotonically increasing, gap-free

2. **GSN claiming with initial_gsn:**
   - Start SystemCache with `initial_gsn: 100`
   - `claim_gsn_range(1)` → `{101, 101}`

3. **Dirty set operations:**
   - `is_dirty?("todo_abc")` → `false`
   - `mark_dirty_batch(["todo_abc", "todo_xyz"])`
   - `is_dirty?("todo_abc")` → `true`
   - `is_dirty?("todo_xyz")` → `true`
   - `clear_dirty("todo_abc")`
   - `is_dirty?("todo_abc")` → `false`
   - `is_dirty?("todo_xyz")` → `true` (not affected)

4. **Concurrent GSN claiming (basic):**
   - Spawn 10 tasks, each claiming `claim_gsn_range(1)`
   - Collect all results, verify all 10 GSNs are unique and cover 1..10

---

## Verification

```bash
cd ebb_server && mix test test/ebb_server/storage/system_cache_test.exs
```

All 4 test cases pass. GSN counter is monotonic and gap-free, dirty set tracks entities correctly.
