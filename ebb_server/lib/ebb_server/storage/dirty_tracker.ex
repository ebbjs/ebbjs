defmodule EbbServer.Storage.DirtyTracker do
  @moduledoc """
  GenServer that owns the dirty set ETS table.

  Tracks which entity IDs need re-materialization. Each mark stores the
  entity ID together with a monotonic generation stamped when the mark
  is written: `{entity_id, generation}`.

  A materializer reads the generation before it scans, then clears with
  a compare-and-clear (`clear_dirty/3`): the mark is removed only if the
  stored generation still equals the one observed. A newer mark that
  lands while materialization is in flight has a different generation
  and survives, so the next read re-materializes instead of serving
  stale data forever.

  The GenServer exists solely to own the ETS table lifetime and manage
  startup/shutdown.

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

  Every ID in the batch shares one fresh generation.

  ## Examples

      iex> DirtyTracker.mark_dirty_batch(["todo_1", "todo_2"])
      :ok
  """
  @spec mark_dirty_batch([String.t()], atom()) :: :ok
  def mark_dirty_batch(entity_ids, dirty_set \\ @default_dirty_set_name)
      when is_list(entity_ids) do
    generation = :erlang.unique_integer([:monotonic, :positive])

    Enum.each(entity_ids, fn id ->
      :ets.insert(dirty_set, {id, generation})
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
    dirty_generation(entity_id, dirty_set) != nil
  end

  @doc """
  Returns the generation stamped on an entity's dirty mark, or `nil` when
  the entity is clean.

  ## Examples

      iex> DirtyTracker.dirty_generation("todo_1")
      nil
  """
  @spec dirty_generation(String.t(), atom()) :: term()
  def dirty_generation(entity_id, dirty_set \\ @default_dirty_set_name) do
    case :ets.lookup(dirty_set, entity_id) do
      [{^entity_id, generation}] -> generation
      [] -> nil
    end
  end

  @doc """
  Compare-and-clears the dirty mark for an entity ID.

  Removes the mark only when the currently stored generation equals
  `observed_generation`. A mark written after the observation carries a
  different generation and is left in place.

  ## Examples

      iex> generation = DirtyTracker.dirty_generation("todo_1")
      iex> DirtyTracker.clear_dirty("todo_1", generation, :ebb_dirty_set)
      true
  """
  @spec clear_dirty(String.t(), term(), atom()) :: true
  # No default for `dirty_set`: a two-arity call must not silently pass a
  # table where a generation is expected.
  def clear_dirty(entity_id, observed_generation, dirty_set) do
    :ets.delete_object(dirty_set, {entity_id, observed_generation})
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
        "entityGroup" -> ["eg_", "entityGroup_"]
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
