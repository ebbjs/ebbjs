# SQLite Store

## Purpose

Manages the SQLite database that serves as the read-optimized materialized entity cache. Handles schema DDL, entity UPSERT (during materialization), and filtered queries with permission JOINs for `ctx.query()`. This is the only module that interacts with `exqlite` directly.

## Responsibilities

- Open the SQLite database at the configured `data_dir` path with correct PRAGMAs (WAL mode, cache size, etc.)
- Run schema DDL on startup (create tables, indexes, generated columns)
- Provide entity UPSERT for the Entity Store's materialization path
- Provide entity SELECT by ID for `ctx.get()` (post-materialization)
- Provide filtered entity SELECT by type with `json_extract` predicates and permission JOINs for `ctx.query()`
- Provide actor record management (auto-create on first auth)
- Provide function version management (for server function deployment)

## Public Interface

### Module: `EbbServer.Storage.SQLite`

#### Lifecycle

| Name           | Signature                                  | Description                                              |
| -------------- | ------------------------------------------ | -------------------------------------------------------- |
| `start_link/1` | `start_link(opts) :: GenServer.on_start()` | Opens SQLite, runs DDL. `opts`: `[data_dir: String.t()]` |

#### Entity Operations

| Name                    | Signature                                                                         | Description                                                                               |
| ----------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `upsert_entity/1`       | `upsert_entity(entity :: entity_row()) :: :ok \| {:error, term()}`                | INSERT OR REPLACE into `entities` table. Used by Entity Store after materialization.      |
| `upsert_entities/1`     | `upsert_entities(entities :: [entity_row()]) :: :ok \| {:error, term()}`          | Batch UPSERT within a single transaction. Used by Entity Store for batch materialization. |
| `get_entity/1`          | `get_entity(id :: String.t()) :: {:ok, entity_row()} \| :not_found`               | SELECT by primary key from `entities` table.                                              |
| `query_entities/1`      | `query_entities(query :: entity_query()) :: {:ok, [entity_row()]}`                | SELECT with type filter, `json_extract` predicates, permission JOINs, and pagination.     |
| `get_entity_last_gsn/1` | `get_entity_last_gsn(id :: String.t()) :: {:ok, non_neg_integer()} \| :not_found` | Returns the `last_gsn` for an entity (used by Entity Store to determine delta start).     |

#### Actor Operations

| Name             | Signature                                     | Description                                       |
| ---------------- | --------------------------------------------- | ------------------------------------------------- |
| `ensure_actor/1` | `ensure_actor(actor_id :: String.t()) :: :ok` | INSERT OR IGNORE into `actors` table. Idempotent. |

#### Function Version Operations

| Name                        | Signature                                                                            | Description                                     |
| --------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------- |
| `get_active_function/1`     | `get_active_function(name :: String.t()) :: {:ok, function_version()} \| :not_found` | Returns the active version of a named function. |
| `upsert_function_version/1` | `upsert_function_version(fv :: function_version()) :: :ok`                           | INSERT OR REPLACE a function version record.    |

### Types

```elixir
@type entity_row :: %{
  id: String.t(),
  type: String.t(),
  data: String.t(),           # JSON string
  created_hlc: non_neg_integer(),
  updated_hlc: non_neg_integer(),
  deleted_hlc: non_neg_integer() | nil,
  deleted_by: String.t() | nil,
  last_gsn: non_neg_integer()
}

@type entity_query :: %{
  type: String.t(),
  filter: map() | nil,        # Translated to json_extract WHERE clauses
  actor_id: String.t(),       # For permission JOIN
  limit: non_neg_integer() | nil,
  offset: non_neg_integer() | nil
}

@type function_version :: %{
  id: String.t(),
  name: String.t(),
  version: String.t(),
  code: String.t(),
  input_schema: String.t() | nil,
  output_schema: String.t() | nil,
  status: String.t(),         # "pending" | "active" | "previous"
  created_at: non_neg_integer(),
  activated_at: non_neg_integer() | nil
}
```

## Dependencies

None. This is a leaf component -- it depends only on the `exqlite` hex package.

## Internal Design Notes

**Connection management:** Use a single SQLite connection (not a pool). SQLite WAL mode allows concurrent readers, but ebb's write pattern is single-threaded (only Entity Store writes, and it serializes through its GenServer). A single connection avoids `SQLITE_BUSY` contention.

**Prepared statements:** Prepare and cache the most frequent statements at startup:

- Entity UPSERT
- Entity SELECT by ID
- Entity SELECT by type (base query, extended with dynamic WHERE clauses)
- Entity `last_gsn` lookup

**Permission JOIN for `query_entities`:** The query builds a JOIN path:

```sql
SELECT e.* FROM entities e
INNER JOIN entities r ON r.type = 'relationship'
  AND r.source_id = e.id
  AND r.deleted_hlc IS NULL
INNER JOIN entities gm ON gm.type = 'groupMember'
  AND gm.group_id = r.target_id
  AND gm.actor_id = ?
  AND gm.deleted_hlc IS NULL
WHERE e.type = ?
  AND e.deleted_hlc IS NULL
  -- dynamic json_extract predicates appended here
```

**Filter translation:** The `filter` map from `ctx.query(type, filter)` is translated to `json_extract(data, '$.fields.<field>.value')` WHERE clauses. Only simple equality and comparison operators are supported initially. The filter map structure matches what the Bun server sends over HTTP.

**PRAGMAs (set on open):**

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA cache_size = -64000;    -- 64MB
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;
```

`synchronous = NORMAL` (not `FULL`) is acceptable because SQLite is a cache, not the source of truth. If SQLite data is lost, it can be rematerialized from RocksDB.

## Open Questions

- **Connection pooling for reads:** If `ctx.query()` latency becomes a bottleneck under high concurrency, consider a read-only connection pool (SQLite WAL supports concurrent readers). Start with a single connection and measure.
- **Filter operator set:** What filter operators does `ctx.query()` support beyond equality? The spec mentions `json_extract()` predicates but doesn't enumerate operators. Start with `=`, `!=`, `>`, `<`, `>=`, `<=` and add more as the client SDK defines them.
- **Generated column overhead:** The 7 generated columns on the `entities` table add overhead to every UPSERT. If profiling shows this is significant, consider moving system entity queries to ETS-only (they're already cached there) and dropping the generated columns.
