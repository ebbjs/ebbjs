defmodule EbbServer.Storage.GsnCounter do
  @moduledoc """
  Pure module for managing Global Sequence Numbers (GSN) using atomics.

  Provides lock-free, monotonically increasing sequence numbers via
  Erlang's `:atomics` module. No GenServer needed - all operations
  are direct atomic operations.

  ## GSNs are never rewound or reused

  A claim only advances the counter. If the Writer fails to commit the
  claimed range it abandons it — the GSNs become permanent holes in the
  Action log — rather than resetting the counter. `reconcile/2` only ever
  raises the counter, so a Writer restart cannot replay a GSN.

  ## Usage

      # Claim a range of GSNs
      {gsn_start, gsn_end} = GsnCounter.claim_gsn_range(100)

      # Ensure a restarted counter never sits below the durable log
      GsnCounter.reconcile(counter, RocksDB.get_max_gsn())

      # Get current resources (for testing)
      %{gsn_counter: counter, gsn_counter_name: :my_counter} = GsnCounter.get_resources()

      # Reset counter (for testing)
      :ok = GsnCounter.reset(:my_counter, counter)
  """

  @default_gsn_counter_name :ebb_gsn_counter

  @doc """
  Claims a range of GSNs atomically.

  Returns a tuple of {start, end} GSN values. The range is guaranteed
  to be gap-free and monotonically increasing across concurrent calls.

  ## Options

  - `:counter` - Custom atomics reference. Defaults to the module's persistent term.

  ## Examples

      iex> GsnCounter.claim_gsn_range(1)
      {1, 1}

      iex> GsnCounter.claim_gsn_range(5)
      {2, 6}
  """
  @spec claim_gsn_range(pos_integer(), :atomics.atomics() | nil) ::
          {pos_integer(), pos_integer()}
  def claim_gsn_range(count, counter \\ nil) when is_integer(count) and count > 0 do
    counter_ref = counter || :persistent_term.get(@default_gsn_counter_name)
    gsn_end = :atomics.add_get(counter_ref, 1, count)
    gsn_start = gsn_end - count + 1
    {gsn_start, gsn_end}
  end

  @doc """
  Raises the counter to at least `gsn` and returns the resulting value.

  Used by `EbbServer.Storage.Writer.init/1` to heal a Writer restart that
  left the counter ahead of the durable log. Never lowers the counter —
  GSNs are never reused.

  ## Examples

      counter = :atomics.new(1, signed: false)
      GsnCounter.reconcile(counter, 7)
      #=> 7
  """
  @spec reconcile(:atomics.atomics(), non_neg_integer()) :: non_neg_integer()
  def reconcile(counter, gsn) when is_integer(gsn) and gsn >= 0 do
    current = :atomics.get(counter, 1)

    if gsn > current do
      :atomics.put(counter, 1, gsn)
      gsn
    else
      current
    end
  end

  @doc """
  Returns the current resources (counter reference and name).

  Useful for testing and for passing counter references to other processes.
  """
  @spec get_resources() :: %{
          gsn_counter: :atomics.atomics() | nil,
          gsn_counter_name: atom()
        }
  def get_resources do
    %{
      gsn_counter: :persistent_term.get(@default_gsn_counter_name),
      gsn_counter_name: @default_gsn_counter_name
    }
  end

  @doc """
  Resets the GSN counter to 0.

  ## Options

  - `:counter_name` - The persistent term name for the counter. Defaults to module default.
  - `:counter` - The atomics reference to reset. Defaults to the stored persistent term.

  ## Examples

      iex> GsnCounter.reset()
      :ok

      iex> GsnCounter.reset(:my_counter, my_atomics)
      :ok
  """
  @spec reset(atom(), :atomics.atomics() | nil) :: :ok
  def reset(counter_name \\ @default_gsn_counter_name, counter \\ nil) do
    counter_ref = counter || :persistent_term.get(counter_name, nil)

    if counter_ref do
      :atomics.put(counter_ref, 1, 0)
    end

    :ok
  end
end
