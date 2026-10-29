defmodule EbbServer.Bench.SocketSubscribersTest do
  @moduledoc """
  Pins the client-side accounting of a real-socket run without opening any
  sockets: how connections are spread over client processes, how the line
  protocol updates a client's report, and how the per-process reports merge
  into the summary the report, metrics, and guardrails read.
  """

  use ExUnit.Case, async: true

  alias EbbServer.Bench.SocketSubscribers

  @summary_keys [
    :subscribers,
    :processes,
    :delivered_total,
    :data_chunks,
    :control_total,
    :holes,
    :errors,
    :client_p50,
    :client_p95,
    :client_p99,
    :client_samples,
    :lag_p50,
    :lag_p99,
    :lag_samples,
    :bytes_total
  ]

  describe "connections_per_process/2" do
    test "splits evenly when the connections divide" do
      assert SocketSubscribers.connections_per_process(1_000, 8) == List.duplicate(125, 8)
    end

    test "spreads the remainder over the first processes" do
      assert SocketSubscribers.connections_per_process(10, 4) == [3, 3, 2, 2]
      assert SocketSubscribers.connections_per_process(1, 1) == [1]
      assert SocketSubscribers.connections_per_process(7, 7) == List.duplicate(1, 7)
    end

    test "the parts always add up to the connection count" do
      for count <- [1, 5, 100, 1_000], processes <- 1..min(count, 8) do
        parts = SocketSubscribers.connections_per_process(count, processes)
        assert length(parts) == processes
        assert Enum.sum(parts) == count
        assert Enum.max(parts) - Enum.min(parts) <= 1
      end
    end
  end

  describe "summarize/1" do
    test "returns exactly the summary keys the report and guardrails read" do
      summary = SocketSubscribers.summarize([report()])

      assert Enum.sort(Map.keys(summary)) == Enum.sort(@summary_keys)
    end

    test "merges raw samples instead of averaging per-process percentiles" do
      slow = report(lats: [100, 100, 100], lags: [10])
      fast = report(lats: [1, 2, 3, 4, 5], lags: [20])

      summary = SocketSubscribers.summarize([slow, fast])

      # Merged and sorted: [1, 2, 3, 4, 5, 100, 100, 100] -> rank 4 is 4.
      assert summary.client_samples == 8
      assert summary.client_p50 == 4
      assert summary.client_p99 == 100
      assert summary.lag_samples == 2
      assert summary.lag_p50 == 10
      assert summary.lag_p99 == 20
    end

    test "adds the per-process counters" do
      summary =
        SocketSubscribers.summarize([
          report(connections: 125, delivered: 1_000, data_chunks: 10, bytes_total: 900, holes: 1),
          report(connections: 125, delivered: 2_000, data_chunks: 20, bytes_total: 800, errors: 2)
        ])

      assert summary.subscribers == 250
      assert summary.processes == 2
      assert summary.delivered_total == 3_000
      assert summary.data_chunks == 30
      assert summary.bytes_total == 1_700
      assert summary.holes == 1
      assert summary.errors == 2
    end

    test "a run with no samples reports null percentiles, not zero" do
      summary = SocketSubscribers.summarize([report(lats: [], lags: [])])

      assert summary.client_samples == 0
      assert summary.client_p50 == nil
      assert summary.lag_p50 == nil
    end
  end

  describe "apply_line/2" do
    test "a ready line records the connection count and the client clock skew" do
      report = report(clock_us: nil, connections: 0)

      updated = SocketSubscribers.apply_line(report, "ok 25 900000000")

      assert updated.connections == 25
      assert updated.clock_us == 900_000_000
      assert is_integer(updated.skew_us)
    end

    test "progress lines carry the running delivery count" do
      assert %{delivered: 4_096} =
               SocketSubscribers.apply_line(report(), "progress 900000000 4096")
    end

    test "a done line carries the final counters" do
      updated = SocketSubscribers.apply_line(report(), "done 1000 40 2 0 0 65536")

      assert updated.delivered == 1_000
      assert updated.data_chunks == 40
      assert updated.control == 2
      assert updated.holes == 0
      assert updated.errors == 0
      assert updated.bytes_total == 65_536
      assert updated.done?
    end

    test "lat and lag lines append raw samples across batches" do
      report =
        report()
        |> SocketSubscribers.apply_line("lat 3 11,12,13")
        |> SocketSubscribers.apply_line("lat 2 14,15")
        |> SocketSubscribers.apply_line("lag 2 900,901")

      assert report.lats == [11, 12, 13, 14, 15]
      assert report.lags == [900, 901]
    end

    test "bye marks the client as finished" do
      assert %{bye?: true} = SocketSubscribers.apply_line(report(), "bye")
    end

    test "an unknown or malformed line is ignored" do
      report = report()

      assert SocketSubscribers.apply_line(report(), "something new") == report
      assert SocketSubscribers.apply_line(report(), "done nonsense") == report
      assert SocketSubscribers.apply_line(report(), "lat not-a-count") == report
    end
  end

  describe "delivered/1" do
    test "is nil without subscribers" do
      assert SocketSubscribers.delivered(nil) == nil
    end

    test "reads the shared progress counter" do
      delivered = :atomics.new(1, signed: true)
      :atomics.put(delivered, 1, 42)

      assert SocketSubscribers.delivered(%{delivered: delivered}) == 42
    end
  end

  defp report(overrides \\ []) do
    Map.merge(
      %{
        port: nil,
        connections: 10,
        buffer: "",
        delivered: 0,
        data_chunks: 0,
        control: 0,
        holes: 0,
        errors: 0,
        bytes_total: 0,
        lats: [],
        lags: [],
        clock_us: nil,
        skew_us: 0,
        done?: false,
        bye?: true,
        exit: nil
      },
      Map.new(overrides)
    )
  end
end
