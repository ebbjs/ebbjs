defmodule EbbServer.Bench.RunSummary do
  @moduledoc """
  One shape for a measured pass, whether it came from this run or from a
  baseline report.

  The guardrail comparison and the machine-readable block both need the same
  fields. Normalising here keeps a missing key from silently turning into
  `nil` in only one of the two paths, which would disable a check without a
  test noticing.
  """

  alias EbbServer.Bench.Options

  @type t :: %{
          label: String.t() | nil,
          depth: pos_integer() | nil,
          config: map(),
          rate: number() | nil,
          p50: number() | nil,
          p95: number() | nil,
          p99: number() | nil,
          throughput_accepted: non_neg_integer() | nil,
          throughput_rejected: non_neg_integer() | nil,
          latency_count: non_neg_integer() | nil,
          accepted: non_neg_integer() | nil,
          rejected: non_neg_integer() | nil,
          errors: non_neg_integer() | nil,
          gsn_holes: non_neg_integer() | nil,
          gsn_first_hole: pos_integer() | nil,
          socket_holes: non_neg_integer() | nil,
          socket_errors: non_neg_integer() | nil,
          watermark_lag_high: integer() | nil,
          watermark_lag_final: integer() | nil
        }

  @doc """
  Summarises a measured pass from this run.
  """
  @spec from_run(map(), Options.t()) :: t()
  def from_run(run, %Options{} = config) do
    build(
      run.label,
      run.depth,
      Options.workload(run_config(run, config)),
      overall(run.metrics.throughput) || %{},
      overall(run.metrics.latency) || %{},
      Map.merge(run.metrics.correctness, socket_correctness(run.metrics))
    )
  end

  @doc """
  Summarises a run read from a baseline report's machine block.
  """
  @spec from_machine(map()) :: t()
  def from_machine(run) do
    build(
      run["label"],
      run["depth"],
      # Defaults fill any option a report predates, so an older baseline still
      # matches on the workload fields it does carry.
      Map.merge(Options.workload(%Options{}), run["config"] || %{}),
      run["throughput"] || %{},
      run["latency"] || %{},
      run["correctness"] || %{}
    )
  end

  # A real-socket run gates on what the clients saw on the wire, so their hole
  # and error counts ride along with the server-side correctness fields.
  defp socket_correctness(%{fanout: %{socket: socket}}) when is_map(socket) do
    %{socket_holes: socket.holes, socket_errors: socket.errors}
  end

  defp socket_correctness(_metrics), do: %{}

  @doc """
  The effective config for a pass, falling back to the metrics a test-only
  run map carries when it has no explicit config.
  """
  @spec run_config(map(), Options.t()) :: Options.t()
  def run_config(%{config: %Options{} = run_config}, _config), do: run_config

  def run_config(run, config) do
    %{
      config
      | tier: run.metrics.tier,
        concurrency: run.metrics.context.concurrency,
        in_flight: [run.depth]
    }
  end

  @doc """
  The overall window of a metric series, or `nil` when there is none.
  """
  @spec overall([map()] | nil) :: map() | nil
  def overall(nil), do: nil
  def overall(windows), do: Enum.find(windows, &(&1.window == "overall"))

  defp build(label, depth, config, throughput, latency, correctness) do
    %{
      label: label,
      depth: depth,
      config: config,
      rate: value(throughput, "rate", :rate),
      p50: value(latency, "p50", :p50),
      p95: value(latency, "p95", :p95),
      p99: value(latency, "p99", :p99),
      throughput_accepted: value(throughput, "accepted", :accepted),
      throughput_rejected: value(throughput, "rejected", :rejected),
      latency_count: value(latency, "count", :count),
      accepted: value(correctness, "accepted", :accepted),
      rejected: value(correctness, "rejected", :rejected),
      errors: value(correctness, "errors", :errors),
      gsn_holes: value(correctness, "gsn_holes", :gsn_holes),
      gsn_first_hole: value(correctness, "gsn_first_hole", :gsn_first_hole),
      socket_holes: value(correctness, "socket_holes", :socket_holes),
      socket_errors: value(correctness, "socket_errors", :socket_errors),
      watermark_lag_high: value(correctness, "watermark_lag_high", :watermark_lag_high),
      watermark_lag_final: value(correctness, "watermark_lag_final", :watermark_lag_final)
    }
  end

  defp value(map, string_key, atom_key) do
    Map.get(map, atom_key, Map.get(map, string_key))
  end
end
