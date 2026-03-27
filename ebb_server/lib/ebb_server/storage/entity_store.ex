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
  """

  alias EbbServer.Storage.{RocksDB, SQLite, SystemCache}

  @default_rocks_name EbbServer.Storage.RocksDB
  @default_sqlite_name EbbServer.Storage.SQLite

  @doc """
  Fetches an entity by ID, reading from SQLite cache or materializing on demand.

  The `actor_id` parameter is accepted for future access control but is not
  used in Slice 1.

  Returns `{:ok, entity}` or `:not_found`.
  """
  @spec get(String.t(), String.t(), keyword()) :: {:ok, map()} | :not_found
  def get(entity_id, _actor_id, opts \\ []) do
    rocks_name = Keyword.get(opts, :rocks_name, @default_rocks_name)
    sqlite_name = Keyword.get(opts, :sqlite_name, @default_sqlite_name)

    if SystemCache.is_dirty?(entity_id) do
      materialize(entity_id, rocks_name: rocks_name, sqlite_name: sqlite_name)
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
  @spec materialize(String.t(), keyword()) :: {:ok, map()} | :not_found
  def materialize(entity_id, opts \\ []) do
    rocks_name = Keyword.get(opts, :rocks_name, @default_rocks_name)
    sqlite_name = Keyword.get(opts, :sqlite_name, @default_sqlite_name)

    {current_data, last_gsn, existing_row} =
      case SQLite.get_entity(entity_id, sqlite_name) do
        {:ok, row} ->
          {Jason.decode!(row.data), row.last_gsn, row}

        :not_found ->
          {%{"fields" => %{}}, 0, nil}
      end

    entries =
      RocksDB.prefix_iterator(RocksDB.cf_entity_actions(rocks_name), entity_id, name: rocks_name)
      |> Stream.map(fn {key, action_id_binary} ->
        {_eid, gsn} = RocksDB.decode_entity_gsn_key(key)
        {gsn, action_id_binary}
      end)
      |> Stream.filter(fn {gsn, _} -> gsn > last_gsn end)
      |> Enum.to_list()
      |> Enum.sort_by(fn {gsn, _} -> gsn end)

    if entries == [] do
      if existing_row != nil do
        SystemCache.clear_dirty(entity_id)

        case SQLite.get_entity(entity_id, sqlite_name) do
          {:ok, row} -> {:ok, format_entity(row)}
          :not_found -> :not_found
        end
      else
        SystemCache.clear_dirty(entity_id)
        :not_found
      end
    else
      materialized = apply_actions(entity_id, current_data, entries, rocks_name)

      %{
        data: merged_data,
        type: type,
        created_hlc: created_hlc,
        updated_hlc: updated_hlc,
        deleted_hlc: deleted_hlc,
        deleted_by: deleted_by,
        max_gsn: max_gsn
      } = materialized

      if deleted_hlc != nil do
        SystemCache.clear_dirty(entity_id)
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
        SystemCache.clear_dirty(entity_id)

        {:ok, format_entity(entity_row)}
      end
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

    fields_with_update_id =
      Enum.into(update["data"]["fields"] || %{}, %{}, fn {field_name, field_value} ->
        {field_name, Map.put(field_value, "update_id", update["id"])}
      end)

    new_data = %{"fields" => fields_with_update_id}

    %{
      acc
      | data: new_data,
        type: update["subject_type"],
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

        winner =
          cond do
            existing == nil ->
              Map.put(new_field, "update_id", update["id"])

            new_field["hlc"] > existing["hlc"] ->
              Map.put(new_field, "update_id", update["id"])

            new_field["hlc"] < existing["hlc"] ->
              existing

            true ->
              if update["id"] > existing["update_id"] do
                Map.put(new_field, "update_id", update["id"])
              else
                existing
              end
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

  defp format_entity(%{data: nil} = row) do
    raise "Unexpected nil data for entity #{inspect(row.entity_id)}"
  end

  defp format_entity(row) do
    %{row | data: Jason.decode!(row.data)}
  end
end
