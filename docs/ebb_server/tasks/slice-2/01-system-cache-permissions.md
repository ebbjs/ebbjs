# Phase 1: System Cache Permission APIs

> **Slice:** [02 — Permission-Checked Write](../../slices/02-permission-checked-write.md)
> **Depends on:** Slice 1 complete
> **Produces:** Extended `EbbServer.Storage.SystemCache` with 3 new ETS tables and permission-related APIs (`get_permissions/2`, `get_entity_group/1`, etc.), plus unit tests. These APIs are consumed by the Permission Checker.

---

## Task 3. Add new ETS tables to SystemCache init

**Files:** `ebb_server/lib/ebb_server/storage/system_cache.ex` (modify)

**API contract for PermissionChecker:** The Permission Checker (Phase 2) will call these functions:

- `get_permissions(actor_id, group_id, opts)` — returns permissions list or `nil`
- `get_entity_group(entity_id, opts)` — returns group_id or `nil`
- `get_actor_groups(actor_id, opts)` — returns `[%{group_id, permissions}]`

Add 3 new ETS tables created in `init/1`, alongside the existing `dirty_set`:

1. `:ebb_group_members` — `:bag` type, `:public`, `:named_table`. Keyed by `actor_id`. Each entry is `{actor_id, %{id: member_id, group_id: group_id, permissions: [String.t()]}}`.
2. `:ebb_relationships` — `:set` type, `:public`, `:named_table`. Keyed by `source_id` (entity_id). Each entry is `{source_id, %{id: rel_id, target_id: group_id, type: entity_type, field: field_name}}`.
3. `:ebb_relationships_by_group` — `:bag` type, `:public`, `:named_table`. Keyed by `target_id` (group_id). Each entry is `{group_id, source_id}`.

**Modify `init/1`:**

Add configurable table names via opts (matching existing pattern for `dirty_set`):

```elixir
group_members_table = Keyword.get(opts, :group_members, :ebb_group_members)
relationships_table = Keyword.get(opts, :relationships, :ebb_relationships)
relationships_by_group_table = Keyword.get(opts, :relationships_by_group, :ebb_relationships_by_group)

:ets.new(group_members_table, [:bag, :public, :named_table])
:ets.new(relationships_table, [:set, :public, :named_table])
:ets.new(relationships_by_group_table, [:bag, :public, :named_table])
```

Add these table names to the struct and state.

**Modify `terminate/2`:**

Delete all 3 new ETS tables (with the same try/rescue pattern as `dirty_set`).

**Update the struct:**

```elixir
defstruct [:dirty_set, :gsn_counter, :gsn_counter_name,
           :group_members, :relationships, :relationships_by_group]
```

**Add module attribute defaults:**

```elixir
@default_group_members :ebb_group_members
@default_relationships :ebb_relationships
@default_relationships_by_group :ebb_relationships_by_group
```

---

## Task 4. Add Group Member APIs

**Files:** `ebb_server/lib/ebb_server/storage/system_cache.ex` (modify)

Add the following public functions. All accept optional table name params for test isolation.

**`put_group_member/1` (or `/2` with opts):**

Insert a group member entry. The input is a map with string or atom keys: `%{id, actor_id, group_id, permissions}`. First delete any existing entry with the same `id` (to handle updates), then insert.

```elixir
def put_group_member(member, table \\ @default_group_members) do
  actor_id = member[:actor_id] || member["actor_id"]
  entry = %{
    id: member[:id] || member["id"],
    group_id: member[:group_id] || member["group_id"],
    permissions: member[:permissions] || member["permissions"]
  }

  # Remove any existing entry with the same member id
  delete_group_member_by_id(entry.id, actor_id, table)

  :ets.insert(table, {actor_id, entry})
  :ok
end
```

**`delete_group_member/1` (or `/2` with opts):**

Remove a group member by member entity ID. Must scan the bag to find and remove the matching entry. Since the bag is keyed by `actor_id` and we only have `member_id`, we need to scan all entries.

```elixir
def delete_group_member(member_id, table \\ @default_group_members) do
  # Use match_object to find entries with matching id across all keys
  # Pattern: {any_actor_id, %{id: member_id, ...}} — but ETS match patterns
  # can't match on map values directly, so use tab2list + filter
  table
  |> :ets.tab2list()
  |> Enum.each(fn {_actor_id, %{id: id} = _entry} = object ->
    if id == member_id do
      :ets.delete_object(table, object)
    end
  end)

  :ok
end
```

**Note:** This is a full table scan, acceptable because the group_members table is small (one entry per actor-group pair). If the table grows large, consider maintaining a secondary index `{member_id, actor_id}` for O(1) deletion.

**`get_actor_groups/1` (or `/2` with opts):**

```elixir
def get_actor_groups(actor_id, table \\ @default_group_members) do
  :ets.lookup(table, actor_id)
  |> Enum.map(fn {_actor_id, entry} ->
    %{group_id: entry.group_id, permissions: entry.permissions}
  end)
end
```

**`get_permissions/2` (or `/3` with opts):**

```elixir
def get_permissions(actor_id, group_id, table \\ @default_group_members) do
  :ets.lookup(table, actor_id)
  |> Enum.find_value(fn {_actor_id, entry} ->
    if entry.group_id == group_id, do: entry.permissions
  end)
end
```

---

## Task 5. Add Relationship APIs

**Files:** `ebb_server/lib/ebb_server/storage/system_cache.ex` (modify)

**`put_relationship/1` (or `/2` with opts):**

Insert into both `relationships` (by source_id) and `relationships_by_group` (by target_id/group_id).

```elixir
def put_relationship(rel, opts \\ []) do
  rel_table = Keyword.get(opts, :relationships, @default_relationships)
  rbg_table = Keyword.get(opts, :relationships_by_group, @default_relationships_by_group)

  source_id = rel[:source_id] || rel["source_id"]
  target_id = rel[:target_id] || rel["target_id"]
  entry = %{
    id: rel[:id] || rel["id"],
    target_id: target_id,
    type: rel[:type] || rel["type"],
    field: rel[:field] || rel["field"]
  }

  :ets.insert(rel_table, {source_id, entry})
  :ets.insert(rbg_table, {target_id, source_id})
  :ok
end
```

**`delete_relationship/1` (or `/2` with opts):**

Remove from both tables. Scan the `:set` table to find the entry with matching `id`, then delete from both tables using the `source_id` and `target_id`.

```elixir
def delete_relationship(rel_id, opts \\ []) do
  rel_table = Keyword.get(opts, :relationships, @default_relationships)
  rbg_table = Keyword.get(opts, :relationships_by_group, @default_relationships_by_group)

  # Scan relationships table to find the entry with matching id
  rel_table
  |> :ets.tab2list()
  |> Enum.each(fn {source_id, %{id: id, target_id: target_id}} ->
    if id == rel_id do
      :ets.delete(rel_table, source_id)
      :ets.delete_object(rbg_table, {target_id, source_id})
    end
  end)

  :ok
end
```

**Note:** The relationships table is a `:set` keyed by `source_id`, so there's at most one entry per source entity. This scan is O(n) in the number of relationships. Acceptable for small-to-medium deployments. For large deployments, consider a secondary index `{rel_id, source_id}` for O(1) deletion.

**`get_entity_group/1` (or `/2` with opts):**

Look up the group an entity belongs to via its relationship.

```elixir
def get_entity_group(entity_id, table \\ @default_relationships) do
  case :ets.lookup(table, entity_id) do
    [{_source_id, %{target_id: group_id}}] -> group_id
    [] -> nil
  end
end
```

**`get_group_entities/1` (or `/2` with opts):**

Return all entity IDs in a group (reverse lookup).

```elixir
def get_group_entities(group_id, table \\ @default_relationships_by_group) do
  :ets.lookup(table, group_id)
  |> Enum.map(fn {_group_id, source_id} -> source_id end)
end
```

---

## Task 6. Add `dirty_entity_ids_for_type/1`

**Files:** `ebb_server/lib/ebb_server/storage/system_cache.ex` (modify)

Add a function to find dirty entity IDs that match a type prefix. Since entity IDs are prefixed by type (e.g., `todo_abc123`), use a prefix scan on the dirty_set ETS table.

```elixir
def dirty_entity_ids_for_type(type, dirty_set \\ @default_dirty_set_name) do
  prefix = type <> "_"

  dirty_set
  |> :ets.tab2list()
  |> Enum.reduce([], fn {entity_id, _}, acc ->
    if String.starts_with?(entity_id, prefix) do
      [entity_id | acc]
    else
      acc
    end
  end)
end
```

**Note:** This uses a full table scan with prefix matching via `:ets.tab2list/1`. Acceptable for small dirty sets. If performance becomes an issue, a secondary `dirty_by_type` ETS table can be added later.

---

## Task 7. Add startup population from RocksDB

**Files:** `ebb_server/lib/ebb_server/storage/system_cache.ex` (modify)

At the end of `init/1`, after creating all ETS tables and setting up the GSN counter, populate the `group_members` and `relationships` tables from RocksDB.

Iterate `cf_type_entities` for types `"groupMember"` and `"relationship"`. For each entity ID found, materialize it (read from RocksDB, apply updates) and populate the appropriate ETS table.

```elixir
defp populate_system_caches(state) do
  rocks_name = EbbServer.Storage.RocksDB  # uses default name

  # Populate group members
  populate_type("groupMember", rocks_name, fn entity_data ->
    put_group_member(%{
      id: entity_data["id"],
      actor_id: get_in(entity_data, ["data", "fields", "actor_id", "value"]),
      group_id: get_in(entity_data, ["data", "fields", "group_id", "value"]),
      permissions: get_in(entity_data, ["data", "fields", "permissions", "value"])
    }, state.group_members)
  end)

  # Populate relationships
  populate_type("relationship", rocks_name, fn entity_data ->
    put_relationship(%{
      id: entity_data["id"],
      source_id: get_in(entity_data, ["data", "source_id"]),
      target_id: get_in(entity_data, ["data", "target_id"]),
      type: get_in(entity_data, ["data", "type"]),
      field: get_in(entity_data, ["data", "field"])
    }, relationships: state.relationships, relationships_by_group: state.relationships_by_group)
  end)
end

defp populate_type(type, rocks_name, insert_fn) do
  prefix = type <> <<0>>
  cf = EbbServer.Storage.RocksDB.cf_type_entities(rocks_name)

  EbbServer.Storage.RocksDB.prefix_iterator(cf, prefix, name: rocks_name)
  |> Stream.each(fn {key, _value} ->
    # Decode entity_id from the type_entity key
    # key format: type <> 0x00 <> entity_id
    <<_type_bytes::binary-size(byte_size(type)), 0, entity_id::binary>> = key

    # Materialize the entity to get current state
    case EbbServer.Storage.EntityStore.materialize(entity_id) do
      {:ok, entity} -> insert_fn.(entity)
      _ -> :ok
    end
  end)
  |> Stream.run()
end
```

**Important:** This must be called at the end of `init/1` before returning `{:ok, state}`. It blocks the supervision tree until complete, ensuring no requests are served until caches are populated. Wrap in a try/catch so startup doesn't fail if RocksDB is empty (first boot).

**Note:** On first boot (empty RocksDB), the iterators return nothing and this is a no-op. The startup population only matters after a restart when there are existing system entities in RocksDB.

---

## Task 8. Unit tests for System Cache permission APIs

**Files:** `ebb_server/test/ebb_server/storage/system_cache_test.exs` (modify)

Add new describe blocks to the existing test file. Use isolated ETS tables for each test.

**Modify `start_isolated_cache/1`** to also create the 3 new ETS tables and return their names.

**Test cases:**

1. **`put_group_member/1` and `get_actor_groups/1`:**
   - Put a group member for actor "a_1" in group "g_1" with permissions `["todo.create"]`
   - `get_actor_groups("a_1")` → `[%{group_id: "g_1", permissions: ["todo.create"]}]`

2. **`get_actor_groups/1` — multiple groups:**
   - Put actor "a_1" in group "g_1" and group "g_2"
   - `get_actor_groups("a_1")` → list of 2 entries

3. **`get_permissions/2` — returns permissions for matching group:**
   - Put actor "a_1" in group "g_1" with `["todo.create", "todo.update"]`
   - `get_permissions("a_1", "g_1")` → `["todo.create", "todo.update"]`

4. **`get_permissions/2` — returns nil for non-member:**
   - `get_permissions("a_1", "g_nonexistent")` → `nil`

5. **`delete_group_member/1` — removes entry:**
   - Put member "gm_1" for actor "a_1" in group "g_1"
   - `delete_group_member("gm_1")`
   - `get_actor_groups("a_1")` → `[]`

6. **`put_relationship/1` and `get_entity_group/1`:**
   - Put relationship: source "todo_1" → target "g_1"
   - `get_entity_group("todo_1")` → `"g_1"`

7. **`get_entity_group/1` — returns nil for unknown entity:**
   - `get_entity_group("unknown")` → `nil`

8. **`get_group_entities/1`:**
   - Put relationships: "todo_1" → "g_1", "todo_2" → "g_1"
   - `get_group_entities("g_1")` → `["todo_1", "todo_2"]` (order may vary)

9. **`delete_relationship/1` — removes from both tables:**
   - Put relationship "rel_1": source "todo_1" → target "g_1"
   - `delete_relationship("rel_1")`
   - `get_entity_group("todo_1")` → `nil`
   - `get_group_entities("g_1")` → `[]`

10. **`dirty_entity_ids_for_type/1`:**
    - Mark dirty: `["todo_abc", "todo_xyz", "post_123"]`
    - `dirty_entity_ids_for_type("todo")` → `["todo_abc", "todo_xyz"]` (order may vary)
    - `dirty_entity_ids_for_type("post")` → `["post_123"]`

---

## Verification

```bash
cd ebb_server && mix test test/ebb_server/storage/system_cache_test.exs
```

All existing tests still pass. All 10 new test cases pass. SystemCache now manages group members, relationships, and dirty-by-type queries.
