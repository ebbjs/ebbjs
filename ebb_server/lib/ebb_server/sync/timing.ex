defmodule EbbServer.Sync.Timing do
  @moduledoc """
  The monotonic clock and span arithmetic the sync processes share.

  Every hop in the fan-out chain measures the same two things: the current
  monotonic millisecond, and the non-negative distance between two timestamps
  that may not both be present. `span/2` returns `nil` rather than `0` when a
  timestamp is missing so a caller can tell "not sampled" from "no elapsed
  time", which the router's dwell hop depends on.
  """

  @doc """
  Elapsed milliseconds between `from` and `to`, clamped at zero.

  Returns `nil` unless both timestamps are integers, so an unsampled hop stays
  distinguishable from a hop that took no measurable time.
  """
  @spec span(term(), term()) :: non_neg_integer() | nil
  def span(from, to) when is_integer(from) and is_integer(to), do: max(to - from, 0)
  def span(_from, _to), do: nil

  @doc "The current monotonic time in milliseconds."
  @spec now_ms() :: integer()
  def now_ms, do: System.monotonic_time(:millisecond)

  @doc """
  `dividend / divisor` rounded up, for whole-unit conversions such as
  retry-after seconds and idle windows.
  """
  @spec ceil_div(non_neg_integer(), pos_integer()) :: non_neg_integer()
  def ceil_div(dividend, divisor) when divisor > 0, do: div(dividend + divisor - 1, divisor)
end
