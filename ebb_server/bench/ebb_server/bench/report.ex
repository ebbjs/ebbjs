defmodule EbbServer.Bench.Report do
  @moduledoc """
  Renders a run's results as a Markdown document with the machine block,
  configuration, throughput, latency, resource/correctness numbers, and a
  methodology section that states the limits of the measurement.
  """

  alias EbbServer.Bench.Options
  alias EbbServer.Storage.RocksDB

  @doc """
  Renders the full Markdown report.
  """
  @spec render(Options.t(), map()) :: String.t()
  def render(%Options{} = config, result) do
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
      "",
      "## Throughput",
      "",
      throughput_table(result.throughput),
      "",
      "## Latency",
      "",
      latency_table(config, result.latency),
      "",
      latency_note(config),
      fanout_section(result.fanout),
      "## Correctness and resources",
      "",
      correctness_table(result),
      "",
      "## Methodology and limitations",
      "",
      methodology(config, result),
      ""
    ]
    |> Enum.reject(&is_nil/1)
    |> Enum.join("\n")
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

  defp environment_table do
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

  defp latency_table(_config, latency) do
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

  defp latency_note(%{tier: :t0} = _config) do
    "Values are per `Writer.write_actions/1` call, excluding wire serialization. " <>
      "With `--batch-size > 1` each sample covers the whole batch.\n"
  end

  defp latency_note(_config) do
    "Values are wall time around `:httpc` for one request, including MessagePack encoding and " <>
      "`rejected` parsing; server-side `:telemetry` does not exist yet (#125), so this is an " <>
      "outside-in number with client overhead folded in.\n"
  end

  defp fanout_section(nil), do: nil

  defp fanout_section(fanout) do
    rows = [
      {"Subscribers", "#{fanout.subscribers}"},
      {"Actions delivered (total)", "#{fanout.delivered_total}"},
      {"Delivered per subscriber (avg)", format_value(fanout.delivered_avg)},
      {"Control events (total)", "#{fanout.control_total}"},
      {"Delivery lag samples", "#{fanout.lag_count}"},
      {"Delivery lag p50 (µs)", format_value(fanout.lag_p50)},
      {"Delivery lag p99 (µs)", format_value(fanout.lag_p99)}
    ]

    "## Fan-out (T3)\n\n" <>
      table(["Metric", "Value"], rows) <>
      "\n\n" <>
      "Delivery lag is measured from a monotonic stamp embedded in each Action, so it includes " <>
      "server queueing before the commit; a pure commit-to-delivery number needs `:telemetry` " <>
      "(#125). Only every 50th delivery is decoded for the sample. Delivered counts cover the " <>
      "whole run (warmup plus measured window); the throughput table above is measured-window " <>
      "only.\n"
  end

  defp correctness_table(result) do
    correctness = result.correctness
    resources = result.resources

    rows = [
      {"Accepted Actions", format_integer(correctness.accepted)},
      {"Rejected Actions", format_integer(correctness.rejected)},
      {"Write/transport errors", format_integer(correctness.errors)},
      {"GSN holes", format_integer(correctness.gsn_holes)},
      {"Watermark lag high-water (GSNs)", format_integer(correctness.watermark_lag_high)},
      {"Final watermark lag (GSNs)", format_integer(correctness.watermark_lag_final)},
      {"Peak RSS", format_kb(resources.peak_rss_kb)},
      {"Peak process memory", format_bytes(resources.peak_memory_bytes)},
      {"Peak dirty-set size", format_integer(resources.peak_dirty)},
      {"Scheduler utilization", format_ratio(resources.scheduler_utilization)},
      {"Resource samples", format_integer(resources.sample_count)}
    ]

    table(["Metric", "Value"], rows)
  end

  defp methodology(config, result) do
    [
      "The measured window starts after #{config.warmup}s of warmup; warmup traffic is executed " <>
        "but its samples are discarded.",
      database_state(config, result),
      distribution_semantics(config),
      "Latency is captured outside the server (there is no `:telemetry` yet, see #125): the call " <>
        "or request is timed by the client process.",
      "Latency samples use reservoir sampling capped at ~200,000 across all workers " <>
        "(per-worker cap = cap / concurrency), so percentiles describe the retained sample.",
      http_client_note(config),
      "RocksDB compaction and flush backlog are not measured: the `rocksdb` package exposes no " <>
        "property for them and there is no `:telemetry` hook yet.",
      durability_note(config),
      steady_note(config)
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

  defp http_client_note(%{tier: :t0}), do: ""

  defp http_client_note(_config) do
    "HTTP tiers use `:httpc` with a keep-alive session pool sized to twice the requested " <>
      "concurrency; MessagePack encoding and response parsing are included in every latency sample."
  end

  defp durability_note(%{durability: :sync}) do
    "Durability is the production default (`sync: true`): every commit is fsynced before the " <>
      "GSN range is acknowledged."
  end

  defp durability_note(%{durability: :async}) do
    "Durability is `sync: false` — a measurement-only ceiling, never a candidate configuration."
  end

  defp steady_note(%{duration: duration}) when duration <= 61 do
    "The run is shorter than 61s, so no sustained window is reported (steady = n/a)."
  end

  defp steady_note(_config) do
    "Burst (first 15s) and steady (61s..120s) are reported separately because the two measure " <>
      "different regimes: cold memtable and compaction pressure affect the sustained rate."
  end

  defp table(headers, rows) do
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

  defp otp_release, do: :erlang.system_info(:otp_release) |> to_string()

  defp utc_stamp, do: DateTime.utc_now() |> Calendar.strftime("%Y%m%dT%H%M%SZ")

  defp timestamp, do: DateTime.utc_now() |> DateTime.to_iso8601()
end
