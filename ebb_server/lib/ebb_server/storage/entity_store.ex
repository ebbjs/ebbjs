defmodule EbbServer.Storage.EntityStore do
  @moduledoc """
  Provides entity read access with on-demand materialization from RocksDB to SQLite.

  This module is NOT a GenServer for Slice 1. It composes the SQLite GenServer
  (for cached reads) and the RocksDB GenServer (for materialization).

  The `get/2,3` function is the main entry point:
  - First checks if the entity is dirty in SystemCache
  - If clean: reads directly from SQLite
  - If dirty: materializes by replaying actions from RocksDB

  All public functions accept optional `:rocks_name` and `:sqlite_name` parameters
  (defaulting to the module names) so that tests can run isolated instances.

  ## Merge Semantics

  When merging field values, the Last-Writer-Wins (LWW) strategy is used:

  1. **HLC comparison first**: Fields with higher Hybrid Logical Clock (HLC) values win.
  2. **Tiebreaker**: When HLCs are equal, the lexicographically higher `update_id` wins.
     - This ensures deterministic, reproducible results across all clients.
     - Lexicographic comparison uses standard string ordering (Unicode codepoints).
     - Example: `"upd_zzz" > "upd_aaa"` evaluates to `true`.
     - Note: Numeric IDs like `"id-10"` sort before `"id-9"` lexicographically
       (`"1"` < `"9"`), which is acceptable since the comparison is purely
       deterministic, not semantically meaningful.

  This approach is replicable across any client (Elixir, JavaScript, Python, etc.)
  since all use the same lexicographic string comparison rules.
  """

  alias EbbServer.Storage.{RocksDB, SQLite, SystemCache}

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

    if SystemCache.dirty?(entity_id, dirty_set) do
      materialize(entity_id,
        rocks_name: rocks_name,
        sqlite_name: sqlite_name,
        dirty_set: dirty_set
      )
    else
      case SQLite.get_entity(entity_id, sqlite_name) do
        {:ok, row} ->
          {:ok, format_entity(row)}

        :not_found ->
          :not_found
      end
    end
  end

  @doc """
  Materializes an entity by replaying actions from RocksDB into SQLite.

  This function is public for testability. It should not be called directly
  in normal operation — use `get/2` instead.

  Process:
  1. Read current state from SQLite (or empty for new entities)
  2. Scan RocksDB cf_entity_actions for actions after last_gsn
  3. Replay each action's updates in GSN order
  4. Upsert materialized entity to SQLite
  5. Clear dirty flag in SystemCache
  """
  @spec materialize(String.t(), keyword()) :: {:ok, map()} | :not_found | {:error, term()}
  def materialize(entity_id, opts \\ []) do
    rocks_name = Keyword.get(opts, :rocks_name, @default_rocks_name)
    sqlite_name = Keyword.get(opts, :sqlite_name, @default_sqlite_name)
    dirty_set = Keyword.get(opts, :dirty_set, @default_dirty_set)

    {current_data, last_gsn, existing_row} = fetch_current_state(entity_id, sqlite_name)
    entries = fetch_relevant_entries(entity_id, rocks_name, last_gsn)

    if entries == [] do
      handle_empty_entries(entity_id, existing_row, dirty_set, sqlite_name)
    else
      apply_entries_and_persist(
        entity_id,
        current_data,
        entries,
        rocks_name,
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

  defp handle_empty_entries(entity_id, nil, dirty_set, _sqlite_name) do
    SystemCache.clear_dirty(entity_id, dirty_set)
    :not_found
  end

  defp handle_empty_entries(entity_id, _existing_row, dirty_set, sqlite_name) do
    SystemCache.clear_dirty(entity_id, dirty_set)

    case SQLite.get_entity(entity_id, sqlite_name) do
      {:ok, row} -> {:ok, format_entity(row)}
      :not_found -> :not_found
    end
  end

  defp apply_entries_and_persist(
         entity_id,
         current_data,
         entries,
         rocks_name,
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
        handle_materialized_result(entity_id, result, dirty_set, sqlite_name)

      {:error, _reason} ->
        {:error, :materialization_failed}
    end
  end

  defp handle_materialized_result(entity_id, result, dirty_set, sqlite_name) do
    %{
      data: merged_data,
      type: type,
      created_hlc: created_hlc,
      updated_hlc: updated_hlc,
      deleted_hlc: deleted_hlc,
      deleted_by: deleted_by,
      max_gsn: max_gsn
    } = result

    if deleted_hlc != nil do
      SystemCache.clear_dirty(entity_id, dirty_set)
      :not_found
    else
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
      SystemCache.clear_dirty(entity_id, dirty_set)
      {:ok, format_entity(entity_row)}
    end
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

    new_data =
      cond do
        subject_type == "groupMember" ->
          data = update["data"]
          fields = data["fields"] || %{}

          actor_id = get_field_value(data, "actor_id")
          group_id = get_field_value(data, "group_id")
          permissions = get_field_value(data, "permissions")

          %{
            "fields" => %{
              "actor_id" => %{"value" => actor_id, "update_id" => update["id"]},
              "group_id" => %{"value" => group_id, "update_id" => update["id"]},
              "permissions" => %{"value" => permissions, "update_id" => update["id"]}
            }
          }

        subject_type == "relationship" ->
          update["data"]

        true ->
          fields_with_update_id =
            Enum.into(update["data"]["fields"] || %{}, %{}, fn {field_name, field_value} ->
              {field_name, Map.put(field_value, "update_id", update["id"])}
            end)

          %{"fields" => fields_with_update_id}
      end

    %{
      acc
      | data: new_data,
        type: subject_type,
        created_hlc: if(acc.created_hlc == nil, do: hlc, else: acc.created_hlc),
        updated_hlc: hlc,
        max_gsn: max(acc.max_gsn, gsn)
    }
  end

  defp get_field_value(data, field) when is_map(data) do
    cond do
      Map.has_key?(data, field) ->
        case data[field] do
          %{"value" => value} -> value
          value when is_binary(value) -> value
          _ -> nil
        end

      Map.has_key?(data, "fields") and is_map(data["fields"]) ->
        get_field_value(data["fields"], field)

      true ->
        nil
    end
  end

  defp get_field_value(_, _), do: nil

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

        winner =
          cond do
            existing == nil ->
              Map.put(new_field, "update_id", update["id"])

            new_field["hlc"] > existing["hlc"] ->
              Map.put(new_field, "update_id", update["id"])

            new_field["hlc"] < existing["hlc"] ->
              existing

            true ->
              tiebreak_winner(new_field, existing, update["id"], existing["update_id"])
          end

        Map.put(existing_fields_map, field_name, winner)
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

  defp tiebreak_winner(new_field, existing, new_id, existing_id) do
    if new_id >= existing_id do
      Map.put(new_field, "update_id", new_id)
    else
      existing
    end
  end

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

    dirty_ids = SystemCache.dirty_entity_ids_for_type(type, dirty_set)

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
    system_prefixes = ["gm_", "rel_"]

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
