defmodule EbbServer.Storage.DirtyTracker do
  @moduledoc """
  GenServer that owns the dirty set ETS table.

  Tracks which entity IDs need re-materialization. The GenServer exists
  solely to own the ETS table lifetime and manage startup/shutdown.

  All public functions are lock-free (ETS reads/writes) and do not
  route through `GenServer.call`.
  """

  use GenServer

  @default_dirty_set_name :ebb_dirty_set

  @type t :: %__MODULE__{
          dirty_set: atom()
        }
  defstruct [:dirty_set]

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  @doc """
  Marks a batch of entity IDs as dirty (needs re-materialization).

  ## Examples

      iex> DirtyTracker.mark_dirty_batch(["todo_1", "todo_2"])
      :ok
  """
  @spec mark_dirty_batch([String.t()], atom()) :: :ok
  def mark_dirty_batch(entity_ids, dirty_set \\ @default_dirty_set_name)
      when is_list(entity_ids) do
    Enum.each(entity_ids, fn id ->
      :ets.insert(dirty_set, {id, true})
    end)

    :ok
  end

  @doc """
  Checks if an entity ID is marked as dirty.

  ## Examples

      iex> DirtyTracker.dirty?("todo_1")
      false
  """
  @spec dirty?(String.t(), atom()) :: boolean()
  def dirty?(entity_id, dirty_set \\ @default_dirty_set_name) do
    :ets.lookup(dirty_set, entity_id) != []
  end

  @doc """
  Clears the dirty flag for an entity ID.

  ## Examples

      iex> DirtyTracker.clear_dirty("todo_1")
      true
  """
  @spec clear_dirty(String.t(), atom()) :: true
  def clear_dirty(entity_id, dirty_set \\ @default_dirty_set_name) do
    :ets.delete(dirty_set, entity_id)
  end

  @doc """
  Resets the dirty set by clearing all entries.

  ## Examples

      iex> DirtyTracker.reset()
      :ok
  """
  @spec reset(atom()) :: :ok
  def reset(dirty_set \\ @default_dirty_set_name) do
    case :ets.info(dirty_set, :name) do
      :undefined ->
        :ets.new(dirty_set, [:set, :public, :named_table])

      _ ->
        try do
          :ets.delete_all_objects(dirty_set)
        rescue
          ArgumentError -> :ets.new(dirty_set, [:set, :public, :named_table])
        end
    end

    :ok
  end

  @doc """
  Returns all dirty entity IDs that match a given type prefix.

  ## Examples

      iex> DirtyTracker.dirty_entity_ids_for_type("todo")
      ["todo_abc", "todo_xyz"]
  """
  @spec dirty_entity_ids_for_type(String.t(), atom()) :: [String.t()]
  def dirty_entity_ids_for_type(type, dirty_set \\ @default_dirty_set_name) do
    type_prefixes =
      case type do
        "groupMember" -> ["gm_", "groupMember_"]
        "relationship" -> ["rel_", "relationship_"]
        _ -> [type <> "_"]
      end

    dirty_set
    |> :ets.tab2list()
    |> Enum.reduce([], fn {entity_id, _}, acc ->
      if Enum.any?(type_prefixes, &String.starts_with?(entity_id, &1)) do
        [entity_id | acc]
      else
        acc
      end
    end)
  end

  @impl true
  def init(opts) do
    dirty_set = Keyword.get(opts, :dirty_set, @default_dirty_set_name)
    :persistent_term.put({__MODULE__, :dirty_set}, dirty_set)
    :ets.new(dirty_set, [:set, :public, :named_table])

    {:ok, %__MODULE__{dirty_set: dirty_set}}
  end

  @impl true
  def terminate(_reason, state) do
    try do
      :ets.delete(state.dirty_set)
    rescue
      ArgumentError -> :ok
    end

    :ok
  end
end
