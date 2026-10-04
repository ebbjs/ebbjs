defmodule EbbServer.Storage.RelationshipCache do
  @moduledoc """
  GenServer that owns the relationship ETS tables.

  Manages domain relationship edges, with a secondary index that
  allows lookups by relationship id. Uses two ETS tables:
  - `:ebb_relationships` - `:bag` of `{source_id, entry}`, one row per edge
  - `:ebb_relationships_by_id` - maps relationship id to entry

  Entity↔Group membership lives in `EntityGroupCache`, not here: a
  `Relationship` is a pure domain edge with no membership marker.

  The GenServer exists solely to own the ETS table lifetime and
  manage startup/shutdown. All public functions are lock-free.
  """

  use GenServer

  @default_relationships :ebb_relationships
  @default_relationships_by_id :ebb_relationships_by_id

  @type t :: %__MODULE__{
          relationships: atom(),
          relationships_by_id: atom()
        }
  defstruct [:relationships, :relationships_by_id]

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
    rbi_table = Keyword.get(opts, :relationships_by_id, @default_relationships_by_id)

    source_id = field(rel, :source_id)
    target_id = field(rel, :target_id)
    entry_id = field(rel, :id)

    if nil_ids?(source_id, target_id, entry_id) do
      {:error, :nil_values_not_allowed}
    else
      entry = %{
        id: entry_id,
        source_id: source_id,
        target_id: target_id,
        type: field(rel, :type),
        field: field(rel, :field)
      }

      # A re-put replaces the row for the same id. Leaving the previous
      # row in the bag would let a stale entry keep resolving.
      delete_relationship(entry_id,
        relationships: rel_table,
        relationships_by_id: rbi_table
      )

      :ets.insert(rel_table, {source_id, entry})
      :ets.insert(rbi_table, {entry_id, entry})
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
    rbi_table = Keyword.get(opts, :relationships_by_id, @default_relationships_by_id)

    case :ets.lookup(rbi_table, rel_id) do
      [{_, entry}] ->
        source_id = entry_source_id(entry)

        :ets.delete_object(rel_table, {source_id, entry})
        :ets.delete(rbi_table, rel_id)
        :ok

      [] ->
        :ok
    end
  end

  @doc """
  Looks up a relationship entry by its id.

  Returns the full entry map (with `:id`, `:source_id`, `:target_id`,
  `:type`, `:field`) or `nil` if no relationship with that id exists.

  ## Examples

      iex> RelationshipCache.get_relationship("rel_1")
      %{id: "rel_1", source_id: "todo_1", target_id: "g_1", type: "todo", field: "group"}

      iex> RelationshipCache.get_relationship("unknown")
      nil
  """
  @spec get_relationship(String.t(), atom()) :: map() | nil
  def get_relationship(rel_id, table \\ @default_relationships_by_id) do
    case :ets.lookup(table, rel_id) do
      [{_, entry}] -> entry
      [] -> nil
    end
  end

  @doc """
  Resets all relationship tables by clearing every entry.

  ## Examples

      iex> RelationshipCache.reset()
      :ok
  """
  @spec reset(keyword()) :: :ok
  def reset(opts \\ []) do
    rel_table = Keyword.get(opts, :relationships, @default_relationships)
    rbi_table = Keyword.get(opts, :relationships_by_id, @default_relationships_by_id)

    reset_table(rel_table, :bag)
    reset_table(rbi_table, :set)

    :ok
  end

  defp reset_table(table, type) do
    case :ets.info(table, :name) do
      :undefined ->
        :ets.new(table, [type, :public, :named_table])

      _ ->
        try do
          :ets.delete_all_objects(table)
        rescue
          ArgumentError -> :ets.new(table, [type, :public, :named_table])
        end
    end
  end

  @impl true
  def init(opts) do
    relationships = Keyword.get(opts, :relationships, @default_relationships)

    relationships_by_id =
      Keyword.get(opts, :relationships_by_id, @default_relationships_by_id)

    :persistent_term.put({__MODULE__, :relationships}, relationships)
    :persistent_term.put({__MODULE__, :relationships_by_id}, relationships_by_id)
    :ets.new(relationships, [:bag, :public, :named_table])
    :ets.new(relationships_by_id, [:set, :public, :named_table])

    {:ok,
     %__MODULE__{
       relationships: relationships,
       relationships_by_id: relationships_by_id
     }}
  end

  @impl true
  def terminate(_reason, state) do
    for table <- [state.relationships, state.relationships_by_id] do
      try do
        :ets.delete(table)
      rescue
        ArgumentError -> :ok
      end
    end

    :ok
  end

  defp entry_source_id(entry), do: field(entry, :source_id)

  defp field(map, key), do: map[key] || map[to_string(key)]

  defp nil_ids?(source_id, target_id, entry_id) do
    is_nil(source_id) or is_nil(target_id) or is_nil(entry_id)
  end
end
