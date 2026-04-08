defmodule EbbServer.Storage.RelationshipCache do
  @moduledoc """
  GenServer that owns the relationship ETS tables.

  Manages entity-to-group and group-to-entity relationship mappings.
  Uses two ETS tables:
  - `:ebb_relationships` - maps source entity to group
  - `:ebb_relationships_by_group` - maps group to source entities

  The GenServer exists solely to own the ETS table lifetime and
  manage startup/shutdown. All public functions are lock-free.
  """

  use GenServer

  @default_relationships :ebb_relationships
  @default_relationships_by_group :ebb_relationships_by_group

  @type t :: %__MODULE__{
          relationships: atom(),
          relationships_by_group: atom()
        }
  defstruct [:relationships, :relationships_by_group]

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  @doc """
  Stores a relationship entry.

  Accepts both atom keys (`:source_id`) and string keys (`"source_id"`).

  ## Examples

      iex> RelationshipCache.put_relationship(%{
      ...>   id: "rel_1",
      ...>   source_id: "todo_1",
      ...>   target_id: "g_1",
      ...>   type: "todo",
      ...>   field: "group"
      ...> })
      :ok
  """
  @spec put_relationship(map(), keyword()) :: :ok | {:error, :nil_values_not_allowed}
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

  @doc """
  Deletes a relationship entry by ID.

  ## Examples

      iex> RelationshipCache.delete_relationship("rel_1")
      :ok
  """
  @spec delete_relationship(String.t(), keyword()) :: :ok
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

  @doc """
  Gets the group ID that an entity belongs to via relationship.

  ## Examples

      iex> RelationshipCache.get_entity_group("todo_1")
      "g_1"

      iex> RelationshipCache.get_entity_group("unknown")
      nil
  """
  @spec get_entity_group(String.t(), atom()) :: String.t() | nil
  def get_entity_group(entity_id, table \\ @default_relationships) do
    case :ets.lookup(table, entity_id) do
      [{_source_id, %{target_id: group_id}}] -> group_id
      [] -> nil
    end
  end

  @doc """
  Gets all entity IDs that belong to a group.

  ## Examples

      iex> RelationshipCache.get_group_entities("g_1")
      ["todo_1", "todo_2"]
  """
  @spec get_group_entities(String.t(), atom()) :: [String.t()]
  def get_group_entities(group_id, table \\ @default_relationships_by_group) do
    :ets.lookup(table, group_id)
    |> Enum.map(fn {_group_id, source_id} -> source_id end)
  end

  @doc """
  Resets both relationship tables by clearing all entries.

  ## Examples

      iex> RelationshipCache.reset()
      :ok
  """
  @spec reset(keyword()) :: :ok
  def reset(opts \\ []) do
    rel_table = Keyword.get(opts, :relationships, @default_relationships)
    rbg_table = Keyword.get(opts, :relationships_by_group, @default_relationships_by_group)

    case :ets.info(rel_table, :name) do
      :undefined ->
        :ets.new(rel_table, [:set, :public, :named_table])

      _ ->
        try do
          :ets.delete_all_objects(rel_table)
        rescue
          ArgumentError -> :ets.new(rel_table, [:set, :public, :named_table])
        end
    end

    case :ets.info(rbg_table, :name) do
      :undefined ->
        :ets.new(rbg_table, [:bag, :public, :named_table])

      _ ->
        try do
          :ets.delete_all_objects(rbg_table)
        rescue
          ArgumentError -> :ets.new(rbg_table, [:bag, :public, :named_table])
        end
    end

    :ok
  end

  @impl true
  def init(opts) do
    relationships = Keyword.get(opts, :relationships, @default_relationships)

    relationships_by_group =
      Keyword.get(opts, :relationships_by_group, @default_relationships_by_group)

    :persistent_term.put({__MODULE__, :relationships}, relationships)
    :persistent_term.put({__MODULE__, :relationships_by_group}, relationships_by_group)
    :ets.new(relationships, [:set, :public, :named_table])
    :ets.new(relationships_by_group, [:bag, :public, :named_table])

    {:ok,
     %__MODULE__{
       relationships: relationships,
       relationships_by_group: relationships_by_group
     }}
  end

  @impl true
  def terminate(_reason, state) do
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

    :ok
  end
end
