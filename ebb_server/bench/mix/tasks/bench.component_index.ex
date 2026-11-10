defmodule Mix.Tasks.Bench.ComponentIndex do
  @shortdoc "Measure component-index write amplification at k = 2, 4, 8 (#799)"

  @moduledoc """
  Measures the `cf_component_entities` index's share of the write path at
  k = 2, 4, 8 components per entity.

      mix bench.component_index

  Every measured Action creates a k-component `todo` row plus its
  `entityGroup` row, through the real `Writer` with sync durability. Each k
  is run three times per arm:

    - `model only` — `--ablate component_entries`, the pre-#799 shape: one
      model entry per row, no per-component entries;
    - `model + components` — the shipped index;
    - `no index` — `--ablate component_entities`, for context.

  `Index ops` and `Index bytes` are the per-entity amplification of the
  shipped index over the model-only shape: k component entries for a
  k-component row, where the pre-#799 index had none.

  This is the measurement gate for slice 6 (`docs/plan/components-epic.md`).
  Throughput numbers are machine-specific; the shape — cost per component,
  not per byte — is what travels.
  """

  use Mix.Task

  alias EbbServer.Bench.ComponentIndex

  @impl Mix.Task
  def run(_args) do
    rows = ComponentIndex.report()

    Mix.shell().info("""
    Component-index write amplification (#799)

      One Action = one k-component `todo` row + its `entityGroup` row, through the real Writer.

      | k | Index ops | Index bytes | Actions/s (model only) | Actions/s (model + components) | Added cost | Actions/s (no index) |
      | -: | --------: | ----------: | ---------------------: | -----------------------------: | ---------: | -------------------: |
    #{Enum.map_join(rows, "\n", &row/1)}
    """)
  end

  defp row(%{k: k, index: index, baseline: baseline, indexed: indexed, ablated: ablated}) do
    {baseline_median, baseline_range} = median(baseline)
    {indexed_median, indexed_range} = median(indexed)
    {ablated_median, ablated_range} = median(ablated)
    cost = paired_cost(baseline, indexed)

    "| #{k} | #{index.ops} | #{index.bytes} | #{rate(baseline_median)} #{baseline_range} | " <>
      "#{rate(indexed_median)} #{indexed_range} | #{Float.round(cost * 100, 1)}% | " <>
      "#{rate(ablated_median)} #{ablated_range} |"
  end

  # Paired per run, not the ratio of medians: the arms are interleaved inside
  # each run so a slow pass cancels out of its own pair.
  defp paired_cost(baseline, indexed) do
    costs =
      Enum.zip(baseline, indexed)
      |> Enum.map(fn {base, with_index} -> 1 - with_index.actions_per_s / base.actions_per_s end)
      |> Enum.sort()

    Enum.at(costs, div(length(costs), 2))
  end

  defp median(measurements) do
    rates = measurements |> Enum.map(& &1.actions_per_s) |> Enum.sort()

    {Enum.at(rates, div(length(rates), 2)),
     "(#{Float.round(List.first(rates), 0)}–#{Float.round(List.last(rates), 0)})"}
  end

  defp rate(value), do: value |> Float.round(0) |> trunc() |> Integer.to_string()
end
