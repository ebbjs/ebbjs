defmodule EbbServer.Storage.EntityStore do
  @moduledoc """
  Read interface for entity state with a zero-staleness guarantee: every
  `get/2` or `query/3` call sees writes that completed before the call,
  even if those writes have not been pre-materialized.

  ## On-demand materialization

  The split between RocksDB (write path) and SQLite (read path) creates
  a window where the materialized entity in SQLite does not reflect the
  most recent committed Action. Closing that window is the job of this
  module: a request checks `DirtyTracker`, and if the entity is dirty,
  replays only the delta since the entity's `last_gsn` from RocksDB,
  applies per-field typed merges, UPSERTs into SQLite, and clears only
  the dirty mark it observed — all before returning. We never replay
  full history.

  Clearing only the observed mark is what keeps this correct under
  concurrency. A writer can commit an Action and mark the entity dirty
  between this module's scan and its clear. An unconditional clear
  would erase that newer mark, leaving the entity clean at an old
  `last_gsn` with a committed Action unmaterialized; every later read
  would see a clean entity and serve stale data permanently. Reading the
  mark's generation before the scan and compare-and-clearing it leaves
  the newer mark in place, so the next read materializes the missing
  Action.

  Provisional marks extend that conservatism to the write path. The
  Writer stamps a batch `{:pending, generation}` before it attempts the
  commit and settles it to an ordinary dirty mark only once the commit
  returns. A materialization that observes a provisional mark replays the
  delta and returns, but leaves the mark for the Writer to resolve. A read
  that starts after the durable commit therefore sees a provisional or
  settled mark, never a clean entity with an unmaterialized commit behind
  it.

  Two materializations of the same dirty entity can also race each
  other, with the older scan finishing last and trying to write an older
  `last_gsn`. `SQLite.upsert_entity/2` is monotonic in `last_gsn`, so
  that stale write is rejected and the newer row stands. The losing
  materializer still returns its own snapshot — its call began before
  the newer commit — but the cache row and every later read converge.

  This module is **not** a GenServer. It composes the `EbbServer.Storage.SQLite`
  GenServer (for cached reads) and the `EbbServer.Storage.RocksDB` GenServer
  (for the source-of-truth reads during materialization), plus ETS reads
  from `DirtyTracker` and `EbbServer.Storage.EntityStore.GsnTracker`.

  ## Merge rules

  Per-field materialization follows the wire's last-writer-wins rule:
  see `EbbServer.Storage.FieldMerge`, which hand-mirrors
  `packages/core/src/types/action.ts`'s `mergeFieldValue`.

  ## Hot path

  Clean entities: one ETS check + one SQLite SELECT. Dirty entities:
  + one RocksDB range iterator + one `multi_get` + merge + one SQLite
  UPSERT + one ETS delete. The common case (most reads hit the cache)
  stays close to an SQLite SELECT.
  """

  alias EbbServer.Storage.{DirtyTracker, FieldMerge, PermissionHelper, RocksDB, SQLite}
  alias EbbServer.Telemetry

  @default_rocks_name EbbServer.Storage.RocksDB
  @default_sqlite_name EbbServer.Storage.SQLite
  @default_dirty_set :ebb_dirty_set

  @doc """
  Fetches an entity by ID, reading from SQLite cache or materializing on demand.

  This read is **not** permission-filtered. `actor_id` is part of the
  interface so read call sites stay uniform, but callers must authorize
  first with `PermissionChecker.can_read?/3` and report a denial the
  same as a missing entity (`:not_found`).

  Returns `{:ok, entity}`, `:not_found`, or `{:error, :materialization_failed}`.
  """
  @spec get(String.t(), String.t(), keyword()) ::
          {:ok, map()} | :not_found | {:error, :materialization_failed}
  def get(entity_id, _actor_id, opts \\ []) do
    rocks_name = Keyword.get(opts, :rocks_name, @default_rocks_name)
    sqlite_name = Keyword.get(opts, :sqlite_name, @default_sqlite_name)
    dirty_set = Keyword.get(opts, :dirty_set, @default_dirty_set)

    if DirtyTracker.dirty?(entity_id, dirty_set) do
      emit_cache_result(:miss, :dirty_materialize)

      materialize(entity_id,
        rocks_name: rocks_name,
        sqlite_name: sqlite_name,
        dirty_set: dirty_set
      )
    else
      emit_cache_result(:hit, :clean_hit)
      read_clean_entity(entity_id, sqlite_name)
    end
  end

  # A clean read is one SQLite SELECT plus a `Jason.decode!` of the row's blob;
  # the decode is the only O(entity-size) part, so it gets its own sample.
  defp read_clean_entity(entity_id, sqlite_name) do
    case SQLite.get_entity(entity_id, sqlite_name) do
      {:ok, row} ->
        started_at = System.monotonic_time()
        result = format_live_entity(row)
        emit_read_latency(:clean_hit, started_at, subject_id: entity_id, rows: [row])
        result

      :not_found ->
        :not_found
    end
  end

  defp emit_cache_result(result, path) do
    Telemetry.execute([:entity_store, :cache_hit_rate], %{count: 1}, %{
      result: result,
      path: path
    })
  end

  # `read_latency_ms` covers the pure decode on a clean point read and the
  # per-query decode pass, so the blob-JSON share of a read is a first-class
  # sample rather than being folded into materialize.
  defp emit_read_latency(path, started_at, opts) do
    rows = Keyword.get(opts, :rows, [])

    byte_size =
      Keyword.get(opts, :byte_size) || Enum.reduce(rows, 0, &(blob_byte_size(&1) + &2))

    Telemetry.execute(
      [:entity_store, :read_latency_ms],
      %{
        duration: System.monotonic_time() - started_at,
        byte_size: byte_size,
        row_count: length(rows)
      },
      %{path: path, subject_id: Keyword.get(opts, :subject_id)}
    )
  end

  # Counting map keys is itself O(N); the JSON blob byte size is free and is
  # the size proxy the catalogue promises. `data` is JSON text on rows read
  # back from SQLite and an already-decoded map on the materialize path.
  defp blob_byte_size(%{data: data}) when is_binary(data), do: byte_size(data)
  defp blob_byte_size(_row), do: 0

  # Dirty-path phases are emitted on success only; a phase that raises leaves
  # the segment unmeasured and the caller's rescue reports the failure.
  defp timed(phase, fun) do
    started_at = System.monotonic_time()
    result = fun.()
    emit_phase(phase, started_at)
    result
  end

  defp emit_phase(phase, started_at) do
    Telemetry.execute(
      [:entity_store, :materialize_phase_ms],
      %{duration: System.monotonic_time() - started_at},
      %{phase: phase}
    )
  end

  @doc """
  Materializes an entity by replaying actions from RocksDB into SQLite.

  This function is public for testability. It should not be called directly
  in normal operation — use `get/2` instead.

  Process:
  1. Read the dirty mark's generation
  2. Read current state from SQLite (or empty for new entities)
  3. Scan RocksDB cf_entity_actions for actions after last_gsn
  4. Replay each action's updates in GSN order
  5. Upsert materialized entity to SQLite
  6. Compare-and-clear the dirty mark with the observed generation

  ## Options

  - `:rocks_name` - RocksDB server name (default: `EbbServer.Storage.RocksDB`)
  - `:sqlite_name` - SQLite server name (default: `EbbServer.Storage.SQLite`)
  - `:dirty_set` - ETS table name for dirty tracking (default: `:ebb_dirty_set`)
  - `:after_scan` - test seam: a 0-arity fun invoked once after the RocksDB
    scan and before the result is handled. Tests use it to interleave a
    concurrent write with an in-flight materialization deterministically,
    with no sleeps.
  """
  @spec materialize(String.t(), keyword()) :: {:ok, map()} | :not_found | {:error, term()}
  def materialize(entity_id, opts \\ []) do
    started_at = System.monotonic_time()
    {result, byte_size} = do_materialize(entity_id, opts)

    subject_type =
      case result do
        {:ok, %{type: type}} -> type
        _ -> nil
      end

    Telemetry.execute(
      [:entity_store, :materialize_latency_ms],
      %{duration: System.monotonic_time() - started_at, byte_size: byte_size},
      %{subject_id: entity_id, subject_type: subject_type, path: :dirty_materialize}
    )

    result
  end

  defp do_materialize(entity_id, opts) do
    rocks_name = Keyword.get(opts, :rocks_name, @default_rocks_name)
    sqlite_name = Keyword.get(opts, :sqlite_name, @default_sqlite_name)
    dirty_set = Keyword.get(opts, :dirty_set, @default_dirty_set)
    after_scan = Keyword.get(opts, :after_scan)

    observed_generation = DirtyTracker.dirty_generation(entity_id, dirty_set)

    {current_data, last_gsn, existing_row, byte_size} =
      fetch_current_state(entity_id, sqlite_name)

    entries = fetch_relevant_entries(entity_id, rocks_name, last_gsn)

    if after_scan, do: after_scan.()

    result =
      if entries == [] do
        handle_empty_entries(entity_id, existing_row, observed_generation, dirty_set, sqlite_name)
      else
        apply_entries_and_persist(
          entity_id,
          current_data,
          entries,
          rocks_name,
          observed_generation,
          dirty_set,
          sqlite_name
        )
      end

    {result, byte_size}
  end

  defp fetch_current_state(entity_id, sqlite_name) do
    started_at = System.monotonic_time()

    case SQLite.get_entity(entity_id, sqlite_name) do
      {:ok, row} ->
        data = Jason.decode!(row.data)
        emit_phase(:fetch_decode, started_at)
        {data, row.last_gsn, row, blob_byte_size(row)}

      :not_found ->
        emit_phase(:fetch_decode, started_at)
        {%{"fields" => %{}}, 0, nil, 0}
    end
  end

  defp fetch_relevant_entries(entity_id, rocks_name, last_gsn) do
    RocksDB.prefix_iterator(RocksDB.cf_entity_actions(rocks_name), entity_id, name: rocks_name)
    |> Stream.map(fn {key, action_id_binary} ->
      {_eid, gsn} = RocksDB.decode_entity_gsn_key(key)
      {gsn, action_id_binary}
    end)
    |> Stream.filter(fn {gsn, _} -> gsn > last_gsn end)
    |> Enum.to_list()
    |> Enum.sort_by(fn {gsn, _} -> gsn end)
  end

  defp handle_empty_entries(entity_id, nil, observed_generation, dirty_set, _sqlite_name) do
    clear_settled(entity_id, observed_generation, dirty_set)
    :not_found
  end

  defp handle_empty_entries(
         entity_id,
         _existing_row,
         observed_generation,
         dirty_set,
         sqlite_name
       ) do
    clear_settled(entity_id, observed_generation, dirty_set)

    case SQLite.get_entity(entity_id, sqlite_name) do
      {:ok, row} -> format_live_entity(row)
      :not_found -> :not_found
    end
  end

  # A provisional mark means the Writer has a commit in flight: the entity is
  # not clean, but the mark belongs to the Writer, which settles it once the
  # commit returns. Clearing it here would reopen the clean-but-stale window
  # the mark exists to close.
  defp clear_settled(entity_id, observed, dirty_set) do
    if DirtyTracker.pending?(observed) do
      :ok
    else
      DirtyTracker.clear_dirty(entity_id, observed, dirty_set)
    end
  end

  defp apply_entries_and_persist(
         entity_id,
         current_data,
         entries,
         rocks_name,
         observed_generation,
         dirty_set,
         sqlite_name
       ) do
    materialized =
      try do
        actions = timed(:actions_load, fn -> load_actions(entries, rocks_name) end)
        {:ok, timed(:merge, fn -> replay(current_data, actions, entity_id) end)}
      rescue
        e ->
          {:error, e}
      end

    case materialized do
      {:ok, result} ->
        handle_materialized_result(
          entity_id,
          result,
          observed_generation,
          dirty_set,
          sqlite_name
        )

      {:error, _reason} ->
        {:error, :materialization_failed}
    end
  end

  defp handle_materialized_result(
         entity_id,
         result,
         observed_generation,
         dirty_set,
         sqlite_name
       ) do
    %{
      data: merged_data,
      type: type,
      created_hlc: created_hlc,
      updated_hlc: updated_hlc,
      deleted_hlc: deleted_hlc,
      deleted_by: deleted_by,
      max_gsn: max_gsn
    } = result

    # Persisting the tombstone is what stops a later clean read from reading
    # the old live row back out of the cache and resurrecting the entity.
    entity_row = %{
      id: entity_id,
      type: type || "unknown",
      data: timed(:encode, fn -> Jason.encode!(merged_data) end),
      created_hlc: created_hlc || updated_hlc,
      updated_hlc: updated_hlc,
      deleted_hlc: deleted_hlc,
      deleted_by: deleted_by,
      last_gsn: max_gsn
    }

    timed(:upsert, fn -> SQLite.upsert_entity(entity_row, sqlite_name) end)
    clear_settled(entity_id, observed_generation, dirty_set)

    # `merged_data` is already the decoded form; handing it to the formatter
    # avoids re-decoding `entity_row.data`, i.e. re-parsing the whole blob.
    timed(:format, fn -> format_live_entity(%{entity_row | data: merged_data}) end)
  end

  defp load_actions(entries, rocks_name) do
    keys = Enum.map(entries, fn {gsn, _action_id} -> RocksDB.encode_gsn_key(gsn) end)

    RocksDB.multi_get(RocksDB.cf_actions(rocks_name), keys, name: rocks_name)
    |> Enum.zip(entries)
    |> Enum.map(&decode_action/1)
  end

  defp decode_action({{:ok, action_etf}, {gsn, _action_id}}) do
    {gsn, :erlang.binary_to_term(action_etf, [:safe])}
  end

  defp decode_action({:not_found, {gsn, _action_id}}) do
    raise "cf_actions has no action at gsn #{gsn}"
  end

  defp replay(data, actions, entity_id) do
    initial_data = if is_map(data), do: data, else: %{"fields" => %{}}

    Enum.reduce(
      actions,
      %{
        data: initial_data,
        type: nil,
        created_hlc: nil,
        updated_hlc: 0,
        deleted_hlc: nil,
        deleted_by: nil,
        max_gsn: 0
      },
      fn {gsn, action}, acc ->
        relevant_updates =
          Enum.filter(action["updates"], fn update ->
            update["subject_id"] == entity_id
          end)

        apply_action(action, relevant_updates, gsn, acc)
      end
    )
  end

  defp apply_action(action, updates, gsn, acc) do
    Enum.reduce(updates, acc, fn update, inner_acc ->
      case update["method"] do
        "put" ->
          apply_put(action, update, gsn, inner_acc)

        "patch" ->
          apply_patch(action, update, gsn, inner_acc)

        "delete" ->
          apply_delete(action, update, gsn, inner_acc)

        _ ->
          inner_acc
      end
    end)
  end

  defp apply_put(action, update, gsn, acc) do
    hlc = action["hlc"]
    subject_type = update["subject_type"]

    fields_with_update_id =
      Enum.into(update["data"]["fields"] || %{}, %{}, fn {field_name, field_value} ->
        {field_name, FieldMerge.stamp(field_value, update["id"])}
      end)

    %{
      acc
      | data: %{"fields" => fields_with_update_id},
        type: subject_type,
        created_hlc: if(acc.created_hlc == nil, do: hlc, else: acc.created_hlc),
        updated_hlc: hlc,
        max_gsn: max(acc.max_gsn, gsn)
    }
  end

  defp apply_patch(action, update, gsn, acc) do
    hlc = action["hlc"]

    existing_fields =
      if is_map(acc.data) and Map.has_key?(acc.data, "fields"),
        do: acc.data["fields"],
        else: %{}

    merged_fields =
      Enum.reduce(update["data"]["fields"] || %{}, existing_fields, fn {field_name, new_field},
                                                                       existing_fields_map ->
        existing = Map.get(existing_fields_map, field_name)
        incoming = FieldMerge.stamp(new_field, update["id"])

        Map.put(existing_fields_map, field_name, FieldMerge.merge(existing, incoming))
      end)

    %{
      acc
      | data: %{"fields" => merged_fields},
        type: acc.type || update["subject_type"],
        created_hlc: acc.created_hlc,
        updated_hlc: hlc,
        max_gsn: max(acc.max_gsn, gsn),
        deleted_hlc: nil,
        deleted_by: nil
    }
  end

  defp apply_delete(action, _update, gsn, acc) do
    %{
      acc
      | deleted_hlc: action["hlc"],
        deleted_by: action["actor_id"],
        updated_hlc: action["hlc"],
        max_gsn: max(acc.max_gsn, gsn)
    }
  end

  defp format_live_entity(%{deleted_hlc: nil} = row), do: {:ok, format_entity(row)}
  defp format_live_entity(_row), do: :not_found

  # Callers that already hold the decoded map (materialize) pass it straight
  # through; SQLite rows carry JSON text and are decoded here.
  defp format_entity(%{data: data} = row) when is_map(data), do: row

  defp format_entity(%{data: nil} = row) do
    raise "Unexpected nil data for entity #{inspect(row.id)}"
  end

  defp format_entity(row) do
    %{row | data: Jason.decode!(row.data)}
  end

  @doc """
  Queries entities of a given type with permission filtering and optional field filters.

  First materializes any dirty entities of the requested type, then delegates to
  SQLite for the permission-checked query.

  ## Options
  - `:rocks_name` - RocksDB server name (default: `EbbServer.Storage.RocksDB`)
  - `:sqlite_name` - SQLite server name (default: `EbbServer.Storage.SQLite`)
  - `:dirty_set` - ETS table name for dirty tracking (default: `:ebb_dirty_set`)
  - `:limit` - Maximum results to return
  - `:offset` - Number of results to skip

  Returns `{:ok, [entity_maps]}` or `{:error, term()}`.
  """
  @spec query(String.t(), map() | nil, String.t(), keyword()) ::
          {:ok, [map()]} | {:error, term()}
  def query(type, filter, actor_id, opts \\ []) do
    rocks_name = Keyword.get(opts, :rocks_name, @default_rocks_name)
    sqlite_name = Keyword.get(opts, :sqlite_name, @default_sqlite_name)
    dirty_set = Keyword.get(opts, :dirty_set, @default_dirty_set)
    limit = Keyword.get(opts, :limit)
    offset = Keyword.get(opts, :offset)

    dirty_ids = DirtyTracker.dirty_entity_ids_for_type(type, dirty_set)

    if dirty_ids != [] do
      Enum.each(dirty_ids, fn id ->
        materialize(id, rocks_name: rocks_name, sqlite_name: sqlite_name, dirty_set: dirty_set)
      end)
    end

    dirty_system_ids = materialize_system_entities(rocks_name, sqlite_name, dirty_set)

    emit_cache_result(
      if(dirty_ids == [] and dirty_system_ids == [], do: :hit, else: :miss),
      :query
    )

    query_params = %{type: type, filter: filter, actor_id: actor_id}
    query_params = if limit, do: Map.put(query_params, :limit, limit), else: query_params
    query_params = if offset, do: Map.put(query_params, :offset, offset), else: query_params

    case SQLite.query_entities(query_params, sqlite_name) do
      {:ok, rows} ->
        started_at = System.monotonic_time()

        {formatted, decoded_bytes} =
          Enum.map_reduce(rows, 0, fn row, bytes ->
            {format_entity(row), bytes + blob_byte_size(row)}
          end)

        emit_read_latency(:query, started_at, rows: rows, byte_size: decoded_bytes)
        {:ok, formatted}

      error ->
        error
    end
  end

  defp materialize_system_entities(rocks_name, sqlite_name, dirty_set) do
    dirty_ids =
      DirtyTracker.dirty_entity_ids_for_types(PermissionHelper.system_entity_types(), dirty_set)

    Enum.each(dirty_ids, fn id ->
      materialize(id, rocks_name: rocks_name, sqlite_name: sqlite_name, dirty_set: dirty_set)
    end)

    dirty_ids
  end
end
