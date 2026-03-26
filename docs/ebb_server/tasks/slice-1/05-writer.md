# Phase 5: Writer

> **Slice:** [01 — Single Action Write + Read-Back](../../slices/01-single-action-write-read.md)
> **Depends on:** [Phase 2 — RocksDB Store](02-rocksdb-store.md), [Phase 4 — System Cache](04-system-cache.md)
> **Produces:** `EbbServer.Storage.Writer` GenServer with immediate flush and unit tests

---

## Task 14. Writer GenServer — single instance, immediate flush

**Files:** `ebb_server/lib/ebb_server/storage/writer.ex` (create)

Create `EbbServer.Storage.Writer` as a GenServer. For Slice 1: single instance, immediate flush (no batching timer).

**`start_link/1`:**
- `GenServer.start_link(__MODULE__, opts, name: __MODULE__)`

**`init/1`:**
- Return `{:ok, %{}}` — no state needed for Slice 1 (no batching buffer)

**`write_actions(actions)` (public API):**
- `GenServer.call(__MODULE__, {:write_actions, actions})`

**`handle_call({:write_actions, actions}, _from, state)`:**

1. Count actions: `batch_size = length(actions)`
2. Claim GSN range: `{gsn_start, gsn_end} = SystemCache.claim_gsn_range(batch_size)`
3. Build WriteBatch operations by iterating actions with their assigned GSNs:
   ```elixir
   actions
   |> Enum.with_index(gsn_start)
   |> Enum.flat_map(fn {action, gsn} ->
     action_with_gsn = Map.put(action, "gsn", gsn)
     action_etf = :erlang.term_to_binary(action_with_gsn)

     # cf_actions: GSN key → full Action ETF
     [{:put, RocksDB.cf_actions(), RocksDB.encode_gsn_key(gsn), action_etf},
      # cf_action_dedup: action_id → GSN key
      {:put, RocksDB.cf_action_dedup(), action["id"], RocksDB.encode_gsn_key(gsn)}]
     ++
     Enum.flat_map(action["updates"], fn update ->
       update_etf = :erlang.term_to_binary(update)
       [
         # cf_updates: action_id|update_id → Update ETF
         {:put, RocksDB.cf_updates(), RocksDB.encode_update_key(action["id"], update["id"]), update_etf},
         # cf_entity_actions: entity_id|gsn → action_id
         {:put, RocksDB.cf_entity_actions(), RocksDB.encode_entity_gsn_key(update["subject_id"], gsn), action["id"]},
         # cf_type_entities: type|entity_id → empty
         {:put, RocksDB.cf_type_entities(), RocksDB.encode_type_entity_key(update["subject_type"], update["subject_id"]), <<>>}
       ]
     end)
   end)
   ```
4. Commit: `RocksDB.write_batch(ops)`
5. Mark dirty: collect all unique `subject_id` values from all updates, call `SystemCache.mark_dirty_batch(entity_ids)`
6. Reply: `{:reply, {:ok, {gsn_start, gsn_end}}, state}`

**Important:** All map keys are strings (not atoms) to prevent atom table pollution. The action maps come from MessagePack decoding which produces string keys.

---

## Task 15. Unit tests

**Files:** `ebb_server/test/ebb_server/storage/writer_test.exs` (create)

These tests require RocksDB and SystemCache to be running. Start them in test setup with unique tmp_dirs.

**Test cases:**

1. **Single action write:**
   - Write one action with one update via `Writer.write_actions([action])`
   - Verify returns `{:ok, {1, 1}}`
   - Verify action is in `cf_actions` at GSN key 1 (read via `RocksDB.get`)
   - Decode the ETF and verify it has `"gsn" => 1`

2. **GSN assignment is sequential:**
   - Write action 1 → GSN `{1, 1}`
   - Write action 2 → GSN `{2, 2}`
   - Write action 3 → GSN `{3, 3}`

3. **All 5 column families are populated:**
   - Write one action with one update
   - Verify `cf_actions` has the action at GSN key
   - Verify `cf_updates` has the update at `action_id|update_id` key
   - Verify `cf_entity_actions` has entry at `entity_id|gsn` key → value is action_id
   - Verify `cf_type_entities` has entry at `type|entity_id` key
   - Verify `cf_action_dedup` has entry at `action_id` key → value is GSN key

4. **ETF round-trip:**
   - Write an action, read it back from `cf_actions`, decode with `:erlang.binary_to_term(binary, [:safe])`
   - Verify all fields match the original action (plus the added `"gsn"` field)

5. **Dirty set is updated:**
   - Write an action targeting entity "todo_abc"
   - Verify `SystemCache.is_dirty?("todo_abc")` is `true`

6. **Durability (survives restart):**
   - Write an action, stop Writer + RocksDB, restart both
   - Read the action from `cf_actions` → still present

---

## Verification

```bash
cd ebb_server && mix test test/ebb_server/storage/writer_test.exs
```

All 6 test cases pass. Writer assigns GSNs, encodes ETF, populates all 5 column families, and marks entities dirty.
