# Phase 2: RocksDB Store

> **Slice:** [01 — Single Action Write + Read-Back](../../slices/01-single-action-write-read.md)
> **Depends on:** [Phase 1 — Project Scaffold](01-project-scaffold.md)
> **Produces:** `EbbServer.Storage.RocksDB` GenServer with full read/write API and unit tests

---

## Task 5. GenServer lifecycle and persistent_term storage

**Files:** `ebb_server/lib/ebb_server/storage/rocks_db.ex` (create)

Create `EbbServer.Storage.RocksDB` as a GenServer.

**`init/1`:**
- Accept `opts` keyword list with `:data_dir` key
- Build path: `Path.join(data_dir, "rocksdb")`
- Ensure directory exists: `File.mkdir_p!/1`
- Define column family descriptors (charlist names for the Erlang NIF): `[{~c"default", []}, {~c"cf_actions", []}, {~c"cf_updates", []}, {~c"cf_entity_actions", []}, {~c"cf_type_entities", []}, {~c"cf_action_dedup", []}]`
- Define db_opts: `[create_if_missing: true, create_missing_column_families: true, max_background_jobs: 4, enable_pipelined_write: true]`
- Call `:rocksdb.open(charlist_path, db_opts, cf_descriptors)` — note the path must be a charlist (`String.to_charlist/1`), and CF names must also be charlists
- Pattern match result: `{:ok, db_ref, [_default_cf, cf_actions, cf_updates, cf_entity_actions, cf_type_entities, cf_action_dedup]}`
- Extract `name` from opts (default `__MODULE__`)
- Store all references in `:persistent_term` using tuple keys namespaced by `name`:
  - `{:ebb_rocksdb_db, name}` → `db_ref`
  - `{:ebb_cf_actions, name}` → `cf_actions`
  - `{:ebb_cf_updates, name}` → `cf_updates`
  - `{:ebb_cf_entity_actions, name}` → `cf_entity_actions`
  - `{:ebb_cf_type_entities, name}` → `cf_type_entities`
  - `{:ebb_cf_action_dedup, name}` → `cf_action_dedup`
- Return `{:ok, %{db_ref: db_ref, name: name}}`

**`terminate/2`:**
- Erase all `:persistent_term` tuple keys for `state.name`
- Call `:rocksdb.close(db_ref)`

**Public accessor functions (module-level, no GenServer call):**
- `db_ref(name \\ __MODULE__)` → `:persistent_term.get({:ebb_rocksdb_db, name})`
- `cf_actions(name \\ __MODULE__)`, `cf_updates/1`, `cf_entity_actions/1`, `cf_type_entities/1`, `cf_action_dedup/1` — each reads from `:persistent_term` with tuple key. All accept an optional `name` argument (default `__MODULE__`) so tests can run multiple isolated instances concurrently.

**`start_link/1`:**
- Extract `name` from opts (default `__MODULE__`)
- `GenServer.start_link(__MODULE__, opts, name: name)`

The GenServer exists solely to own the database lifecycle. All actual reads/writes use the references from `:persistent_term` without going through the GenServer mailbox.

---

## Task 6. Key encoding/decoding functions

**Files:** `ebb_server/lib/ebb_server/storage/rocks_db.ex` (modify)

Add pure functions to the module:

- `encode_gsn_key(gsn)` → `<<gsn::unsigned-big-integer-size(64)>>`
- `decode_gsn_key(<<gsn::unsigned-big-integer-size(64)>>)` → `gsn`
- `encode_entity_gsn_key(entity_id, gsn)` → `<<entity_id::binary, gsn::unsigned-big-integer-size(64)>>`
- `decode_entity_gsn_key(key)` → extract entity_id as `binary_part(key, 0, byte_size(key) - 8)`, gsn as last 8 bytes decoded as unsigned-big-64. Return `{entity_id, gsn}`.
- `encode_update_key(action_id, update_id)` → `<<action_id::binary, 0, update_id::binary>>` — null byte separator since both IDs are variable-length strings.
- `encode_type_entity_key(type, entity_id)` → `<<type::binary, 0, entity_id::binary>>` — null byte separator for the same reason.

**Design decision:** The spec says `<<action_id::binary, update_id::binary>>` but both IDs are variable-length. For Slice 1 we only need to write these keys and do point lookups (not prefix scans on action_id), so concatenation without separator works if we always know both IDs when reading. However, for safety and future prefix scans, use a null byte separator.

---

## Task 7. write_batch, get, and prefix_iterator

**Files:** `ebb_server/lib/ebb_server/storage/rocks_db.ex` (modify)

**`write_batch(operations, opts \\ [])`:**
- `operations` is a list of `{:put, cf_ref, key, value}` tuples
- `opts` is an optional keyword list supporting `:name` (default `__MODULE__`) for multi-instance support
- Create batch: `{:ok, batch} = :rocksdb.batch()`
- For each `{:put, cf_ref, key, value}`: call `:rocksdb.batch_put(batch, cf_ref, key, value)`
- Commit: `:rocksdb.write_batch(db_ref(name), batch, [sync: true])`
- Return `:ok` or `{:error, reason}`

**`get(cf_ref, key, opts \\ [])`:**
- `opts` supports `:name` (default `__MODULE__`)
- Call `:rocksdb.get(db_ref(name), cf_ref, key, [])`
- Return `{:ok, value}` if found, `:not_found` if not found, `{:error, reason}` on error

**`prefix_iterator(cf_ref, prefix, opts \\ [])`:**
- `opts` supports `:name` (default `__MODULE__`)
- Return a `Stream.resource/3`:
  - **start_fn:** Create iterator with `:rocksdb.iterator(db_ref(name), cf_ref, [{:iterate_upper_bound, prefix_upper_bound(prefix)}])`. Seek to prefix with `:rocksdb.iterator_move(iter, {:seek, prefix})`. Return `{iter, :first_result}` where `:first_result` holds the seek result.
  - **next_fn:** On first call, emit the seek result if it's `{:ok, key, value}`. On subsequent calls, call `:rocksdb.iterator_move(iter, :next)`. If result is `{:ok, key, value}` and key starts with prefix, emit `{[{key, value}], iter}`. If `:rocksdb.iterator_move` returns `{:error, :invalid_iterator}` or key doesn't match prefix, emit `{:halt, iter}`.
  - **cleanup_fn:** Call `:rocksdb.iterator_close(iter)`

- Helper `prefix_upper_bound(prefix)`: increment the last byte of the prefix to create an exclusive upper bound. If the last byte is 0xFF, truncate and increment the previous byte (recursively). This ensures the iterator stops at the end of the prefix range.

---

## Task 8. Unit tests

**Files:** `ebb_server/test/ebb_server/storage/rocks_db_test.exs` (create)

Tests use `async: true`. Each test starts its own RocksDB GenServer with a unique tmp_dir and a unique `name` (to avoid persistent_term collisions), and stops it in `on_exit`.

**Test cases:**

1. **Key encoding round-trips:**
   - `encode_gsn_key(42)` → `decode_gsn_key` → 42
   - `encode_entity_gsn_key("todo_abc", 100)` → `decode_entity_gsn_key` → `{"todo_abc", 100}`
   - GSN keys sort lexicographically in GSN order (encode 1, 2, 256, 65536 and verify binary comparison order)

2. **Open/close lifecycle:**
   - Start the GenServer with a tmp_dir, verify it starts successfully
   - Verify all `cf_*` accessor functions return references (not nil) when called with the test name
   - Stop the GenServer, verify `:persistent_term` tuple keys are erased

3. **Write and read round-trip:**
   - Start GenServer, write a single `{:put, cf_actions(name), key, value}` via `write_batch(ops, name: name)`
   - Read it back with `get(cf_actions(name), key, name: name)` → `{:ok, value}`
   - Read a non-existent key → `:not_found`

4. **Prefix iterator:**
   - Write 3 entries to `cf_entity_actions` with keys `encode_entity_gsn_key("todo_abc", 1)`, `encode_entity_gsn_key("todo_abc", 2)`, `encode_entity_gsn_key("todo_xyz", 1)`
   - `prefix_iterator(cf_entity_actions(name), "todo_abc", name: name)` → returns exactly 2 entries
   - Verify entries are in GSN order

5. **Durability (process restart):**
   - Start GenServer with name1 and data_dir, write data, stop GenServer
   - Start GenServer again with same data_dir but a new name2
   - Read data back → still present

---

## Verification

```bash
cd ebb_server && mix test test/ebb_server/storage/rocks_db_test.exs
```

All 5 test cases pass. RocksDB opens, writes, reads, iterates, and survives restarts.
