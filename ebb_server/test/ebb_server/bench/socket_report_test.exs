defmodule EbbServer.Bench.SocketReportTest do
  @moduledoc """
  Pins the real-socket rows of a fan-out run: the client's own counters and
  receive → parse → count cost, the wire-integrity numbers, and the keep-up
  verdict against what the server dispatched.
  """

  use ExUnit.Case, async: true

  alias EbbServer.Bench.{Metrics, Options, Report, SocketSubscribers}

  @ctx %{entities: [], seeded_actions: 1}

  setup do
    {:ok,
     resources: [
       sample(delivered: 0, offset_us: 0),
       sample(delivered: 2_000, offset_us: 2_000_000)
     ],
     telemetry: %{
       fanout_push: [{1_000_000, 500}, {11_000_000, 900}],
       # `count * subscribers` per dispatched batch: 1000 deliveries in the
       # window, which is the 1000 frames the clients counted.
       fanout_dispatched: [{0, 500}, {10_000_000, 500}]
     }}
  end

  test "renders the client rows for a socket run", context do
    {:ok, config} = socket_config()
    report = render(config, analyze(config, socket_fanout(), context))

    assert report =~ "## Socket fan-out client (real SSE)"
    assert report =~ "| Connections | 1000 |"
    assert report =~ "| Client processes | 4 |"
    assert report =~ "| Delivered frames | 1000 |"
    assert report =~ "| Data chunks received | 20 |"
    assert report =~ "| Bytes received | 65536 |"
    assert report =~ "| Control events | 0 |"
    assert report =~ "| GSN holes (wire) | 0 |"
    assert report =~ "| Client errors | 0 |"
    assert report =~ "| Client receive→parse→count p50 (µs) | 3 |"
    assert report =~ "| Client receive→parse→count p95 (µs) | 5 |"
    assert report =~ "| Client receive→parse→count p99 (µs) | 5 |"
    assert report =~ "| Delivery lag p50 (µs) | 900 |"
    assert report =~ "| Delivery lag p99 (µs) | 1000 |"

    assert report =~
             "The consumers kept up with the server (within the sampler's boundary error)."
  end

  test "states when the consumers fell behind the server", context do
    {:ok, config} = socket_config()

    fanout = socket_fanout(holes: 0, errors: 0)
    telemetry = %{context.telemetry | fanout_dispatched: [{0, 100_000}, {10_000_000, 100_000}]}
    report = render(config, analyze(config, fanout, %{context | telemetry: telemetry}))

    # 1000 delivered/sec against 10000 dispatched/sec in the window.
    assert report =~ "Delivered / server-dispatched rate over the measured window: 0.100"
    assert report =~ "1000.0 vs 10000.0 per second"
    assert report =~ "The consumers fell behind the server"
  end

  test "says keep-up is not measured when the server dispatch series is empty", context do
    {:ok, config} = socket_config()
    report = render(config, analyze(config, socket_fanout(), %{context | telemetry: %{}}))

    assert report =~ "consumer keep-up is not stated"
  end

  test "a wire hole or client error is visible in the section", context do
    {:ok, config} = socket_config()
    report = render(config, analyze(config, socket_fanout(holes: 3, errors: 2), context))

    assert report =~ "| GSN holes (wire) | 3 |"
    assert report =~ "| Client errors | 2 |"
  end

  test "an in-process run has no socket section", context do
    {:ok, config} = Options.parse(["--tier", "t4", "--rate", "1000", "--subscribers", "10"])
    report = render(config, analyze(config, in_process_fanout(), context))

    refute report =~ "## Socket fan-out client"
    assert report =~ "## Fixed-rate fan-out (T4)"
  end

  test "the machine block carries the socket gate and the socket options", context do
    {:ok, config} = socket_config()
    report = render(config, analyze(config, socket_fanout(), context))

    assert report =~ ~s("subscriber_socket": true)
    assert report =~ ~s("socket_processes": 4)
    assert report =~ ~s("socket_holes": 0)
    assert report =~ ~s("socket_errors": 0)
  end

  test "the header names the real-socket consumers" do
    {:ok, config} = socket_config()
    report = render(config, analyze(config, socket_fanout(), %{}))

    assert report =~ "consumers on real SSE sockets in separate OS processes"
  end

  defp socket_config do
    Options.parse([
      "--tier",
      "t4",
      "--rate",
      "1000",
      "--subscribers",
      "1000",
      "--subscriber-socket",
      "--socket-processes",
      "4",
      "--duration",
      "20"
    ])
  end

  # Four client processes, a quarter of the connections each, so the merged
  # summary has to add them up rather than trust one client's view.
  defp socket_fanout(overrides \\ []) do
    report = %{
      connections: 250,
      delivered: 250,
      data_chunks: 5,
      control: 0,
      holes: 0,
      errors: 0,
      bytes_total: 16_384,
      lats: [1, 2, 3, 4, 5],
      lags: [900, 1_000],
      clock_us: nil,
      skew_us: 0,
      done?: true,
      bye?: true,
      exit: nil
    }

    [first, second, third, fourth] = List.duplicate(report, 4)
    SocketSubscribers.summarize([Map.merge(first, Map.new(overrides)), second, third, fourth])
  end

  defp in_process_fanout do
    %{subscribers: 10, delivered_total: 2_000, control_total: 0, lags: []}
  end

  defp render(config, result) do
    Report.render(config, %{
      runs: [%{depth: 1, label: "pipeline", config: config, metrics: result}],
      sweep?: false
    })
  end

  defp analyze(config, fanout, context) do
    Metrics.analyze(
      config,
      @ctx,
      [worker()],
      Map.get(context, :resources, []),
      fanout,
      Map.get(context, :telemetry, %{})
    )
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
