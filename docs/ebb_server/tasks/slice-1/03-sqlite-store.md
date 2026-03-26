# Phase 3: SQLite Store

> **Slice:** [01 — Single Action Write + Read-Back](../../slices/01-single-action-write-read.md)
> **Depends on:** [Phase 1 — Project Scaffold](01-project-scaffold.md)
> **Produces:** `EbbServer.Storage.SQLite` GenServer with entity UPSERT/SELECT and unit tests

---

## Task 9. GenServer with DDL and PRAGMAs

**Files:** `ebb_server/lib/ebb_server/storage/sqlite.ex` (create)

Create `EbbServer.Storage.SQLite` as a GenServer.

**`init/1`:**
- Accept `opts` keyword list with `:data_dir` key
- Ensure directory exists: `File.mkdir_p!(data_dir)`
- Build path: `Path.join(data_dir, "ebb.db")`
- Open: `{:ok, db} = Exqlite.Sqlite3.open(path)`
- Run PRAGMAs via `Exqlite.Sqlite3.execute/2`:
  ```sql
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA cache_size = -64000;
  PRAGMA busy_timeout = 5000;
  PRAGMA foreign_keys = ON;
  ```
- Run DDL (entities table):
  ```sql
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
    actor_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.actor_id')) STORED,
    group_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.group_id')) STORED,
    permissions TEXT GENERATED ALWAYS AS (json_extract(data, '$.permissions')) STORED
  );
  ```
- Run index DDL:
  ```sql
  CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type) WHERE deleted_hlc IS NULL;
  CREATE INDEX IF NOT EXISTS idx_entities_type_gsn ON entities(type, last_gsn);
  ```
- Prepare and cache statements in state:
  - `:upsert_stmt` → `INSERT OR REPLACE INTO entities (id, type, data, created_hlc, updated_hlc, deleted_hlc, deleted_by, last_gsn) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  - `:get_entity_stmt` → `SELECT id, type, data, created_hlc, updated_hlc, deleted_hlc, deleted_by, last_gsn FROM entities WHERE id = ?`
  - `:get_last_gsn_stmt` → `SELECT last_gsn FROM entities WHERE id = ?`
- Return `{:ok, %{db: db, stmts: %{upsert: upsert_stmt, get_entity: get_entity_stmt, get_last_gsn: get_last_gsn_stmt}}}`

**`terminate/2`:**
- Close the database: `Exqlite.Sqlite3.close(db)`

**`start_link/1`:**
- `GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))`
- Accept an optional `:name` in opts for test isolation.

---

## Task 10. Entity operations

**Files:** `ebb_server/lib/ebb_server/storage/sqlite.ex` (modify)

Add `handle_call` clauses and public API functions. Each public function accepts an optional `server` argument defaulting to `__MODULE__` for test isolation.

**`upsert_entity(entity_row, server \\ __MODULE__)`:**
- Public function: `GenServer.call(server, {:upsert_entity, entity_row})`
- `handle_call({:upsert_entity, entity_row}, _from, state)`:
  - Bind the prepared `:upsert_stmt` with values: `[entity_row.id, entity_row.type, entity_row.data, entity_row.created_hlc, entity_row.updated_hlc, entity_row.deleted_hlc, entity_row.deleted_by, entity_row.last_gsn]`
  - Use `Exqlite.Sqlite3.bind/2` then `Exqlite.Sqlite3.step/2` (expect `:done`)
  - Reset the statement with `Exqlite.Sqlite3.reset/1`
  - Reply `:ok`

**`get_entity(id, server \\ __MODULE__)`:**
- Public function: `GenServer.call(server, {:get_entity, id})`
- `handle_call({:get_entity, id}, _from, state)`:
  - Bind `:get_entity_stmt` with `[id]`
  - Step: if `{:row, row}` → parse row into map `%{id: ..., type: ..., data: ..., created_hlc: ..., updated_hlc: ..., deleted_hlc: ..., deleted_by: ..., last_gsn: ...}`
  - If `:done` → `:not_found`
  - Reset statement
  - Reply `{:ok, entity_map}` or `:not_found`

**`get_entity_last_gsn(id, server \\ __MODULE__)`:**
- Public function: `GenServer.call(server, {:get_entity_last_gsn, id})`
- `handle_call({:get_entity_last_gsn, id}, _from, state)`:
  - Bind `:get_last_gsn_stmt` with `[id]`
  - Step: if `{:row, [last_gsn]}` → reply `{:ok, last_gsn}`
  - If `:done` → reply `:not_found`
  - Reset statement

---

## Task 11. Unit tests

**Files:** `ebb_server/test/ebb_server/storage/sqlite_test.exs` (create)

Each test starts its own SQLite GenServer with a unique tmp_dir and a unique name, and stops it in `on_exit`.

**Test cases:**

1. **DDL runs without error:**
   - Start SQLite GenServer with tmp_dir, verify it starts
   - Verify entities table exists (query `sqlite_master`)

2. **Upsert and get round-trip:**
   - Upsert an entity row: `%{id: "todo_abc", type: "todo", data: "{\"fields\":{}}", created_hlc: 1000, updated_hlc: 1000, deleted_hlc: nil, deleted_by: nil, last_gsn: 1}`
   - `get_entity("todo_abc")` → returns the same data
   - `get_entity("nonexistent")` → `:not_found`

3. **get_entity_last_gsn:**
   - After upsert with `last_gsn: 5`, `get_entity_last_gsn("todo_abc")` → `{:ok, 5}`
   - `get_entity_last_gsn("nonexistent")` → `:not_found`

4. **Upsert replaces existing:**
   - Upsert entity with `last_gsn: 1`, then upsert same ID with `last_gsn: 2`
   - `get_entity` returns `last_gsn: 2`

5. **Generated columns work:**
   - Upsert entity with `data: "{\"source_id\": \"src_1\", \"target_id\": \"tgt_1\"}"`
   - Query the raw row and verify generated columns are populated

---

## Verification

```bash
cd ebb_server && mix test test/ebb_server/storage/sqlite_test.exs
```

All 5 test cases pass. SQLite opens, runs DDL, upserts, selects, and generated columns work.
