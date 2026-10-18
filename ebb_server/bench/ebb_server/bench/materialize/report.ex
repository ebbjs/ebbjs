defmodule EbbServer.Bench.Materialize.Report do
  @moduledoc """
  Renders a materialization benchmark result as a Markdown document:
  document size, read-path latency per scenario, the dirty-path phase
  breakdown, query amplification, and the generated-column ablation.
  """

  alias EbbServer.Bench
  alias EbbServer.Bench.Materialize.Options

  @point_paths [:cold, :dirty, :clean]

  @doc """
  Renders the full Markdown report.
  """
  @spec render(Options.t(), map()) :: String.t()
  def render(%Options{} = config, result) do
    [
      "# ebb_server read / materialization benchmark",
      "",
      "Generated #{timestamp()} on `#{hostname()}`.",
      "",
      "## Environment",
      "",
      Bench.Report.environment_table(),
      "",
      "## Configuration",
      "",
      Bench.Report.table(["Option", "Value"], Options.describe(config)),
      "",
      "Reproduction command:",
      "",
      "```sh",
      Options.command(config),
      "```",
      "",
      blob_section(config, result),
      read_section(config, result),
      phase_section(config, result),
      query_section(config, result),
      ablation_section(result),
      "## Methodology and limitations",
      "",
      methodology(config),
      ""
    ]
    |> Enum.reject(&(&1 in [nil, ""]))
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
    Path.join([File.cwd!(), "bench", "results", "#{utc_stamp()}-materialize-#{hostname()}.md"])
  end

  defp blob_section(config, result) do
    rows =
      for n <- config.sizes, dist <- config.distributions do
        [n, dist, keys_per_entity(config, n, dist), format_bytes(bytes(result, n, dist, :clean))]
      end

    "## Document size\n\n" <>
      Bench.Report.table(
        ["Run keys (N)", "Distribution", "Keys/entity", "Blob bytes/entity"],
        rows
      ) <>
      "\n\nThe blob is the JSON SQLite stores (`data`); `Keys/entity` is the `content` map's\n" <>
      "key count. `hot` seeds one entity with N keys; `spread` seeds the configured pool\n" <>
      "with `N / pool` keys each, so the two have the same total document bytes.\n"
  end

  defp read_section(config, result) do
    paths = Enum.filter(@point_paths, &(&1 in config.scenarios))

    rows =
      for n <- config.sizes,
          dist <- config.distributions,
          path <- paths do
        stats = total(result, n, dist, path)

        [
          n,
          dist,
          path,
          format_us(stats.p50),
          format_us(stats.p95),
          format_us(decode(result, n, dist, path)),
          format_us(phase_sum(result, n, dist, path)),
          stats.samples,
          run_spread(stats),
          format_bytes(bytes(result, n, dist, path))
        ]
      end

    "## Read path by scenario (hot and spread)\n\n" <>
      Bench.Report.table(
        [
          "N",
          "Distribution",
          "Path",
          "p50 (µs)",
          "p95 (µs)",
          "Decode p50 (µs)",
          "Phase sum p50 (µs)",
          "Samples",
          "Run p50 min–max (µs)",
          "Bytes"
        ],
        rows
      ) <>
      "\n\n`cold` is the first read of an unmaterialized entity (no pre-existing blob, so\n" <>
      "`Bytes` is 0); `dirty` is one read after a one-key `content` patch; `clean` is a\n" <>
      "read of an already-materialized entity. p50/p95 pool every sample across runs;\n" <>
      "the run-spread column is the min–max of each run's own p50, so variance across\n" <>
      "boots is visible. `Bytes` is the blob the server decoded (0 for cold). `Decode\n" <>
      "p50` is `ebb.entity_store.read_latency_ms` — the `Jason.decode!` alone, without\n" <>
      "the SQLite SELECT the total includes — and is n/a where no such event fires.\n" <>
      "`Phase sum p50` is the median of each materialize's own sum of\n" <>
      "`ebb.entity_store.materialize_phase_ms` samples, so it is comparable to the\n" <>
      "wall-clock `p50`; the small gap is the `get/3`/`materialize/2` wrappers and the\n" <>
      "dirty-mark read, which sit outside the phases.\n"
  end

  defp phase_section(config, result) do
    paths = Enum.filter([:cold, :dirty], &(&1 in config.scenarios))

    rows =
      for n <- config.sizes,
          path <- paths,
          {phase, %{mean: mean, median: median}} <- result.summary.phases[{n, :hot, path, nil}],
          not is_nil(mean) do
        [
          n,
          path,
          phase,
          format_us(mean),
          format_us(median),
          share(mean, path_total(result, n, path))
        ]
      end

    "## Dirty-path phases (hot)\n\n" <>
      Bench.Report.table(
        ["N", "Path", "Phase", "Mean (µs)", "Median (µs)", "Share of mean sum"],
        rows
      ) <>
      "\n\nMeans of `ebb.entity_store.materialize_phase_ms` across runs. Means are used\n" <>
      "because the per-phase medians are not co-monotonic: a slow materialize is slow\n" <>
      "in every phase, so summing the medians understates the total while summing the\n" <>
      "means reconciles with the mean wall clock. `fetch_decode` is the SQLite SELECT\n" <>
      "plus `Jason.decode!` of the existing blob; `entries_scan` is the RocksDB\n" <>
      "`cf_entity_actions` prefix scan; `actions_load` is the RocksDB `multi_get` plus\n" <>
      "ETF decode; `merge` is the LWW replay; `encode` is the JSON the write needs\n" <>
      "(the whole blob on a replace, the touched keys on a patch); `upsert` is\n" <>
      "the SQLite write including the eight STORED `json_extract` generated columns;\n" <>
      "`format` is the post-#514 pass-through.\n"
  end

  defp path_total(result, n, path) do
    result.summary.phases
    |> Map.fetch!({n, :hot, path, nil})
    |> Map.values()
    |> Enum.map(& &1.mean)
    |> Enum.reject(&is_nil/1)
    |> Enum.sum()
  end

  defp query_section(config, result) do
    if :query in config.scenarios do
      rows =
        for n <- config.sizes, k <- config.query_ks do
          stats = total(result, n, :spread, :query, k)

          [
            n,
            k,
            format_us(stats.p50),
            format_us(stats.p95),
            format_us(decode(result, n, :spread, :query, k)),
            stats.samples,
            run_spread(stats),
            format_bytes(bytes(result, n, :spread, :query, k))
          ]
        end

      "## Query amplification (spread)\n\n" <>
        Bench.Report.table(
          [
            "N",
            "K rows",
            "p50 (µs)",
            "p95 (µs)",
            "Decode p50 (µs)",
            "Samples",
            "Run p50 min–max (µs)",
            "Bytes decoded"
          ],
          rows
        ) <>
        "\n\nOne `EntityStore.query/4` returning K rows, all already materialized, so the\n" <>
        "decode column is the `Enum.map(rows, &format_entity/1)` pass; the total also\n" <>
        "includes the permission join. Bytes decoded is the sum of the returned rows'\n" <>
        "blobs; it grows with K, which is the amplification the clean point read does not\n" <>
        "show.\n"
    end
  end

  defp ablation_section(result) do
    rows =
      Enum.map(result.ablation, fn row ->
        delta = delta_us(row.with_generated, row.without_generated)

        [
          row.size,
          format_bytes(row.bytes),
          format_us(row.with_generated),
          format_us(row.without_generated),
          format_us(delta),
          share(delta, row.with_generated)
        ]
      end)

    "## Generated-column ablation\n\n" <>
      Bench.Report.table(
        [
          "N",
          "Blob bytes",
          "8 generated cols (µs)",
          "No generated cols (µs)",
          "Delta (µs)",
          "Delta share"
        ],
        rows
      ) <>
      "\n\nTwo in-memory SQLite tables with the app's upsert SQL: one with the eight\n" <>
      "STORED `json_extract` columns, one without. The delta is the generated-column\n" <>
      "recomputation per upsert. Absolute times are lower than the live `upsert` phase\n" <>
      "(no WAL, no file), so read the delta and its share, not the absolute.\n"
  end

  defp delta_us(nil, _), do: nil
  defp delta_us(_, nil), do: nil
  defp delta_us(with_generated, without_generated), do: with_generated - without_generated

  defp methodology(config) do
    [
      "One run boots an isolated storage tree (`EbbServer.Bench.Boot`) in a temp\n" <>
        "directory, seeds the hot entity and the spread pool for every size, and\n" <>
        "measures the scenarios in order, so a cold sample is always the first read of\n" <>
        "an entity. #{config.runs} runs are reported; p50/p95 pool every sample and the\n" <>
        "run-spread column keeps the per-run medians.",
      "Each entity's `content` field is a wire map of `run_<i>` keys with ~#{config.run_value_bytes}-byte\n" <>
        "values, and each entity is filed into its actor's group by an `entityGroup`\n" <>
        "membership update in the same Action, so the query permission join sees it.",
      "The dirty scenario writes one patch Action per repetition off the clock (the\n" <>
        "write cost is the write benchmark's subject) and times the following `get/3`.",
      "The query scenario runs against a pool that was materialized before sampling,\n" <>
        "so the sample is the decode pass, not a materialization.",
      "Phases and sizes come from the server's own `ebb.entity_store.*` telemetry via a\n" <>
        "handler attached in the bench process; the total is the bench's wall clock.",
      "The generated-column ablation uses a private in-memory SQLite database, so it\n" <>
        "isolates the `json_extract` recomputation from WAL and file I/O."
    ]
    |> Enum.join("\n\n")
  end

  defp total(result, n, dist, path, k \\ nil), do: result.summary.totals[{n, dist, path, k}]
  defp decode(result, n, dist, path, k \\ nil), do: result.summary.decodes[{n, dist, path, k}]

  defp phase_sum(result, n, dist, path, k \\ nil),
    do: result.summary.phase_sums[{n, dist, path, k}]

  defp bytes(result, n, dist, path, k \\ nil), do: result.summary.bytes[{n, dist, path, k}]

  defp keys_per_entity(_config, n, :hot), do: n
  defp keys_per_entity(config, n, :spread), do: max(div(n, config.spread_entities), 1)

  defp run_spread(%{run_median_min: nil}), do: "n/a"
  defp run_spread(%{run_median_min: min, run_median_max: max}), do: "#{min}–#{max}"

  defp format_us(nil), do: "n/a"
  defp format_us(value), do: "#{:erlang.float_to_binary(value * 1.0, decimals: 1)}"

  defp format_bytes(nil), do: "n/a"
  defp format_bytes(value), do: "#{value}"

  defp share(nil, _), do: "n/a"
  defp share(_value, nil), do: "n/a"
  defp share(_value, 0), do: "n/a"

  defp share(value, total) do
    "#{:erlang.float_to_binary(value * 100 / total, decimals: 1)}%"
  end

  defp hostname do
    case :inet.gethostname() do
      {:ok, name} -> to_string(name)
      _ -> "unknown"
    end
  end

  defp utc_stamp, do: DateTime.utc_now() |> Calendar.strftime("%Y%m%dT%H%M%SZ")

  defp timestamp, do: DateTime.utc_now() |> DateTime.to_iso8601()
end
