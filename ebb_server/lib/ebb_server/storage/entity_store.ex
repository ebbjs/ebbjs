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

  A field value is either a **leaf** (`%{"value" => v, "update_id" =>
  id, "hlc" => hlc}`) or a **map** (`%{"map" => %{key => value}}`).
  The `map` key is the discriminant, so a map value is self-describing
  and the merge needs no schema. Leaf merge is uniform across all field
  types: higher HLC wins, ties broken by lexicographically higher
  `update_id`. Map merge unions the key sets and applies the same rule
  to each key recursively. A kind mismatch (leaf against map) replaces
  the whole value, since a field's kind is fixed by its schema and the
  incoming patch is the newer intent.

  This deliberately keeps the materialization logic simple — there is
  no per-type dispatch table today. CRDT-style merging (e.g. G-Counter,
  causal-tree text) is **not** a server-side concern: the per-leaf LWW
  rule is enough for the server's job (decide which blob wins), and the
  typed reducer on the client is what interprets a `causal-tree` blob
  correctly. See Epic #110 for how `e.collaborativeText()` is defined
  and Epic #111 for the storage-architecture rationale.

  ## Hot path

  Clean entities: one ETS check + one SQLite SELECT. Dirty entities:
  + one RocksDB range iterator + per-update merge + one SQLite UPSERT
  + one ETS delete. The common case (most reads hit the cache) stays
  close to an SQLite SELECT.

  ## Merge Semantics

  When merging field values, the Last-Writer-Wins (LWW) strategy is
  applied at every leaf, and maps recurse:

  1. **Map union**: When both the existing and incoming values are maps,
     their key sets are unioned and every key present on both sides is
     merged by these same rules. A patch that mentions only one key
     leaves its siblings untouched.
  2. **HLC comparison first**: Leaves with higher Hybrid Logical Clock
     (HLC) values win. HLCs are compared numerically, so an integer and
     the decimal string that names it (`10` and `"10"`) order
     identically.
  3. **Tiebreaker**: When HLCs are equal, the lexicographically higher `update_id` wins.
     - This ensures deterministic, reproducible results across all clients.
     - Lexicographic comparison uses standard string ordering (Unicode codepoints).
     - Example: `"upd_zzz" > "upd_aaa"` evaluates to `true`.
     - Note: Numeric IDs like `"id-10"` sort before `"id-9"` lexicographically
       (`"1"` < `"9"`), which is acceptable since the comparison is purely
       deterministic, not semantically meaningful.
  4. **Kind mismatch**: When exactly one side is a map, the incoming
     value replaces the existing value wholesale: a field's kind is
     fixed by its schema, so this is a newer intent, not a merge.
  5. **Tombstone**: A leaf `value: null` is merged like any other leaf,
     so a late-arriving write can still beat it. Storage retains it;
     projection is what hides a tombstoned map key.

  This approach is replicable across any client (Elixir, JavaScript, Python, etc.)
  since all use the same numeric HLC and lexicographic string comparison rules.
  """

  alias EbbServer.Storage.{DirtyTracker, RocksDB, SQLite}

  @default_rocks_name EbbServer.Storage.RocksDB
  @default_sqlite_name EbbServer.Storage.SQLite
  @default_dirty_set :ebb_dirty_set

  @doc """
  Fetches an entity by ID, reading from SQLite cache or materializing on demand.

  The `actor_id` parameter is accepted for future access control but is not
  used in Slice 1.

  Returns `{:ok, entity}`, `:not_found`, or `{:error, :materialization_failed}`.
  """
  @spec get(String.t(), String.t(), keyword()) ::
          {:ok, map()} | :not_found | {:error, :materialization_failed}
  def get(entity_id, _actor_id, opts \\ []) do
    rocks_name = Keyword.get(opts, :rocks_name, @default_rocks_name)
    sqlite_name = Keyword.get(opts, :sqlite_name, @default_sqlite_name)
    dirty_set = Keyword.get(opts, :dirty_set, @default_dirty_set)

    if DirtyTracker.dirty?(entity_id, dirty_set) do
      materialize(entity_id,
        rocks_name: rocks_name,
        sqlite_name: sqlite_name,
        dirty_set: dirty_set
      )
    else
      case SQLite.get_entity(entity_id, sqlite_name) do
        {:ok, row} -> format_live_entity(row)
        :not_found -> :not_found
      end
    end
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
    rocks_name = Keyword.get(opts, :rocks_name, @default_rocks_name)
    sqlite_name = Keyword.get(opts, :sqlite_name, @default_sqlite_name)
    dirty_set = Keyword.get(opts, :dirty_set, @default_dirty_set)
    after_scan = Keyword.get(opts, :after_scan)

    observed_generation = DirtyTracker.dirty_generation(entity_id, dirty_set)
    {current_data, last_gsn, existing_row} = fetch_current_state(entity_id, sqlite_name)
    entries = fetch_relevant_entries(entity_id, rocks_name, last_gsn)

    if after_scan, do: after_scan.()

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
  end

  defp fetch_current_state(entity_id, sqlite_name) do
    case SQLite.get_entity(entity_id, sqlite_name) do
      {:ok, row} ->
        {Jason.decode!(row.data), row.last_gsn, row}

      :not_found ->
        {%{"fields" => %{}}, 0, nil}
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
        {:ok, apply_actions(entity_id, current_data, entries, rocks_name)}
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
      data: Jason.encode!(merged_data),
      created_hlc: created_hlc || updated_hlc,
      updated_hlc: updated_hlc,
      deleted_hlc: deleted_hlc,
      deleted_by: deleted_by,
      last_gsn: max_gsn
    }

    SQLite.upsert_entity(entity_row, sqlite_name)
    clear_settled(entity_id, observed_generation, dirty_set)

    format_live_entity(entity_row)
  end

  defp apply_actions(entity_id, data, entries, rocks_name) do
    initial_data = if is_map(data), do: data, else: %{"fields" => %{}}

    Enum.reduce(
      entries,
      %{
        data: initial_data,
        type: nil,
        created_hlc: nil,
        updated_hlc: 0,
        deleted_hlc: nil,
        deleted_by: nil,
        max_gsn: 0
      },
      fn {gsn, _action_id}, acc ->
        {:ok, action_etf} =
          RocksDB.get(RocksDB.cf_actions(rocks_name), RocksDB.encode_gsn_key(gsn),
            name: rocks_name
          )

        action = :erlang.binary_to_term(action_etf, [:safe])

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
        {field_name, stamp_update_id(field_value, update["id"])}
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
        incoming = stamp_update_id(new_field, update["id"])

        Map.put(existing_fields_map, field_name, merge_field(existing, incoming))
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

  # A field's leaves are stamped with the update's id so the stored value
  # is self-describing. Entries nested under a `map` recurse; the map
  # object itself is not a leaf and carries no update_id. A leaf that
  # already carries a wire `update_id` keeps it: the client's fold trusts
  # that value, so the server must use it too for an equal-HLC tiebreak to
  # resolve identically on both sides. Only a leaf with no usable id — the
  # historical top-level shape — falls back to the Update's id.
  defp stamp_update_id(%{"map" => entries}, update_id) when is_map(entries) do
    stamped =
      Enum.into(entries, %{}, fn {key, value} -> {key, stamp_update_id(value, update_id)} end)

    %{"map" => stamped}
  end

  defp stamp_update_id(%{"update_id" => id} = leaf, _update_id) when is_binary(id) and id != "",
    do: leaf

  defp stamp_update_id(leaf, update_id) when is_map(leaf),
    do: Map.put(leaf, "update_id", update_id)

  defp merge_field(nil, incoming), do: incoming

  defp merge_field(existing, incoming) do
    cond do
      map_field?(existing) and map_field?(incoming) ->
        merged =
          Map.merge(existing["map"], incoming["map"], fn _key, existing_value, incoming_value ->
            merge_field(existing_value, incoming_value)
          end)

        %{"map" => merged}

      map_field?(existing) or map_field?(incoming) ->
        incoming

      true ->
        case compare_hlc(incoming["hlc"], existing["hlc"]) do
          :gt -> incoming
          :lt -> existing
          :eq -> tiebreak_winner(incoming, existing, incoming["update_id"], existing["update_id"])
        end
    end
  end

  defp map_field?(field), do: is_map(field) and is_map(Map.get(field, "map"))

  # Field HLCs cross the wire either as integers or as decimal strings
  # (the msgpack codec keeps values above the JS safe-integer range as
  # strings). Compare numerically so both forms order identically.
  defp compare_hlc(left, right) do
    left = hlc_value(left)
    right = hlc_value(right)

    cond do
      left > right -> :gt
      left < right -> :lt
      true -> :eq
    end
  end

  defp hlc_value(nil), do: 0
  defp hlc_value(hlc) when is_integer(hlc), do: hlc

  defp hlc_value(hlc) when is_binary(hlc) do
    case Integer.parse(hlc) do
      {int, ""} -> int
      _ -> 0
    end
  end

  defp hlc_value(_), do: 0

  defp tiebreak_winner(new_field, existing, new_id, existing_id) do
    if new_id >= existing_id do
      Map.put(new_field, "update_id", new_id)
    else
      existing
    end
  end

  defp format_live_entity(%{deleted_hlc: nil} = row), do: {:ok, format_entity(row)}
  defp format_live_entity(_row), do: :not_found

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

    materialize_system_entities(rocks_name, sqlite_name, dirty_set)

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

  defp materialize_system_entities(rocks_name, sqlite_name, dirty_set) do
    system_prefixes = ["gm_", "eg_", "rel_"]

    dirty_set
    |> :ets.tab2list()
    |> Enum.map(fn {id, _} -> id end)
    |> Enum.filter(fn id ->
      Enum.any?(system_prefixes, &String.starts_with?(id, &1))
    end)
    |> Enum.each(fn id ->
      materialize(id, rocks_name: rocks_name, sqlite_name: sqlite_name, dirty_set: dirty_set)
    end)
  end
end
