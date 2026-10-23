defmodule EbbServer.Bench.MetricsTest do
  @moduledoc """
  Pins the t4 fan-out metrics: the per-bucket commit→broadcast-complete
  series and the delivered Actions/sec derived from the resource samples.
  """

  use ExUnit.Case, async: true

  alias EbbServer.Bench.{Metrics, Options}
  alias EbbServer.Telemetry

  @ctx %{entities: [], seeded_actions: 1}

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

  describe "writer flush phases and pipeline gauges" do
    test "windows each phase, the accounting total, and both gauges" do
      {:ok, config} = Options.parse(["--duration", "10"])

      telemetry = %{
        {:writer_flush_phase, :queue} => [{-1_000_000, 9_999}, {0, 1_000}, {2_000_000, 3_000}],
        {:writer_flush_phase, :prepare} => [{0, 2_000}],
        {:writer_flush_phase, :resolve} => [{0, 4_000}],
        {:writer_flush_phase, :commit_wait} => [{0, 6_000}],
        {:writer_flush_phase, :apply} => [{0, 8_000}],
        {:writer_flush_phase, :notify} => [{0, 10_000}],
        :writer_flush_total => [{0, 31_000}, {2_000_000, 35_000}],
        :writer_queue_depth => [{0, 1}, {1_000_000, 3}],
        :writer_in_flight => [{0, 3}, {1_000_000, 1}],
        :writer_oldest_unreleased_gsn => [{0, 0}, {1_000_000, 8}]
      }

      server = Metrics.analyze(config, @ctx, [worker()], [], nil, telemetry).server

      assert Enum.sort(Map.keys(server.flush_phases)) ==
               Enum.sort(Telemetry.writer_flush_phases())

      assert %{window: "overall", count: 2, p50: 1_000, p95: 3_000, p99: 3_000} =
               overall(server.flush_phases.queue)

      assert overall(server.flush_phases.prepare).count == 1
      assert overall(server.flush_phases.prepare).p50 == 2_000
      assert overall(server.flush_phases.notify).p50 == 10_000

      assert %{count: 2, p50: 31_000} = overall(server.flush_total)
      assert server.queue_depth == %{count: 2, mean: 2.0, peak: 3}
      assert server.in_flight_batches == %{count: 2, mean: 2.0, peak: 3}
      assert server.oldest_unreleased_gsn == %{count: 2, mean: 4.0, peak: 8}
    end

    test "an empty telemetry map leaves the phases and gauges unmeasured" do
      {:ok, config} = Options.parse([])

      server = Metrics.analyze(config, @ctx, [worker()], [], nil, %{}).server

      for phase <- Telemetry.writer_flush_phases() do
        assert overall(server.flush_phases[phase]).count == 0
      end

      assert overall(server.flush_total).count == 0
      assert server.queue_depth == %{count: 0, mean: nil, peak: nil}
      assert server.in_flight_batches == %{count: 0, mean: nil, peak: nil}
      assert server.oldest_unreleased_gsn == %{count: 0, mean: nil, peak: nil}
    end
  end

  describe "gsn_hole_stats/1" do
    test "a contiguous log has no holes" do
      assert Metrics.gsn_hole_stats([1, 2, 3]) == %{count: 0, first_missing: nil}
    end

    test "counts missing GSNs and names the first gap" do
      assert Metrics.gsn_hole_stats([1, 4, 5]) == %{count: 2, first_missing: 2}
    end

    test "counts several gaps" do
      assert Metrics.gsn_hole_stats([2, 5, 9]) == %{count: 6, first_missing: 1}
    end

    test "an empty log has no holes" do
      assert Metrics.gsn_hole_stats([]) == %{count: 0, first_missing: nil}
    end
  end

  defp overall(windows), do: Enum.find(windows, &(&1.window == "overall"))

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
