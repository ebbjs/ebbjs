defmodule EbbServer.Bench.MetricsTest do
  @moduledoc """
  Pins the t4 fan-out metrics: the per-bucket commit→broadcast-complete
  series and the delivered Actions/sec derived from the resource samples.
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

  describe "dispatched_rate/2" do
    test "sums only in-window deliveries and divides by the window length" do
      telemetry = %{
        fanout_dispatched: [
          {-1_000_000, 500},
          {0, 100},
          {1_000_000, 200},
          {4_000_000, 300},
          {5_000_000, 9_999}
        ]
      }

      # Window is [0, 5s): 100 + 200 + 300 = 600 over 5s.
      assert Metrics.dispatched_rate(telemetry, 5) == 120.0
    end

    test "is nil when the run captured no dispatched samples" do
      assert Metrics.dispatched_rate(%{}, 5) == nil
      assert Metrics.dispatched_rate(%{fanout_dispatched: []}, 5) == nil
    end

    test "reports zero when every captured batch dispatched nothing" do
      assert Metrics.dispatched_rate(%{fanout_dispatched: [{1_000_000, 0}]}, 5) == 0.0
    end
  end

  describe "delivered_rate/2" do
    test "is nil for tiers that do not sample deliveries" do
      {:ok, config} = Options.parse([])

      samples = [
        %{delivered: 0, offset_us: 1_000_000},
        %{delivered: 10, offset_us: 2_000_000}
      ]

      assert Metrics.delivered_rate(samples, config) == nil
    end

    test "computes delivered per second and per subscriber for t4" do
      {:ok, config} = Options.parse(["--tier", "t4", "--rate", "1000", "--subscribers", "5"])

      samples = [
        %{delivered: 100, offset_us: 1_000_000},
        %{delivered: 1_100, offset_us: 3_000_000}
      ]

      assert Metrics.delivered_rate(samples, config) == %{
               delivered_per_sec: 500.0,
               delivered_per_subscriber_per_sec: 100.0
             }
    end

    test "ignores warmup and post-deadline samples" do
      {:ok, config} =
        Options.parse(["--tier", "t4", "--rate", "1000", "--subscribers", "5", "--duration", "10"])

      samples = [
        %{delivered: 0, offset_us: -2_000_000},
        %{delivered: 1_000, offset_us: 0},
        %{delivered: 6_000, offset_us: 5_000_000},
        %{delivered: 99_000, offset_us: 12_000_000}
      ]

      assert Metrics.delivered_rate(samples, config) == %{
               delivered_per_sec: 1000.0,
               delivered_per_subscriber_per_sec: 200.0
             }
    end

    test "is nil with fewer than two samples in the measured window" do
      {:ok, config} = Options.parse(["--tier", "t4", "--rate", "100", "--subscribers", "5"])

      assert %{delivered_per_sec: nil, delivered_per_subscriber_per_sec: nil} =
               Metrics.delivered_rate([%{delivered: 100, offset_us: 1_000_000}], config)
    end

    test "is nil when the run had no subscribers" do
      {:ok, config} = Options.parse(["--tier", "t4", "--rate", "100"])

      samples = [
        %{delivered: nil, offset_us: 1_000_000},
        %{delivered: nil, offset_us: 2_000_000}
      ]

      assert %{delivered_per_sec: nil, delivered_per_subscriber_per_sec: nil} =
               Metrics.delivered_rate(samples, config)
    end
  end

  describe "in_flight aggregation" do
    test "reports the peak and mean observed across workers" do
      {:ok, config} = Options.parse(["--in-flight", "4"])

      result =
        Metrics.analyze(
          config,
          %{entities: [], seeded_actions: 1},
          [
            worker(in_flight_peak: 4, in_flight_sum: 8, in_flight_samples: 4),
            worker(in_flight_peak: 2, in_flight_sum: 4, in_flight_samples: 2)
          ],
          [],
          nil
        )

      assert result.in_flight == %{peak: 4, mean: 2.0}
    end

    test "the mean is nil when no worker saw a completed call" do
      {:ok, config} = Options.parse(["--in-flight", "2"])

      result =
        Metrics.analyze(config, %{entities: [], seeded_actions: 1}, [worker()], [], nil)

      assert result.in_flight == %{peak: 0, mean: nil}
    end
  end

  defp worker(overrides \\ []) do
    Map.merge(
      %{
        accepted: 1,
        rejected: 0,
        errors: 0,
        buckets: %{0 => 1},
        rejected_buckets: %{},
        reservoir: Metrics.reservoir_new(10),
        in_flight_peak: 0,
        in_flight_sum: 0,
        in_flight_samples: 0
      },
      Map.new(overrides)
    )
  end
end
