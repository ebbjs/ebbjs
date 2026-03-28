# Phase 7: Entity Store Query

> **Slice:** [02 — Permission-Checked Write](../../slices/02-permission-checked-write.md)
> **Depends on:** [Phase 2 — System Cache Permission APIs](02-system-cache-permissions.md) (for `dirty_entity_ids_for_type/1`)
> **Produces:** Fixed SQLite generated columns for nested field paths, `EntityStore.query/3` function and `SQLite.query_entities/1` with permission JOINs, plus unit tests

---

## Task 20. Update SQLite generated columns and add `query_entities/1`

**Files:** `ebb_server/lib/ebb_server/storage/sqlite.ex` (modify)

**Step 1: Fix generated column definitions.**

The existing `@create_entities_table` DDL has generated columns that extract from the wrong JSON paths for GroupMember entities. Update the generated columns for `actor_id`, `group_id`, and `permissions` to extract from the nested `fields.<name>.value` path that `EntityStore.materialize` produces:

```elixir
@create_entities_table """
CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  data TEXT,
  created_hlc INTEGER NOT NULL,
  updated_hlc INTEGER NOT NULL,
  deleted_hlc INTEGER,
  deleted_by TEXT,
  last_gsn INTEGER NOT NULL,
  source_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.source_id')) STORED,
  target_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.target_id')) STORED,
  rel_type TEXT GENERATED ALWAYS AS (json_extract(data, '$.type')) STORED,
  rel_field TEXT GENERATED ALWAYS AS (json_extract(data, '$.field')) STORED,
  actor_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.fields.actor_id.value')) STORED,
  group_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.fields.group_id.value')) STORED,
  permissions TEXT GENERATED ALWAYS AS (json_extract(data, '$.fields.permissions.value')) STORED
);
"""
```

**Step 2: Add schema migration.**

Since SQLite doesn't support `ALTER TABLE` for generated columns, add a migration check at the start of `init/1` (after opening the database, before DDL) that detects the old schema and drops the table:

```elixir
# In init/1, after Sqlite3.open and PRAGMAs, before CREATE TABLE:
migrate_schema(db)

defp migrate_schema(db) do
  case Sqlite3.prepare(db, "SELECT sql FROM sqlite_master WHERE type='table' AND name='entities'") do
    {:ok, stmt} ->
      result = case Sqlite3.step(db, stmt) do
        {:row, [create_sql]} ->
          # Detect old schema: actor_id extracted from $.actor_id instead of $.fields.actor_id.value
          if is_binary(create_sql) and String.contains?(create_sql, "json_extract(data, '$.actor_id')") do
            :needs_migration
          else
            :ok
          end
        :done -> :ok  # Table doesn't exist yet
      end
      Sqlite3.release(db, stmt)

      if result == :needs_migration do
        :ok = Sqlite3.execute(db, "DROP TABLE entities")
      end
    _ -> :ok
  end
end
```

**Note:** Dropping the table is safe because SQLite is a materialization cache — all data can be reconstructed from RocksDB. After the table is recreated with the new schema, entities will be re-materialized on demand (when marked dirty or queried).

**Step 3: Add `query_entities/1` function.**

Add a new public function `query_entities/1` that performs a type-scoped filtered query with permission JOINs.

**Public API:**

```elixir
@spec query_entities(map(), GenServer.server()) :: {:ok, [map()]}
def query_entities(query, server \\ __MODULE__) do
  GenServer.call(server, {:query_entities, query})
end
```

**`handle_call({:query_entities, query}, _from, state)`:**

Build a dynamic SQL query with permission JOINs and optional filter predicates.

The query map has the shape: `%{type: String.t(), filter: map() | nil, actor_id: String.t(), limit: integer() | nil, offset: integer() | nil}`.

**Important note on generated columns:** The existing SQLite schema has generated columns that extract from the top level of `data` (e.g., `json_extract(data, '$.source_id')`). However, `EntityStore.materialize` stores entity data in the format `{"fields": {"actor_id": {"type": "lww", "value": "...", "hlc": ...}}}`. This means:

- **Relationship entities** store `source_id`, `target_id`, `type`, `field` at the top level of `data` (not under `fields`), so the existing generated columns `source_id` and `target_id` work correctly.
- **GroupMember entities** store `actor_id`, `group_id`, `permissions` under `data.fields.<name>.value`, so the existing generated columns `actor_id`, `group_id`, `permissions` extract `null`.

**Fix:** Update the generated columns for `actor_id`, `group_id`, and `permissions` to extract from the nested `fields` path. Add a migration step in `init/1` that recreates the table if the generated column definitions have changed, or use `ALTER TABLE` if SQLite supports it (it doesn't for generated columns — the table must be recreated).

**Practical approach for Slice 2:** Since this is still early development and the database is recreatable (RocksDB is the source of truth, SQLite is a cache), the simplest fix is to update the DDL in `sqlite.ex` and let the `CREATE TABLE IF NOT EXISTS` handle new databases. For existing databases, add a version check that drops and recreates the table if the schema has changed.

**Updated generated columns in `sqlite.ex`:**

```sql
-- Relationship fields (top-level in data — these are correct as-is)
source_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.source_id')) STORED,
target_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.target_id')) STORED,
rel_type TEXT GENERATED ALWAYS AS (json_extract(data, '$.type')) STORED,
rel_field TEXT GENERATED ALWAYS AS (json_extract(data, '$.field')) STORED,

-- GroupMember fields (nested under fields.<name>.value)
actor_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.fields.actor_id.value')) STORED,
group_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.fields.group_id.value')) STORED,
permissions TEXT GENERATED ALWAYS AS (json_extract(data, '$.fields.permissions.value')) STORED
```

**Add schema migration to `init/1`:** Before `CREATE TABLE IF NOT EXISTS`, check if the table exists with the old schema and drop it if so:

```elixir
# Check if table exists with old generated column definitions
case Sqlite3.prepare(db, "SELECT sql FROM sqlite_master WHERE type='table' AND name='entities'") do
  {:ok, stmt} ->
    case Sqlite3.step(db, stmt) do
      {:row, [create_sql]} ->
        if String.contains?(create_sql, "json_extract(data, '$.actor_id')") do
          # Old schema — drop and recreate
          Sqlite3.execute(db, "DROP TABLE entities")
        end
      :done -> :ok
    end
    Sqlite3.release(db, stmt)
  _ -> :ok
end
```

**Base SQL with permission JOIN:**

```sql
SELECT e.id, e.type, e.data, e.created_hlc, e.updated_hlc, e.deleted_hlc, e.deleted_by, e.last_gsn
FROM entities e
INNER JOIN entities r ON r.type = 'relationship'
  AND r.source_id = e.id
  AND r.deleted_hlc IS NULL
INNER JOIN entities gm ON gm.type = 'groupMember'
  AND gm.group_id = r.target_id
  AND gm.actor_id = ?
  AND gm.deleted_hlc IS NULL
WHERE e.type = ?
  AND e.deleted_hlc IS NULL
```

**Note:** With the corrected generated columns, this JOIN works correctly: `r.source_id` matches the relationship's `data.source_id` (top-level), `r.target_id` matches `data.target_id` (top-level), `gm.group_id` matches `data.fields.group_id.value` (nested), and `gm.actor_id` matches `data.fields.actor_id.value` (nested).

**Filter translation:** If `query.filter` is a non-nil map, translate each key-value pair to a `json_extract` WHERE clause:

```elixir
defp build_filter_clauses(nil), do: {"", []}
defp build_filter_clauses(filter) when filter == %{}, do: {"", []}
defp build_filter_clauses(filter) do
  {clauses, params} =
    Enum.reduce(filter, {[], []}, fn {field, value}, {clauses, params} ->
      clause = " AND json_extract(e.data, '$.fields.#{field}.value') = ?"
      {[clause | clauses], [value | params]}
    end)

  {Enum.join(Enum.reverse(clauses)), Enum.reverse(params)}
end
```

**Important:** Sanitize field names to prevent SQL injection. Only allow alphanumeric characters and underscores in field names:

```elixir
defp safe_field_name?(name) when is_binary(name) do
  Regex.match?(~r/^[a-zA-Z_][a-zA-Z0-9_]*$/, name)
end
```

**Pagination:** Append `LIMIT ? OFFSET ?` if provided.

**Full handler:**

```elixir
def handle_call({:query_entities, query}, _from, state) do
  %{db: db} = state

  {filter_sql, filter_params} = build_filter_clauses(query[:filter])

  base_sql = """
  SELECT e.id, e.type, e.data, e.created_hlc, e.updated_hlc, e.deleted_hlc, e.deleted_by, e.last_gsn
  FROM entities e
  INNER JOIN entities r ON r.type = 'relationship'
    AND r.source_id = e.id
    AND r.deleted_hlc IS NULL
  INNER JOIN entities gm ON gm.type = 'groupMember'
    AND gm.group_id = r.target_id
    AND gm.actor_id = ?
    AND gm.deleted_hlc IS NULL
  WHERE e.type = ?
    AND e.deleted_hlc IS NULL
  """

  sql = base_sql <> filter_sql

  {sql, pagination_params} = case {query[:limit], query[:offset]} do
    {nil, _} -> {sql, []}
    {limit, nil} -> {sql <> " LIMIT ?", [limit]}
    {limit, offset} -> {sql <> " LIMIT ? OFFSET ?", [limit, offset]}
  end

  params = [query.actor_id, query.type] ++ filter_params ++ pagination_params

  {:ok, stmt} = Sqlite3.prepare(db, sql)
  :ok = Sqlite3.bind(stmt, params)

  rows = collect_rows(db, stmt, [])
  Sqlite3.release(db, stmt)

  {:reply, {:ok, rows}, state}
end

defp collect_rows(db, stmt, acc) do
  case Sqlite3.step(db, stmt) do
    {:row, row} -> collect_rows(db, stmt, [row_to_entity(row) | acc])
    :done -> Enum.reverse(acc)
  end
end
```

**Note:** This uses a dynamically prepared statement (not cached) because the SQL varies with filters. For frequently used queries, consider caching prepared statements keyed by filter shape. For Slice 2, dynamic preparation is acceptable.

**Add indexes for the permission JOIN:** The existing indexes may not cover the JOIN efficiently. Add indexes in the DDL section of `init/1`:

```sql
CREATE INDEX IF NOT EXISTS idx_entities_source_id ON entities(source_id) WHERE type = 'relationship' AND deleted_hlc IS NULL;
CREATE INDEX IF NOT EXISTS idx_entities_group_member ON entities(group_id, actor_id) WHERE type = 'groupMember' AND deleted_hlc IS NULL;
```

Add these to the `@create_indexes` module attribute.

**Important:** These indexes depend on the corrected generated columns (see above). The `group_id` and `actor_id` columns must extract from `$.fields.group_id.value` and `$.fields.actor_id.value` respectively for these indexes to be populated correctly.

---

## Task 21. Add `query/3` to Entity Store

**Files:** `ebb_server/lib/ebb_server/storage/entity_store.ex` (modify)

Add the `query/3` function that batch materializes dirty entities of the requested type, then delegates to SQLite for the filtered query.

```elixir
@spec query(String.t(), map() | nil, String.t(), keyword()) ::
        {:ok, [map()]} | {:error, term()}
def query(type, filter, actor_id, opts \\ []) do
  rocks_name = Keyword.get(opts, :rocks_name, @default_rocks_name)
  sqlite_name = Keyword.get(opts, :sqlite_name, @default_sqlite_name)
  dirty_set = Keyword.get(opts, :dirty_set, @default_dirty_set)
  limit = Keyword.get(opts, :limit)
  offset = Keyword.get(opts, :offset)

  # 1. Find dirty entities of this type
  dirty_ids = SystemCache.dirty_entity_ids_for_type(type, dirty_set)

  # 2. Materialize all dirty ones
  if dirty_ids != [] do
    Enum.each(dirty_ids, fn id ->
      materialize(id, rocks_name: rocks_name, sqlite_name: sqlite_name, dirty_set: dirty_set)
    end)
  end

  # 3. Query SQLite (all entities of this type are now clean)
  query_params = %{type: type, filter: filter, actor_id: actor_id}
  query_params = if limit, do: Map.put(query_params, :limit, limit), else: query_params
  query_params = if offset, do: Map.put(query_params, :offset, offset), else: query_params

  case SQLite.query_entities(query_params, sqlite_name) do
    {:ok, rows} ->
      {:ok, Enum.map(rows, &format_entity/1)}
    error ->
      error
  end
end
```

**Note:** The `format_entity/1` function already exists in EntityStore and parses the `data` JSON string into a map. Reuse it for query results.

**Batch materialization:** For Slice 2, materialize entities sequentially. A future optimization could use `Task.async_stream` for parallel RocksDB reads, then serialize SQLite upserts.

---

## Task 22. Unit tests for Entity Store query and SQLite query_entities

**Files:** `ebb_server/test/ebb_server/storage/entity_store_query_test.exs` (create)

These tests require the full storage stack (RocksDB, SQLite, SystemCache, Writer).

**Test setup:**

Start isolated instances of all storage components (same pattern as writer_test.exs but also including SQLite).

**Test cases:**

1. **Query returns entities of the correct type:**
   - Bootstrap a group (write Group + GroupMember + Relationship actions)
   - Write two "todo" entities linked to the group
   - Write one "post" entity linked to the group
   - `EntityStore.query("todo", nil, actor_id)` → returns 2 entities
   - `EntityStore.query("post", nil, actor_id)` → returns 1 entity

2. **Query respects permissions (only returns entities in actor's groups):**
   - Bootstrap group "g_1" for actor "a_1"
   - Bootstrap group "g_2" for actor "a_2"
   - Write "todo_1" in group "g_1", "todo_2" in group "g_2"
   - `EntityStore.query("todo", nil, "a_1")` → returns only "todo_1"
   - `EntityStore.query("todo", nil, "a_2")` → returns only "todo_2"

3. **Query with filter:**
   - Write two todos: one with `completed: true`, one with `completed: false`
   - `EntityStore.query("todo", %{"completed" => true}, actor_id)` → returns only the completed one

4. **Query materializes dirty entities first:**
   - Write a todo entity (marks it dirty)
   - Without reading it first (so it's still dirty)
   - `EntityStore.query("todo", nil, actor_id)` → returns the entity (was materialized by query)
   - Verify `SystemCache.is_dirty?(entity_id)` is now `false`

5. **Query returns empty list when no entities match:**
   - `EntityStore.query("nonexistent_type", nil, actor_id)` → `{:ok, []}`

6. **Query returns empty list when actor has no group access:**
   - Write entities in a group
   - Query as a different actor who is not a member
   - Returns `{:ok, []}`

---

## Verification

```bash
cd ebb_server && mix test test/ebb_server/storage/entity_store_query_test.exs
```

All 6 test cases pass. Entity Store query materializes dirty entities, delegates to SQLite with permission JOINs, and returns correctly filtered results.
