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

  @default_dirty_set_name :ebb_dirty_set
  @default_gsn_counter_name :ebb_gsn_counter

  @type t :: %__MODULE__{
          dirty_set: atom(),
          gsn_counter: :atomics.atomics(),
          gsn_counter_name: atom()
        }
  defstruct [:dirty_set, :gsn_counter, :gsn_counter_name]

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
  def mark_dirty_batch(entity_ids, dirty_set \\ @default_dirty_set_name) when is_list(entity_ids) do
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

  @impl true
  def init(opts) do
    initial_gsn = Keyword.get(opts, :initial_gsn, 0)
    dirty_set = Keyword.get(opts, :dirty_set, @default_dirty_set_name)
    gsn_counter = Keyword.get(opts, :gsn_counter, nil)
    gsn_counter_name = Keyword.get(opts, :gsn_counter_name, @default_gsn_counter_name)

    :ets.new(dirty_set, [:set, :public, :named_table])

    counter =
      case gsn_counter do
        nil -> :atomics.new(1, signed: false)
        _ -> gsn_counter
      end

    if initial_gsn > 0 do
      :atomics.put(counter, 1, initial_gsn)
    end

    :persistent_term.put(gsn_counter_name, counter)

    {:ok, %__MODULE__{dirty_set: dirty_set, gsn_counter: counter, gsn_counter_name: gsn_counter_name}}
  end

  @impl true
  def terminate(_reason, state) do
    try do
      :ets.delete(state.dirty_set)
    rescue
      ArgumentError -> :ok
    end

    :persistent_term.erase(state.gsn_counter_name)

    :ok
  end
end
