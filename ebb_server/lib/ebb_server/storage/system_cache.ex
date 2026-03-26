defmodule EbbServer.Storage.SystemCache do
  @moduledoc """
  GenServer that owns shared ETS tables and atomics for the storage layer.

  Creates and owns:
  - `:ebb_dirty_set` ETS table — tracks which entity IDs need re-materialization
  - GSN counter (`:atomics`) — monotonically increasing, gap-free global sequence numbers

  All public data functions are lock-free (ETS reads/writes and atomics operations)
  and do not route through `GenServer.call`. The GenServer exists solely to own
  the ETS table lifetime and manage startup/shutdown of the shared resources.
  """

  use GenServer

  # ---------------------------------------------------------------------------
  # Public API — start / stop
  # ---------------------------------------------------------------------------

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  # ---------------------------------------------------------------------------
  # Public API — GSN counter (lock-free via :atomics)
  # ---------------------------------------------------------------------------

  @doc """
  Atomically claims a contiguous range of `count` GSNs.

  Returns `{gsn_start, gsn_end}` where the range is inclusive on both ends.
  Thread-safe — multiple concurrent callers will receive non-overlapping ranges.
  """
  @spec claim_gsn_range(pos_integer()) :: {pos_integer(), pos_integer()}
  def claim_gsn_range(count) when is_integer(count) and count > 0 do
    counter = :persistent_term.get(:ebb_gsn_counter)
    gsn_end = :atomics.add_get(counter, 1, count)
    gsn_start = gsn_end - count + 1
    {gsn_start, gsn_end}
  end

  # ---------------------------------------------------------------------------
  # Public API — dirty set (lock-free via ETS)
  # ---------------------------------------------------------------------------

  @doc """
  Marks a batch of entity IDs as dirty (needing re-materialization).
  """
  @spec mark_dirty_batch([String.t()]) :: :ok
  def mark_dirty_batch(entity_ids) when is_list(entity_ids) do
    Enum.each(entity_ids, fn id ->
      :ets.insert(:ebb_dirty_set, {id, true})
    end)

    :ok
  end

  @doc """
  Returns `true` if the given entity ID is marked dirty.
  """
  @spec is_dirty?(String.t()) :: boolean()
  def is_dirty?(entity_id) do
    :ets.lookup(:ebb_dirty_set, entity_id) != []
  end

  @doc """
  Clears the dirty flag for the given entity ID.

  Returns `true` (matches ETS delete behavior).
  """
  @spec clear_dirty(String.t()) :: true
  def clear_dirty(entity_id) do
    :ets.delete(:ebb_dirty_set, entity_id)
  end

  # ---------------------------------------------------------------------------
  # GenServer callbacks
  # ---------------------------------------------------------------------------

  @impl true
  def init(opts) do
    initial_gsn = Keyword.get(opts, :initial_gsn, 0)

    # Create the dirty set ETS table — public so any process can read/write
    :ets.new(:ebb_dirty_set, [:set, :public, :named_table])

    # Create the GSN atomics counter and store in persistent_term
    gsn_counter = :atomics.new(1, signed: false)

    if initial_gsn > 0 do
      :atomics.put(gsn_counter, 1, initial_gsn)
    end

    :persistent_term.put(:ebb_gsn_counter, gsn_counter)

    {:ok, %{}}
  end

  @impl true
  def terminate(_reason, _state) do
    # ETS table is automatically deleted when the owning process dies,
    # but be explicit for clarity
    try do
      :ets.delete(:ebb_dirty_set)
    rescue
      ArgumentError -> :ok
    end

    :persistent_term.erase(:ebb_gsn_counter)
    :ok
  end
end
