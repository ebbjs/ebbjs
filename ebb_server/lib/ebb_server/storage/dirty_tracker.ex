defmodule EbbServer.Storage.DirtyTracker do
  @moduledoc """
  GenServer that owns the dirty set ETS table.

  Tracks which entities need re-materialization. Each mark stores the
  entity ID together with its subject type and a monotonic generation
  stamped when the mark is written: `{entity_id, subject_type,
  generation}`. The recorded type is what lets a query materialize the
  dirty entities of a type without inferring the type from the ID —
  clients own ID generation, so a prefix carries no type information.

  A materializer reads the generation before it scans, then clears with
  a compare-and-clear (`clear_dirty/3`): the mark is removed only if the
  stored generation still equals the one observed. A newer mark that
  lands while materialization is in flight has a different generation
  and survives, so the next read re-materializes instead of serving
  stale data forever.

  ## Provisional marks

  The Writer commits before it can mark a batch, so a plain post-commit
  mark would leave a window in which an entity is clean while SQLite is
  already behind RocksDB. To close it, the Writer writes a *provisional*
  mark (`{:pending, generation}`) before the commit attempt and settles
  it to an ordinary dirty mark once the commit returns. Materializers
  treat a provisional mark as dirty but never clear it; only the Writer
  resolves it. See `mark_pending_batch/2` and `clear_pending_batch/3`.

  The GenServer exists solely to own the ETS table lifetime and manage
  startup/shutdown.

  All public functions are lock-free (ETS reads/writes) and do not
  route through `GenServer.call`.
  """

  use GenServer

  @default_dirty_set_name :ebb_dirty_set

  @type entity_mark :: {entity_id :: String.t(), subject_type :: String.t()}
  @type t :: %__MODULE__{
          dirty_set: atom()
        }
  defstruct [:dirty_set]

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  @doc """
  Marks a batch of `{entity_id, subject_type}` pairs as dirty (needs
  re-materialization).

  Every entity in the batch shares one fresh generation.

  ## Examples

      iex> DirtyTracker.mark_dirty_batch([{"todo_1", "todo"}, {"todo_2", "todo"}])
      :ok
  """
  @spec mark_dirty_batch([entity_mark()], atom()) :: :ok
  def mark_dirty_batch(entities, dirty_set \\ @default_dirty_set_name)
      when is_list(entities) do
    insert_marks(entities, dirty_set, :erlang.unique_integer([:monotonic, :positive]))
  end

  @doc """
  Marks a batch of `{entity_id, subject_type}` pairs as provisionally
  dirty while a commit is in flight.

  The Writer writes a provisional mark *before* it attempts the durable
  commit, so an entity is never observed clean between the commit landing
  and the batch being marked dirty. Readers treat a provisional mark as
  dirty but leave it in place; only the Writer settles it (by overwriting
  it with `mark_dirty_batch/2`) or clears it (`clear_pending_batch/3`).

  Returns the generation stamped on the batch, which `clear_pending_batch/3`
  needs to clear the same marks.

  ## Examples

      iex> generation = DirtyTracker.mark_pending_batch([{"todo_1", "todo"}])
      iex> DirtyTracker.pending?(DirtyTracker.dirty_generation("todo_1"))
      true
  """
  @spec mark_pending_batch([entity_mark()], atom()) :: non_neg_integer()
  def mark_pending_batch(entities, dirty_set \\ @default_dirty_set_name)
      when is_list(entities) do
    generation = :erlang.unique_integer([:monotonic, :positive])
    insert_marks(entities, dirty_set, {:pending, generation})
    generation
  end

  @doc """
  Clears the provisional marks of a batch, but only those still stamped
  with `generation`.

  The Writer uses this on the abandon paths: a commit that failed or
  raised must not leave entities provisionally dirty. A settled mark, or
  a provisional mark from a newer batch, has a different value and is
  left in place.

  ## Examples

      iex> generation = DirtyTracker.mark_pending_batch([{"todo_1", "todo"}])
      iex> DirtyTracker.clear_pending_batch([{"todo_1", "todo"}], generation, :ebb_dirty_set)
      :ok
  """
  @spec clear_pending_batch([entity_mark()], non_neg_integer(), atom()) :: :ok
  # No default for `dirty_set`: a two-arity call must not silently pass a
  # table where a generation is expected.
  def clear_pending_batch(entities, generation, dirty_set) when is_list(entities) do
    Enum.each(entities, fn {id, subject_type} ->
      :ets.delete_object(dirty_set, {id, subject_type, {:pending, generation}})
    end)

    :ok
  end

  @doc """
  Converts every provisional mark into a settled dirty mark.

  Called on Writer startup: no commit can be in flight at that point, so
  any surviving provisional mark belongs to a batch whose outcome is
  unknown (the Writer may have crashed before settling it). Settling is
  the conservative choice — the entity re-materializes, and if nothing
  was committed the materializer finds no new actions and clears it.

  ## Examples

      iex> DirtyTracker.settle_all_pending()
      :ok
  """
  @spec settle_all_pending(atom()) :: :ok
  def settle_all_pending(dirty_set \\ @default_dirty_set_name) do
    generation = :erlang.unique_integer([:monotonic, :positive])

    dirty_set
    |> :ets.tab2list()
    |> Enum.each(fn
      {entity_id, subject_type, {:pending, _}} ->
        :ets.insert(dirty_set, {entity_id, subject_type, generation})

      _settled ->
        :ok
    end)

    :ok
  end

  @doc """
  True when a mark returned by `dirty_generation/2` is provisional, i.e. a
  commit for the entity is still in flight.

  ## Examples

      iex> DirtyTracker.pending?(nil)
      false
  """
  @spec pending?(term()) :: boolean()
  def pending?({:pending, _generation}), do: true
  def pending?(_mark), do: false

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
  Returns the mark stored for an entity, or `nil` when the entity is
  clean.

  A settled mark is a generation integer. A provisional mark (a commit is
  in flight) is `{:pending, generation}` — see `pending?/1`.

  ## Examples

      iex> DirtyTracker.dirty_generation("todo_1")
      nil
  """
  @spec dirty_generation(String.t(), atom()) :: term()
  def dirty_generation(entity_id, dirty_set \\ @default_dirty_set_name) do
    case :ets.lookup(dirty_set, entity_id) do
      [{^entity_id, _subject_type, mark}] -> mark
      [] -> nil
    end
  end

  @doc """
  Returns the name of the dirty set table this tracker owns.

  The name is fixed at startup, so a caller that only needs the table —
  rather than the tracker process — can resolve it without knowing the
  `:persistent_term` key.
  """
  @spec dirty_set_name() :: atom()
  def dirty_set_name do
    :persistent_term.get({__MODULE__, :dirty_set}, @default_dirty_set_name)
  end

  @doc """
  Returns the number of entities currently marked dirty.

  Returns `0` when the dirty set table does not exist, so a caller
  sampling the backlog is not coupled to the table's lifetime.
  """
  @spec size(atom()) :: non_neg_integer()
  def size(dirty_set \\ @default_dirty_set_name) do
    case :ets.info(dirty_set, :size) do
      :undefined -> 0
      size -> size
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
      :ok
  """
  @spec clear_dirty(String.t(), term(), atom()) :: :ok
  # No default for `dirty_set`: a two-arity call must not silently pass a
  # table where a generation is expected.
  def clear_dirty(entity_id, observed_generation, dirty_set) do
    :ets.select_delete(dirty_set, [{{entity_id, :_, observed_generation}, [], [true]}])
    :ok
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
  Returns all dirty entity IDs recorded under any of the given subject
  types.

  Classification is by the type recorded in the mark, never by the ID
  prefix. The result order is unspecified.

  ## Examples

      iex> DirtyTracker.dirty_entity_ids_for_types(["todo"])
      ["todo_abc", "todo_xyz"]
  """
  @spec dirty_entity_ids_for_types([String.t()], atom()) :: [String.t()]
  def dirty_entity_ids_for_types(types, dirty_set \\ @default_dirty_set_name)
      when is_list(types) do
    match_spec =
      types
      |> Enum.uniq()
      |> Enum.map(fn type -> {{:"$1", type, :_}, [], [:"$1"]} end)

    :ets.select(dirty_set, match_spec)
  end

  @doc """
  Returns all dirty entity IDs recorded under a single subject type.

  ## Examples

      iex> DirtyTracker.dirty_entity_ids_for_type("todo")
      ["todo_abc", "todo_xyz"]
  """
  @spec dirty_entity_ids_for_type(String.t(), atom()) :: [String.t()]
  def dirty_entity_ids_for_type(type, dirty_set \\ @default_dirty_set_name) do
    dirty_entity_ids_for_types([type], dirty_set)
  end

  defp insert_marks(entities, dirty_set, mark) do
    Enum.each(entities, fn {id, subject_type} ->
      :ets.insert(dirty_set, {id, subject_type, mark})
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
