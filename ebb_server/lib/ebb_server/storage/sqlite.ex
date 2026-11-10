defmodule EbbServer.Storage.SQLite do
  @moduledoc """
  Owns the SQLite database that serves as the read-optimized materialized
  entity cache.

  ## Why this exists

  RocksDB (the write path) has no efficient per-attribute query API.
  Reads of the form "entities of type X where field Y satisfies predicate
  P, joined against the actor's group membership" are exactly what SQLite
  is built for. The cache is **rebuildable** from `cf_actions` +
  `cf_group_actions`; RocksDB is the source of truth, SQLite is the
  materialization.

  This module is the only place that talks to `exqlite`. Every other
  storage module goes through this one for entity materialization and
  read queries.

  ## Lifecycle

  On init, opens the SQLite database with PRAGMAs (WAL mode, 64MB cache,
  5s busy timeout, foreign keys on) and runs the DDL to create or migrate
  the schema. All reads and writes are routed through `GenServer.call`
  using cached statements.

  ## Schema (managed here)

  Generated columns extract field values from the per-entity JSON `data`
  so that `WHERE` clauses can reference them via `json_extract` without
  parsing JSON at read time. Field values live at `data.fields.X.value`.
  A separate `cursors` table holds durable named consumer cursors (Action
  export today, peer replication later).

  ## Component existence

  A materialized row's `data.components` is the canonical, sorted list of
  `<model>/<field>` names derived from `data.fields`. It is written by
  `EbbServer.Storage.EntityStore` alongside the fields and is not part of the
  wire shape: `EbbServer.Storage.EntityView` projects it away.

  `entity_components` mirrors that list one row per `(entity, component)` so
  "which live rows hold component X" is an index lookup rather than a JSON
  scan. Tombstoned rows keep their component rows; the reader joins
  `entities` and filters `deleted_hlc IS NULL`. The mirror is replaced in the
  same GenServer call as the row write, on the lazy materialization path — not
  on the Writer's commit path — so the component-index write measurement does
  not include it.

  The obvious single-table form — an expression index over
  `json_each(data, '$.components')` — is not implementable: `json_each` is a
  table-valued function, and SQLite refuses it in an index expression. The
  derived `data.components` column plus this normalized mirror is the
  amendment.

  ## Reads vs. writes

  This module is read+upsert against the entity cache, plus the small
  `cursors` table of durable consumer positions (Action export today, peer
  replication later). The Writer commits to RocksDB and triggers on-demand
  materialization in this module via `upsert_entity/1` /
  `upsert_entities/1`. We never write to SQLite on the hot write path —
  that goes through RocksDB and fans out to materialization after commit;
  a cursor write happens off the commit path, on the consumer's own poll.

  ## Isolated instances

  Every accessor takes an optional `server` (default `__MODULE__`) so
  concurrent tests can run multiple isolated DBs.
  """

  use GenServer

  alias EbbServer.Storage.QueryFilter
  alias Exqlite.Sqlite3

  # ---------------------------------------------------------------------------
  # SQL constants
  # ---------------------------------------------------------------------------

  # SQLite binds a window as signed 64-bit integers; a larger offset raises in
  # the NIF rather than returning an error a caller can handle.
  @max_offset 0x7FFFFFFFFFFFFFFF

  @pragmas """
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA cache_size = -64000;
  PRAGMA busy_timeout = 5000;
  PRAGMA foreign_keys = ON;
  """

  # Generated columns extract field values from entity `data` JSON.
  # Field values live at `data.fields.X.value`.
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
    source_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.fields.source_id.value')) STORED,
    target_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.fields.target_id.value')) STORED,
    rel_type TEXT GENERATED ALWAYS AS (json_extract(data, '$.fields.type.value')) STORED,
    rel_field TEXT GENERATED ALWAYS AS (json_extract(data, '$.fields.field.value')) STORED,
    actor_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.fields.actor_id.value')) STORED,
    entity_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.fields.entity_id.value')) STORED,
    group_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.fields.group_id.value')) STORED,
    permissions TEXT GENERATED ALWAYS AS (json_extract(data, '$.fields.permissions.value')) STORED
  );
  """

  @create_indexes """
  CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type) WHERE deleted_hlc IS NULL;
  CREATE INDEX IF NOT EXISTS idx_entities_type_gsn ON entities(type, last_gsn);
  CREATE INDEX IF NOT EXISTS idx_entities_source_id ON entities(source_id) WHERE type = 'relationship' AND deleted_hlc IS NULL;
  CREATE INDEX IF NOT EXISTS idx_entities_group_member ON entities(group_id, actor_id) WHERE type = 'groupMember' AND deleted_hlc IS NULL;
  CREATE INDEX IF NOT EXISTS idx_entities_entity_group ON entities(entity_id, group_id) WHERE type = 'entityGroup' AND deleted_hlc IS NULL;
  CREATE INDEX IF NOT EXISTS idx_entities_entity_group_page ON entities(group_id, id) WHERE type = 'entityGroup' AND deleted_hlc IS NULL;
  """

  @create_entity_components_table """
  CREATE TABLE IF NOT EXISTS entity_components (
    entity_id TEXT NOT NULL,
    component TEXT NOT NULL,
    PRIMARY KEY (entity_id, component)
  );
  """

  # The PK prefix covers deletes and replacement for one entity; this index
  # answers the by-component read the table exists for.
  @create_entity_components_indexes """
  CREATE INDEX IF NOT EXISTS idx_entity_components_component
    ON entity_components(component, entity_id);
  """

  @delete_entity_components_sql "DELETE FROM entity_components WHERE entity_id = ?"

  @insert_entity_component_sql """
  INSERT OR IGNORE INTO entity_components (entity_id, component) VALUES (?, ?)
  """

  @upsert_sql """
  INSERT INTO entities (id, type, data, created_hlc, updated_hlc, deleted_hlc, deleted_by, last_gsn)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    type = excluded.type,
    data = excluded.data,
    updated_hlc = excluded.updated_hlc,
    deleted_hlc = excluded.deleted_hlc,
    deleted_by = excluded.deleted_by,
    last_gsn = excluded.last_gsn
  WHERE excluded.last_gsn >= entities.last_gsn
  """

  @get_entity_sql """
  SELECT id, type, data, created_hlc, updated_hlc, deleted_hlc, deleted_by, last_gsn
  FROM entities WHERE id = ?
  """

  @get_last_gsn_sql "SELECT last_gsn FROM entities WHERE id = ?"

  # Reads the by-component side table rather than parsing `data.components`,
  # so a tombstone that keeps its component rows is filtered by the join.
  # `INDEXED BY` pins the plan on a database that is never `ANALYZE`d.
  @query_component_ids_sql """
  SELECT ec.entity_id
  FROM entity_components ec INDEXED BY idx_entity_components_component
  JOIN entities e ON e.id = ec.entity_id
  WHERE ec.component = ? AND e.deleted_hlc IS NULL
  ORDER BY ec.entity_id
  LIMIT ?
  """

  # Group-scoped listing pages (#476). Each query is the keyset for one phase
  # of `EbbServer.Sync.GroupListing`: group members are ordered by
  # `(actor_id, id)` through `idx_entities_group_member`, membership rows by
  # `id` through `idx_entities_entity_group_page`.
  @list_group_member_ids_sql """
  SELECT id, actor_id FROM entities
  WHERE type = 'groupMember' AND group_id = ? AND deleted_hlc IS NULL
  ORDER BY actor_id, id LIMIT ?
  """

  @list_group_member_ids_after_sql """
  SELECT id, actor_id FROM entities
  WHERE type = 'groupMember' AND group_id = ? AND deleted_hlc IS NULL
    AND (actor_id > ? OR (actor_id = ? AND id > ?))
  ORDER BY actor_id, id LIMIT ?
  """

  @list_entity_group_memberships_sql """
  SELECT id, entity_id FROM entities
  WHERE type = 'entityGroup' AND group_id = ? AND deleted_hlc IS NULL
  ORDER BY id LIMIT ?
  """

  @list_entity_group_memberships_after_sql """
  SELECT id, entity_id FROM entities
  WHERE type = 'entityGroup' AND group_id = ? AND deleted_hlc IS NULL AND id > ?
  ORDER BY id LIMIT ?
  """

  # Per-page relationship ids (#744). A relationship is scoped by its source
  # and never gets an `entityGroup` row of its own, so the membership keyset
  # above cannot name it; the page finds its rows by joining its own window
  # to `source_id`.
  #
  # The fence and the index hint are both load-bearing, and nothing in this
  # application runs `ANALYZE`. `AS MATERIALIZED` keeps the window on the
  # membership rows: left to flatten the subquery, SQLite applies it to the
  # joined rows, so one source with a large outgoing degree would fill the page
  # and drop every later source in the window. `INDEXED BY` makes the plan a
  # seek per window row; without it the shape is a scan of the whole live
  # relationship set on a database that has no statistics.
  #
  # The window is bounded by the membership rows the caller already read —
  # `id <=` the page's own last row — and there is deliberately no `LIMIT`.
  # Membership row ids are opaque, so a row committed between the caller's two
  # statements can land inside the window; a limit would then re-cut it and
  # drop the highest id, which is the page's own last source, leaving that
  # source's rows below the watermark where the tail never repairs them. A
  # source the page did not ship is discarded by the caller instead.
  @list_page_relationship_ids_sql """
  WITH page AS MATERIALIZED (
    SELECT entity_id FROM entities
    WHERE type = 'entityGroup' AND group_id = ? AND deleted_hlc IS NULL AND id <= ?
  )
  SELECT r.id
  FROM page m
  JOIN entities r INDEXED BY idx_entities_source_id
    ON r.source_id = m.entity_id AND r.type = 'relationship' AND r.deleted_hlc IS NULL
  """

  @list_page_relationship_ids_after_sql """
  WITH page AS MATERIALIZED (
    SELECT entity_id FROM entities
    WHERE type = 'entityGroup' AND group_id = ? AND deleted_hlc IS NULL
      AND id > ? AND id <= ?
  )
  SELECT r.id
  FROM page m
  JOIN entities r INDEXED BY idx_entities_source_id
    ON r.source_id = m.entity_id AND r.type = 'relationship' AND r.deleted_hlc IS NULL
  """

  # Generic durable consumer cursor. #367's Action export owns the
  # `"action_export"` row; peer replication (#113) will add its own.
  @create_cursors_table """
  CREATE TABLE IF NOT EXISTS cursors (name TEXT PRIMARY KEY, gsn INTEGER NOT NULL);
  """

  @get_cursor_sql "SELECT gsn FROM cursors WHERE name = ?"

  @put_cursor_sql """
  INSERT INTO cursors (name, gsn) VALUES (?, ?)
  ON CONFLICT(name) DO UPDATE SET gsn = excluded.gsn
  """

  # ---------------------------------------------------------------------------
  # Public API — start / stop
  # ---------------------------------------------------------------------------

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts) do
    name = Keyword.get(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, opts, name: name)
  end

  # ---------------------------------------------------------------------------
  # Public API — entity operations
  # ---------------------------------------------------------------------------

  @doc """
  Upserts an entity row into the entities table.

  The upsert is monotonic in `last_gsn`: it only advances a row, never
  regresses it. Concurrent materializations of the same dirty entity can
  finish out of order, and an older snapshot must not clobber a newer one.
  An equal `last_gsn` still applies, so rematerialization stays idempotent.

  `entity_row` must be a map with keys: `:id`, `:type`, `:data`,
  `:created_hlc`, `:updated_hlc`, `:deleted_hlc`, `:deleted_by`, `:last_gsn`.
  An optional `:components` list mirrors the row's sorted component names
  into `entity_components` in the same statement that writes the row.
  `created_hlc` is the row's creation time. A fresh data directory's schema
  refuses a row without one, and the repo discards old data rather than
  migrating it (#793 decision 9), so a materializer that loses the stamp
  fails there instead of storing a null the client has to interpret.
  """
  @spec upsert_entity(map(), GenServer.server()) :: :ok
  def upsert_entity(entity_row, server \\ __MODULE__) do
    GenServer.call(server, {:upsert_entity, entity_row})
  end

  @doc """
  Applies a per-key patch to an existing entity row with `json_set`.

  `fields` maps a JSON path relative to `$.fields.` to that path's
  already-encoded JSON value. A path is a top-level field name, optionally
  extended with `.map."<key>"` components to reach a key inside a map
  field. Each entry becomes a `json_set(data, '$.fields.<path>', json(?))`
  pair, so SQLite rewrites the `data` JSON in place and recomputes the
  STORED generated columns. The caller is responsible for quoting any map
  key and for rejecting a top-level field name that is not a safe JSON path
  component.

  `meta` carries the row's non-JSON columns — `:type`, `:created_hlc`,
  `:updated_hlc`, `:deleted_hlc`, `:deleted_by`, and `:last_gsn` — and each
  is written as given. The materializer replays a delta from the row it
  already holds, so `created_hlc` is the value that row was created with and
  a later patch restates it rather than moving the stamp. An empty `fields`
  map performs a metadata-only update, which is also the write form a
  zero-component row takes.

  Like `upsert_entity/2`, the write is monotonic in `last_gsn`: the row is
  only updated when its current `last_gsn` is less than or equal to the
  patch's. A lower `last_gsn` is rejected and the row is left alone.

  `components` is the row's sorted `<model>/<field>` list. It replaces the
  entity's `entity_components` rows inside the same GenServer call, and is
  written into `data.components` in the same `json_set` statement as the
  field patches, so the canonical JSON cannot go stale.
  """
  @spec patch_entity(
          String.t(),
          %{String.t() => String.t()},
          [String.t()],
          map(),
          GenServer.server()
        ) :: :ok
  def patch_entity(entity_id, fields, components, meta, server \\ __MODULE__) do
    GenServer.call(server, {:patch_entity, entity_id, fields, components, meta})
  end

  @doc """
  Fetches an entity by ID.

  Returns `{:ok, entity_map}` or `:not_found`.
  """
  @spec get_entity(String.t(), GenServer.server()) :: {:ok, map()} | :not_found
  def get_entity(id, server \\ __MODULE__) do
    GenServer.call(server, {:get_entity, id})
  end

  @doc """
  Fetches just the `last_gsn` for an entity by ID.

  Returns `{:ok, last_gsn}` or `:not_found`.
  """
  @spec get_entity_last_gsn(String.t(), GenServer.server()) :: {:ok, integer()} | :not_found
  def get_entity_last_gsn(id, server \\ __MODULE__) do
    GenServer.call(server, {:get_entity_last_gsn, id})
  end

  @doc """
  Lists the group's live `groupMember` rows in keyset order.

  Ordered by `(actor_id, id)`; `after_key` is `nil` to start from the
  beginning or the `{actor_id, id}` pair of the last row returned by a
  previous call. The pair, not `actor_id` alone, is the key so two
  membership rows for one actor cannot shadow each other at a page
  boundary.

  Returns `[{id, actor_id}]`.
  """
  @spec list_group_members(
          String.t(),
          {String.t(), String.t()} | nil,
          pos_integer(),
          GenServer.server()
        ) :: [{String.t(), String.t()}]
  def list_group_members(group_id, after_key, limit, server \\ __MODULE__) do
    GenServer.call(server, {:list_group_members, group_id, after_key, limit})
  end

  @doc """
  Lists the group's live `entityGroup` rows in keyset order.

  Ordered by row `id`; `after_key` is `nil` to start from the beginning or
  the last row id returned by a previous call.

  Returns `[{membership_id, entity_id}]`.
  """
  @spec list_entity_group_memberships(
          String.t(),
          String.t() | nil,
          pos_integer(),
          GenServer.server()
        ) :: [{String.t(), String.t()}]
  def list_entity_group_memberships(group_id, after_key, limit, server \\ __MODULE__) do
    GenServer.call(server, {:list_entity_group_memberships, group_id, after_key, limit})
  end

  @doc """
  Lists the live `relationship` row ids whose source an `entityGroup` row in
  the group's window names.

  The window is `(after_key, window_end]` over the membership keyset
  `list_entity_group_memberships/4` pages. It is bounded by the membership
  rows the caller already read rather than recomputed, so a row committed
  between the two calls cannot slide it, and it is not cut to a count: two
  membership rows can name one source, so an id can repeat and the caller
  dedupes. Rows are ids only: every row the listing ships is materialized and
  read through `get_entities/2`, and reading `data` twice would double that.
  """
  @spec list_page_relationship_ids(
          String.t(),
          String.t() | nil,
          String.t(),
          GenServer.server()
        ) :: {:ok, [String.t()]} | {:error, term()}
  def list_page_relationship_ids(group_id, after_key, window_end, server \\ __MODULE__) do
    GenServer.call(
      server,
      {:list_page_relationship_ids, group_id, after_key, window_end}
    )
  end

  @doc """
  Returns SQLite's `EXPLAIN QUERY PLAN` details for the per-page relationship
  statement, for the `after_key` variant a page would run.

  The statement names `idx_entities_source_id` on purpose, so a renamed or
  dropped index fails at prepare instead of quietly becoming a scan on a
  database that has never been `ANALYZE`d. This seam lets a test assert the
  plan itself rather than the SQL text.
  """
  @spec explain_page_relationship_ids(String.t() | nil, GenServer.server()) ::
          {:ok, [String.t()]} | {:error, term()}
  def explain_page_relationship_ids(after_key, server \\ __MODULE__) do
    GenServer.call(server, {:explain_page_relationship_ids, after_key})
  end

  @doc """
  Lists the live ids of entities holding `component`, ascending.

  Reads through `idx_entity_components_component` and joins `entities` so a
  tombstoned row, which keeps its component rows, is not returned. This is
  the read seam for #799; no wire query path uses it yet.
  """
  @spec query_component_ids(String.t(), pos_integer(), GenServer.server()) ::
          {:ok, [String.t()]} | {:error, term()}
  def query_component_ids(component, limit, server \\ __MODULE__) do
    GenServer.call(server, {:query_component_ids, component, limit})
  end

  @doc """
  Returns SQLite's `EXPLAIN QUERY PLAN` details for the component read.

  Like `explain_page_relationship_ids/2`, this seam lets a test assert the
  plan, rather than the SQL text, names `idx_entity_components_component`.
  """
  @spec explain_component_ids(String.t(), GenServer.server()) ::
          {:ok, [String.t()]} | {:error, term()}
  def explain_component_ids(component, server \\ __MODULE__) do
    GenServer.call(server, {:explain_component_ids, component})
  end

  @doc """
  Fetches multiple live entity rows by id.

  Rows deleted by tombstone are omitted, so the result can be shorter than
  the id list. Order is unspecified; callers that need an order index the
  result by `id`.
  """
  @spec get_entities([String.t()], GenServer.server()) :: [map()]
  def get_entities(ids, server \\ __MODULE__) do
    case Enum.uniq(ids) do
      [] -> []
      ids -> GenServer.call(server, {:get_entities, ids})
    end
  end

  # ---------------------------------------------------------------------------
  # Public API — durable consumer cursors
  # ---------------------------------------------------------------------------

  @doc """
  Reads a named durable cursor.

  Returns `:not_found` when the cursor has never been written, which a
  consumer should treat as "start from 0".
  """
  @spec get_cursor(String.t(), GenServer.server()) :: {:ok, non_neg_integer()} | :not_found
  def get_cursor(name, server \\ __MODULE__) do
    GenServer.call(server, {:get_cursor, name})
  end

  @doc """
  Writes a named durable cursor, upserting any existing value.
  """
  @spec put_cursor(String.t(), non_neg_integer(), GenServer.server()) :: :ok
  def put_cursor(name, gsn, server \\ __MODULE__) do
    GenServer.call(server, {:put_cursor, name, gsn})
  end

  @health_timeout 500

  @doc """
  Verifies that the cache accepts and answers a trivial statement.

  `EbbServer.Health` uses this to tell a live process from a usable one.
  The call is bounded so a suspended or wedged cache reports not-ready
  instead of blocking the readiness probe indefinitely.
  """
  @spec health(GenServer.server()) :: :ok | {:error, term()}
  def health(server \\ __MODULE__) do
    GenServer.call(server, :health, @health_timeout)
  end

  # ---------------------------------------------------------------------------
  # GenServer callbacks
  # ---------------------------------------------------------------------------

  @impl true
  def init(opts) do
    data_dir = Keyword.fetch!(opts, :data_dir)
    File.mkdir_p!(data_dir)

    path = Path.join(data_dir, "ebb.db")
    {:ok, db} = Sqlite3.open(path)

    # PRAGMAs
    :ok = Sqlite3.execute(db, @pragmas)

    # DDL
    :ok = Sqlite3.execute(db, @create_entities_table)
    :ok = Sqlite3.execute(db, @create_indexes)
    :ok = Sqlite3.execute(db, @create_entity_components_table)
    :ok = Sqlite3.execute(db, @create_entity_components_indexes)
    :ok = Sqlite3.execute(db, @create_cursors_table)

    # Prepare cached statements
    {:ok, upsert_stmt} = Sqlite3.prepare(db, @upsert_sql)
    {:ok, get_entity_stmt} = Sqlite3.prepare(db, @get_entity_sql)
    {:ok, get_last_gsn_stmt} = Sqlite3.prepare(db, @get_last_gsn_sql)
    {:ok, get_cursor_stmt} = Sqlite3.prepare(db, @get_cursor_sql)
    {:ok, put_cursor_stmt} = Sqlite3.prepare(db, @put_cursor_sql)
    {:ok, delete_components_stmt} = Sqlite3.prepare(db, @delete_entity_components_sql)
    {:ok, insert_component_stmt} = Sqlite3.prepare(db, @insert_entity_component_sql)

    state = %{
      db: db,
      stmts: %{
        upsert: upsert_stmt,
        get_entity: get_entity_stmt,
        get_last_gsn: get_last_gsn_stmt,
        get_cursor: get_cursor_stmt,
        put_cursor: put_cursor_stmt,
        delete_components: delete_components_stmt,
        insert_component: insert_component_stmt
      }
    }

    {:ok, state}
  end

  @impl true
  def handle_call(:health, _from, state) do
    {:reply, Sqlite3.execute(state.db, "SELECT 1"), state}
  end

  @impl true
  def handle_call({:upsert_entity, entity_row}, _from, state) do
    %{db: db, stmts: %{upsert: stmt}} = state

    values = [
      entity_row.id,
      entity_row.type,
      entity_row.data,
      entity_row.created_hlc,
      entity_row.updated_hlc,
      entity_row.deleted_hlc,
      entity_row.deleted_by,
      entity_row.last_gsn
    ]

    :ok = Sqlite3.bind(stmt, values)
    :done = Sqlite3.step(db, stmt)
    # A rejected stale upsert must not rewrite the index from its old row.
    applied? = write_applied?(db)
    :ok = Sqlite3.reset(stmt)

    if applied? do
      replace_entity_components(
        db,
        state.stmts,
        entity_row.id,
        Map.get(entity_row, :components, [])
      )
    end

    {:reply, :ok, state}
  end

  @impl true
  def handle_call({:patch_entity, id, fields, components, meta}, _from, state) do
    %{db: db} = state

    pairs =
      fields
      |> Enum.sort_by(fn {name, _json} -> name end)
      |> Enum.map(fn {name, json} -> {"$.fields." <> name, json} end)

    components_set = "'$.components', json(?)"

    {data_clause, data_params} =
      case pairs do
        [] ->
          {"data = json_set(data, " <> components_set <> "), ", []}

        _ ->
          placeholders = Enum.map_join(pairs, "", fn _ -> ", ?, json(?)" end)
          params = Enum.flat_map(pairs, fn {path, json} -> [path, json] end)

          {"data = json_set(data" <> placeholders <> ", " <> components_set <> "), ", params}
      end

    sql =
      "UPDATE entities SET " <>
        data_clause <>
        "type = ?, created_hlc = ?, updated_hlc = ?, deleted_hlc = ?, deleted_by = ?, " <>
        "last_gsn = ? WHERE id = ? AND last_gsn <= ?"

    params =
      data_params ++
        [
          Jason.encode!(components),
          meta.type,
          meta.created_hlc,
          meta.updated_hlc,
          meta.deleted_hlc,
          meta.deleted_by,
          meta.last_gsn,
          id,
          meta.last_gsn
        ]

    {:ok, stmt} = Sqlite3.prepare(db, sql)

    try do
      :ok = Sqlite3.bind(stmt, params)
      :done = Sqlite3.step(db, stmt)
      # A rejected stale patch must not rewrite the index from its old row.
      applied? = write_applied?(db)
      :ok = Sqlite3.reset(stmt)

      if applied?, do: replace_entity_components(db, state.stmts, id, components)
    after
      Sqlite3.release(db, stmt)
    end

    {:reply, :ok, state}
  end

  @impl true
  def handle_call({:get_entity, id}, _from, state) do
    %{db: db, stmts: %{get_entity: stmt}} = state

    :ok = Sqlite3.bind(stmt, [id])

    result =
      case Sqlite3.step(db, stmt) do
        {:row, row} -> {:ok, row_to_entity(row)}
        :done -> :not_found
      end

    :ok = Sqlite3.reset(stmt)

    {:reply, result, state}
  end

  @impl true
  def handle_call({:get_entity_last_gsn, id}, _from, state) do
    %{db: db, stmts: %{get_last_gsn: stmt}} = state

    :ok = Sqlite3.bind(stmt, [id])

    result =
      case Sqlite3.step(db, stmt) do
        {:row, [last_gsn]} -> {:ok, last_gsn}
        :done -> :not_found
      end

    :ok = Sqlite3.reset(stmt)

    {:reply, result, state}
  end

  @impl true
  def handle_call({:get_cursor, name}, _from, state) do
    %{db: db, stmts: %{get_cursor: stmt}} = state

    :ok = Sqlite3.bind(stmt, [name])

    result =
      case Sqlite3.step(db, stmt) do
        {:row, [gsn]} -> {:ok, gsn}
        :done -> :not_found
      end

    :ok = Sqlite3.reset(stmt)

    {:reply, result, state}
  end

  @impl true
  def handle_call({:put_cursor, name, gsn}, _from, state) do
    %{db: db, stmts: %{put_cursor: stmt}} = state

    :ok = Sqlite3.bind(stmt, [name, gsn])
    :done = Sqlite3.step(db, stmt)
    :ok = Sqlite3.reset(stmt)

    {:reply, :ok, state}
  end

  @impl true
  def handle_call({:query_component_ids, component, limit}, _from, state)
      when is_integer(limit) and limit > 0 do
    {:reply, collect_ids(state, @query_component_ids_sql, [component, limit]), state}
  end

  @impl true
  def handle_call({:query_component_ids, _component, _limit}, _from, state) do
    {:reply, {:error, :invalid_limit}, state}
  end

  @impl true
  def handle_call({:explain_component_ids, component}, _from, state) do
    {:reply, explain(state.db, @query_component_ids_sql, [component, 1]), state}
  end

  @impl true
  def handle_call({:list_group_members, group_id, after_key, limit}, _from, state) do
    {sql, params} =
      case after_key do
        nil ->
          {@list_group_member_ids_sql, [group_id, limit]}

        {actor_id, id} ->
          {@list_group_member_ids_after_sql, [group_id, actor_id, actor_id, id, limit]}
      end

    {:reply, collect_pairs(state, sql, params), state}
  end

  @impl true
  def handle_call({:list_entity_group_memberships, group_id, after_key, limit}, _from, state) do
    {sql, params} =
      case after_key do
        nil -> {@list_entity_group_memberships_sql, [group_id, limit]}
        id -> {@list_entity_group_memberships_after_sql, [group_id, id, limit]}
      end

    {:reply, collect_pairs(state, sql, params), state}
  end

  @impl true
  def handle_call({:list_page_relationship_ids, group_id, after_key, window_end}, _from, state) do
    {sql, params} = page_relationship_statement(group_id, after_key, window_end)

    {:reply, collect_ids(state, sql, params), state}
  end

  @impl true
  def handle_call({:explain_page_relationship_ids, after_key}, _from, state) do
    %{db: db} = state
    # An explain never runs the statement, so the window it is given only has
    # to bind: the plan is the answer.
    {sql, params} = page_relationship_statement(nil, after_key, nil)

    {:reply, explain(db, sql, params), state}
  end

  @impl true
  def handle_call({:get_entities, ids}, _from, state) do
    %{db: db} = state

    placeholders = Enum.map_join(ids, ",", fn _ -> "?" end)

    sql = """
    SELECT id, type, data, created_hlc, updated_hlc, deleted_hlc, deleted_by, last_gsn
    FROM entities WHERE id IN (#{placeholders}) AND deleted_hlc IS NULL
    """

    {:ok, stmt} = Sqlite3.prepare(db, sql)
    :ok = Sqlite3.bind(stmt, ids)
    rows = collect_rows(db, stmt, [])
    Sqlite3.release(db, stmt)

    {:reply, rows, state}
  end

  @impl true
  def handle_call({:query_entities, query}, _from, state) do
    case validate_window(query) do
      :ok -> do_query_entities(query, state)
      {:error, reason} -> {:reply, {:error, reason}, state}
    end
  end

  # A missing or non-positive limit is not a bound: SQLite reads both
  # `LIMIT NULL` and a negative limit as "no limit", and a missing key would
  # raise here and take the shared cache down. `EntityStore.query/4`
  # normalizes the window, so this only guards direct callers.
  defp validate_window(%{limit: limit} = query) when is_integer(limit) and limit > 0 do
    case Map.get(query, :offset) do
      nil -> :ok
      offset when is_integer(offset) and offset >= 0 and offset <= @max_offset -> :ok
      _offset -> {:error, :invalid_offset}
    end
  end

  defp validate_window(_query), do: {:error, :invalid_limit}

  defp do_query_entities(query, state) do
    case build_filter_clauses(query[:filter]) do
      {:ok, filter_sql, filter_params} ->
        run_query_entities(query, filter_sql, filter_params, state)

      {:error, :invalid_filter} = error ->
        {:reply, error, state}
    end
  end

  defp run_query_entities(query, filter_sql, filter_params, state) do
    %{db: db} = state

    # An empty permission list is how a membership is revoked
    # (`EbbServer.Storage.PermissionChecker` treats such a row as no
    # membership), so the join has to agree, or revocation would only cover
    # single-entity reads.
    base_sql = """
    SELECT DISTINCT e.id, e.type, e.data, e.created_hlc, e.updated_hlc, e.deleted_hlc, e.deleted_by, e.last_gsn
    FROM entities e
    INNER JOIN entities m ON m.type = 'entityGroup'
      AND m.entity_id = e.id
      AND m.deleted_hlc IS NULL
    INNER JOIN entities gm ON gm.type = 'groupMember'
      AND gm.group_id = m.group_id
      AND gm.actor_id = ?
      AND gm.deleted_hlc IS NULL
      AND COALESCE(json_array_length(gm.permissions), 0) > 0
    WHERE e.type = ?
      AND e.deleted_hlc IS NULL
    """

    # Offset pagination needs a total order. `created_hlc` is the row's
    # creation time and is never NULL, so `id` only breaks same-millisecond
    # ties. DISTINCT collapses the membership join's one row per shared group.
    # The page is always bounded: `LIMIT -1` is valid SQLite for "no limit", so
    # a missing bound must never reach the SQL.
    sql = base_sql <> filter_sql <> " ORDER BY e.created_hlc, e.id LIMIT ?"

    {sql, pagination_params} =
      case query[:offset] do
        nil -> {sql, [query.limit]}
        offset -> {sql <> " OFFSET ?", [query.limit, offset]}
      end

    params = [query.actor_id, query.type] ++ filter_params ++ pagination_params

    case run_prepared(db, sql, params) do
      {:ok, rows} -> {:reply, {:ok, rows}, state}
      {:error, reason} -> {:reply, {:error, reason}, state}
    end
  end

  # Every failure on the read path becomes a reply: this process is shared by
  # every tenant, so a statement SQLite refuses must not take it down.
  defp run_prepared(db, sql, params) do
    case Sqlite3.prepare(db, sql) do
      {:ok, stmt} ->
        try do
          with :ok <- Sqlite3.bind(stmt, params) do
            collect_query_rows(db, stmt, [])
          end
        rescue
          error -> {:error, error}
        after
          Sqlite3.release(db, stmt)
        end

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp collect_query_rows(db, stmt, acc) do
    case Sqlite3.step(db, stmt) do
      {:row, row} -> collect_query_rows(db, stmt, [row_to_entity(row) | acc])
      :done -> {:ok, Enum.reverse(acc)}
      :busy -> {:error, :busy}
      {:error, reason} -> {:error, reason}
    end
  end

  @doc """
  Queries entities of a given type with permission JOINs and optional filters.

  The query map must carry a `:limit`; `EbbServer.Storage.EntityStore.query/4`
  normalizes and bounds it. `:offset` is optional.

  Returns `{:ok, [entity_maps]}`, `{:error, :invalid_filter}`,
  `{:error, :invalid_limit}`, `{:error, :invalid_offset}` or
  `{:error, reason}`.
  """
  @spec query_entities(map(), GenServer.server()) ::
          {:ok, [map()]} | {:error, :invalid_filter | :invalid_limit | :invalid_offset | term()}
  def query_entities(query, server \\ __MODULE__) do
    GenServer.call(server, {:query_entities, query})
  end

  @impl true
  def terminate(_reason, %{db: db, stmts: stmts}) do
    # Release all prepared statements before closing
    Enum.each(Map.values(stmts), fn stmt ->
      Sqlite3.release(db, stmt)
    end)

    Sqlite3.close(db)
  end

  # ---------------------------------------------------------------------------
  # Query helpers
  # ---------------------------------------------------------------------------

  defp build_filter_clauses(filter) do
    with {:ok, normalized} <- QueryFilter.normalize(filter) do
      case normalized do
        nil ->
          {:ok, "", []}

        groups ->
          {group_sql, params} = Enum.map_reduce(groups, [], &group_clauses/2)

          {:ok, " AND (" <> Enum.join(group_sql, " OR ") <> ")", Enum.reverse(params)}
      end
    end
  end

  defp group_clauses(group, params) do
    {clauses, params} = Enum.reduce(group, {[], params}, &filter_clause/2)
    {"(" <> Enum.join(Enum.reverse(clauses), " AND ") <> ")", params}
  end

  # `json_extract` returns SQL NULL for a missing path and for a JSON null
  # alike, which is exactly "absent or tombstoned". Binding NULL into `= ?`
  # would compare as never true. A map field is a live value even when its
  # keys are tombstoned (clearing the whole field writes a leaf tombstone),
  # so the map envelope must not satisfy "no live value".
  defp filter_clause({field, nil}, {clauses, params}) do
    clause =
      "(" <>
        field_path(field) <>
        " IS NULL AND json_type(e.data, '$.fields." <> field <> ".map') IS NOT 'object')"

    {[clause | clauses], params}
  end

  defp filter_clause({field, value}, {clauses, params}) do
    {["#{field_path(field)} = ?" | clauses], [convert_filter_value(value) | params]}
  end

  defp field_path(field), do: "json_extract(e.data, '$.fields.#{field}.value')"

  defp convert_filter_value(true), do: 1
  defp convert_filter_value(false), do: 0
  defp convert_filter_value(value), do: value

  defp collect_rows(db, stmt, acc) do
    case Sqlite3.step(db, stmt) do
      {:row, row} -> collect_rows(db, stmt, [row_to_entity(row) | acc])
      :done -> Enum.reverse(acc)
    end
  end

  defp page_relationship_statement(group_id, nil, window_end) do
    {@list_page_relationship_ids_sql, [group_id, window_end]}
  end

  defp page_relationship_statement(group_id, after_key, window_end) do
    {@list_page_relationship_ids_after_sql, [group_id, after_key, window_end]}
  end

  # Statements that name an index are explained rather than run, so a renamed
  # or dropped index fails as a plan assertion instead of a silent scan.
  defp explain(db, sql, params) do
    case Sqlite3.prepare(db, "EXPLAIN QUERY PLAN " <> sql) do
      {:ok, stmt} ->
        try do
          with :ok <- Sqlite3.bind(stmt, params) do
            collect_plan_details(db, stmt, [])
          end
        rescue
          error -> {:error, error}
        after
          Sqlite3.release(db, stmt)
        end

      {:error, reason} ->
        {:error, reason}
    end
  end

  # `changes/1` reports the row count of the statement just stepped; a
  # monotonic guard that rejected the write leaves it at zero.
  defp write_applied?(db) do
    case Sqlite3.changes(db) do
      {:ok, count} -> count > 0
      _error -> false
    end
  end

  # Delete-then-insert keeps the mirror exactly equal to the row's list, so a
  # drop and an added component both converge on the same state.
  defp replace_entity_components(db, stmts, entity_id, components) do
    :ok = Sqlite3.bind(stmts.delete_components, [entity_id])
    :done = Sqlite3.step(db, stmts.delete_components)
    :ok = Sqlite3.reset(stmts.delete_components)

    Enum.each(components, fn component ->
      :ok = Sqlite3.bind(stmts.insert_component, [entity_id, component])
      :done = Sqlite3.step(db, stmts.insert_component)
      :ok = Sqlite3.reset(stmts.insert_component)
    end)

    :ok
  end

  defp collect_pairs(state, sql, params) do
    %{db: db} = state

    {:ok, stmt} = Sqlite3.prepare(db, sql)
    :ok = Sqlite3.bind(stmt, params)

    pairs = collect_pair_rows(db, stmt, [])
    Sqlite3.release(db, stmt)

    pairs
  end

  # Every failure on the read path becomes a reply: this process is shared by
  # every tenant, so a statement SQLite refuses must not take it down.
  defp collect_ids(state, sql, params) do
    %{db: db} = state

    case Sqlite3.prepare(db, sql) do
      {:ok, stmt} ->
        try do
          with :ok <- Sqlite3.bind(stmt, params) do
            collect_id_rows(db, stmt, [])
          end
        rescue
          error -> {:error, error}
        after
          Sqlite3.release(db, stmt)
        end

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp collect_id_rows(db, stmt, acc) do
    case Sqlite3.step(db, stmt) do
      {:row, [id]} -> collect_id_rows(db, stmt, [id | acc])
      :done -> {:ok, Enum.reverse(acc)}
      :busy -> {:error, :busy}
      {:error, reason} -> {:error, reason}
    end
  end

  defp collect_plan_details(db, stmt, acc) do
    case Sqlite3.step(db, stmt) do
      {:row, [_id, _parent, _unused, detail]} -> collect_plan_details(db, stmt, [detail | acc])
      :done -> {:ok, Enum.reverse(acc)}
      :busy -> {:error, :busy}
      {:error, reason} -> {:error, reason}
    end
  end

  defp collect_pair_rows(db, stmt, acc) do
    case Sqlite3.step(db, stmt) do
      {:row, [first, second]} -> collect_pair_rows(db, stmt, [{first, second} | acc])
      :done -> Enum.reverse(acc)
    end
  end

  # ---------------------------------------------------------------------------
  # Private helpers
  # ---------------------------------------------------------------------------

  defp row_to_entity([
         id,
         type,
         data,
         created_hlc,
         updated_hlc,
         deleted_hlc,
         deleted_by,
         last_gsn
       ]) do
    %{
      id: id,
      type: type,
      data: data,
      created_hlc: created_hlc,
      updated_hlc: updated_hlc,
      deleted_hlc: deleted_hlc,
      deleted_by: deleted_by,
      last_gsn: last_gsn
    }
  end
end
