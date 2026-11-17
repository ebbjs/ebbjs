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
  """

  @doc """
  The range is guaranteed to be gap-free and monotonically increasing across
  concurrent calls.
  """
  @spec claim_gsn_range(pos_integer(), :atomics.atomics()) ::
          {pos_integer(), pos_integer()}
  def claim_gsn_range(count, counter) when is_integer(count) and count > 0 do
    gsn_end = :atomics.add_get(counter, 1, count)
    gsn_start = gsn_end - count + 1
    {gsn_start, gsn_end}
  end

  @doc """
  Raises the counter to at least `gsn` and returns the resulting value.

  Used by `EbbServer.Storage.Writer.init/1` to heal a Writer restart that
  left the counter ahead of the durable log. Never lowers the counter —
  GSNs are never reused.
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

  @spec reset(:atomics.atomics()) :: :ok
  def reset(counter) do
    :atomics.put(counter, 1, 0)
    :ok
  end
end
