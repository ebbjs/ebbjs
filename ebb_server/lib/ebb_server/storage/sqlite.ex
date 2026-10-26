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

  alias Exqlite.Sqlite3

  # ---------------------------------------------------------------------------
  # SQL constants
  # ---------------------------------------------------------------------------

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

  `meta` carries the row's non-JSON columns: `:type`, `:updated_hlc`,
  `:deleted_hlc`, `:deleted_by`, and `:last_gsn`. `created_hlc` is not
  touched by an update. An empty `fields` map performs a metadata-only
  update.

  Like `upsert_entity/2`, the write is monotonic in `last_gsn`: the row is
  only updated when its current `last_gsn` is less than or equal to the
  patch's. A lower `last_gsn` is rejected and the row is left alone.
  """
  @spec patch_entity(String.t(), %{String.t() => String.t()}, map(), GenServer.server()) :: :ok
  def patch_entity(entity_id, fields, meta, server \\ __MODULE__) do
    GenServer.call(server, {:patch_entity, entity_id, fields, meta})
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
    :ok = Sqlite3.execute(db, @create_cursors_table)

    # Prepare cached statements
    {:ok, upsert_stmt} = Sqlite3.prepare(db, @upsert_sql)
    {:ok, get_entity_stmt} = Sqlite3.prepare(db, @get_entity_sql)
    {:ok, get_last_gsn_stmt} = Sqlite3.prepare(db, @get_last_gsn_sql)
    {:ok, get_cursor_stmt} = Sqlite3.prepare(db, @get_cursor_sql)
    {:ok, put_cursor_stmt} = Sqlite3.prepare(db, @put_cursor_sql)

    state = %{
      db: db,
      stmts: %{
        upsert: upsert_stmt,
        get_entity: get_entity_stmt,
        get_last_gsn: get_last_gsn_stmt,
        get_cursor: get_cursor_stmt,
        put_cursor: put_cursor_stmt
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
    :ok = Sqlite3.reset(stmt)

    {:reply, :ok, state}
  end

  @impl true
  def handle_call({:patch_entity, id, fields, meta}, _from, state) do
    %{db: db} = state

    pairs =
      fields
      |> Enum.sort_by(fn {name, _json} -> name end)
      |> Enum.map(fn {name, json} -> {"$.fields." <> name, json} end)

    {data_clause, data_params} =
      case pairs do
        [] ->
          {"", []}

        _ ->
          placeholders = Enum.map_join(pairs, "", fn _ -> ", ?, json(?)" end)
          params = Enum.flat_map(pairs, fn {path, json} -> [path, json] end)
          {"data = json_set(data" <> placeholders <> "), ", params}
      end

    sql =
      "UPDATE entities SET " <>
        data_clause <>
        "type = ?, updated_hlc = ?, deleted_hlc = ?, deleted_by = ?, last_gsn = ? " <>
        "WHERE id = ? AND last_gsn <= ?"

    params =
      data_params ++
        [
          meta.type,
          meta.updated_hlc,
          meta.deleted_hlc,
          meta.deleted_by,
          meta.last_gsn,
          id,
          meta.last_gsn
        ]

    {:ok, stmt} = Sqlite3.prepare(db, sql)
    :ok = Sqlite3.bind(stmt, params)
    :done = Sqlite3.step(db, stmt)
    :ok = Sqlite3.reset(stmt)
    Sqlite3.release(db, stmt)

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
    %{db: db} = state

    {filter_sql, filter_params} = build_filter_clauses(query[:filter])

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

    # Offset pagination needs a total order, so `id` breaks `created_hlc` ties
    # within a millisecond. DISTINCT collapses the membership join's one row per
    # shared group.
    sql = base_sql <> filter_sql <> " ORDER BY e.created_hlc, e.id"

    {sql, pagination_params} =
      case {query[:limit], query[:offset]} do
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

  @doc """
  Queries entities of a given type with permission JOINs and optional filters.

  Returns `{:ok, [entity_maps]}`.
  """
  @spec query_entities(map(), GenServer.server()) :: {:ok, [map()]}
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

  defp build_filter_clauses(nil), do: {"", []}
  defp build_filter_clauses(filter) when filter == %{}, do: {"", []}

  defp build_filter_clauses(filter) do
    Enum.reduce(filter, {[], []}, fn {field, value}, {clauses, params} ->
      if safe_field_name?(field) do
        clause = " AND json_extract(e.data, '$.fields.#{field}.value') = ?"
        {[clause | clauses], [convert_filter_value(value) | params]}
      else
        raise "Unsafe field name: #{inspect(field)}"
      end
    end)
    |> then(fn {clauses, params} -> {Enum.join(Enum.reverse(clauses)), Enum.reverse(params)} end)
  end

  defp convert_filter_value(true), do: 1
  defp convert_filter_value(false), do: 0
  defp convert_filter_value(value), do: value

  defp safe_field_name?(name) when is_binary(name) do
    Regex.match?(~r/^[a-zA-Z_][a-zA-Z0-9_]*$/, name)
  end

  defp collect_rows(db, stmt, acc) do
    case Sqlite3.step(db, stmt) do
      {:row, row} -> collect_rows(db, stmt, [row_to_entity(row) | acc])
      :done -> Enum.reverse(acc)
    end
  end

  defp collect_pairs(state, sql, params) do
    %{db: db} = state

    {:ok, stmt} = Sqlite3.prepare(db, sql)
    :ok = Sqlite3.bind(stmt, params)

    pairs = collect_pair_rows(db, stmt, [])
    Sqlite3.release(db, stmt)

    pairs
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
