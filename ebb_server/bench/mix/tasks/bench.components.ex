defmodule Mix.Tasks.Bench.Components do
  @shortdoc "Report the component envelope's payload cost (#797)"

  @moduledoc """
  Prints the encoded size of one logical five-field edit in the component
  envelope against the row-record shape it replaces.

      mix bench.components

  The stored (`cf_actions` ETF) and request (JSON) sizes are both reported,
  plus the Update count. See `EbbServer.Bench.Components` for what is built.

  Throughput is measured with `mix bench.actions --tier t0` (the real
  `Writer`, no HTTP) against the same config at the commit this envelope
  replaces; the epic records both runs.
  """

  use Mix.Task

  alias EbbServer.Bench.Components

  @impl Mix.Task
  def run(_args) do
    report = Components.report()

    Mix.shell().info("""
    Component envelope payload cost (#797)

      One logical edit touching #{report.new_updates} components: #{inspect(Components.components())}

      | Measure                | Row record (before) | Components (after) | Delta |
      | ---------------------- | ------------------: | -----------------: | ----: |
      | Updates per edit       | #{report.old_updates}                   | #{report.new_updates}                  | #{delta(report.old_updates, report.new_updates)} |
      | Stored payload (bytes) | #{report.old_stored_bytes}                | #{report.new_stored_bytes}                | #{delta(report.old_stored_bytes, report.new_stored_bytes)} |
      | Request JSON (bytes)   | #{report.old_json_bytes}                | #{report.new_json_bytes}                | #{delta(report.old_json_bytes, report.new_json_bytes)} |
    """)
  end

  defp delta(from, to) do
    change =
      cond do
        from == 0 -> "n/a"
        true -> "#{Float.round((to - from) / from * 100, 1)}%"
      end

    "#{to - from} (#{change})"
  end
end
