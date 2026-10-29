defmodule EbbServer.Bench.Report do
  @moduledoc """
  Renders a run's results as a Markdown document with the machine block,
  configuration, throughput, latency, resource/correctness numbers, and a
  methodology section that states the limits of the measurement.

  A result is one entry per measured pass. A pipeline-depth sweep renders the
  cross-run comparison table first and then one detail block per run; a plain
  single-depth run keeps the original top-level sections plus the Writer's own
  pipeline section (Actions/flush, gauges, and flush phases), which a sweep
  carries inside its depth section instead.
  """

  alias EbbServer.Bench.{Options, RunSummary}
  alias EbbServer.Storage.RocksDB
  alias EbbServer.Telemetry

  # `conn_deliver` is per subscriber and can outlive the push sample, so the
  # push-side attribution is every hop except it.
  @push_side_hops Enum.reject(Telemetry.fanout_hops(), &(&1 == :conn_deliver))

  @doc """
  Renders the full Markdown report.
  """
  @spec render(Options.t(), %{runs: [map()], sweep?: boolean()}) :: String.t()
  def render(%Options{} = config, %{runs: runs, sweep?: sweep?} = result) do
    failures = Map.get(result, :failures, [])
    pipelined? = sweep? or Enum.any?(runs, &(&1.depth > 1))
    baseline? = Enum.any?(runs, &(&1.label == "t0 baseline"))

    (header(config) ++
       pipeline_depth_section(runs, sweep?) ++
       writer_pipeline_section(config, runs, sweep?) ++
       List.flatten(run_sections(config, runs, length(runs) > 1)) ++
       failures_section(failures) ++
       guardrails_section(Map.get(result, :guardrails)) ++
       methodology_section(config, primary_metrics(runs), pipelined?, baseline?) ++
       List.wrap(machine_section(config, result)))
    |> Enum.reject(&is_nil/1)
    |> Enum.join("\n")
  end

  defp primary_metrics([%{metrics: metrics} | _]), do: metrics
  defp primary_metrics([]), do: nil

  defp header(config) do
    [
      "# ebb_server Actions/sec benchmark",
      "",
      "Generated #{timestamp()} on `#{hostname()}`.",
      "",
      "**Tier #{config.tier}** — #{Options.tier_description(config.tier)}.",
      "",
      "## Environment",
      "",
      environment_table(),
      "",
      "## Configuration",
      "",
      table(["Option", "Value"], Options.describe(config)),
      "",
      "Reproduction command:",
      "",
      "```sh",
      Options.command(config),
      "```",
      ""
    ]
  end

  defp pipeline_depth_section(_runs, false), do: []

  defp pipeline_depth_section(runs, true) do
    [
      "## Pipeline depth",
      "",
      table(
        [
          "Run",
          "Tier",
          "Callers",
          "Calls in flight per worker",
          "Observed peak (per worker)",
          "Observed mean (per worker)",
          "Accepted/sec (overall)",
          "p50 (µs)",
          "p95 (µs)",
          "p99 (µs)",
          "Actions/flush",
          "Flush p50 (µs)",
          "GSN holes",
          "Watermark lag high-water"
        ],
        Enum.map(runs, &pipeline_depth_row/1)
      ),
      "",
      pipeline_depth_note(),
      "",
      writer_gauge_section(runs),
      writer_phase_section(runs)
    ]
    |> List.flatten()
    |> Enum.reject(&is_nil/1)
  end

  defp pipeline_depth_note do
    "Observed peak and mean count the harness's outstanding `write_actions/1` calls per " <>
      "worker (`Callers × Calls in flight` calls are outstanding in total); the Writer's own " <>
      "view is the gauge table below, not these columns. The `t0 baseline` row is the " <>
      "no-regression check measured in this same report. Every depth runs against a fresh " <>
      "booted and seeded DB. `Actions/flush` and `Flush p50` come from " <>
      "`ebb.writer.batch_latency_ms`: the current Writer coalesces outstanding calls into " <>
      "shared flushes, so a deeper workload also deepens the flush, and those two columns " <>
      "make the load change visible."
  end

  defp writer_pipeline_section(_config, _runs, true), do: []

  # A single-depth run has no depth table to carry the Writer's own numbers,
  # so the coalescing shape and phase attribution get their own section. Every
  # sweep already renders these tables under `## Pipeline depth`.
  defp writer_pipeline_section(config, runs, false) do
    if Options.bypasses_writer?(config) do
      []
    else
      [
        "## Writer pipeline",
        "",
        table(
          ["Run", "Actions/flush", "Flush p50 (µs)"],
          Enum.map(runs, &writer_flow_row/1)
        ),
        "",
        "`Actions/flush` and `Flush p50` come from `ebb.writer.batch_latency_ms`, so they " <>
          "describe the coalesced flush this run actually produced rather than the requested " <>
          "burst; the gauges and phases below are the same tables a sweep renders in its " <>
          "pipeline-depth section.",
        "",
        writer_gauge_section(runs),
        writer_phase_section(runs)
      ]
      |> List.flatten()
    end
  end

  defp writer_flow_row(%{label: label, metrics: metrics}) do
    [
      label,
      format_actions_per_flush(metrics.correctness.accepted, metrics.server.writer_batch),
      format_flush_p50(metrics.server.writer_batch)
    ]
  end

  defp writer_gauge_section(runs) do
    rows =
      Enum.map(runs, fn run ->
        queue = Map.get(run.metrics.server, :queue_depth)
        in_flight = Map.get(run.metrics.server, :in_flight_batches)
        oldest = Map.get(run.metrics.server, :oldest_unreleased_gsn)

        [
          run.label,
          gauge_value(queue, :peak),
          gauge_value(queue, :mean),
          gauge_value(in_flight, :peak),
          gauge_value(in_flight, :mean),
          gauge_value(oldest, :peak),
          gauge_value(oldest, :mean)
        ]
      end)

    [
      "### Writer pipeline gauges",
      "",
      table(
        [
          "Run",
          "`queue_depth` peak",
          "`queue_depth` mean",
          "`in_flight_batches` peak",
          "`in_flight_batches` mean",
          "`oldest_unreleased_gsn` peak",
          "`oldest_unreleased_gsn` mean"
        ],
        rows
      ),
      "",
      "`queue_depth` is the number of `write_actions/1` calls one flush drained, taken from " <>
        "`ebb.writer.batch_size`'s `callers`, so its peak/mean describe how deep the coalescing " <>
        "queue got, not a sampled mailbox length. The other two columns are the Writer's own " <>
        "`ebb.writer.in_flight_batches` and `ebb.writer.oldest_unreleased_gsn` gauges, emitted " <>
        "on every claim and release, so they describe the actual reorder buffer rather than the " <>
        "harness-side outstanding-call figures a depth sweep reports. `in_flight_batches` counts " <>
        "every open claim, including one applying; `oldest_unreleased_gsn` is the head of the " <>
        "claim order and `0` when the buffer is empty, so its mean includes idle samples.",
      ""
    ]
  end

  defp writer_phase_section(runs) do
    phases = Telemetry.writer_flush_phases()
    heading = ["### Flush phases (p50 / p95, µs)", ""]

    if Enum.all?(runs, &no_flush_phases?(&1.metrics.server, phases)) do
      heading ++
        [
          "Not captured: no `ebb.writer.flush_phase_ms` samples landed in the measured " <>
            "window, so the Writer's phases cannot be attributed for these runs. The event is " <>
            "emitted once per claimed range; a run from a build before it landed has no phase " <>
            "data.",
          ""
        ]
    else
      rows =
        Enum.map(runs, fn run ->
          [run.label | flush_phase_cells(run.metrics.server, phases)]
        end)

      heading ++
        [
          table(["Run" | Enum.map(phases, &Atom.to_string/1)] ++ ["sum p50"], rows),
          "",
          "Each phase cell is `p50 / p95` in µs. The six phases sum to one claimed range's " <>
            "lifetime, from the oldest coalesced call's send to the end of its `notify` phase, " <>
            "so `sum p50` (the per-range sum the collector records as `flush_total`) is the " <>
            "flush a caller waited on. `queue` and `prepare` are the terms " <>
            "`ebb.writer.batch_latency_ms` cannot see, because its timer starts after the " <>
            "request is dequeued and the payload is built. A phase that did " <>
            "not run is `0`, not missing, so an abandoned range reports `0` for the phases it " <>
            "never reached.",
          ""
        ]
    end
  end

  # A synthetic report fixture can omit the writer gauges entirely; a real run
  # always collects them.
  defp gauge_value(nil, _key), do: "n/a"
  defp gauge_value(gauge, key), do: format_value(Map.fetch!(gauge, key))

  defp no_flush_phases?(server, phases) do
    case Map.get(server, :flush_phases) do
      nil -> true
      samples -> Enum.all?(phases, &(overall(Map.fetch!(samples, &1)).count == 0))
    end
  end

  defp flush_phase_cells(server, phases) do
    Enum.map(phases, fn phase -> phase_cell(overall(Map.fetch!(server.flush_phases, phase))) end) ++
      [format_value(overall(server.flush_total).p50)]
  end

  defp phase_cell(%{count: 0}), do: "n/a"
  defp phase_cell(window), do: "#{format_value(window.p50)} / #{format_value(window.p95)}"

  defp pipeline_depth_row(%{depth: depth, label: label, metrics: metrics}) do
    achieved = overall(metrics.throughput)
    latency = overall(metrics.latency)
    correctness = metrics.correctness

    [
      label,
      "#{metrics.tier}",
      "#{metrics.context.concurrency}",
      "#{depth}",
      format_integer(metrics.in_flight.peak),
      format_value(metrics.in_flight.mean),
      format_rate(achieved.rate),
      format_value(latency.p50),
      format_value(latency.p95),
      format_value(latency.p99),
      format_actions_per_flush(correctness.accepted, metrics.server.writer_batch),
      format_flush_p50(metrics.server.writer_batch),
      frontier_value(correctness.gsn_holes),
      frontier_value(correctness.watermark_lag_high)
    ]
  end

  defp format_actions_per_flush(_accepted, []), do: "n/a"

  defp format_actions_per_flush(accepted, windows) do
    case overall(windows) do
      %{count: 0} -> "n/a"
      %{count: count} -> Integer.to_string(div(accepted, count))
    end
  end

  defp format_flush_p50([]), do: "n/a"

  defp format_flush_p50(windows) do
    case overall(windows) do
      nil -> "n/a"
      window -> format_value(window.p50)
    end
  end

  defp frontier_value(nil), do: "n/a"
  defp frontier_value(value), do: format_integer(value)

  defp run_sections(config, runs, multiple?) do
    Enum.map(runs, fn run -> run_section(config, run, multiple?) end)
  end

  defp run_section(config, run, multiple?) do
    # The sections are tier-dependent, so each run reports against its own
    # tier (a t0 baseline inside a t2 sweep is still a t0 run).
    run_config = %{config | tier: run.metrics.tier}

    heading = if multiple?, do: ["## Run: depth #{run.depth} (#{run.metrics.tier})", ""], else: []
    heading ++ detail_sections(run_config, run.metrics)
  end

  defp detail_sections(config, result) do
    [
      "## Throughput",
      "",
      throughput_table(result.throughput),
      "",
      "## Latency",
      "",
      client_latency_table(result.latency),
      "",
      latency_note(config),
      server_latency_section(result.server),
      fanout_section(config, result.fanout, result.server),
      fixed_rate_section(config, result),
      fanout_hop_section(config, result.server),
      write_batch_section(config, result),
      "## Correctness and resources",
      "",
      correctness_table(config, result),
      ""
    ]
    |> Enum.reject(&is_nil/1)
  end

  defp failures_section([]), do: []

  defp failures_section(failures) do
    rows = Enum.map(failures, &[&1.label, "#{&1.tier}", "#{&1.depth}", &1.error])

    [
      "## Failed passes",
      "",
      table(["Run", "Tier", "Calls in flight per worker", "Error"], rows),
      "",
      "These passes did not complete, so the report is incomplete and the run exited with an " <>
        "error. Every row above was measured against its own freshly booted and seeded DB and " <>
        "is still valid on its own.",
      ""
    ]
  end

  defp guardrails_section(nil), do: []

  defp guardrails_section(guardrails) do
    status = if guardrails.enforced?, do: "enforced", else: "disabled (--no-guardrails)"

    outcome =
      cond do
        guardrails.violations == [] ->
          "All guardrails passed."

        guardrails.enforced? ->
          "The run failed #{length(guardrails.violations)} guardrail(s); the report is " <>
            "still written so the measurement is not lost."

        true ->
          "#{length(guardrails.violations)} violation(s) recorded; enforcement is off, " <>
            "so the run did not fail."
      end

    [
      "## Guardrails",
      "",
      "Status: #{status}. #{outcome}",
      "",
      guardrail_bands(guardrails.bands),
      "",
      violations_table(guardrails.violations),
      comparisons_table(guardrails.comparisons)
    ]
    |> Enum.reject(&is_nil/1)
  end

  defp guardrail_bands(bands) do
    "Regression bands against a matched baseline: Actions/sec more than " <>
      "#{format_percent(bands.rate_regression)} below, or p50 more than " <>
      "#{format_percent(bands.p50_regression)} above. A GSN hole, an unbounded watermark " <>
      "lag, a rejected Action, or a write/transport error fails regardless of the baseline."
  end

  defp violations_table([]), do: nil

  defp violations_table(violations) do
    rows =
      Enum.map(violations, fn violation ->
        [to_string(violation.invariant), violation.run, violation.detail]
      end)

    "### Violations\n\n" <> table(["Invariant", "Run", "Detail"], rows)
  end

  defp comparisons_table([]), do: nil

  defp comparisons_table(comparisons) do
    rows =
      Enum.map(comparisons, fn comparison ->
        [
          comparison.run,
          comparison.baseline_run || "no match",
          delta_cell(comparison.rate),
          delta_cell(comparison.p50),
          delta_cell(comparison.p95),
          pair_cell(comparison.gsn_holes),
          pair_cell(comparison.watermark_lag_final)
        ]
      end)

    "### Baseline comparison\n\n" <>
      table(
        [
          "Run",
          "Baseline",
          "Actions/sec (Δ)",
          "p50 µs (Δ)",
          "p95 µs (Δ)",
          "Holes (current / baseline)",
          "Final lag (current / baseline)"
        ],
        rows
      )
  end

  defp delta_cell(%{current: nil}), do: "n/a"

  defp delta_cell(%{current: current, delta: delta}) do
    "#{format_value(current)} (#{format_delta(delta)})"
  end

  defp pair_cell(%{current: current, baseline: baseline}) do
    "#{format_value(current)} / #{format_value(baseline)}"
  end

  defp format_delta(nil), do: "n/a"

  defp format_delta(delta) do
    sign = if delta >= 0, do: "+", else: ""
    "#{sign}#{:erlang.float_to_binary(delta * 100, decimals: 1)}%"
  end

  defp format_percent(value) do
    "#{round(value * 100)}%"
  end

  defp methodology_section(_config, nil, _pipelined?, _baseline?), do: []

  defp methodology_section(config, result, pipelined?, baseline?) do
    [
      "## Methodology and limitations",
      "",
      methodology(config, result, pipelined?, baseline?),
      ""
    ]
  end

  @doc """
  Writes `markdown` to the configured output path, expanding and creating
  parent directories.
  """
  @spec write(String.t(), Options.t()) :: String.t()
  def write(markdown, %Options{} = config) do
    path = config.out || default_path()
    path = Path.expand(path)
    File.mkdir_p!(Path.dirname(path))
    File.write!(path, markdown)
    path
  end

  defp default_path do
    Path.join([File.cwd!(), "bench", "results", "#{utc_stamp()}-#{hostname()}.md"])
  end

  @doc """
  Renders the host/CPU/RocksDB environment table as Markdown.

  Shared with the read-path report so both benchmarks describe the host the
  same way.
  """
  @spec environment_table() :: String.t()
  def environment_table do
    rows =
      [
        {"Hostname", hostname()},
        {"Kernel", uname()},
        {"CPU", "#{cpu_model()} (#{System.schedulers_online()} schedulers)"},
        {"Total memory", total_memory()},
        {"Elixir", System.version()},
        {"OTP", otp_release()}
      ] ++
        Enum.map(RocksDB.tuning(), fn {key, value} -> {"RocksDB #{key}", to_string(value)} end) ++
        [{"RocksDB sync", "true (prod default; false only for --durability async)"}]

    table(["Field", "Value"], rows)
  end

  defp throughput_table(throughput) do
    rows =
      Enum.map(throughput, fn row ->
        [
          row.window,
          "#{row.seconds}",
          "#{row.accepted}",
          format_rate(row.rate),
          "#{row.rejected}"
        ]
      end)

    table(["Window", "Seconds", "Accepted", "Accepted/sec", "Rejected"], rows)
  end

  defp client_latency_table(latency) do
    rows =
      Enum.map(latency, fn row ->
        [
          row.window,
          "#{row.count}",
          format_value(row.p50),
          format_value(row.p95),
          format_value(row.p99)
        ]
      end)

    table(["Window", "Samples", "p50", "p95", "p99"], rows)
  end

  defp server_latency_section(server) do
    case server_latency_rows(server) do
      [] ->
        nil

      rows ->
        "## Server-side latency (`ebb.*` telemetry)\n\n" <>
          table(["Event", "Window", "Samples", "p50", "p95", "p99"], rows) <>
          "\n\n" <>
          "Captured in the bench process by attaching handlers to the server's `ebb.*` events. " <>
          "`ebb.http.request_latency_ms` is measured inside the request process, so MessagePack " <>
          "encoding and transport are excluded; `ebb.writer.batch_latency_ms` covers one durable " <>
          "Writer flush, and `ebb.writer.commit_latency_ms` is the Committer's share of it " <>
          "(frame encode + `cf_*` op assembly + `write_batch`); `ebb.fanout.push_latency_ms` " <>
          "starts at the end of the post-commit apply (the fan-out notify send) and ends at " <>
          "the end of the `GroupServer` cast, per batch per group. " <>
          "`ebb.writer.batch_latency_ms` starts after the request is dequeued, so the wait a " <>
          "call spends in the Writer mailbox is not part of it: `ebb.writer.flush_phase_ms` " <>
          "reports that wait as `queue`, with `prepare` beside it, and a sweep renders the " <>
          "phase table in the pipeline-depth section. " <>
          "Durations are converted from native time units to microseconds and windowed like the " <>
          "client-side samples.\n"
    end
  end

  defp server_latency_rows(server) do
    [
      {"`ebb.http.request_latency_ms`", server.http_request},
      {"`ebb.writer.batch_latency_ms`", server.writer_batch},
      {"`ebb.writer.commit_latency_ms`", server.writer_commit},
      {"`ebb.fanout.push_latency_ms`", server.fanout_push}
    ]
    |> Enum.reject(fn {_event, windows} -> Enum.all?(windows, &(&1.count == 0)) end)
    |> Enum.flat_map(fn {event, windows} -> Enum.map(windows, &server_latency_row(event, &1)) end)
  end

  defp server_latency_row(event, window) do
    [
      event,
      window.window,
      "#{window.count}",
      format_value(window.p50),
      format_value(window.p95),
      format_value(window.p99)
    ]
  end

  defp latency_note(%{tier: :t0} = _config) do
    "Client-side values are wall time around `Writer.write_actions/1` in the bench worker; " <>
      "server-side `ebb.writer.batch_latency_ms` measures the same flush from inside the " <>
      "Writer, and `ebb.writer.commit_latency_ms` covers only the frame encode, op " <>
      "assembly, and `write_batch` after the payload was built and encoded before the " <>
      "claim. The difference is worker overhead plus the time the call spent in the Writer " <>
      "mailbox, which `ebb.writer.flush_phase_ms` reports as `queue` (with `prepare` measured " <>
      "beside it); a sweep renders that phase table in the pipeline-depth section.\n"
  end

  defp latency_note(%{tier: :t5}) do
    "Values are wall time around the raw `:rocksdb.write_batch/3` call in the bench worker. " <>
      "Batch assembly — Action construction, validation, ETF encoding, key building, and " <>
      "`batch_put` — is outside the timer, so this is the NIF call alone. The throughput " <>
      "table above counts wall Actions, assembly included.\n"
  end

  defp latency_note(_config) do
    "Client-side values are wall time around `:httpc` for one request, including MessagePack " <>
      "encoding, transport, and response parsing; server-side `ebb.http.request_latency_ms` " <>
      "measures the request inside the server, so the difference is client and transport " <>
      "overhead. `ebb.writer.batch_latency_ms` reports the durable flush separately; the wait " <>
      "a request spends in the Writer mailbox sits between the two and is reported by " <>
      "`ebb.writer.flush_phase_ms` as `queue` (with `prepare` measured beside it), whose " <>
      "phase table a sweep renders in the pipeline-depth section.\n"
  end

  defp fanout_section(%{tier: :t4}, _fanout, _server), do: nil
  defp fanout_section(_config, nil, _server), do: nil
  defp fanout_section(_config, [], _server), do: nil

  defp fanout_section(_config, fanout, server) do
    push = overall(server.fanout_push)

    rows = [
      {"Subscribers", "#{fanout.subscribers}"},
      {"Actions delivered (total)", "#{fanout.delivered_total}"},
      {"Delivered per subscriber (avg)", format_value(fanout.delivered_avg)},
      {"Control events (total)", "#{fanout.control_total}"},
      {"Delivery lag samples", "#{fanout.lag_count}"},
      {"Delivery lag p50 (µs)", format_value(fanout.lag_p50)},
      {"Delivery lag p99 (µs)", format_value(fanout.lag_p99)},
      {"Server commit→broadcast-complete samples", "#{push.count}"},
      {"Server commit→broadcast-complete p50 (µs)", format_value(push.p50)},
      {"Server commit→broadcast-complete p99 (µs)", format_value(push.p99)}
    ]

    "## Fan-out (T3)\n\n" <>
      table(["Metric", "Value"], rows) <>
      "\n\n" <>
      "Delivery lag is measured from a monotonic stamp embedded in each Action, so it spans " <>
      "client send → commit → dispatch → subscriber delivery and folds in client and transport " <>
      "overhead. `ebb.fanout.push_latency_ms` (server post-apply → broadcast complete) reports " <>
      "server queueing separately. Only every 50th delivery is decoded for the sample. Delivered " <>
      "counts cover the whole run (warmup plus measured window); the throughput table above is " <>
      "measured-window only.\n"
  end

  defp overall(windows), do: RunSummary.overall(windows)

  defp fixed_rate_section(%{tier: :t4} = config, result) do
    metrics = result.fanout_metrics
    achieved = overall(result.throughput)

    rows = [
      {"Target write rate", "#{config.rate} Actions/sec"},
      {"Achieved write rate", format_rate(achieved.rate)},
      {"Subscribers", "#{config.subscribers}"},
      {"Delivered Actions/sec", format_rate(metrics.delivered_per_sec)},
      {"Delivered per subscriber/sec", format_rate(metrics.delivered_per_subscriber_per_sec)},
      {"Server dispatched Actions/sec", format_rate(metrics.dispatched_per_sec)}
    ]

    "## Fixed-rate fan-out (T4)\n\n" <>
      table(["Metric", "Value"], rows) <>
      "\n\nCommit → broadcast complete latency (`ebb.fanout.push_latency_ms`) per 10s bucket:\n\n" <>
      bucket_table(result.fanout_series) <>
      "\n\n" <>
      "A flat p50 across buckets means fan-out keeps up; a rising p50 means the Router " <>
      "is falling behind the commit stream. `Server dispatched Actions/sec` counts the " <>
      "deliveries the server enqueued (`count × subscribers` per dispatched batch); " <>
      "`Delivered Actions/sec` counts what the bench subscribers actually received. If " <>
      "the two match, the server is the limit; if dispatched far exceeds delivered, the " <>
      "bench subscriber is the limit.\n"
  end

  defp fixed_rate_section(_config, _result), do: nil

  defp fanout_hop_section(config, server) do
    hops = Map.get(server, :fanout_hops) || %{}

    if Enum.any?(Telemetry.fanout_hops(), &(hop_window(hops, &1).count > 0)) do
      "## Fan-out latency breakdown\n\n" <>
        hop_table(hops) <>
        "\n\n" <>
        hop_accounting_table(server, hops) <>
        "\n\n" <>
        hop_notes(config, server) <>
        "\n"
    end
  end

  defp hop_table(hops) do
    rows =
      Enum.map(Telemetry.fanout_hops(), fn hop ->
        window = hop_window(hops, hop)

        [
          "`#{hop}`",
          "#{window.count}",
          format_value(window.p50),
          format_value(window.p95),
          format_value(window.p99)
        ]
      end)

    table(["Hop", "Samples", "p50 (µs)", "p95 (µs)", "p99 (µs)"], rows)
  end

  defp hop_accounting_table(server, hops) do
    push = overall_window(Map.get(server, :fanout_push, []))
    sum = push_side_p50(hops)

    rows =
      [
        [
          "`ebb.fanout.push_latency_ms` (re-based)",
          "#{push.count}",
          format_value(push.p50),
          format_value(push.p95),
          format_value(push.p99),
          "—",
          "—"
        ]
      ] ++ notify_context_row(server) ++ [sum_row(push, sum)]

    table(
      [
        "Measurement",
        "Samples",
        "p50 (µs)",
        "p95 (µs)",
        "p99 (µs)",
        "Δ vs push p50 (µs)",
        "Δ vs push p50"
      ],
      rows
    )
  end

  # #537 already prices the Writer → Router hand-off as the `notify` phase,
  # so it is context for the push sample rather than another hop in the sum.
  defp notify_context_row(server) do
    phases = Map.get(server, :flush_phases) || %{}

    case overall_window(Map.get(phases, :notify, [])) do
      %{count: 0} ->
        []

      window ->
        [
          [
            "`writer_notify` (context: #537 `notify` phase)",
            "#{window.count}",
            format_value(window.p50),
            format_value(window.p95),
            format_value(window.p99),
            "—",
            "—"
          ]
        ]
    end
  end

  defp sum_row(push, sum) do
    [
      "Sum of push-side hop p50s",
      "—",
      format_value(sum),
      "—",
      "—",
      delta_absolute(push.p50, sum),
      delta_percent(push.p50, sum)
    ]
  end

  defp delta_absolute(nil, _sum), do: "n/a"
  defp delta_absolute(_push, nil), do: "n/a"
  defp delta_absolute(push, sum), do: format_signed(sum - push)

  defp delta_percent(nil, _sum), do: "n/a"
  defp delta_percent(_push, nil), do: "n/a"
  defp delta_percent(0, _sum), do: "n/a"
  defp delta_percent(push, sum), do: format_delta((sum - push) / push)

  # A hop with no samples in the window contributes 0. That is the correct
  # reading for `router_dwell` (emitted only when a range actually waits) and
  # for a hop whose event never fired; the notes state the caveat.
  defp push_side_p50(hops) do
    @push_side_hops
    |> Enum.map(fn hop -> hop_window(hops, hop).p50 || 0 end)
    |> Enum.sum()
  end

  defp hop_window(hops, hop), do: overall_window(Map.get(hops, hop, []))

  defp overall_window(nil), do: empty_window()

  defp overall_window(windows) do
    overall(windows) || empty_window()
  end

  defp empty_window, do: %{window: "overall", count: 0, p50: nil, p95: nil, p99: nil}

  defp format_signed(value) when value >= 0, do: "+" <> format_value(value)
  defp format_signed(value), do: format_value(value)

  defp hop_notes(config, server) do
    notify? =
      overall_window(Map.get(Map.get(server, :flush_phases) || %{}, :notify, [])).count > 0

    notify_note =
      "`writer_notify` is #537's `notify` phase in `ebb.writer.flush_phase_ms` and is " <>
        "immediately before the re-based push sample (plus the mailbox hand-off), so it is " <>
        "shown as context" <>
        if(notify?,
          do: ", not as another hop in the sum.",
          else: ". It had no samples in this window."
        )

    [
      "Each hop is one `ebb.fanout.hop_ms` sample per range per hop (per range per group " <>
        "for the group hops), emitted by the server on the same measured window as every " <>
        "other `ebb.*` sample. `router_queue` runs from the Writer's notify send to the " <>
        "Router's `handle_info/2`; `router_dwell` is the wait in `Plan` for the committed " <>
        "watermark and is emitted only when a range actually waits, so an empty row means no " <>
        "range was held; `router_decode` is the `range_iterator` plus decode and group split; " <>
        "`router_encode` resolves the groups with a live `GroupServer` and builds their frames, " <>
        "one encode per (Action, distinct Update subset) for the whole range; " <>
        "`group_queue` is the cast to the `GroupServer` entry; " <>
        "`group_encode` is the flatten of the frames the Router built, not a frame encode; " <>
        "`group_cast` is the directly measured span from the end of that flatten to " <>
        "the last subscriber cast being enqueued, not a residual.",
      "`conn_deliver` " <>
        conn_sample_note(config) <>
        " Its sample count is therefore not " <>
        "the delivery count, and its server-side end is the parent `send/2` returning rather " <>
        "than the SSE handler's `chunk/2`, so a real socket is not measured.",
      "The sum covers " <>
        Enum.map_join(@push_side_hops, " + ", &"`#{&1}`") <>
        ": the push-side hops that end inside the re-based `ebb.fanout.push_latency_ms`. " <>
        "`conn_deliver` is excluded because it is per subscriber and can outlive the push. " <>
        "A hop with no samples in the window contributes 0. The sum balances when one " <>
        "group receives a range, the t4 shape; with several groups the group-scoped hops " <>
        "repeat per group while the range-scoped hops do not.",
      notify_note
    ]
    |> Enum.join("\n\n")
  end

  defp conn_sample_note(%{conn_sample_rate: 0}) do
    "is off for this run (`--conn-sample-rate 0`), so every `conn_deliver` row is empty."
  end

  defp conn_sample_note(%{conn_sample_rate: 1}) do
    "is sampled on every delivery (`--conn-sample-rate 1`)."
  end

  defp conn_sample_note(%{conn_sample_rate: rate}) do
    "is sampled 1 delivery in #{rate} (`--conn-sample-rate #{rate}`)."
  end

  defp write_batch_section(%{tier: :t5} = config, result) do
    achieved = overall(result.throughput)

    rows = [
      {"Callers (BEAM processes)", "#{config.concurrency}"},
      {"write_batch sync", sync_label(config.durability)},
      {"Actions per call", "#{config.batch_size}"},
      {"Updates per Action", "#{config.updates_per_action}"},
      {"GSN ranges", "disjoint per caller, contiguous per call"},
      {"Achieved Actions/sec", format_rate(achieved.rate)}
    ]

    "## Concurrent write_batch (T5)\n\n" <>
      table(["Metric", "Value"], rows) <>
      "\n\n" <>
      "Each caller is one BEAM process issuing `:rocksdb.write_batch/3` directly at a " <>
      "synthetic GSN base; only RocksDB's ability to overlap commits is measured. The " <>
      "measured path bypasses the Writer, so its caches, watermark, and fan-out stay idle " <>
      "(the storage tree still boots to open the DB and seed the bench context). Nothing here " <>
      "reflects the production write path's bookkeeping, and GSN holes/watermark lag are " <>
      "reported `n/a` because the spike writes at a synthetic GSN base and never advances " <>
      "the Writer's frontier. Comparing callers at the same sync mode " <>
      "is the point: the gap between one and two callers is the headroom a committer pool " <>
      "could use. The peak-dirty row in the resources table is Workbook seed residue, not a " <>
      "t5 signal.\n"
  end

  defp write_batch_section(_config, _result), do: nil

  defp sync_label(:sync), do: "sync: true"
  defp sync_label(:async), do: "sync: false"

  defp bucket_table(series) do
    rows =
      Enum.map(series, fn bucket ->
        [
          "#{bucket.from_second}",
          "#{bucket.count}",
          format_value(bucket.p50),
          format_value(bucket.p95)
        ]
      end)

    table(["From second", "Samples", "p50 (µs)", "p95 (µs)"], rows)
  end

  defp correctness_table(%Options{} = config, result) do
    correctness = result.correctness
    resources = result.resources

    # The frontier never moves when `:watermark` is ablated or when the run
    # The frontier never moves when `:watermark` is ablated or when the run
    # bypasses the Writer (t5), so its derived numbers are meaningless rather
    # than zero. GSN density is separate: only t5 writes at a synthetic base.
    frontier = fn value ->
      if Options.measures_frontier?(config), do: format_integer(value), else: "n/a"
    end

    density = fn value ->
      if Options.measures_gsn_density?(config), do: format_integer(value), else: "n/a"
    end

    rows = [
      {"Accepted Actions", format_integer(correctness.accepted)},
      {"Rejected Actions", format_integer(correctness.rejected)},
      {"Write/transport errors", format_integer(correctness.errors)},
      {"GSN holes", density.(correctness.gsn_holes)},
      {"First missing GSN", first_hole_value(config, Map.get(correctness, :gsn_first_hole))},
      {"Watermark lag high-water (GSNs)", frontier.(correctness.watermark_lag_high)},
      {"Final watermark lag (GSNs)", frontier.(correctness.watermark_lag_final)},
      {"Peak RSS", format_kb(resources.peak_rss_kb)},
      {"Peak process memory", format_bytes(resources.peak_memory_bytes)},
      {"Peak dirty-set size", format_integer(resources.peak_dirty)},
      {"Scheduler utilization", format_ratio(resources.scheduler_utilization)},
      {"Resource samples", format_integer(resources.sample_count)}
    ]

    table(["Metric", "Value"], rows)
  end

  defp methodology(config, result, pipelined?, baseline?) do
    [
      "The measured window starts after #{config.warmup}s of warmup; warmup traffic is executed " <>
        "but its samples are discarded.",
      database_state(config, result),
      distribution_semantics(config),
      pipeline_note(pipelined?, baseline?),
      client_latency_note(config),
      "Latency samples use reservoir sampling capped at ~200,000 across all workers " <>
        "(per-worker cap = cap / concurrency), so percentiles describe the retained sample.",
      http_client_note(config),
      "RocksDB compaction and flush backlog are not measured: the `rocksdb` package exposes no " <>
        "property for them and emits no `:telemetry` event.",
      durability_note(config),
      write_batch_note(config),
      steady_note(config),
      ablation_note(config)
    ]
    |> Enum.reject(&(&1 == ""))
    |> Enum.join(" ")
  end

  defp database_state(config, result) do
    ctx = result.context
    hot_note = if config.distribution == :hot, do: " plus the hot entity", else: ""

    "The DB starts empty in a temp directory and is seeded before measurement with 1 bootstrap " <>
      "Action (the bench group plus `a_bench` membership) and #{ctx.seeded_actions - 1} entity " <>
      "Action(s) (#{ctx.preloaded_entities} preloaded entities#{hot_note})."
  end

  defp distribution_semantics(%{distribution: :spread}) do
    "`spread` gives every Action a fresh entity and membership row, so the group index and dirty " <>
      "set grow across the window."
  end

  defp distribution_semantics(%{distribution: :hot}) do
    "`hot` re-puts one pre-seeded entity and its existing membership row every Action, so writes " <>
      "contend on LWW materialization instead of growing the entity set."
  end

  defp http_client_note(%{tier: tier}) when tier in [:t0, :t5], do: ""

  defp http_client_note(_config) do
    "HTTP tiers use `:httpc` with a keep-alive session pool sized to twice the run's " <>
      "outstanding calls (concurrency × calls in flight per worker); MessagePack encoding and " <>
      "response parsing are included in every latency sample."
  end

  defp pipeline_note(false, _baseline?), do: ""

  defp pipeline_note(true, baseline?) do
    "The pipeline-depth workload keeps N `Writer.write_actions/1` calls outstanding per worker " <>
      "instead of one, so the harness exercises temporal parallelism across GSN ranges. It uses " <>
      "the headline batch/Action shape (Actions per call, Updates per Action, distribution, and " <>
      "durability). " <>
      baseline_note(baseline?) <>
      "The observed peak and mean are harness-side outstanding calls; the Writer's own " <>
      "`ebb.writer.in_flight_batches` and `ebb.writer.oldest_unreleased_gsn` gauges are " <>
      "reported in a sweep's pipeline-depth section (#537). The Writer is booted with " <>
      "`max_in_flight` = min(N, 4), so a " <>
      "successor can resolve against the predecessor's planned cache overlay while it " <>
      "commits; N outstanding calls can still coalesce into shared flushes, which is why " <>
      "`Actions/flush` is reported beside every depth row."
  end

  defp baseline_note(true) do
    "A t0 depth-1 baseline was measured in this same report as the no-regression check. "
  end

  defp baseline_note(false), do: ""

  defp durability_note(%{durability: :sync}) do
    "Durability is the production default (`sync: true`): every commit is fsynced before the " <>
      "GSN range is acknowledged."
  end

  defp durability_note(%{durability: :async}) do
    "Durability is `sync: false` — a measurement-only ceiling, never a candidate configuration."
  end

  defp client_latency_note(%{tier: :t5}) do
    "No server-side telemetry is captured for this tier: the call bypasses the HTTP stack " <>
      "and the Writer."
  end

  defp client_latency_note(_config) do
    "Client-side latency is timed in the bench worker (T0) or around `:httpc` (HTTP tiers); " <>
      "server-side latency is recorded by the server and read from the `ebb.*` telemetry " <>
      "events (`ebb.http.request_latency_ms`, `ebb.writer.batch_latency_ms`, " <>
      "`ebb.writer.flush_phase_ms`, `ebb.fanout.push_latency_ms`) with handlers attached in " <>
      "the bench process, so transport and server queueing are reported separately."
  end

  defp write_batch_note(_config), do: ""

  defp steady_note(%{duration: duration}) when duration <= 61 do
    "The run is shorter than 61s, so no sustained window is reported (steady = n/a)."
  end

  defp steady_note(_config) do
    "Burst (first 15s) and steady (61s..120s) are reported separately because the two measure " <>
      "different regimes: cold memtable and compaction pressure affect the sustained rate."
  end

  defp ablation_note(%{ablate: []}), do: ""

  defp ablation_note(%{ablate: phases}) do
    "Ablation is active: the Writer skipped #{Enum.map_join(phases, ", ", &Atom.to_string/1)} " <>
      "on the write path, so this run measures a reduced write path and its latency, " <>
      "density, and dirty-cache numbers are not comparable to an unablated run."
  end

  @doc """
  Renders `headers` and `rows` as a Markdown table.
  """
  @spec table([String.t()], [Enumerable.t()]) :: String.t()
  def table(headers, rows) do
    header = "| " <> Enum.join(headers, " | ") <> " |"
    separator = "| " <> Enum.map_join(headers, " | ", fn _ -> "---" end) <> " |"

    body =
      Enum.map(rows, fn row -> "| " <> Enum.map_join(cells(row), " | ", &to_string/1) <> " |" end)

    Enum.join([header, separator | body], "\n")
  end

  defp cells(row) when is_tuple(row), do: Tuple.to_list(row)
  defp cells(row), do: row

  defp format_rate(nil), do: "n/a"
  defp format_rate(rate), do: :erlang.float_to_binary(rate * 1.0, decimals: 1)

  defp format_value(nil), do: "n/a"
  defp format_value(value) when is_integer(value), do: Integer.to_string(value)
  defp format_value(value), do: :erlang.float_to_binary(value * 1.0, decimals: 1)

  defp format_integer(nil), do: "not measured"
  defp format_integer(value), do: Integer.to_string(value)

  defp format_kb(nil), do: "not measured"

  defp format_kb(kb) do
    "#{kb} kB (#{:erlang.float_to_binary(kb / 1024, decimals: 1)} MiB)"
  end

  defp format_bytes(nil), do: "not measured"

  defp format_bytes(bytes) do
    "#{:erlang.float_to_binary(bytes / 1_048_576, decimals: 1)} MiB"
  end

  defp format_ratio(nil), do: "not measured"

  defp format_ratio(ratio) do
    "#{:erlang.float_to_binary(ratio * 100, decimals: 1)}%"
  end

  defp hostname do
    case :inet.gethostname() do
      {:ok, name} -> to_string(name)
      _ -> "unknown"
    end
  end

  defp uname do
    case System.cmd("uname", ["-a"], stderr_to_stdout: true) do
      {output, 0} -> String.trim(output)
      _ -> "unknown"
    end
  rescue
    _ -> "unknown"
  end

  defp cpu_model do
    with {:ok, content} <- File.read("/proc/cpuinfo"),
         line when is_binary(line) <-
           content |> String.split("\n") |> Enum.find(&String.starts_with?(&1, "model name")) do
      line |> String.split(":", parts: 2) |> List.last() |> String.trim()
    else
      _ -> "unknown"
    end
  end

  defp total_memory do
    with {:ok, content} <- File.read("/proc/meminfo"),
         [_, kb] <- Regex.run(~r/^MemTotal:\s+(\d+) kB/m, content) do
      "#{kb} kB"
    else
      _ -> "unknown"
    end
  end

  defp first_hole_value(%Options{} = config, value) do
    cond do
      not Options.measures_gsn_density?(config) -> "n/a"
      is_nil(value) -> "none"
      true -> format_integer(value)
    end
  end

  defp machine_section(config, result) do
    payload = %{
      "schema" => "ebb-bench-results",
      "version" => 1,
      "generated_at" => DateTime.utc_now() |> DateTime.to_iso8601(),
      "config" => Options.workload(config),
      "guardrails" => machine_guardrails(Map.get(result, :guardrails)),
      "runs" => Enum.map(result.runs, &machine_run(config, &1)),
      "failures" => Enum.map(Map.get(result, :failures, []), &machine_failure/1)
    }

    [
      "## Machine-readable results",
      "",
      "<!-- ebb-bench-results:v1",
      Jason.encode!(payload, pretty: true),
      "-->",
      ""
    ]
    |> Enum.join("\n")
  end

  defp machine_guardrails(nil), do: nil

  defp machine_guardrails(guardrails) do
    %{
      "enforced" => guardrails.enforced?,
      "baseline" => Map.get(guardrails, :baseline?, false),
      "bands" => %{
        "rate_regression" => guardrails.bands.rate_regression,
        "p50_regression" => guardrails.bands.p50_regression
      },
      "violations" =>
        Enum.map(guardrails.violations, fn violation ->
          %{
            "invariant" => to_string(violation.invariant),
            "run" => violation.run,
            "detail" => violation.detail
          }
        end),
      "comparisons" => guardrails.comparisons
    }
  end

  defp machine_failure(failure) do
    %{
      "label" => failure.label,
      "depth" => failure.depth,
      "tier" => to_string(failure.tier),
      "error" => failure.error
    }
  end

  defp machine_run(config, run) do
    summary = RunSummary.from_run(run, config)

    %{
      "label" => summary.label,
      "depth" => summary.depth,
      "config" => summary.config,
      "throughput" => %{
        "rate" => summary.rate,
        "accepted" => summary.throughput_accepted,
        "rejected" => summary.throughput_rejected
      },
      "latency" => %{
        "count" => summary.latency_count,
        "p50" => summary.p50,
        "p95" => summary.p95,
        "p99" => summary.p99
      },
      "correctness" => %{
        "accepted" => summary.accepted,
        "rejected" => summary.rejected,
        "errors" => summary.errors,
        "gsn_holes" => summary.gsn_holes,
        "gsn_first_hole" => summary.gsn_first_hole,
        "watermark_lag_high" => summary.watermark_lag_high,
        "watermark_lag_final" => summary.watermark_lag_final
      }
    }
  end

  defp otp_release, do: :erlang.system_info(:otp_release) |> to_string()

  defp utc_stamp, do: DateTime.utc_now() |> Calendar.strftime("%Y%m%dT%H%M%SZ")

  defp timestamp, do: DateTime.utc_now() |> DateTime.to_iso8601()
end
