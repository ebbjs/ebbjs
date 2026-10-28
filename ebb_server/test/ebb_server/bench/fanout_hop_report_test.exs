defmodule EbbServer.Bench.FanoutHopReportTest do
  @moduledoc """
  Pins the fan-out latency breakdown: per-hop overall percentiles, the
  re-based push sample, the push-side p50 sum with its delta, and the
  sampling/end-of-chain caveats. A run whose hop series is empty must not
  render the section at all.
  """

  use ExUnit.Case, async: true

  alias EbbServer.Bench.{Metrics, Options, Report}

  @ctx %{entities: [], seeded_actions: 1}

  @hop_telemetry %{
    {:fanout_hop, :router_queue} => [{0, 1_000}, {1_000_000, 3_000}],
    {:fanout_hop, :router_decode} => [{0, 2_000}],
    {:fanout_hop, :group_queue} => [{0, 500}],
    {:fanout_hop, :group_encode} => [{0, 1_500}],
    {:fanout_hop, :group_cast} => [{0, 1_000}],
    {:fanout_hop, :conn_deliver} => [{0, 400}, {2_000_000, 600}],
    :fanout_push => [{0, 4_000}, {1_000_000, 6_000}, {2_000_000, 8_000}],
    {:writer_flush_phase, :queue} => [{0, 100}],
    {:writer_flush_phase, :prepare} => [{0, 200}],
    {:writer_flush_phase, :resolve} => [{0, 300}],
    {:writer_flush_phase, :commit_wait} => [{0, 400}],
    {:writer_flush_phase, :apply} => [{0, 500}],
    {:writer_flush_phase, :notify} => [{0, 60}],
    :writer_flush_total => [{0, 1_560}]
  }

  test "renders per-hop overall percentiles, the push sample, and the sum" do
    {:ok, config} = Options.parse(["--duration", "20"])

    report = render(config, analyze(config, @hop_telemetry))

    assert report =~ "## Fan-out latency breakdown"
    assert report =~ "| Hop | Samples | p50 (µs) | p95 (µs) | p99 (µs) |"

    assert report =~ "| `router_queue` | 2 | 1000 | 3000 | 3000 |"
    assert report =~ "| `router_dwell` | 0 | n/a | n/a | n/a |"
    assert report =~ "| `router_decode` | 1 | 2000 | 2000 | 2000 |"
    assert report =~ "| `group_queue` | 1 | 500 | 500 | 500 |"
    assert report =~ "| `group_encode` | 1 | 1500 | 1500 | 1500 |"
    assert report =~ "| `group_cast` | 1 | 1000 | 1000 | 1000 |"
    assert report =~ "| `conn_deliver` | 2 | 400 | 600 | 600 |"

    assert report =~
             "| `ebb.fanout.push_latency_ms` (re-based) | 3 | 6000 | 8000 | 8000 | — | — |"

    assert report =~
             "| `writer_notify` (context: #537 `notify` phase) | 1 | 60 | 60 | 60 | — | — |"

    # router_queue + router_dwell + router_decode + group_queue + group_encode
    # + group_cast, with conn_deliver (400) deliberately excluded.
    assert report =~ "| Sum of push-side hop p50s | — | 6000 | — | — | +0 | +0.0% |"
  end

  test "states the sampling rate and both ends of the delivery chain" do
    {:ok, config} = Options.parse(["--duration", "20"])
    report = render(config, analyze(config, @hop_telemetry))

    assert report =~ "sampled 1 delivery in 100 (`--conn-sample-rate 100`)"
    assert report =~ "Its sample count is therefore not the delivery count"
    assert report =~ "parent `send/2` returning rather than the SSE handler's `chunk/2`"
    assert report =~ "`conn_deliver` is excluded because it is per subscriber"
    assert report =~ "A hop with no samples in the window contributes 0"
    assert report =~ "#537's `notify` phase in `ebb.writer.flush_phase_ms`"
    assert report =~ "immediately before the re-based push sample"
    assert report =~ "shown as context, not as another hop in the sum"
  end

  test "describes the sample rate as off or every delivery when tuned" do
    for {value, expected} <- [
          {"0", "is off for this run (`--conn-sample-rate 0`)"},
          {"1", "is sampled on every delivery (`--conn-sample-rate 1`)"}
        ] do
      {:ok, config} = Options.parse(["--duration", "20", "--conn-sample-rate", value])

      report = render(config, analyze(config, @hop_telemetry))

      assert report =~ expected
    end
  end

  test "is skipped when no hop has a sample" do
    {:ok, config} = Options.parse(["--duration", "20"])

    report =
      render(
        config,
        analyze(config, %{
          :fanout_push => [{0, 5_000}]
        })
      )

    refute report =~ "## Fan-out latency breakdown"
  end

  test "renders after the fixed-rate section on t4" do
    {:ok, config} =
      Options.parse(["--tier", "t4", "--rate", "1000", "--subscribers", "10", "--duration", "20"])

    report = render(config, analyze(config, @hop_telemetry, fanout_resources()))

    fixed_rate = :binary.match(report, "## Fixed-rate fan-out (T4)") |> elem(0)
    breakdown = :binary.match(report, "## Fan-out latency breakdown") |> elem(0)

    assert fixed_rate < breakdown
  end

  defp render(config, result) do
    Report.render(config, %{
      runs: [%{depth: 1, label: "pipeline", metrics: result}],
      sweep?: false
    })
  end

  defp analyze(config, telemetry, resources \\ []) do
    Metrics.analyze(config, @ctx, [worker()], resources, nil, telemetry)
  end

  defp fanout_resources do
    [
      %{
        watermark: 0,
        max_gsn: 100,
        dirty: 5,
        memory: 1_000,
        rss_kb: 1_000,
        sched_active: 1,
        sched_total: 4,
        delivered: 0,
        offset_us: 0
      },
      %{
        watermark: 0,
        max_gsn: 100,
        dirty: 5,
        memory: 1_000,
        rss_kb: 1_000,
        sched_active: 1,
        sched_total: 4,
        delivered: 2_000,
        offset_us: 2_000_000
      }
    ]
  end

  defp worker do
    %{
      accepted: 2_000,
      rejected: 0,
      errors: 0,
      buckets: %{0 => 2_000},
      rejected_buckets: %{},
      reservoir: Metrics.reservoir_new(10),
      in_flight_peak: 1,
      in_flight_sum: 1,
      in_flight_samples: 1
    }
  end
end
