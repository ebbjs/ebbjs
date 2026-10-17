defmodule EbbServer.Bench.MetricsTest do
  @moduledoc """
  Pins the t4 fan-out metrics: the per-bucket commit→dispatch series and
  the delivered Actions/sec derived from the resource samples.
  """

  use ExUnit.Case, async: true

  alias EbbServer.Bench.{Metrics, Options}

  describe "fanout_series/3" do
    test "buckets push samples and reports nearest-rank percentiles" do
      samples = [
        {0, 100},
        {1_000_000, 200},
        {2_000_000, 300},
        {11_000_000, 400}
      ]

      assert [first, second | _rest] = Metrics.fanout_series(samples, 25, 10)

      assert first == %{from_second: 0, count: 3, p50: 200, p95: 300}
      assert second == %{from_second: 10, count: 1, p50: 400, p95: 400}
    end

    test "covers the measured window in bucket_seconds steps, empty buckets included" do
      assert [%{from_second: 0}, %{from_second: 10}, %{from_second: 20}] =
               Metrics.fanout_series([], 25, 10)
    end

    test "excludes warmup samples carrying a negative offset" do
      assert [%{from_second: 0, count: 0, p50: nil, p95: nil}] =
               Metrics.fanout_series([{-1, 999}], 5, 10)
    end

    test "defaults to ten-second buckets" do
      assert [%{from_second: 0}, %{from_second: 10}] = Metrics.fanout_series([], 15)
    end
  end

  describe "delivered_rate/2" do
    test "is nil for tiers that do not sample deliveries" do
      {:ok, config} = Options.parse([])
      samples = [%{delivered: 0, at_us: 1_000_000}, %{delivered: 10, at_us: 2_000_000}]

      assert Metrics.delivered_rate(samples, config) == nil
    end

    test "computes delivered per second and per subscriber for t4" do
      {:ok, config} = Options.parse(["--tier", "t4", "--rate", "1000", "--subscribers", "5"])

      samples = [
        %{delivered: 100, at_us: 1_000_000},
        %{delivered: 1_100, at_us: 3_000_000}
      ]

      assert Metrics.delivered_rate(samples, config) == %{
               target_rate: 1000,
               delivered_per_sec: 500.0,
               delivered_per_subscriber_per_sec: 100.0
             }
    end

    test "is nil with fewer than two samples" do
      {:ok, config} = Options.parse(["--tier", "t4", "--rate", "100", "--subscribers", "5"])

      assert %{delivered_per_sec: nil, delivered_per_subscriber_per_sec: nil} =
               Metrics.delivered_rate([%{delivered: 100, at_us: 1_000_000}], config)
    end

    test "is nil when the run had no subscribers" do
      {:ok, config} = Options.parse(["--tier", "t4", "--rate", "100"])

      samples = [%{delivered: nil, at_us: 1_000_000}, %{delivered: nil, at_us: 2_000_000}]

      assert %{delivered_per_sec: nil, delivered_per_subscriber_per_sec: nil} =
               Metrics.delivered_rate(samples, config)
    end
  end
end
