defmodule EbbServer.Bench.Report do
  @moduledoc """
  Renders a run's results as a Markdown document with the machine block,
  configuration, throughput, latency, resource/correctness numbers, and a
  methodology section that states the limits of the measurement.

  A result is one entry per measured pass. A pipeline-depth sweep renders the
  cross-run comparison table first and then one detail block per run; a plain
  single-depth run keeps the original top-level sections.
  """

  alias EbbServer.Bench.{Options, RunSummary}
  alias EbbServer.Storage.RocksDB

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
    rows = Enum.map(runs, &pipeline_depth_row/1)

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
        rows
      ),
      "",
      "Observed peak and mean count the harness's outstanding `write_actions/1` calls per " <>
        "worker, not the Writer's in-flight batches (`Callers × Calls in flight` calls are " <>
        "outstanding in total). The `t0 baseline` row is the no-regression check measured in " <>
        "this same report. Every depth runs against a fresh booted and seeded DB. " <>
        "`Actions/flush` and `Flush p50` come from `ebb.writer.batch_latency_ms`: the current " <>
        "Writer coalesces outstanding calls into shared flushes, so a deeper workload also " <>
        "deepens the flush, and those two columns make the load change visible.",
      ""
    ]
  end

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
          "(wrapper encode + `cf_*` op assembly + `write_batch`); `ebb.fanout.push_latency_ms` is commit → broadcast complete per batch per group. " <>
          "The Writer flush timer starts after the request is dequeued, so the wait a call spends " <>
          "in the Writer mailbox is not instrumented and stays inside the client-side number. " <>
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
      "Writer, and `ebb.writer.commit_latency_ms` covers only the wrapper encode, op " <>
      "assembly, and `write_batch` after the payload was built and encoded before the " <>
      "claim. The difference is worker overhead plus the time the call spent in the Writer " <>
      "mailbox, which is not separately instrumented.\n"
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
      "a request spends in the Writer mailbox sits between the two and is not instrumented.\n"
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
      "overhead. `ebb.fanout.push_latency_ms` (server commit → broadcast complete) reports server " <>
      "queueing separately. Only every 50th delivery is decoded for the sample. Delivered " <>
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
      "The observed peak and mean are harness-side outstanding calls, not the Writer's " <>
      "in-flight batches (#537). The Writer is booted with `max_in_flight` = min(N, 4), so a " <>
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
      "`ebb.fanout.push_latency_ms`) with handlers attached in the bench process, so " <>
      "transport and server queueing are reported separately."
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
