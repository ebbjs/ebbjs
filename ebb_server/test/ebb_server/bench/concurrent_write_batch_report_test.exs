defmodule EbbServer.Bench.ConcurrentWriteBatchReportTest do
  @moduledoc """
  Pins how the t5 spike reports itself: the raw `write_batch` caller count and
  sync mode are stated, and GSN holes / watermark lag are n/a because the run
  never claims GSNs through the Writer.
  """

  use ExUnit.Case, async: true

  alias EbbServer.Bench.{Metrics, Options, Report}

  setup do
    ctx = %{entities: [], seeded_actions: 1}

    worker = %{
      accepted: 20_000,
      rejected: 0,
      errors: 0,
      buckets: %{0 => 20_000},
      rejected_buckets: %{},
      reservoir: Metrics.reservoir_new(10)
    }

    resources = [
      %{
        watermark: 0,
        max_gsn: 20_000,
        dirty: 0,
        memory: 1_000,
        rss_kb: 1_000,
        sched_active: 1,
        sched_total: 4
      }
    ]

    {:ok, ctx: ctx, worker: worker, resources: resources}
  end

  test "GSN holes and watermark lag are unmeasured for t5", context do
    {:ok, config} = Options.parse(["--tier", "t5", "--concurrency", "2"])
    result = analyze(config, context)

    assert result.correctness.gsn_holes == nil
    assert result.correctness.watermark_lag_high == nil
    assert result.correctness.watermark_lag_final == nil
    assert result.correctness.accepted == 20_000
  end

  test "the report renders n/a for the frontier and explains the raw call", context do
    {:ok, config} = Options.parse(["--tier", "t5", "--concurrency", "2"])
    report = Report.render(config, analyze(config, context))

    assert report =~ "| GSN holes | n/a |"
    assert report =~ "| Watermark lag high-water (GSNs) | n/a |"
    assert report =~ "## Concurrent write_batch (T5)"
    assert report =~ "| Callers (BEAM processes) | 2 |"
    assert report =~ "sync: true"
    assert report =~ "bypasses"
    assert report =~ "no Writer"
    assert report =~ "assembly"
  end

  test "async durability is reported as such", context do
    {:ok, config} = Options.parse(["--tier", "t5", "--durability", "async"])
    report = Report.render(config, analyze(config, context))

    assert report =~ "sync: false"
    refute report =~ "sync: true"
  end

  test "the t5 report carries no fan-out or fixed-rate sections", context do
    {:ok, config} = Options.parse(["--tier", "t5"])
    report = Report.render(config, analyze(config, context))

    refute report =~ "## Fan-out (T3)"
    refute report =~ "## Fixed-rate fan-out (T4)"
  end

  defp analyze(config, context) do
    Metrics.analyze(config, context.ctx, [context.worker], context.resources, nil, %{})
  end
end
