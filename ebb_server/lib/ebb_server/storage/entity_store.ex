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
  applies per-field typed merges, writes the changed keys back to SQLite
  (a per-key `json_set` patch when possible, a full UPSERT otherwise), and
  clears only
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
  `last_gsn`. Both write-back forms are monotonic in `last_gsn`, so
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
  write (a per-key `json_set` patch, or a full UPSERT for a put) + one
  ETS delete. The common case (most reads hit the cache) stays close to
  an SQLite SELECT.
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
  5. Write the materialized entity back to SQLite
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

    base_present? = existing_row != nil

    entries =
      timed(:entries_scan, fn -> fetch_relevant_entries(entity_id, rocks_name, last_gsn) end)

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
          sqlite_name,
          base_present?
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
         sqlite_name,
         base_present?
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
          sqlite_name,
          base_present?,
          current_data
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
         sqlite_name,
         base_present?,
         current_data
       ) do
    %{
      data: merged_data,
      type: type,
      created_hlc: created_hlc,
      updated_hlc: updated_hlc,
      deleted_hlc: deleted_hlc,
      deleted_by: deleted_by,
      max_gsn: max_gsn,
      data_mode: data_mode,
      changed: changed
    } = result

    entity_row = %{
      id: entity_id,
      type: type || "unknown",
      created_hlc: created_hlc || updated_hlc,
      updated_hlc: updated_hlc,
      deleted_hlc: deleted_hlc,
      deleted_by: deleted_by,
      last_gsn: max_gsn
    }

    # The write — whole-blob or per-key — persists the tombstone columns;
    # that is what stops a later clean read from resurrecting the entity.
    if data_mode == :patch and base_present? and safe_changed_paths?(changed) do
      changed_json =
        timed(:encode, fn -> build_patch_fields(changed, current_data, merged_data) end)

      meta = Map.take(entity_row, [:type, :updated_hlc, :deleted_hlc, :deleted_by, :last_gsn])

      timed(:upsert, fn -> SQLite.patch_entity(entity_id, changed_json, meta, sqlite_name) end)
    else
      # A put replaced the whole `fields` map (or there was no cached base to
      # patch), so the merged map must be written wholesale.
      data = timed(:encode, fn -> Jason.encode!(merged_data) end)

      timed(:upsert, fn -> SQLite.upsert_entity(Map.put(entity_row, :data, data), sqlite_name) end)
    end

    clear_settled(entity_id, observed_generation, dirty_set)

    # `merged_data` is already the decoded form; handing it to the formatter
    # avoids re-decoding the stored blob, i.e. re-parsing the whole entity.
    timed(:format, fn -> format_live_entity(Map.put(entity_row, :data, merged_data)) end)
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
        max_gsn: 0,
        data_mode: :patch,
        changed: MapSet.new()
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
        max_gsn: max(acc.max_gsn, gsn),
        data_mode: :replace
    }
  end

  defp apply_patch(action, update, gsn, acc) do
    hlc = action["hlc"]

    stamped_fields =
      Enum.map(update["data"]["fields"] || %{}, fn {field_name, new_field} ->
        {field_name, FieldMerge.stamp(new_field, update["id"])}
      end)

    existing_fields =
      if is_map(acc.data) and Map.has_key?(acc.data, "fields"),
        do: acc.data["fields"],
        else: %{}

    merged_fields =
      Enum.reduce(stamped_fields, existing_fields, fn {field_name, incoming}, fields ->
        Map.put(fields, field_name, FieldMerge.merge(Map.get(fields, field_name), incoming))
      end)

    changed_paths =
      Enum.flat_map(stamped_fields, fn {field_name, incoming} ->
        leaf_paths([field_name], incoming)
      end)

    %{
      acc
      | data: %{"fields" => merged_fields},
        type: acc.type || update["subject_type"],
        created_hlc: acc.created_hlc,
        updated_hlc: hlc,
        max_gsn: max(acc.max_gsn, gsn),
        deleted_hlc: nil,
        deleted_by: nil,
        changed: MapSet.union(acc.changed, MapSet.new(changed_paths))
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

  # A patch can only change the keys it carries, so the JSON paths that need
  # writing are exactly the leaves of the incoming field value: a leaf
  # contributes its field name, a map field one path per touched map key. This
  # is what lets write-back touch only the changed key instead of re-encoding a
  # large map field.
  defp leaf_paths(prefix, %{"map" => entries}) when is_map(entries) do
    case Map.to_list(entries) do
      [] -> [prefix]
      pairs -> Enum.flat_map(pairs, fn {key, value} -> leaf_paths(prefix ++ [key], value) end)
    end
  end

  defp leaf_paths(prefix, _leaf), do: [prefix]

  # Builds the `%{relative_path => json}` map for `patch_entity/4`. A field
  # whose kind changed (leaf over map, or map over leaf) can only be written
  # wholesale, as can one that was never a cached map; everything else is
  # written per touched key.
  defp build_patch_fields(changed, current_data, merged_data) do
    changed
    |> Enum.group_by(fn [top | _keys] -> top end)
    |> Enum.flat_map(fn {top, paths} ->
      base_field = get_in(current_data, ["fields", top])
      merged_field = get_in(merged_data, ["fields", top])
      patch_fields(top, base_field, merged_field, paths)
    end)
    |> Map.new()
  end

  defp patch_fields(top, base_field, merged_field, paths) do
    nested = Enum.reject(paths, &match?([_], &1))

    cond do
      not map_field?(merged_field) -> [{top, Jason.encode!(merged_field)}]
      nested == [] -> [{top, Jason.encode!(merged_field)}]
      not map_field?(base_field) -> [{top, Jason.encode!(merged_field)}]
      true -> nested_path_fields(top, base_field, merged_field, nested)
    end
  end

  defp nested_path_fields(top, base_field, merged_field, paths) do
    values =
      Enum.map(paths, fn [_top | keys] ->
        {relative_path(top, keys), navigate_map(merged_field, keys)}
      end)

    compatible? =
      Enum.all?(paths, fn [_top | keys] -> base_nested_compatible?(base_field, keys) end)

    if compatible? and Enum.all?(values, fn {_path, value} -> match?({:ok, _}, value) end) do
      Enum.map(values, fn {path, {:ok, value}} -> {path, Jason.encode!(value)} end)
    else
      [{top, Jason.encode!(merged_field)}]
    end
  end

  # `json_set` walks `.map."key"` components through the *stored* document, so
  # a nested write is only equivalent to the merge when every existing ancestor
  # is a map field. A missing ancestor is fine: `json_set` creates it in the
  # same shape. A leaf in the way (a nested kind change) forces the whole field
  # to be rewritten, or the leaf's sibling keys would survive the `json_set`.
  defp base_nested_compatible?(_base_field, [_key]), do: true

  defp base_nested_compatible?(base_field, keys) do
    {ancestors, _last} = Enum.split(keys, -1)

    ancestors
    |> Enum.reduce_while({:ok, base_field}, &descend_map/2)
    |> nested_compatible_result()
  end

  defp descend_map(key, {:ok, current}) do
    if map_field?(current) do
      case Map.fetch(current["map"], key) do
        {:ok, next} -> {:cont, {:ok, next}}
        :error -> {:halt, :missing}
      end
    else
      {:halt, :blocked}
    end
  end

  defp nested_compatible_result(:blocked), do: false
  defp nested_compatible_result(:missing), do: true
  defp nested_compatible_result({:ok, parent}), do: map_field?(parent)

  # Map keys are JSON-quoted so a key containing `.` or quotes cannot escape the
  # path; `Jason.encode!` produces exactly the quoted-component syntax json_set
  # expects.
  defp relative_path(top, keys) do
    top <> Enum.map_join(keys, "", fn key -> ".map." <> Jason.encode!(to_string(key)) end)
  end

  defp navigate_map(value, []), do: {:ok, value}

  defp navigate_map(%{"map" => entries}, [key | rest]) do
    case Map.fetch(entries, key) do
      {:ok, value} -> navigate_map(value, rest)
      :error -> :error
    end
  end

  defp navigate_map(_value, _keys), do: :error

  defp map_field?(%{"map" => entries}) when is_map(entries), do: true
  defp map_field?(_value), do: false

  # The top-level field name reaches json_set unquoted, so it must be a plain
  # identifier; anything else falls back to the whole-blob upsert.
  defp safe_changed_paths?(changed) do
    Enum.all?(changed, fn [top | _keys] ->
      is_binary(top) and Regex.match?(~r/^[A-Za-z_][A-Za-z0-9_]*$/, top)
    end)
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
