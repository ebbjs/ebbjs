defmodule EbbServer.Bench.Materialize.Ablation do
  @moduledoc """
  Isolates the STORED generated-column cost with two throwaway SQLite tables.

  The app's `entities` table has eight `json_extract` STORED generated
  columns that SQLite recomputes on every upsert. Reproducing that cost on
  the live bench table would mean altering the production schema, so the
  ablation builds one table with the same eight columns and one without, in
  a private in-memory database, and upserts the same blob into each with the
  app's upsert SQL.
  """

  alias EbbServer.Bench.Materialize.{Stats, Workload}
  alias Exqlite.Sqlite3

  @base_columns """
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  data TEXT,
  created_hlc INTEGER NOT NULL,
  updated_hlc INTEGER NOT NULL,
  deleted_hlc INTEGER,
  deleted_by TEXT,
  last_gsn INTEGER NOT NULL
  """

  @generated_columns """
  , source_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.fields.source_id.value')) STORED
  , target_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.fields.target_id.value')) STORED
  , rel_type TEXT GENERATED ALWAYS AS (json_extract(data, '$.fields.type.value')) STORED
  , rel_field TEXT GENERATED ALWAYS AS (json_extract(data, '$.fields.field.value')) STORED
  , actor_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.fields.actor_id.value')) STORED
  , entity_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.fields.entity_id.value')) STORED
  , group_id TEXT GENERATED ALWAYS AS (json_extract(data, '$.fields.group_id.value')) STORED
  , permissions TEXT GENERATED ALWAYS AS (json_extract(data, '$.fields.permissions.value')) STORED
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

  @doc """
  Returns one row per size: the blob bytes and the median upsert time with
  and without the generated columns.
  """
  @spec run(EbbServer.Bench.Materialize.Options.t()) :: [map()]
  def run(%EbbServer.Bench.Materialize.Options{} = config) do
    for n <- config.sizes do
      blob = Workload.content_data(n, config.run_value_bytes) |> Jason.encode!()

      %{
        size: n,
        bytes: byte_size(blob),
        with_generated: upsert_time(blob, true, config.reps),
        without_generated: upsert_time(blob, false, config.reps)
      }
    end
  end

  defp upsert_time(blob, generated?, reps) do
    {:ok, db} = Sqlite3.open(":memory:")
    :ok = Sqlite3.execute(db, create_sql(generated?))
    {:ok, stmt} = Sqlite3.prepare(db, @upsert_sql)

    try do
      durations =
        for seq <- 1..reps do
          started_at = System.monotonic_time(:microsecond)
          :ok = Sqlite3.bind(stmt, ["mz_ablation", "todo", blob, 1, seq, nil, nil, seq])
          :done = Sqlite3.step(db, stmt)
          :ok = Sqlite3.reset(stmt)
          System.monotonic_time(:microsecond) - started_at
        end

      Stats.median(durations)
    after
      Sqlite3.release(db, stmt)
      Sqlite3.close(db)
    end
  end

  defp create_sql(true), do: "CREATE TABLE entities (#{@base_columns}#{@generated_columns});"
  defp create_sql(false), do: "CREATE TABLE entities (#{@base_columns});"
end
