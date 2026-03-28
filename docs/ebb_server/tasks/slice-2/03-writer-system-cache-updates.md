# Phase 3: Writer System Cache Updates

> **Slice:** [02 — Permission-Checked Write](../../slices/02-permission-checked-write.md)
> **Depends on:** [Phase 2 — System Cache Permission APIs](02-system-cache-permissions.md)
> **Produces:** Extended `EbbServer.Storage.Writer` that updates system entity caches after each batch commit, plus unit tests

---

## Task 9. Add system entity cache update logic to Writer

**Files:** `ebb_server/lib/ebb_server/storage/writer.ex` (modify)

After the `mark_dirty_batch` call in `handle_call`, add a call to `update_system_caches/1` that scans the committed actions for system entity updates and calls the appropriate SystemCache functions.

**⚠️ Important note on Phase 5 rewrite:** This phase writes the system cache update logic using **string-keyed** action maps (the current Writer input format). In Phase 5, the Writer is refactored to accept **atom-keyed** `validated_action` maps from the Permission Checker. At that point, all field access in `update_system_caches` and its helpers must be updated from `action["updates"]` to `action.updates`, `update["subject_type"]` to `update.subject_type`, `update["method"]` to `update.method` (now an atom `:put` instead of string `"put"`), etc. The logic and structure remain the same — only the key access pattern changes. Write the tests in this phase using string keys; they will be updated in Phase 5 alongside the Writer refactoring.

**Modify `handle_call` — add after `mark_dirty_batch`:**

In the success branch of the `case EbbServer.Storage.RocksDB.write_batch(ops, ...)` block, after the `mark_dirty_batch` call and before the reply, add:

```elixir
update_system_caches(filtered, state)
```

**Add `update_system_caches/2` private function:**

Scan all updates across all actions in the batch. For each update where `subject_type` is `"groupMember"` or `"relationship"`, call the appropriate SystemCache function.

```elixir
defp update_system_caches(actions, state) do
  Enum.each(actions, fn action ->
    Enum.each(action["updates"], fn update ->
      case update["subject_type"] do
        "groupMember" -> handle_group_member_update(update, state)
        "relationship" -> handle_relationship_update(update, state)
        _ -> :ok
      end
    end)
  end)
end
```

**`handle_group_member_update/2`:**

For `"put"` or `"patch"` methods: extract the relevant fields from the update's data and call `SystemCache.put_group_member/1`.

For `"delete"` method: call `SystemCache.delete_group_member/1` with the subject_id (which is the groupMember entity ID).

```elixir
defp handle_group_member_update(update, _state) do
  case update["method"] do
    method when method in ["put", "patch"] ->
      data = update["data"]
      fields = data["fields"] || %{}

      SystemCache.put_group_member(%{
        id: update["subject_id"],
        actor_id: get_field_value(fields, "actor_id"),
        group_id: get_field_value(fields, "group_id"),
        permissions: get_field_value(fields, "permissions")
      })

    "delete" ->
      SystemCache.delete_group_member(update["subject_id"])
  end
end
```

**`handle_relationship_update/2`:**

For `"put"` or `"patch"`: extract source_id, target_id, type, field from the update's data. Relationship data may store these at the top level of `data` (not nested under `fields`), since relationships are system entities with a different data shape.

```elixir
defp handle_relationship_update(update, _state) do
  case update["method"] do
    method when method in ["put", "patch"] ->
      data = update["data"]

      SystemCache.put_relationship(%{
        id: update["subject_id"],
        source_id: data["source_id"] || get_field_value(data["fields"], "source_id"),
        target_id: data["target_id"] || get_field_value(data["fields"], "target_id"),
        type: data["type"] || get_field_value(data["fields"], "type"),
        field: data["field"] || get_field_value(data["fields"], "field")
      })

    "delete" ->
      SystemCache.delete_relationship(update["subject_id"])
  end
end
```

**Helper for extracting field values:**

```elixir
defp get_field_value(nil, _field), do: nil
defp get_field_value(fields, field) do
  case fields[field] do
    %{"value" => value} -> value
    value when is_binary(value) -> value
    _ -> nil
  end
end
```

**Important:** The `update_system_caches/2` call happens inline, after the RocksDB commit and dirty marking, but before the reply to the caller. This ensures permission changes take effect immediately for subsequent requests.

**Note on data shape:** System entities (groupMember, relationship) may have their key fields at the top level of `data` (e.g., `data["source_id"]`) rather than nested under `data["fields"]["source_id"]["value"]`. The helper tries both patterns for robustness. The canonical format should be documented and enforced by the Permission Checker's structure validation, but the Writer should be tolerant.

---

## Task 10. Unit tests for Writer system cache updates

**Files:** `ebb_server/test/ebb_server/storage/writer_test.exs` (modify)

Add new describe blocks to the existing writer test file. The existing `start_isolated_cache` helper needs to be updated to also create the 3 new ETS tables.

**⚠️ Note:** These tests use string-keyed action maps (the current Writer input format). In Phase 5, when the Writer is refactored to accept atom-keyed maps, these tests must be updated to use the `validated_action()` / `validated_update()` helpers defined in Phase 5's Task 16.

**Modify `start_isolated_cache/0`:**

Add creation of `group_members`, `relationships`, and `relationships_by_group` ETS tables with unique names. Return them in the result map.

```elixir
defp start_isolated_cache do
  unique_id = System.unique_integer([:positive])
  dirty_set_name = :"ebb_dirty_#{unique_id}"
  gsn_counter_name = :"ebb_gsn_#{unique_id}"
  cache_name = :"ebb_cache_#{unique_id}"
  gm_name = :"ebb_gm_#{unique_id}"
  rel_name = :"ebb_rel_#{unique_id}"
  rbg_name = :"ebb_rbg_#{unique_id}"

  counter = :atomics.new(1, signed: false)
  :persistent_term.put(gsn_counter_name, counter)

  {:ok, _pid} = SystemCache.start_link(
    name: cache_name,
    dirty_set: dirty_set_name,
    gsn_counter: counter,
    gsn_counter_name: gsn_counter_name,
    initial_gsn: 0,
    group_members: gm_name,
    relationships: rel_name,
    relationships_by_group: rbg_name
  )

  on_exit(fn ->
    if pid = Process.whereis(cache_name), do: if(Process.alive?(pid), do: GenServer.stop(pid))
    :persistent_term.erase(gsn_counter_name)
  end)

  %{dirty_set: dirty_set_name, gsn_counter: counter,
    group_members: gm_name, relationships: rel_name, relationships_by_group: rbg_name}
end
```

**Test cases:**

1. **GroupMember PUT updates ETS:**
   - Build an action with a PUT update for `subject_type: "groupMember"`, `subject_id: "gm_1"`, with data containing `actor_id`, `group_id`, `permissions` fields
   - Write via Writer
   - Verify `SystemCache.get_actor_groups("actor_1", gm_table)` returns the group membership
   - Verify `SystemCache.get_permissions("actor_1", "group_1", gm_table)` returns the permissions

2. **Relationship PUT updates ETS:**
   - Build an action with a PUT update for `subject_type: "relationship"`, `subject_id: "rel_1"`, with data containing `source_id`, `target_id`, `type`, `field`
   - Write via Writer
   - Verify `SystemCache.get_entity_group("todo_1", rel_table)` returns the group_id
   - Verify `SystemCache.get_group_entities("group_1", rbg_table)` includes `"todo_1"`

3. **GroupMember DELETE removes from ETS:**
   - Write a PUT for groupMember, verify it's in ETS
   - Write a DELETE for the same groupMember
   - Verify `SystemCache.get_actor_groups("actor_1", gm_table)` returns `[]`

4. **Relationship DELETE removes from ETS:**
   - Write a PUT for relationship, verify it's in ETS
   - Write a DELETE for the same relationship
   - Verify `SystemCache.get_entity_group("todo_1", rel_table)` returns `nil`

5. **Non-system entity updates do not affect ETS:**
   - Write a PUT for `subject_type: "todo"` (user entity)
   - Verify group_members and relationships tables are empty

6. **Mixed batch — system and user entities:**
   - Write an action with both a "todo" update and a "groupMember" update
   - Verify only the groupMember update is reflected in ETS
   - Verify the todo entity is marked dirty but not in permission tables

---

## Verification

```bash
cd ebb_server && mix test test/ebb_server/storage/writer_test.exs
```

All existing tests still pass. All 6 new test cases pass. Writer now updates system entity caches inline after each batch commit.
