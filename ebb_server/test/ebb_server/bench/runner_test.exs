defmodule EbbServer.Bench.RunnerTest do
  @moduledoc """
  Pins the pipeline-depth scheduling and the pipelined worker loop without
  booting a storage tree.

  `Runner.passes/1` is the pure decision about which measured passes a run
  costs; `Runner.pipelined/6` is the loop itself, driven here against a stub
  call function so the depth, the per-call sequence numbers, the occupancy
  samples, and the deadline drain can be checked without a Writer.
  """

  use ExUnit.Case, async: true

  alias EbbServer.Bench.{Metrics, Options, Runner}

  describe "passes/1" do
    test "a single depth costs exactly one pass" do
      {:ok, config} = Options.parse(["--tier", "t0", "--in-flight", "2"])

      assert [%{depth: 2, label: "pipeline", config: pass_config}] = Runner.passes(config)
      assert pass_config.in_flight == [2]
      assert pass_config.tier == :t0
    end

    test "a sweep measures the t0 depth-1 baseline first, then each requested depth" do
      {:ok, config} =
        Options.parse([
          "--tier",
          "t2",
          "--in-flight",
          "1,2,4",
          "--batch-size",
          "100",
          "--updates-per-action",
          "2",
          "--distribution",
          "hot",
          "--durability",
          "async",
          "--warmup",
          "5",
          "--duration",
          "30",
          "--seed",
          "7"
        ])

      assert [baseline | requested] = Runner.passes(config)

      assert %{depth: 1, label: "t0 baseline"} = baseline
      assert baseline.config.tier == :t0
      assert baseline.config.concurrency == 1
      assert baseline.config.in_flight == [1]
      assert baseline.config.rate == 0
      assert baseline.config.subscribers == 0
      refute baseline.config.subscriber_lean

      assert baseline.config.batch_size == 100
      assert baseline.config.updates_per_action == 2
      assert baseline.config.distribution == :hot
      assert baseline.config.durability == :async
      assert baseline.config.warmup == 5
      assert baseline.config.duration == 30
      assert baseline.config.seed == 7

      assert Enum.map(requested, &{&1.depth, &1.label}) ==
               [{1, "pipeline"}, {2, "pipeline"}, {4, "pipeline"}]

      assert Enum.map(requested, & &1.config.tier) == [:t2, :t2, :t2]
      assert Enum.map(requested, & &1.config.in_flight) == [[1], [2], [4]]
    end

    test "a t0 concurrency-1 sweep uses its depth-1 pass as the baseline" do
      {:ok, config} = Options.parse(["--tier", "t0", "--concurrency", "1", "--in-flight", "1,2"])

      assert [
               %{depth: 1, label: "t0 baseline"},
               %{depth: 2, label: "pipeline"}
             ] = Runner.passes(config)
    end

    test "a t0 sweep above concurrency 1 still boots a baseline pass" do
      {:ok, config} = Options.parse(["--tier", "t0", "--concurrency", "4", "--in-flight", "1,2"])

      assert [%{label: "t0 baseline", config: %{concurrency: 1}} | requested] =
               Runner.passes(config)

      assert Enum.map(requested, &{&1.depth, &1.label}) == [{1, "pipeline"}, {2, "pipeline"}]
    end
  end

  describe "collect/2" do
    test "keeps the passes that completed when a later pass fails" do
      {:ok, config} = Options.parse(["--tier", "t0", "--in-flight", "1,2,4"])

      run = fn
        %{in_flight: [4]} -> raise "boom"
        pass -> %{tier: pass.tier}
      end

      assert {runs, failures} = Runner.collect(config, run)
      assert Enum.map(runs, &{&1.depth, &1.label}) == [{1, "t0 baseline"}, {2, "pipeline"}]

      assert [%{depth: 4, label: "pipeline", tier: :t0, error: "boom"}] = failures
    end

    test "a failure that exits the pass is kept as a failure too" do
      {:ok, config} = Options.parse(["--tier", "t0", "--in-flight", "1,2"])

      run = fn
        %{in_flight: [2]} -> exit(:boom)
        pass -> %{tier: pass.tier}
      end

      assert {[%{depth: 1}], [%{depth: 2, error: error}]} = Runner.collect(config, run)
      assert error =~ "boom"
    end
  end

  describe "pipelined/6" do
    test "keeps depth calls outstanding, numbers every call, and records every reply" do
      {:ok, started} = Agent.start_link(fn -> [] end)
      now = System.monotonic_time(:microsecond)

      perform = fn seq ->
        Agent.update(started, &[seq | &1])
        Process.sleep(1)
        {100, 5, 0, 0}
      end

      stats = Runner.new_stats(1_000, now)

      stats =
        Runner.pipelined(3, now, now + 30_000, stats, perform,
          seq_step: 10,
          reply_timeout_ms: 1_000
        )

      seqs = Agent.get(started, & &1)

      assert length(seqs) == stats.in_flight_samples
      assert seqs == Enum.uniq(seqs)
      assert Enum.all?(seqs, &(rem(&1, 10) == 0))
      assert stats.seq == length(seqs) * 10
      assert stats.accepted == length(seqs) * 5
      assert stats.in_flight_peak == 3
      assert length(Metrics.reservoir_items(stats.reservoir)) == length(seqs)
    end

    test "stops starting new calls at the deadline and drains the outstanding ones" do
      {:ok, started} = Agent.start_link(fn -> [] end)
      now = System.monotonic_time(:microsecond)

      perform = fn seq ->
        Agent.update(started, &[seq | &1])
        Process.sleep(5)
        {50, 2, 1, 0}
      end

      stats =
        Runner.pipelined(2, now, now + 20_000, Runner.new_stats(1_000, now), perform,
          reply_timeout_ms: 1_000
        )

      seqs = Agent.get(started, & &1)
      elapsed_us = System.monotonic_time(:microsecond) - now

      assert elapsed_us >= 20_000
      assert elapsed_us < 500_000
      assert length(seqs) == stats.in_flight_samples
      assert stats.accepted == length(seqs) * 2
      assert stats.rejected == length(seqs)
    end

    test "completions before the measured window stay out of the occupancy mean" do
      now = System.monotonic_time(:microsecond)

      perform = fn _seq ->
        Process.sleep(1)
        {100, 5, 0, 0}
      end

      stats =
        Runner.pipelined(2, now + 10_000_000, now + 220_000, Runner.new_stats(100, now), perform,
          reply_timeout_ms: 1_000
        )

      assert stats.in_flight_samples == 0
      assert stats.in_flight_peak == 0
      assert stats.in_flight_sum == 0
      assert stats.accepted == 0
    end

    test "raises when an outstanding call never replies" do
      now = System.monotonic_time(:microsecond)

      perform = fn _seq ->
        Process.sleep(100)
        {1, 1, 0, 0}
      end

      assert_raise RuntimeError, ~r/never replied/, fn ->
        Runner.pipelined(1, now, now + 5_000_000, Runner.new_stats(10, now), perform,
          reply_timeout_ms: 20
        )
      end
    end
  end

  describe "real-socket fan-out wiring" do
    defmodule FakeSocketSubscribers do
      @moduledoc false
      def delivered(:handle), do: 4_096
      def stop_all(:handle), do: %{subscribers: 1, processes: 1, holes: 0, errors: 0}
    end

    test "a socket run starts the socket subscriber, not the in-process one" do
      config = socket_config()
      assert Runner.subscriber_source(config) == EbbServer.Bench.SocketSubscribers

      {:ok, in_process} = Options.parse(["--tier", "t3", "--subscribers", "10"])
      assert Runner.subscriber_source(in_process) == EbbServer.Bench.Subscriber

      {:ok, none} = Options.parse(["--tier", "t0"])
      assert Runner.subscriber_source(none) == nil
    end

    test "a t4 or t3 run without the flag keeps the in-process subscriber" do
      for tier <- ~w(t3 t4) do
        args = ["--tier", tier, "--subscribers", "10"]
        args = if tier == "t4", do: args ++ ["--rate", "100"], else: args

        {:ok, config} = Options.parse(args)
        assert Runner.subscriber_source(config) == EbbServer.Bench.Subscriber
      end
    end

    test "the socket client gets the run's port, process count, warmup and duration" do
      {:ok, config} =
        Options.parse([
          "--tier",
          "t4",
          "--rate",
          "300",
          "--subscribers",
          "1000",
          "--subscriber-socket",
          "--socket-processes",
          "4",
          "--warmup",
          "5",
          "--duration",
          "25",
          "--port",
          "4222"
        ])

      assert Runner.socket_opts(config) == [
               port: 4222,
               processes: 4,
               warmup: 5,
               duration: 25
             ]
    end

    test "the sampler and the report read the subscriber source's counters" do
      config = socket_config()
      source = Runner.subscriber_source(config)

      # A fake module stands in for the OS clients so the dispatch is testable
      # without opening 1000 sockets.
      assert Runner.fanout_delivered(FakeSocketSubscribers, :handle) == 4_096

      assert Runner.stop_fanout(FakeSocketSubscribers, :handle) == %{
               subscribers: 1,
               processes: 1,
               holes: 0,
               errors: 0
             }

      assert Runner.fanout_delivered(nil, nil) == nil
      assert Runner.stop_fanout(nil, nil) == nil
      assert source == EbbServer.Bench.SocketSubscribers
    end

    test "the baseline pass of a socket sweep is a plain t0 run" do
      {:ok, config} =
        Options.parse([
          "--tier",
          "t3",
          "--subscribers",
          "10",
          "--subscriber-socket",
          "--in-flight",
          "1,2"
        ])

      assert [%{label: "t0 baseline", config: baseline} | _rest] = Runner.passes(config)
      assert baseline.tier == :t0
      refute baseline.subscriber_socket
      assert baseline.socket_processes == 0
    end

    defp socket_config do
      {:ok, config} =
        Options.parse([
          "--tier",
          "t4",
          "--rate",
          "300",
          "--subscribers",
          "10",
          "--subscriber-socket",
          "--socket-processes",
          "2"
        ])

      config
    end
  end
end
