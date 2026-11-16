defmodule EbbServer.Storage.DirtyTracker do
  @moduledoc """
  GenServer that owns the dirty set ETS table.

  Tracks which entities need re-materialization. Each mark stores the
  entity ID together with its committed model and a monotonic generation
  stamped when the mark is written: `{entity_id, model, generation}`. The
  recorded model is what lets a query materialize the dirty entities of a
  model without inferring it from the ID — clients own ID generation, so a
  prefix carries no model information.

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
  """

  use GenServer

  @default_dirty_set_name :ebb_dirty_set

  @type entity_mark :: {entity_id :: String.t(), model :: String.t() | nil}
  @type t :: %__MODULE__{
          dirty_set: atom()
        }
  defstruct [:dirty_set]

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  @spec mark_dirty_batch([entity_mark()], atom()) :: :ok
  def mark_dirty_batch(entities, dirty_set \\ @default_dirty_set_name)
      when is_list(entities) do
    insert_marks(entities, dirty_set, :erlang.unique_integer([:monotonic, :positive]))
  end

  @spec mark_pending_batch([entity_mark()], atom()) :: non_neg_integer()
  def mark_pending_batch(entities, dirty_set \\ @default_dirty_set_name)
      when is_list(entities) do
    generation = :erlang.unique_integer([:monotonic, :positive])
    insert_marks(entities, dirty_set, {:pending, generation})
    generation
  end

  @spec clear_pending_batch([entity_mark()], non_neg_integer(), atom()) :: :ok
  # No default for `dirty_set`: a two-arity call must not silently pass a
  # table where a generation is expected.
  def clear_pending_batch(entities, generation, dirty_set) when is_list(entities) do
    # Matched on the id and this batch's generation, not on the model: a
    # `nil` model in the batch never replaced the model the mark preserved,
    # so the mark's model is not the batch's to predict.
    Enum.each(entities, fn {id, _model} ->
      :ets.match_delete(dirty_set, {id, :_, {:pending, generation}})
    end)

    :ok
  end

  @spec settle_all_pending(atom()) :: :ok
  def settle_all_pending(dirty_set \\ @default_dirty_set_name) do
    generation = :erlang.unique_integer([:monotonic, :positive])

    dirty_set
    |> :ets.tab2list()
    |> Enum.each(fn
      {entity_id, model, {:pending, _}} ->
        :ets.insert(dirty_set, {entity_id, model, generation})

      _settled ->
        :ok
    end)

    :ok
  end

  @spec pending?(term()) :: boolean()
  def pending?({:pending, _generation}), do: true
  def pending?(_mark), do: false

  @spec dirty?(String.t(), atom()) :: boolean()
  def dirty?(entity_id, dirty_set \\ @default_dirty_set_name) do
    dirty_generation(entity_id, dirty_set) != nil
  end

  @spec dirty_generation(String.t(), atom()) :: term()
  def dirty_generation(entity_id, dirty_set \\ @default_dirty_set_name) do
    case :ets.lookup(dirty_set, entity_id) do
      [{^entity_id, _model, mark}] -> mark
      [] -> nil
    end
  end

  @spec dirty_set_name() :: atom()
  def dirty_set_name do
    :persistent_term.get({__MODULE__, :dirty_set}, @default_dirty_set_name)
  end

  @spec size(atom()) :: non_neg_integer()
  def size(dirty_set \\ @default_dirty_set_name) do
    case :ets.info(dirty_set, :size) do
      :undefined -> 0
      size -> size
    end
  end

  @spec clear_dirty(String.t(), term(), atom()) :: :ok
  # No default for `dirty_set`: a two-arity call must not silently pass a
  # table where a generation is expected.
  def clear_dirty(entity_id, observed_generation, dirty_set) do
    :ets.select_delete(dirty_set, [{{entity_id, :_, observed_generation}, [], [true]}])
    :ok
  end

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

  @spec dirty_entity_ids_for_models([String.t()], atom()) :: [String.t()]
  def dirty_entity_ids_for_models(models, dirty_set \\ @default_dirty_set_name)
      when is_list(models) do
    match_spec =
      models
      |> Enum.uniq()
      |> Enum.map(fn model -> {{:"$1", model, :_}, [], [:"$1"]} end)

    :ets.select(dirty_set, match_spec)
  end

  @spec dirty_entity_ids_for_model(String.t(), atom()) :: [String.t()]
  def dirty_entity_ids_for_model(model, dirty_set \\ @default_dirty_set_name) do
    dirty_entity_ids_for_models([model], dirty_set)
  end

  defp insert_marks(entities, dirty_set, mark) do
    Enum.each(entities, fn {id, model} -> insert_mark(dirty_set, id, model, mark) end)
  end

  defp insert_mark(dirty_set, id, nil, mark) do
    # A mark is one row per id, so a `nil` model would overwrite — and hide —
    # the model an earlier mark recorded, leaving the entity invisible to
    # `dirty_entity_ids_for_model/2`. Update the mark alone and keep whatever
    # model the row already carries; `insert_new` covers an id with no mark
    # yet, and losing that race re-runs the model-preserving update.
    unless :ets.update_element(dirty_set, id, {3, mark}) do
      unless :ets.insert_new(dirty_set, {id, nil, mark}) do
        :ets.update_element(dirty_set, id, {3, mark})
      end
    end

    :ok
  end

  defp insert_mark(dirty_set, id, model, mark) do
    :ets.insert(dirty_set, {id, model, mark})
    :ok
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
