# Phase 10: Recovery and Cleanup

> **Slice:** [01 — Single Action Write + Read-Back](../../slices/01-single-action-write-read.md)
> **Depends on:** [Phase 9 — Integration Tests](09-integration.md)
> **Produces:** GSN recovery on restart, `get_max_gsn/0`, and a final code quality pass

---

## Task 23. SystemCache GSN recovery on restart

**Files:** `ebb_server/lib/ebb_server/storage/system_cache.ex` (modify)

When the application restarts, the GSN counter in `:atomics` resets to 0. We need to recover the max GSN from RocksDB.

**Approach — Option A (simplest):** Make SystemCache's `init/1` call `RocksDB.get_max_gsn()` directly. This works because RocksDB starts before SystemCache in the `rest_for_one` supervisor.

**Update `SystemCache.init/1`:**
```elixir
def init(opts) do
  # Create ETS and atomics as before...

  # Recover GSN from RocksDB (guaranteed to be running due to rest_for_one ordering)
  initial_gsn = Keyword.get_lazy(opts, :initial_gsn, fn ->
    EbbServer.Storage.RocksDB.get_max_gsn()
  end)

  if initial_gsn > 0 do
    :atomics.put(gsn_counter, 1, initial_gsn)
  end

  {:ok, %{}}
end
```

The `Keyword.get_lazy/3` allows tests to still pass an explicit `:initial_gsn` to skip the RocksDB call.

---

## Task 24. RocksDB.get_max_gsn/0

**Files:** `ebb_server/lib/ebb_server/storage/rocks_db.ex` (modify)

Add a function to find the highest GSN in `cf_actions`:

**`get_max_gsn()`:**
- Open iterator: `{:ok, iter} = :rocksdb.iterator(db_ref(), cf_actions(), [])`
- Seek to last: `result = :rocksdb.iterator_move(iter, :last)`
- If `{:ok, key, _value}` → `gsn = decode_gsn_key(key)`, close iterator, return `gsn`
- If `{:error, :invalid_iterator}` → close iterator, return `0`

Add a test to `rocks_db_test.exs`:
- Empty database: `get_max_gsn()` → 0
- Write 3 entries with GSNs 1, 2, 3: `get_max_gsn()` → 3

---

## Task 25. Final cleanup and verification checklist

**Files:** All files created in tasks 1-24

Review all files for:

1. **Consistent string keys:** All maps stored in RocksDB use string keys, never atoms. Verify Writer builds maps with string keys. Verify EntityStore reads with `[:safe]` flag.

2. **Error handling:**
   - Writer: if `write_batch` fails, the GenServer should crash (let supervisor restart). Don't silently swallow errors.
   - EntityStore: if materialization fails, return `{:error, reason}` and do NOT clear the dirty bit.
   - HTTP Router: catch errors from Writer/EntityStore and return appropriate HTTP status codes (503 for storage errors, 500 for unexpected errors).

3. **Resource cleanup in tests:** Every test that starts a GenServer must stop it in `on_exit`. Every test that creates temp directories must clean them up.

4. **Module documentation:** Add `@moduledoc` to each module explaining its role in the system.

---

## Final Verification

Run the complete test suite:

```bash
cd ebb_server && mix test
```

All tests pass:
- `RocksDBTest` — key encoding, write/read, prefix iterator, durability, get_max_gsn
- `SQLiteTest` — DDL, upsert/get, generated columns
- `SystemCacheTest` — GSN claiming, dirty set operations
- `WriterTest` — action write, GSN assignment, column family population, ETF round-trip
- `EntityStoreTest` — materialization, caching, dirty bit, LWW merge
- `IntegrationTest` — full HTTP flow

### Manual Verification

1. Start the server: `cd ebb_server && mix run --no-halt`
2. POST an action via curl:
   ```bash
   # Create a MessagePack payload (or use a script)
   curl -X POST http://localhost:4000/sync/actions \
     -H "Content-Type: application/msgpack" \
     --data-binary @action.msgpack
   # Expect: 200 {"rejected": []}
   ```
3. GET the entity:
   ```bash
   curl http://localhost:4000/entities/todo_xyz789?actor_id=a_test
   # Expect: 200 with JSON entity containing correct field values
   ```
4. Restart the server, GET again (re-materializes from RocksDB):
   ```bash
   curl http://localhost:4000/entities/todo_xyz789?actor_id=a_test
   # Expect: same response (data survived restart)
   ```

### Key Invariants

- GSN 1 is assigned to the first action
- ETF encoding/decoding round-trips without data loss
- The dirty bit is set after write, cleared after materialization
- SQLite contains the entity after first read
- Second read does not trigger re-materialization (dirty bit is false)
- Data survives process restart (RocksDB durability)
- GSN counter recovers to the correct value on restart (no duplicate GSNs)
