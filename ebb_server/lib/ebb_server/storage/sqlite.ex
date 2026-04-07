defmodule EbbServer.Storage.SQLite do
  @moduledoc """
  GenServer that owns the SQLite database lifecycle for entity storage.

  On init, opens an SQLite database, runs PRAGMAs and DDL, and prepares
  cached statements for entity UPSERT/SELECT operations. All reads and
  writes are routed through `GenServer.call` using the prepared statements.

  All public functions accept an optional `server` argument (defaulting to
  `__MODULE__`) so that tests can run multiple isolated instances concurrently.
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

  @create_indexes """
  CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type) WHERE deleted_hlc IS NULL;
  CREATE INDEX IF NOT EXISTS idx_entities_type_gsn ON entities(type, last_gsn);
  CREATE INDEX IF NOT EXISTS idx_entities_source_id ON entities(source_id) WHERE type = 'relationship' AND deleted_hlc IS NULL;
  CREATE INDEX IF NOT EXISTS idx_entities_group_member ON entities(group_id, actor_id) WHERE type = 'groupMember' AND deleted_hlc IS NULL;
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
  """

  @get_entity_sql """
  SELECT id, type, data, created_hlc, updated_hlc, deleted_hlc, deleted_by, last_gsn
  FROM entities WHERE id = ?
  """

  @get_last_gsn_sql "SELECT last_gsn FROM entities WHERE id = ?"

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

  `entity_row` must be a map with keys: `:id`, `:type`, `:data`,
  `:created_hlc`, `:updated_hlc`, `:deleted_hlc`, `:deleted_by`, `:last_gsn`.
  """
  @spec upsert_entity(map(), GenServer.server()) :: :ok
  def upsert_entity(entity_row, server \\ __MODULE__) do
    GenServer.call(server, {:upsert_entity, entity_row})
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

    # Schema migration check
    migrate_schema(db)

    # DDL
    :ok = Sqlite3.execute(db, @create_entities_table)
    :ok = Sqlite3.execute(db, @create_indexes)

    # Prepare cached statements
    {:ok, upsert_stmt} = Sqlite3.prepare(db, @upsert_sql)
    {:ok, get_entity_stmt} = Sqlite3.prepare(db, @get_entity_sql)
    {:ok, get_last_gsn_stmt} = Sqlite3.prepare(db, @get_last_gsn_sql)

    state = %{
      db: db,
      stmts: %{
        upsert: upsert_stmt,
        get_entity: get_entity_stmt,
        get_last_gsn: get_last_gsn_stmt
      }
    }

    {:ok, state}
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

  @doc """
  Queries entities of a given type with permission JOINs and optional filters.

  Returns `{:ok, [entity_maps]}`.
  """
  @spec query_entities(map(), GenServer.server()) :: {:ok, [map()]}
  def query_entities(query, server \\ __MODULE__) do
    GenServer.call(server, {:query_entities, query})
  end

  @impl true
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

  @impl true
  def terminate(_reason, %{db: db, stmts: stmts}) do
    # Release all prepared statements before closing
    Enum.each(Map.values(stmts), fn stmt ->
      Sqlite3.release(db, stmt)
    end)

    Sqlite3.close(db)
  end

  # ---------------------------------------------------------------------------
  # Schema migration
  # ---------------------------------------------------------------------------

  defp migrate_schema(db) do
    case Sqlite3.prepare(
           db,
           "SELECT sql FROM sqlite_master WHERE type='table' AND name='entities'"
         ) do
      {:ok, stmt} ->
        result = check_schema_migration_needed(db, stmt)
        Sqlite3.release(db, stmt)
        if result == :needs_migration, do: Sqlite3.execute(db, "DROP TABLE entities")
        result

      _ ->
        :ok
    end
  end

  defp check_schema_migration_needed(db, stmt) do
    case Sqlite3.step(db, stmt) do
      {:row, [create_sql]} ->
        needs_migration?(create_sql)

      :done ->
        :ok
    end
  end

  defp needs_migration?(create_sql) when is_binary(create_sql) do
    if String.contains?(create_sql, "json_extract(data, '$.actor_id')") &&
         not String.contains?(create_sql, "$.fields.actor_id.value") do
      :needs_migration
    else
      :ok
    end
  end

  defp needs_migration?(_), do: :ok

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
