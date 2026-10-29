defmodule EbbServer.Bench.Guardrails do
  @moduledoc """
  Run-level guardrails for `mix bench.actions`.

  A benchmark that loses data or spends latency on throughput must not print
  a clean table and exit zero. Every measured pass is checked against the
  correctness invariants, and `--baseline` adds two regression budgets
  against a prior report:

    * no GSN holes,
    * final watermark lag below the run's accepted GSN count,
    * no rejected Actions and no write/transport errors,
    * on a real-socket run, no GSN discontinuities and no client errors on the
      wire (the #577 gate applied to what the consumers actually received),
    * Actions/sec no more than 10% below the matched baseline,
    * p50 no more than 25% above the matched baseline.

  The bands are constants here so the report, the failure message, and the
  published results cannot drift apart. A run may opt out with
  `--no-guardrails`: violations are still evaluated and rendered in the
  report, but they do not fail the process.
  """

  alias EbbServer.Bench.{Baseline, Options, RunSummary}

  # Regression bands, as fractions of the matched baseline. They are set from
  # the published ±5–10% single-run VM spread, not from a single delta.
  @rate_regression_band 0.10
  @p50_regression_band 0.25

  @type violation :: %{invariant: atom(), run: String.t(), detail: String.t()}
  @type comparison :: map()
  @type t :: %{
          enforced?: boolean(),
          baseline?: boolean(),
          violations: [violation()],
          comparisons: [comparison()],
          bands: map()
        }

  @doc """
  The regression bands, as fractions.
  """
  @spec bands() :: %{rate_regression: float(), p50_regression: float()}
  def bands do
    %{rate_regression: @rate_regression_band, p50_regression: @p50_regression_band}
  end

  @doc """
  Evaluates every correctness invariant and, when `baseline` is present, the
  matched-config regression budgets.
  """
  @spec evaluate([map()], Options.t(), Baseline.t() | nil) :: t()
  def evaluate(runs, %Options{} = config, baseline \\ nil) do
    summaries = Enum.map(runs, &RunSummary.from_run(&1, config))
    correctness = Enum.flat_map(summaries, &correctness_violations(&1, config))

    {baseline_violations, comparisons} =
      case baseline do
        nil -> {[], []}
        report -> compare(summaries, Baseline.runs(report))
      end

    %{
      enforced?: config.guardrails,
      baseline?: not is_nil(baseline),
      violations: correctness ++ baseline_violations,
      comparisons: comparisons,
      bands: bands()
    }
  end

  @doc """
  Fails the calling process with every violation, unless enforcement is off.

  Disabled enforcement still prints a one-line warning so an exploratory run
  cannot hide that its report contains violations.
  """
  @spec enforce!(t(), Options.t()) :: :ok
  def enforce!(%{violations: []}, %Options{}), do: :ok

  def enforce!(%{violations: violations}, %Options{guardrails: false}) do
    IO.puts(
      "\nGuardrails disabled (--no-guardrails): #{length(violations)} violation(s) " <>
        "recorded in the report, not failing the run."
    )

    :ok
  end

  def enforce!(%{violations: violations}, %Options{}) do
    details = Enum.map_join(violations, "\n", &"  - #{&1.invariant}: #{&1.run}: #{&1.detail}")

    raise "bench guardrails failed (#{length(violations)} violation(s)):\n#{details}\n" <>
            "Re-run with --no-guardrails to keep an intentionally degraded run."
  end

  defp correctness_violations(run, config) do
    # A stalled-commit run is expected to produce 503s; its guardrail is that
    # the late durable write fills the abandoned range (no holes), nothing is
    # rejected, and the 503 count stays inside the stalled callers' envelope.
    expected_errors? = config.stall_commits > 0

    []
    |> add_violation_if(gsn_holes_violation(run), :gsn_holes, run, gsn_holes_detail(run))
    |> add_violation_if(
      socket_holes_violation?(run),
      :socket_gsn_holes,
      run,
      "#{run.socket_holes} GSN discontinuity(ies) observed on the wire"
    )
    |> add_violation_if(
      socket_errors_violation?(run),
      :socket_client_errors,
      run,
      "#{run.socket_errors} socket client connection/protocol error(s)"
    )
    |> add_violation_if(lag_violation?(run), :watermark_lag, run, lag_detail(run))
    |> add_violation_if(
      run.rejected > 0,
      :rejected_actions,
      run,
      "#{run.rejected} rejected Actions"
    )
    |> add_violation_if(
      not expected_errors? and run.errors > 0,
      :write_transport_errors,
      run,
      "#{run.errors} write/transport errors"
    )
    |> add_violation_if(
      expected_errors? and not stalled_errors_within_envelope?(run, config),
      :stalled_commit_errors,
      run,
      "#{run.errors} errors for #{config.stall_commits} stalled commit(s); expected " <>
        "1..#{max_stalled_errors(config, run.depth)}"
    )
  end

  defp add_violation_if(violations, false, _invariant, _run, _detail), do: violations

  defp add_violation_if(violations, true, invariant, run, detail) do
    violations ++ [violation(invariant, run, detail)]
  end

  defp stalled_errors_within_envelope?(run, config) do
    is_integer(run.errors) and run.errors > 0 and
      run.errors <= max_stalled_errors(config, run.depth)
  end

  # Every caller waiting on a stalled range gets one 503 and contributes its
  # whole batch to the error count; that is the widest rate the injection can
  # legitimately produce.
  defp max_stalled_errors(config, depth) do
    config.stall_commits * config.concurrency * max(depth || 1, 1) * config.batch_size
  end

  defp gsn_holes_violation(%{gsn_holes: holes}) when is_integer(holes), do: holes > 0
  defp gsn_holes_violation(_run), do: false

  defp socket_holes_violation?(%{socket_holes: holes}) when is_integer(holes), do: holes > 0
  defp socket_holes_violation?(_run), do: false

  defp socket_errors_violation?(%{socket_errors: errors}) when is_integer(errors), do: errors > 0
  defp socket_errors_violation?(_run), do: false

  defp gsn_holes_detail(run) do
    first =
      case run.gsn_first_hole do
        nil -> "none"
        gsn -> Integer.to_string(gsn)
      end

    "#{run.gsn_holes} GSN holes; first missing GSN #{first}"
  end

  # The frontier is only meaningful for a run that advances it. An accepted
  # count of zero is not an exemption: a frozen frontier with a stuck accept
  # counter (0 lag >= 0) is exactly the shape this guardrail exists to catch.
  defp lag_violation?(run) do
    is_integer(run.watermark_lag_final) and is_integer(run.accepted) and
      run.watermark_lag_final >= run.accepted
  end

  defp lag_detail(run) do
    "final watermark lag #{run.watermark_lag_final} >= #{run.accepted} accepted GSNs"
  end

  defp compare(summaries, baseline_runs) do
    index = Map.new(Enum.map(baseline_runs, &{run_key(RunSummary.from_machine(&1)), &1}))

    summaries
    |> Enum.map(fn run ->
      case Map.fetch(index, run_key(run)) do
        :error ->
          {[
             violation(
               :baseline_no_match,
               run,
               "no baseline pass with a matching workload config"
             )
           ], missing_comparison(run)}

        {:ok, baseline_run} ->
          compare_run(run, RunSummary.from_machine(baseline_run))
      end
    end)
    |> Enum.unzip()
    |> then(fn {violations, comparisons} -> {List.flatten(violations), comparisons} end)
  end

  defp compare_run(run, baseline) do
    violations =
      []
      |> add_violation_if(
        rate_regressed?(run.rate, baseline.rate),
        :baseline_throughput,
        run,
        "#{format_rate(run.rate)} Actions/s is more than " <>
          "#{percent(@rate_regression_band)} below #{format_rate(baseline.rate)}"
      )
      |> add_violation_if(
        p50_regressed?(run.p50, baseline.p50),
        :baseline_latency,
        run,
        "p50 #{format_value(run.p50)} µs is more than " <>
          "#{percent(@p50_regression_band)} above #{format_value(baseline.p50)} µs"
      )

    comparison = %{
      run: run_label(run),
      baseline_run: run_label(baseline),
      rate: delta(run.rate, baseline.rate),
      p50: delta(run.p50, baseline.p50),
      p95: delta(run.p95, baseline.p95),
      p99: delta(run.p99, baseline.p99),
      gsn_holes: %{current: run.gsn_holes, baseline: baseline.gsn_holes},
      watermark_lag_final: %{
        current: run.watermark_lag_final,
        baseline: baseline.watermark_lag_final
      }
    }

    {violations, comparison}
  end

  defp missing_comparison(run) do
    %{
      run: run_label(run),
      baseline_run: nil,
      rate: delta(run.rate, nil),
      p50: delta(run.p50, nil),
      p95: delta(run.p95, nil),
      p99: delta(run.p99, nil),
      gsn_holes: %{current: run.gsn_holes, baseline: nil},
      watermark_lag_final: %{current: run.watermark_lag_final, baseline: nil}
    }
  end

  defp run_key(run), do: {run.depth, run.config}

  defp rate_regressed?(current, baseline) when is_number(current) and is_number(baseline) do
    baseline > 0 and (baseline - current) / baseline > @rate_regression_band
  end

  defp rate_regressed?(_current, _baseline), do: false

  defp p50_regressed?(current, baseline) when is_number(current) and is_number(baseline) do
    baseline > 0 and (current - baseline) / baseline > @p50_regression_band
  end

  defp p50_regressed?(_current, _baseline), do: false

  defp delta(current, baseline)
       when is_number(current) and is_number(baseline) and baseline != 0 do
    %{current: current, baseline: baseline, delta: (current - baseline) / baseline}
  end

  defp delta(current, baseline), do: %{current: current, baseline: baseline, delta: nil}

  defp violation(invariant, run, detail) do
    %{invariant: invariant, run: run_label(run), detail: detail}
  end

  defp run_label(run), do: "#{run.label} depth #{run.depth}"

  defp percent(value), do: "#{round(value * 100)}%"

  defp format_rate(nil), do: "n/a"
  defp format_rate(value), do: :erlang.float_to_binary(value * 1.0, decimals: 1)

  defp format_value(nil), do: "n/a"
  defp format_value(value) when is_integer(value), do: Integer.to_string(value)
  defp format_value(value), do: :erlang.float_to_binary(value * 1.0, decimals: 1)
end
