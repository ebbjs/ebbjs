defmodule EbbServer.Bench.Materialize.Stats do
  @moduledoc """
  Percentile helpers shared by the materialization benchmark and its
  generated-column ablation.
  """

  @doc """
  The `p`-quantile of `samples` (nearest-rank), or `nil` for an empty list.
  """
  @spec percentile([number()], float()) :: number() | nil
  def percentile([], _p), do: nil

  def percentile(samples, p) do
    sorted = Enum.sort(samples)
    index = min(round(p * (length(sorted) - 1)), length(sorted) - 1)
    Enum.at(sorted, index)
  end

  @doc """
  The median of `samples`, or `nil` for an empty list.
  """
  @spec median([number()]) :: number() | nil
  def median(samples), do: percentile(samples, 0.5)
end
