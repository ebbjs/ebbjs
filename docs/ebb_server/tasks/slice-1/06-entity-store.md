# Phase 6: Entity Store

> **Slice:** [01 — Single Action Write + Read-Back](../../slices/01-single-action-write-read.md)
> **Depends on:** [Phase 2 — RocksDB Store](02-rocksdb-store.md), [Phase 3 — SQLite Store](03-sqlite-store.md), [Phase 4 — System Cache](04-system-cache.md)
> **Produces:** `EbbServer.Storage.EntityStore` module with `get/2` and on-demand materialization, plus unit tests

---

## Task 16. get/2 with on-demand materialization

**Files:** `ebb_server/lib/ebb_server/storage/entity_store.ex` (create)

Create `EbbServer.Storage.EntityStore` as a module (not a GenServer for Slice 1 — SQLite calls go through the SQLite GenServer).

**`get(entity_id, _actor_id)`:**

1. Check dirty: `SystemCache.is_dirty?(entity_id)`
2. If **not dirty**:
   - `SQLite.get_entity(entity_id)` → if `{:ok, row}`, parse `row.data` with `Jason.decode!/1` and return `{:ok, format_entity(row)}`
   - If `:not_found`, return `:not_found`
3. If **dirty** → call `materialize(entity_id)`

**`materialize(entity_id)` (public for testability):**

1. Get current state from SQLite:

   ```elixir
   {current_data, last_gsn, existing_row} = case SQLite.get_entity(entity_id) do
     {:ok, row} -> {Jason.decode!(row.data), row.last_gsn, row}
     :not_found -> {%{"fields" => %{}}, 0, nil}
   end
   ```

2. Read delta from RocksDB — scan `cf_entity_actions` with prefix `entity_id`:

   ```elixir
    entries = RocksDB.prefix_iterator(RocksDB.cf_entity_actions(), entity_id)  # uses default name
   |> Stream.map(fn {key, action_id_binary} ->
     {_eid, gsn} = RocksDB.decode_entity_gsn_key(key)
     {gsn, action_id_binary}
   end)
   |> Stream.filter(fn {gsn, _} -> gsn > last_gsn end)
   |> Enum.to_list()
   |> Enum.sort_by(fn {gsn, _} -> gsn end)
   ```

3. If no new entries and entity exists in SQLite:
   - `SystemCache.clear_dirty(entity_id)`
   - Return `SQLite.get_entity(entity_id)` formatted

4. For each `{gsn, action_id}`, read the full Action from `cf_actions`:
   - Read: `{:ok, action_etf} = RocksDB.get(RocksDB.cf_actions(), RocksDB.encode_gsn_key(gsn))` (uses default name)
   - Decode: `action = :erlang.binary_to_term(action_etf, [:safe])`
   - Filter updates: find updates in `action["updates"]` where `update["subject_id"] == entity_id`

5. Apply updates in GSN order. For each update:
   - If `method == "put"`:
     - Set entity data to `update["data"]`
     - Set `type` to `update["subject_type"]`
     - Set `created_hlc` to `action["hlc"]` (if first PUT / no existing row)
     - Set `updated_hlc` to `action["hlc"]`
   - If `method == "patch"`:
     - For each field in `update["data"]["fields"]`:
       - LWW merge with tiebreaker:
         - If incoming `"hlc"` > existing `"hlc"` (or existing doesn't exist): use incoming, tag with `"update_id"` from the update
         - If incoming `"hlc"` < existing `"hlc"`: keep existing
         - If incoming `"hlc"` == existing `"hlc"`: lexicographic compare of `update["id"]` vs existing field's `"update_id"` — higher update ID wins. This ensures deterministic convergence across all nodes regardless of processing order.
       - The winning field value is stored with an `"update_id"` key for future tiebreaking (e.g., `%{"type" => "lww", "value" => "x", "hlc" => 1000, "update_id" => "upd_abc"}`)
     - Set `updated_hlc` to `action["hlc"]`
   - If `method == "delete"`:
     - Set `deleted_hlc` to `action["hlc"]`
     - Set `deleted_by` to `action["actor_id"]`
     - Set `updated_hlc` to `action["hlc"]`

6. Build entity row and upsert to SQLite:

   ```elixir
   entity_row = %{
     id: entity_id,
     type: type,
     data: Jason.encode!(merged_data),
     created_hlc: created_hlc,
     updated_hlc: updated_hlc,
     deleted_hlc: deleted_hlc,
     deleted_by: deleted_by,
     last_gsn: max_gsn_seen
   }
   SQLite.upsert_entity(entity_row)
   ```

7. Clear dirty: `SystemCache.clear_dirty(entity_id)`

8. Return `{:ok, format_entity(entity_row)}` where `format_entity` returns the row with `data` as a parsed map (not JSON string).

---

## Task 17. Unit tests

**Files:** `ebb_server/test/ebb_server/storage/entity_store_test.exs` (create)

These tests require RocksDB, SQLite, SystemCache, and Writer to be running.

**Test cases:**

1. **Materialize a PUT (first read):**
   - Write an action with a PUT update for entity "todo_abc" via Writer
   - Call `EntityStore.get("todo_abc", "a_test")`
   - Verify returns `{:ok, entity}` with correct `id`, `type`, `data` (fields with title and completed)
   - Verify `entity.last_gsn` is 1

2. **Entity is cached in SQLite after materialization:**
   - After the above, call `SQLite.get_entity("todo_abc")` directly
   - Verify it returns the entity (proves SQLite was populated)

3. **Dirty bit is cleared after materialization:**
   - After materialization, `SystemCache.is_dirty?("todo_abc")` → `false`

4. **Second read is clean (no re-materialization):**
   - Call `EntityStore.get("todo_abc", "a_test")` again
   - Verify returns the same entity
   - (Dirty bit is already false, so it reads from SQLite directly)

5. **Entity not found:**
   - `EntityStore.get("nonexistent", "a_test")` → `:not_found`

6. **LWW merge with PATCH:**
   - Write a PUT action for entity "todo_abc" with field `title` at HLC 1000
   - Write a PATCH action for same entity with field `title` at HLC 2000 (newer value)
   - `EntityStore.get("todo_abc", "a_test")` → title has the HLC 2000 value

7. **LWW merge — older PATCH doesn't overwrite:**
   - Write a PUT action with field `title` at HLC 2000
   - Write a PATCH action with field `title` at HLC 1000 (older)
   - `EntityStore.get` → title still has the HLC 2000 value

8. **Incremental materialization:**
   - Write action 1 (PUT), read entity (materializes, last_gsn=1)
   - Write action 2 (PATCH with new field), read entity again
   - Verify entity has both the original fields and the new field
   - Verify `last_gsn` is 2

9. **LWW tiebreaker — equal HLCs resolved by update ID:**
   - Write a PUT action for entity "todo_abc" with field `title` at HLC 1000, update ID "upd_aaa"
   - Write a PATCH action for same entity with field `title` at HLC 1000 (same), update ID "upd_zzz"
   - `EntityStore.get("todo_abc", "a_test")` → title has the "upd_zzz" value (higher update ID wins)
   - Verify the materialized field includes `"update_id" => "upd_zzz"`

10. **LWW tiebreaker — lower update ID does not overwrite:**
    - Write a PUT action for entity "todo_abc" with field `title` at HLC 1000, update ID "upd_zzz"
    - Write a PATCH action for same entity with field `title` at HLC 1000 (same), update ID "upd_aaa"
    - `EntityStore.get` → title still has the "upd_zzz" value (higher update ID wins)

---

## Verification

```bash
cd ebb_server && mix test test/ebb_server/storage/entity_store_test.exs
```

All 10 test cases pass. Materialization works for PUT, PATCH, and incremental reads. LWW merge is correct including HLC tiebreaker. Dirty bit lifecycle is correct.
