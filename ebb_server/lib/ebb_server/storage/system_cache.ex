defmodule EbbServer.Storage.SystemCache do
  @moduledoc """
  GenServer that owns shared ETS tables and atomics for the storage layer.

  Creates and owns:
  - ETS table (configurable name) — tracks which entity IDs need re-materialization
  - GSN counter atomics (configurable reference) — monotonically increasing, gap-free global sequence numbers

  All public data functions are lock-free (ETS reads/writes and atomics operations)
  and do not route through `GenServer.call`. The GenServer exists solely to own
  the ETS table lifetime and manage startup/shutdown of the shared resources.
  """

  use GenServer
  require Logger

  @default_dirty_set_name :ebb_dirty_set
  @default_gsn_counter_name :ebb_gsn_counter
  @default_group_members :ebb_group_members
  @default_relationships :ebb_relationships
  @default_relationships_by_group :ebb_relationships_by_group

  @type t :: %__MODULE__{
          dirty_set: atom(),
          gsn_counter: :atomics.atomics(),
          gsn_counter_name: atom(),
          group_members: atom(),
          relationships: atom(),
          relationships_by_group: atom()
        }
  defstruct [
    :dirty_set,
    :gsn_counter,
    :gsn_counter_name,
    :group_members,
    :relationships,
    :relationships_by_group
  ]

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  @spec claim_gsn_range(pos_integer(), :atomics.atomics() | nil) :: {pos_integer(), pos_integer()}
  def claim_gsn_range(count, counter \\ nil) when is_integer(count) and count > 0 do
    counter_ref = counter || :persistent_term.get(@default_gsn_counter_name)
    gsn_end = :atomics.add_get(counter_ref, 1, count)
    gsn_start = gsn_end - count + 1
    {gsn_start, gsn_end}
  end

  @spec mark_dirty_batch([String.t()], atom()) :: :ok
  def mark_dirty_batch(entity_ids, dirty_set \\ @default_dirty_set_name)
      when is_list(entity_ids) do
    Enum.each(entity_ids, fn id ->
      :ets.insert(dirty_set, {id, true})
    end)

    :ok
  end

  @spec is_dirty?(String.t(), atom()) :: boolean()
  def is_dirty?(entity_id, dirty_set \\ @default_dirty_set_name) do
    :ets.lookup(dirty_set, entity_id) != []
  end

  @spec clear_dirty(String.t(), atom()) :: true
  def clear_dirty(entity_id, dirty_set \\ @default_dirty_set_name) do
    :ets.delete(dirty_set, entity_id)
  end

  @spec reset(atom(), :atomics.atomics() | nil) :: :ok
  def reset(dirty_set \\ @default_dirty_set_name, gsn_counter \\ nil) do
    case :ets.info(dirty_set, :name) do
      ^dirty_set ->
        :ets.delete_all_objects(dirty_set)

      _ ->
        :ets.new(dirty_set, [:set, :public, :named_table])
    end

    counter = gsn_counter || :persistent_term.get(@default_gsn_counter_name, nil)

    if counter do
      :atomics.put(counter, 1, 0)
    end

    :ok
  end

  @spec get_resources() :: %{dirty_set: atom(), gsn_counter: :atomics.atomics() | nil}
  def get_resources do
    %{
      dirty_set: @default_dirty_set_name,
      gsn_counter: :persistent_term.get(@default_gsn_counter_name)
    }
  end

  def put_group_member(member, table \\ @default_group_members) do
    actor_id = member[:actor_id] || member["actor_id"]
    group_id = member[:group_id] || member["group_id"]
    entry_id = member[:id] || member["id"]

    if is_nil(actor_id) or is_nil(group_id) or is_nil(entry_id) do
      {:error, :nil_values_not_allowed}
    else
      entry = %{
        id: entry_id,
        group_id: group_id,
        permissions: member[:permissions] || member["permissions"]
      }

      delete_group_member_by_id(entry.id, actor_id, table)
      :ets.insert(table, {actor_id, entry})
      :ok
    end
  end

  def delete_group_member(member_id, table \\ @default_group_members) do
    table
    |> :ets.tab2list()
    |> Enum.each(fn object ->
      if object |> elem(1) |> Map.get(:id) == member_id do
        :ets.delete_object(table, object)
      end
    end)

    :ok
  end

  defp delete_group_member_by_id(member_id, actor_id, table) do
    table
    |> :ets.tab2list()
    |> Enum.each(fn {^actor_id, %{id: id} = entry} ->
      if id == member_id do
        :ets.delete_object(table, {actor_id, entry})
      end
    end)
  end

  def get_actor_groups(actor_id, table \\ @default_group_members) do
    actual_table = resolve_table(table, :group_members)

    :ets.lookup(actual_table, actor_id)
    |> Enum.map(fn {_actor_id, entry} ->
      %{group_id: entry.group_id, permissions: entry.permissions}
    end)
  end

  defp resolve_table(table, _key) when is_atom(table), do: table
  defp resolve_table(opts, key) when is_list(opts), do: Keyword.get(opts, key)

  defp ensure_table(name, opts) do
    case :ets.info(name, :name) do
      :undefined -> :ets.new(name, opts)
      _ -> name
    end
  end

  def get_permissions(actor_id, group_id, table \\ @default_group_members) do
    actual_table = resolve_table(table, :group_members)

    :ets.lookup(actual_table, actor_id)
    |> Enum.flat_map(fn {_actor_id, entry} ->
      if entry.group_id == group_id, do: entry.permissions, else: []
    end)
    |> case do
      [] -> nil
      perms -> Enum.uniq(List.flatten(perms))
    end
  end

  def put_relationship(rel, opts \\ []) do
    rel_table = Keyword.get(opts, :relationships, @default_relationships)
    rbg_table = Keyword.get(opts, :relationships_by_group, @default_relationships_by_group)

    source_id = rel[:source_id] || rel["source_id"]
    target_id = rel[:target_id] || rel["target_id"]
    entry_id = rel[:id] || rel["id"]

    if is_nil(source_id) or is_nil(target_id) or is_nil(entry_id) do
      {:error, :nil_values_not_allowed}
    else
      entry = %{
        id: entry_id,
        target_id: target_id,
        type: rel[:type] || rel["type"],
        field: rel[:field] || rel["field"]
      }

      :ets.insert(rel_table, {source_id, entry})
      :ets.insert(rbg_table, {target_id, source_id})
      :ok
    end
  end

  def delete_relationship(rel_id, opts \\ []) do
    rel_table = Keyword.get(opts, :relationships, @default_relationships)
    rbg_table = Keyword.get(opts, :relationships_by_group, @default_relationships_by_group)

    rel_table
    |> :ets.tab2list()
    |> Enum.each(fn {source_id, %{id: id, target_id: target_id}} ->
      if id == rel_id do
        :ets.delete(rel_table, source_id)
        :ets.delete_object(rbg_table, {target_id, source_id})
      end
    end)

    :ok
  end

  def get_entity_group(entity_id, table \\ @default_relationships) do
    actual_table = resolve_table(table, :relationships)

    case :ets.lookup(actual_table, entity_id) do
      [{_source_id, %{target_id: group_id}}] -> group_id
      [] -> nil
    end
  end

  def get_group_entities(group_id, table \\ @default_relationships_by_group) do
    :ets.lookup(table, group_id)
    |> Enum.map(fn {_group_id, source_id} -> source_id end)
  end

  def dirty_entity_ids_for_type(type, dirty_set \\ @default_dirty_set_name) do
    prefix = type <> "_"

    dirty_set
    |> :ets.tab2list()
    |> Enum.reduce([], fn {entity_id, _}, acc ->
      if String.starts_with?(entity_id, prefix) do
        [entity_id | acc]
      else
        acc
      end
    end)
  end

  defp populate_system_caches(state) do
    rocks_name = EbbServer.Storage.RocksDB

    populate_type("groupMember", rocks_name, fn entity_data ->
      put_group_member(
        %{
          id: entity_data["id"],
          actor_id: get_in(entity_data, ["data", "fields", "actor_id", "value"]),
          group_id: get_in(entity_data, ["data", "fields", "group_id", "value"]),
          permissions: get_in(entity_data, ["data", "fields", "permissions", "value"])
        },
        state.group_members
      )
    end)

    populate_type("relationship", rocks_name, fn entity_data ->
      put_relationship(
        %{
          id: entity_data["id"],
          source_id: get_in(entity_data, ["data", "source_id"]),
          target_id: get_in(entity_data, ["data", "target_id"]),
          type: get_in(entity_data, ["data", "type"]),
          field: get_in(entity_data, ["data", "field"])
        },
        relationships: state.relationships,
        relationships_by_group: state.relationships_by_group
      )
    end)
  end

  defp populate_type(type, rocks_name, insert_fn) do
    prefix = type <> <<0>>
    cf = EbbServer.Storage.RocksDB.cf_type_entities(rocks_name)

    rocks_name
    |> EbbServer.Storage.RocksDB.prefix_iterator(cf, prefix)
    |> Stream.each(fn {key, _value} ->
      <<_type_bytes::binary-size(byte_size(type)), 0, entity_id::binary>> = key

      case EbbServer.Storage.EntityStore.materialize(entity_id, rocks_name: rocks_name) do
        {:ok, entity} -> insert_fn.(entity)
        error -> Logger.warning("Failed to materialize entity #{entity_id}: #{inspect(error)}")
      end
    end)
    |> Stream.run()
  end

  @impl true
  def init(opts) do
    initial_gsn =
      Keyword.get_lazy(opts, :initial_gsn, fn ->
        EbbServer.Storage.RocksDB.get_max_gsn()
      end)

    dirty_set = Keyword.get(opts, :dirty_set, @default_dirty_set_name)
    gsn_counter = Keyword.get(opts, :gsn_counter, nil)
    gsn_counter_name = Keyword.get(opts, :gsn_counter_name, @default_gsn_counter_name)
    group_members = Keyword.get(opts, :group_members, @default_group_members)
    relationships = Keyword.get(opts, :relationships, @default_relationships)

    relationships_by_group =
      Keyword.get(opts, :relationships_by_group, @default_relationships_by_group)

    :ets.new(dirty_set, [:set, :public, :named_table])
    ensure_table(group_members, [:bag, :public, :named_table])
    ensure_table(relationships, [:set, :public, :named_table])
    ensure_table(relationships_by_group, [:bag, :public, :named_table])

    counter =
      case gsn_counter do
        nil -> :atomics.new(1, signed: false)
        _ -> gsn_counter
      end

    if initial_gsn > 0 do
      :atomics.put(counter, 1, initial_gsn)
    end

    :persistent_term.put(gsn_counter_name, counter)

    state = %__MODULE__{
      dirty_set: dirty_set,
      gsn_counter: counter,
      gsn_counter_name: gsn_counter_name,
      group_members: group_members,
      relationships: relationships,
      relationships_by_group: relationships_by_group
    }

    try do
      populate_system_caches(state)
    rescue
      e ->
        Logger.warning("Failed to populate system caches: #{inspect(e)}")
        :ok
    end

    {:ok, state}
  end

  @impl true
  def terminate(_reason, state) do
    try do
      :ets.delete(state.dirty_set)
    rescue
      ArgumentError -> :ok
    end

    try do
      :ets.delete(state.group_members)
    rescue
      ArgumentError -> :ok
    end

    try do
      :ets.delete(state.relationships)
    rescue
      ArgumentError -> :ok
    end

    try do
      :ets.delete(state.relationships_by_group)
    rescue
      ArgumentError -> :ok
    end

    :persistent_term.erase(state.gsn_counter_name)

    :ok
  end
end
