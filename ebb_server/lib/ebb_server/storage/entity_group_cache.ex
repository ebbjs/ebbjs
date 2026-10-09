defmodule EbbServer.Storage.EntityGroupCache do
  @moduledoc """
  GenServer that owns the entity↔Group membership ETS tables.

  Manages entity-to-group mappings for the `entityGroup` system
  entity, with secondary indexes keyed by membership id and by group.
  Uses three ETS tables:
  - `:ebb_entity_groups` - `:bag` of `{entity_id, entry}`, one row per
    membership
  - `:ebb_entity_groups_by_id` - maps membership id to entry
  - `:ebb_entity_groups_by_group` - `:ordered_set` of `{{group_id,
    entity_id}}`, one row per membership, so a membership write is
    O(log N) rather than the O(group size) a `:bag` lookup costs

  This mirrors `RelationshipCache`'s table shape and API — keyword-list
  options and `reset/1` — rather than `GroupCache`'s single-table
  signatures. The split from actor↔Group membership is deliberate:
  `groupMember` carries permissions and is the authorization
  primitive; `entityGroup` carries sync scope only.

  The GenServer exists solely to own the ETS table lifetime and
  manage startup/shutdown. All public functions are lock-free.
  """

  use GenServer

  @default_entity_groups :ebb_entity_groups
  @default_entity_groups_by_id :ebb_entity_groups_by_id
  @default_entity_groups_by_group :ebb_entity_groups_by_group

  @type t :: %__MODULE__{
          entity_groups: atom(),
          entity_groups_by_id: atom(),
          entity_groups_by_group: atom()
        }
  defstruct [:entity_groups, :entity_groups_by_id, :entity_groups_by_group]

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  @doc """
  Stores an entity↔Group membership entry.

  Accepts both atom keys (`:entity_id`) and string keys (`"entity_id"`).

  ## Examples

      iex> EntityGroupCache.put_entity_group(%{id: "eg_1", entity_id: "todo_1", group_id: "g_1"})
      :ok
  """
  @spec put_entity_group(map(), keyword()) :: :ok | {:error, :nil_values_not_allowed}
  def put_entity_group(membership, opts \\ []) do
    table = Keyword.get(opts, :entity_groups, @default_entity_groups)
    by_id_table = Keyword.get(opts, :entity_groups_by_id, @default_entity_groups_by_id)

    by_group_table =
      Keyword.get(opts, :entity_groups_by_group, @default_entity_groups_by_group)

    entity_id = membership[:entity_id] || membership["entity_id"]
    group_id = membership[:group_id] || membership["group_id"]
    entry_id = membership[:id] || membership["id"]

    if is_nil(entity_id) or is_nil(group_id) or is_nil(entry_id) do
      {:error, :nil_values_not_allowed}
    else
      entry = %{id: entry_id, entity_id: entity_id, group_id: group_id}

      # A re-put replaces the row for the same id. Leaving the previous
      # row in the bags would let a stale group keep resolving.
      delete_entity_group(entry_id,
        entity_groups: table,
        entity_groups_by_id: by_id_table,
        entity_groups_by_group: by_group_table
      )

      :ets.insert(table, {entity_id, entry})
      :ets.insert(by_id_table, {entry_id, entry})
      :ets.insert(by_group_table, {{group_id, entity_id}})
      :ok
    end
  end

  @doc """
  Deletes an entity↔Group membership entry by its id.

  ## Examples

      iex> EntityGroupCache.delete_entity_group("eg_1")
      :ok
  """
  @spec delete_entity_group(String.t(), keyword()) :: :ok
  def delete_entity_group(entry_id, opts \\ []) do
    table = Keyword.get(opts, :entity_groups, @default_entity_groups)
    by_id_table = Keyword.get(opts, :entity_groups_by_id, @default_entity_groups_by_id)

    by_group_table =
      Keyword.get(opts, :entity_groups_by_group, @default_entity_groups_by_group)

    case :ets.lookup(by_id_table, entry_id) do
      [{_, entry}] ->
        :ets.delete_object(table, {entry.entity_id, entry})
        :ets.delete(by_group_table, {entry.group_id, entry.entity_id})
        :ets.delete(by_id_table, entry_id)
        :ok

      [] ->
        :ok
    end
  end

  @doc """
  Looks up an entity↔Group membership entry by its id.

  ## Examples

      iex> EntityGroupCache.get_entity_group("eg_1")
      %{id: "eg_1", entity_id: "todo_1", group_id: "g_1"}

      iex> EntityGroupCache.get_entity_group("unknown")
      nil
  """
  @spec get_entity_group(String.t(), atom()) :: map() | nil
  def get_entity_group(entry_id, table \\ @default_entity_groups_by_id) do
    case :ets.lookup(table, entry_id) do
      [{_, entry}] -> entry
      [] -> nil
    end
  end

  @doc """
  Returns the distinct group ids an entity belongs to.

  ## Examples

      iex> EntityGroupCache.entity_groups("todo_1")
      ["g_1", "g_2"]

      iex> EntityGroupCache.entity_groups("unknown")
      []
  """
  @spec entity_groups(String.t(), atom()) :: [String.t()]
  def entity_groups(entity_id, table \\ @default_entity_groups) do
    table
    |> :ets.lookup(entity_id)
    |> Enum.map(fn {_entity_id, entry} -> entry.group_id end)
    |> Enum.uniq()
  end

  @doc """
  Returns the entity ids that belong to a group, in no particular
  order.

  No production caller yet; the cache tests use it to pin the by-group
  index's put/delete behavior. Reads the `:ordered_set` by the
  partially-bound composite key, so cost scales with the number of
  members rather than the whole index.

  ## Examples

      iex> EntityGroupCache.group_entities("g_1")
      ["todo_1", "todo_2"]
  """
  @spec group_entities(String.t(), atom()) :: [String.t()]
  def group_entities(group_id, table \\ @default_entity_groups_by_group) do
    :ets.select(table, [{{{group_id, :"$1"}}, [], [:"$1"]}])
  end

  @doc """
  Resets all membership tables by clearing every entry.

  ## Examples

      iex> EntityGroupCache.reset()
      :ok
  """
  @spec reset(keyword()) :: :ok
  def reset(opts \\ []) do
    table = Keyword.get(opts, :entity_groups, @default_entity_groups)
    by_id_table = Keyword.get(opts, :entity_groups_by_id, @default_entity_groups_by_id)

    by_group_table =
      Keyword.get(opts, :entity_groups_by_group, @default_entity_groups_by_group)

    reset_table(table, :bag)
    reset_table(by_id_table, :set)
    reset_table(by_group_table, :ordered_set)
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
    table = Keyword.get(opts, :entity_groups, @default_entity_groups)
    by_id_table = Keyword.get(opts, :entity_groups_by_id, @default_entity_groups_by_id)

    by_group_table =
      Keyword.get(opts, :entity_groups_by_group, @default_entity_groups_by_group)

    :persistent_term.put({__MODULE__, :entity_groups}, table)
    :persistent_term.put({__MODULE__, :entity_groups_by_id}, by_id_table)
    :persistent_term.put({__MODULE__, :entity_groups_by_group}, by_group_table)
    :ets.new(table, [:bag, :public, :named_table])
    :ets.new(by_id_table, [:set, :public, :named_table])
    :ets.new(by_group_table, [:ordered_set, :public, :named_table])

    {:ok,
     %__MODULE__{
       entity_groups: table,
       entity_groups_by_id: by_id_table,
       entity_groups_by_group: by_group_table
     }}
  end

  @impl true
  def terminate(_reason, state) do
    for table <- [state.entity_groups, state.entity_groups_by_id, state.entity_groups_by_group] do
      try do
        :ets.delete(table)
      rescue
        ArgumentError -> :ok
      end
    end

    :ok
  end
end
