defmodule EbbServer.Bench.FixedRateReportTest do
  @moduledoc """
  Pins the t4 report: the fixed-rate section must show the target versus
  achieved write rate, the delivered rate, and the per-bucket
  commit→broadcast-complete latency series that tells whether fan-out keeps
  up. A t4 run renders only that section, not the T3 fan-out table.
  """

  use ExUnit.Case, async: true

  alias EbbServer.Bench.{Metrics, Options, Report}

  setup do
    ctx = %{entities: [], seeded_actions: 1}

    worker = %{
      accepted: 2000,
      rejected: 0,
      errors: 0,
      buckets: %{0 => 2000},
      rejected_buckets: %{},
      reservoir: Metrics.reservoir_new(10)
    }

    resources = [
      sample(delivered: 0, offset_us: 0),
      sample(delivered: 2000, offset_us: 2_000_000)
    ]

    fanout = %{subscribers: 10, delivered_total: 2000, control_total: 0, lags: []}
    telemetry = %{fanout_push: [{1_000_000, 500}, {11_000_000, 900}]}

    {:ok, ctx: ctx, worker: worker, resources: resources, fanout: fanout, telemetry: telemetry}
  end

  test "t4 renders the fixed-rate fan-out section", context do
    {:ok, config} =
      Options.parse(["--tier", "t4", "--rate", "1000", "--subscribers", "10", "--duration", "20"])

    result = analyze(config, context)
    report = Report.render(config, result)

    assert report =~ "## Fixed-rate fan-out (T4)"
    assert report =~ "| Target write rate | 1000 Actions/sec |"
    assert report =~ "| Achieved write rate | 100.0 |"
    assert report =~ "| Subscribers | 10 |"
    assert report =~ "| Delivered Actions/sec | 1000.0 |"
    assert report =~ "| Delivered per subscriber/sec | 100.0 |"
    assert report =~ "| 0 | 1 | 500 | 500 |"
    assert report =~ "| 10 | 1 | 900 | 900 |"
    assert report =~ "Commit → broadcast complete latency"
    assert report =~ "A flat p50 across buckets means fan-out keeps up"
  end

  test "t4 renders only the fixed-rate section, not the T3 fan-out table", context do
    {:ok, config} =
      Options.parse(["--tier", "t4", "--rate", "1000", "--subscribers", "10", "--duration", "20"])

    report = Report.render(config, analyze(config, context))

    assert report =~ "## Fixed-rate fan-out (T4)"
    refute report =~ "## Fan-out (T3)"
    refute report =~ "Actions delivered (total)"
  end

  test "a t4 run without subscribers still renders the section", context do
    {:ok, config} = Options.parse(["--tier", "t4", "--rate", "100", "--duration", "20"])

    result = analyze(config, %{context | resources: [], fanout: nil, telemetry: %{}})
    report = Report.render(config, result)

    assert report =~ "## Fixed-rate fan-out (T4)"
    assert report =~ "| Target write rate | 100 Actions/sec |"
    assert report =~ "| Delivered Actions/sec | n/a |"
  end

  test "non-t4 tiers do not render the fixed-rate section", context do
    {:ok, config} = Options.parse(["--duration", "20"])
    report = Report.render(config, analyze(config, context))

    refute report =~ "Fixed-rate fan-out"
    assert report =~ "## Fan-out (T3)"
  end

  defp analyze(config, context) do
    Metrics.analyze(
      config,
      context.ctx,
      [context.worker],
      context.resources,
      context.fanout,
      context.telemetry
    )
  end

  defp sample(overrides) do
    Map.merge(
      %{
        watermark: 0,
        max_gsn: 100,
        dirty: 5,
        memory: 1_000,
        rss_kb: 1_000,
        sched_active: 1,
        sched_total: 4
      },
      Map.new(overrides)
    )
  end
end
