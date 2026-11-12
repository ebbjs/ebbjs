defmodule Mix.Tasks.Bench.ComponentIndex do
  @shortdoc "Measure component-index write cost and resident set at k = 2, 4, 8 (#799, #849)"

  @moduledoc """
  Measures the component existence index's share of the write path at
  k = 2, 4, 8 components per entity, and the resident set of the derived
  in-memory copy.

      mix bench.component_index

  Every measured Action creates a k-component `todo` row plus its
  `entityGroup` row, through the real `Writer` with sync durability. Each k
  is run three times per arm:

    - `model only` — `--ablate component_entries`, the pre-#799 shape: one
      model entry per row, no per-component entries;
    - `model + components` — the shipped index;
    - `no index` — `--ablate component_entities`, for context.

  `Index ops` is the per-entity amplification over the model-only shape: k
  component entries for a k-component row, where the pre-#799 index had none.
  The derived store's key shape is priced by the resident-set table below.

  The resident-set table prices the derived in-memory index (#849): the same
  keys, a label interned to an integer and the id kept whole, one model entry
  plus k component entries per row, at the
  #503 document-set row count and one order of magnitude above it. A gate
  failure means a resident budget and lazy component ranges, never a return
  to the column family.

  This is the measurement gate for slice 6 (`docs/plan/components-epic.md`).
  Throughput numbers are machine-specific; the shape — cost per component,
  not per byte — is what travels.
  """

  use Mix.Task

  alias EbbServer.Bench.ComponentIndex

  @impl Mix.Task
  def run(_args) do
    rows = ComponentIndex.report()
    resident = ComponentIndex.resident_set()

    Mix.shell().info("""
    Component-index write amplification (#799)

      One Action = one k-component `todo` row + its `entityGroup` row, through the real Writer.

      | k | Index ops | Actions/s (model only) | Actions/s (model + components) | Added cost | Actions/s (no index) |
      | -: | --------: | ---------------------: | -----------------------------: | ---------: | -------------------: |
    #{Enum.map_join(rows, "\n", &row/1)}

    Component-index resident set (#849)

      A label interned to an integer plus the whole id, in an ETS
      `:ordered_set`; one model entry plus k component entries per row. `rss`
      is the process RSS delta across the fill, `ets` the table's own
      allocator accounting.

      | Rows | k | Entries | Entries bytes | Label bytes | RSS delta | Bytes/entry (entries) |
      | ---: | -: | ------: | ------------: | ----------: | --------: | --------------------: |
    #{Enum.map_join(resident, "\n", &resident_row/1)}

      A 0 B RSS delta means the fill fit in pages the VM already held; the
      table's allocator bytes are the stable figure.
    """)
  end

  defp row(%{k: k, baseline: baseline, indexed: indexed, ablated: ablated}) do
    {baseline_median, baseline_range} = median(baseline)
    {indexed_median, indexed_range} = median(indexed)
    {ablated_median, ablated_range} = median(ablated)
    cost = 1 - indexed_median / baseline_median

    "| #{k} | #{k} | #{rate(baseline_median)} #{baseline_range} | " <>
      "#{rate(indexed_median)} #{indexed_range} | #{Float.round(cost * 100, 1)}% | " <>
      "#{rate(ablated_median)} #{ablated_range} |"
  end

  defp median(measurements) do
    rates = measurements |> Enum.map(& &1.actions_per_s) |> Enum.sort()

    {Enum.at(rates, div(length(rates), 2)),
     "(#{Float.round(List.first(rates), 0)}–#{Float.round(List.last(rates), 0)})"}
  end

  defp resident_row(%{rows: rows, k: k, entries: entries} = row) do
    bytes_per_entry = row.entries_bytes / entries

    "| #{rows} | #{k} | #{entries} | #{bytes(row.entries_bytes)} | " <>
      "#{bytes(row.labels_bytes)} | #{bytes(row.rss_bytes)} | " <>
      "#{Float.round(bytes_per_entry, 1)} |"
  end

  defp bytes(nil), do: "n/a"
  defp bytes(value) when value >= 1024 * 1024, do: "#{Float.round(value / 1024 / 1024, 1)} MiB"
  defp bytes(value) when value >= 1024, do: "#{Float.round(value / 1024, 1)} KiB"
  defp bytes(value), do: "#{value} B"

  defp rate(value), do: value |> Float.round(0) |> trunc() |> Integer.to_string()
end
