defmodule EbbServer.Bench.PipelineDepthReportTest do
  @moduledoc """
  Pins the pipeline-depth report: a sweep renders one row per depth (the t0
  no-regression baseline plus each requested depth), one detail block per run
  under its own heading, and states the harness-side coalescing limitation.
  A single run keeps the pre-sweep report shape exactly.
  """

  use ExUnit.Case, async: true

  alias EbbServer.Bench.{Metrics, Options, Report}

  @ctx %{entities: [], seeded_actions: 1}

  test "a sweep renders the pipeline-depth table with the baseline row and per-run blocks" do
    {:ok, sweep} = Options.parse(["--tier", "t2", "--in-flight", "1,4", "--duration", "10"])
    {:ok, baseline} = Options.parse(["--tier", "t0", "--in-flight", "1", "--duration", "10"])
    {:ok, pipeline} = Options.parse(["--tier", "t2", "--in-flight", "4", "--duration", "10"])

    report =
      Report.render(sweep, %{
        runs: [
          %{depth: 1, label: "t0 baseline", metrics: analyze(baseline, worker(1))},
          %{depth: 4, label: "pipeline", metrics: analyze(pipeline, worker(4))}
        ],
        sweep?: true
      })

    assert report =~ "## Pipeline depth"
    assert report =~ "| Run | Tier | Callers | Calls in flight per worker |"

    assert report =~ "| t0 baseline | t0 | 1 | 1 | 1 | 1.0 | 10.0 |"
    assert report =~ "| pipeline | t2 | 1 | 4 | 4 | 4.0 | 10.0 |"
    assert report =~ "| Actions/flush | Flush p50 (µs) |"
    assert report =~ "| 50 | 1000 |"

    assert report =~ "## Run: depth 1 (t0)"
    assert report =~ "## Run: depth 4 (t2)"
    assert length(String.split(report, "## Throughput")) == 3

    assert report =~ "max_in_flight"
    assert report =~ "coalesce into shared flushes"
    assert report =~ "outstanding `write_actions/1` calls"
    assert report =~ "no-regression"
    assert report =~ "headline batch/Action shape"
  end

  test "a sweep renders the Writer's pipeline gauges and flush phases per run" do
    {:ok, sweep} = Options.parse(["--tier", "t2", "--in-flight", "1,4", "--duration", "10"])

    report =
      Report.render(sweep, %{
        runs: [
          %{
            depth: 1,
            label: "t0 baseline",
            metrics: analyze(sweep, worker(1), writer_telemetry())
          },
          %{depth: 4, label: "pipeline", metrics: analyze(sweep, worker(4), writer_telemetry())}
        ],
        sweep?: true
      })

    assert report =~ "### Writer pipeline gauges"

    assert report =~
             "| Run | `in_flight_batches` peak | `in_flight_batches` mean | " <>
               "`oldest_unreleased_gsn` peak | `oldest_unreleased_gsn` mean |"

    assert report =~ "| t0 baseline | 2 | 1.5 | 3 | 1.5 |"
    assert report =~ "| pipeline | 2 | 1.5 | 3 | 1.5 |"
    assert report =~ "emitted on every claim and release"
    assert report =~ "`0` when the buffer is empty, so its mean includes idle samples"

    assert report =~ "### Flush phases (p50 / p95, µs)"

    assert report =~
             "| Run | queue | prepare | resolve | commit_wait | apply | notify | sum p50 |"

    assert report =~
             "| t0 baseline | 100 / 300 | 40 / 40 | 50 / 50 | 60 / 60 | 70 / 70 | 80 / 80 | 400 |"

    assert report =~
             "| pipeline | 100 / 300 | 40 / 40 | 50 / 50 | 60 / 60 | 70 / 70 | 80 / 80 | 400 |"

    assert report =~
             "`queue` and `prepare` are the terms `ebb.writer.batch_latency_ms` cannot see"

    assert report =~ "reported in a sweep's pipeline-depth section (#537)"
  end

  test "a sweep with no phase samples reports the phases as not captured" do
    {:ok, sweep} = Options.parse(["--tier", "t2", "--in-flight", "1,4", "--duration", "10"])

    report =
      Report.render(sweep, %{
        runs: [
          %{depth: 1, label: "t0 baseline", metrics: analyze(sweep, worker(1))},
          %{depth: 4, label: "pipeline", metrics: analyze(sweep, worker(4))}
        ],
        sweep?: true
      })

    assert report =~ "### Flush phases (p50 / p95, µs)"
    assert report =~ "Not captured"
    refute report =~ "| Run | queue | prepare |"

    assert report =~ "### Writer pipeline gauges"
    assert report =~ "| t0 baseline | n/a | n/a | n/a | n/a |"
  end

  test "a single pipelined run does not claim a baseline it never measured" do
    {:ok, config} = Options.parse(["--tier", "t0", "--in-flight", "2"])

    report =
      Report.render(config, %{
        runs: [%{depth: 2, label: "pipeline", metrics: analyze(config, worker(2))}],
        sweep?: false
      })

    refute report =~ "t0 baseline was measured"
    assert report =~ "keeps N `Writer.write_actions/1` calls outstanding"
  end

  test "failed passes are reported and do not hide the completed rows" do
    {:ok, sweep} = Options.parse(["--tier", "t2", "--in-flight", "1,2", "--duration", "10"])
    {:ok, pass} = Options.parse(["--tier", "t2", "--in-flight", "1", "--duration", "10"])

    report =
      Report.render(sweep, %{
        runs: [%{depth: 1, label: "pipeline", metrics: analyze(pass, worker(1))}],
        sweep?: true,
        failures: [%{depth: 2, label: "pipeline", tier: :t2, error: "boom"}]
      })

    assert report =~ "## Failed passes"
    assert report =~ "| pipeline | t2 | 2 | boom |"
    assert report =~ "report is incomplete"
    assert report =~ "| pipeline | t2 | 1 |"
    assert report =~ "## Throughput"
  end

  test "a single run keeps the existing top-level report shape" do
    {:ok, config} = Options.parse(["--tier", "t0", "--in-flight", "1"])

    report =
      Report.render(config, %{
        runs: [%{depth: 1, label: "t0 baseline", metrics: analyze(config, worker(1))}],
        sweep?: false
      })

    refute report =~ "## Pipeline depth"
    refute report =~ "## Run:"
    refute report =~ "max_in_flight"
    refute report =~ "### Writer pipeline gauges"
    refute report =~ "### Flush phases"

    assert report =~ "## Throughput"
    assert report =~ "## Latency"
    assert report =~ "## Correctness and resources"
    assert report =~ "## Methodology and limitations"
    assert report =~ "| Calls in flight per worker | 1 |"
  end

  test "the depth-1 row of a t0 sweep is the baseline" do
    {:ok, sweep} = Options.parse(["--tier", "t0", "--in-flight", "1,2", "--duration", "10"])
    {:ok, pass} = Options.parse(["--tier", "t0", "--in-flight", "1", "--duration", "10"])

    report =
      Report.render(sweep, %{
        runs: [
          %{depth: 1, label: "t0 baseline", metrics: analyze(pass, worker(1))},
          %{depth: 2, label: "pipeline", metrics: analyze(pass, worker(2))}
        ],
        sweep?: true
      })

    assert report =~ "| t0 baseline | t0 | 1 | 1 |"
    assert report =~ "## Run: depth 1 (t0)"
    assert report =~ "## Run: depth 2 (t0)"
  end

  defp analyze(config, worker, telemetry \\ %{writer_batch: [{0, 1_000}, {1_000, 2_000}]}) do
    Metrics.analyze(config, @ctx, [worker], [], nil, telemetry)
  end

  defp writer_telemetry do
    %{
      {:writer_flush_phase, :queue} => [{0, 100}, {0, 300}],
      {:writer_flush_phase, :prepare} => [{0, 40}],
      {:writer_flush_phase, :resolve} => [{0, 50}],
      {:writer_flush_phase, :commit_wait} => [{0, 60}],
      {:writer_flush_phase, :apply} => [{0, 70}],
      {:writer_flush_phase, :notify} => [{0, 80}],
      :writer_flush_total => [{0, 400}],
      :writer_in_flight => [{0, 1}, {1_000_000, 2}],
      :writer_oldest_unreleased_gsn => [{0, 0}, {1_000_000, 3}]
    }
  end

  defp worker(depth) do
    reservoir =
      Enum.reduce([{0, 100}, {0, 200}, {0, 300}], Metrics.reservoir_new(10), fn sample, acc ->
        Metrics.reservoir_add(acc, sample)
      end)

    %{
      accepted: 100,
      rejected: 0,
      errors: 0,
      buckets: %{0 => 100},
      rejected_buckets: %{},
      reservoir: reservoir,
      in_flight_peak: depth,
      in_flight_sum: depth * 2,
      in_flight_samples: 2
    }
  end
end
