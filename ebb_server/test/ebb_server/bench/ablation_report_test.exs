defmodule EbbServer.Bench.AblationReportTest do
  @moduledoc """
  Pins how an ablated run reports itself: `:watermark` ablation must not
  invent density or lag numbers, and the report must name the phases.
  """

  use ExUnit.Case, async: true

  alias EbbServer.Bench.{Metrics, Options, Report}

  setup do
    ctx = %{entities: [], seeded_actions: 1}

    worker = %{
      accepted: 10,
      rejected: 0,
      errors: 0,
      buckets: %{0 => 10},
      rejected_buckets: %{},
      reservoir: Metrics.reservoir_new(10)
    }

    resources = [
      %{
        watermark: 0,
        max_gsn: 100,
        dirty: 5,
        memory: 1_000,
        rss_kb: 1_000,
        sched_active: 1,
        sched_total: 4
      }
    ]

    {:ok, ctx: ctx, worker: worker, resources: resources}
  end

  test "`:watermark` ablation reports n/a instead of a meaningless frontier", context do
    {:ok, config} = Options.parse(["--ablate", "watermark"])
    result = analyze(config, context)

    assert result.correctness.gsn_holes == nil
    assert result.correctness.watermark_lag_high == nil
    assert result.correctness.watermark_lag_final == nil

    report = Report.render(config, result)

    assert report =~ "| GSN holes | n/a |"
    assert report =~ "| Watermark lag high-water (GSNs) | n/a |"
    assert report =~ "| Ablated phases | watermark |"
    assert report =~ "Ablation is active"
  end

  test "an unablated run still measures and reports the frontier", context do
    {:ok, config} = Options.parse([])
    result = analyze(config, context)

    assert is_integer(result.correctness.gsn_holes)
    assert is_integer(result.correctness.watermark_lag_high)

    report = Report.render(config, result)

    refute report =~ "| GSN holes | n/a |"
    assert report =~ "| Ablated phases | none |"
    refute report =~ "Ablation is active"
  end

  defp analyze(config, context) do
    Metrics.analyze(config, context.ctx, [context.worker], context.resources, nil, %{})
  end
end
