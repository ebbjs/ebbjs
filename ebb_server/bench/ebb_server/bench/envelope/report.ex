defmodule EbbServer.Bench.Envelope.Report do
  @moduledoc """
  Renders the `cf_actions` envelope comparison as a Markdown document:
  the stored value per shape, the write leg per flush size, and the read
  price per path, with the methodology that bounds each number.
  """

  alias EbbServer.Bench
  alias EbbServer.Bench.Envelope.Options

  @doc """
  Renders the full Markdown report.
  """
  @spec render(Options.t(), %{shapes: [map()]}) :: String.t()
  def render(%Options{} = config, %{shapes: shapes}) do
    [
      "# ebb_server `cf_actions` envelope benchmark",
      "",
      "Generated #{timestamp()} on `#{hostname()}`.",
      "",
      "Compares the four stored-Action shapes from #552 — `:wrapper` (what " <>
        "`origin/main` stores), `:versioned_wrapper` (that format plus a version integer " <>
        "in a 3-tuple), `:companion` (the never-measured alternative), and " <>
        "`:frame` (`EbbServer.Storage.ActionFormat.frame/2`, what the branch stores) — " <>
        "on the envelope's own encode, on the durable write, and on every read path " <>
        "that touches the envelope.",
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
      headline_section(shapes),
      encode_section(shapes),
      read_section(shapes),
      stored_section(shapes),
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
    Path.join([File.cwd!(), "bench", "results", "#{utc_stamp()}-envelope-#{hostname()}.md"])
  end

  # One row per shape per flush size: the number acceptance criterion 2 in
  # #552 asks for (`commit_latency_ms` split out of the flush) at 100 and 152
  # Actions/flush.
  defp headline_section(shapes) do
    rows =
      for shape <- shapes, write <- shape.write do
        [
          shape.shape,
          write.flush_size,
          write.samples,
          format_ms(write.ms_min),
          format_ms(write.ms_p50),
          format_ms(write.ms_p95),
          format_us(write.us_per_action_p50),
          format_us(write.us_per_action_p95),
          shape.stored.puts_per_action
        ]
      end

    "## Headline: durable write leg\n\n" <>
      Bench.Report.table(
        [
          "Shape",
          "Actions/flush",
          "Flushes measured",
          "ms/flush min",
          "ms/flush p50",
          "ms/flush p95",
          "µs/Action p50",
          "µs/Action p95",
          "`cf_actions` records/Action"
        ],
        rows
      ) <>
      "\n\nOne `RocksDB.write_batch(ops, sync: true)` per sample, holding the full " <>
      "flush shape: the `cf_actions` value in the shape under test plus the dedup, " <>
      "group-index, entity-index, and type-entity rows the Writer commits. `µs/Action` " <>
      "is the same sample divided by the flush size, so it is comparable across flush " <>
      "sizes; `ms/flush` is the number #552's acceptance criterion 2 can paste. `min` " <>
      "is the least-contended flush — host noise only adds time, so `min` is the " <>
      "cleanest estimate of a shape's own cost when a shared host pollutes a few " <>
      "samples. Every write round measures every shape once, rotated so host drift " <>
      "lands on every shape equally. The flush is bounded by op count and fsync, not " <>
      "by the envelope: the envelope's share of a write is the encode leg plus, only " <>
      "for `:companion`, its extra durable put. A difference between two " <>
      "single-record shapes smaller than that share is host noise, not the envelope. " <>
      "The companion's extra durable put is the `cf_actions` records/Action " <>
      "difference.\n"
  end

  defp encode_section([%{encode: %{inputs: inputs}} | _] = shapes) do
    rows =
      Enum.map(shapes, fn shape ->
        encode = shape.encode

        [
          shape.shape,
          encode.samples,
          format_us(encode.us_per_action_p50),
          format_us(encode.us_per_action_p95),
          format_us(encode.us_per_action_min)
        ]
      end)

    "## Encode leg\n\n" <>
      Bench.Report.table(
        ["Shape", "Samples", "µs/Action p50", "µs/Action p95", "µs/Action min"],
        rows
      ) <>
      "\n\nThe per-Action value construction only: `Shapes.cf_actions_value/2` plus " <>
      "`Shapes.extra_ops/2` over #{inputs} Actions, with no RocksDB call and " <>
      "no batch assembly in the timed region. This is the envelope's own write price, " <>
      "separable from op assembly and fsync, and it is the number that explains why " <>
      "the write leg above cannot separate the single-record shapes.\n"
  end

  defp read_section(shapes) do
    rows =
      for shape <- shapes, read <- shape.read do
        [
          shape.shape,
          read.path,
          "`#{read.models}`",
          read.chunk,
          read.passes,
          read.samples,
          format_us(read.us_per_action_p50),
          format_us(read.us_per_action_p95),
          run_spread(read)
        ]
      end

    "## Read paths\n\n" <>
      Bench.Report.table(
        [
          "Shape",
          "Path",
          "Models",
          "Actions/sample",
          "Passes",
          "Samples",
          "µs/Action p50",
          "µs/Action p95",
          "Run p50 min–max (µs)"
        ],
        rows
      ) <>
      "\n\nEach shape reads its own window of the one shared DB, seeded through its " <>
      "own write path, so the value bytes and decode calls are the shape's while the " <>
      "DB, WAL, and block cache are not. Passes are interleaved across shapes with the " <>
      "same rotation as the write leg, so a path's shape-to-shape comparison is made " <>
      "against the same block-cache state. `Actions/sample` is the GSN slice " <>
      "one sample covers; p50/p95 pool every sample across the passes, and the " <>
      "run-spread column is the min–max of each pass's own p50, so variance across " <>
      "passes (and a noisy shared host) is visible rather than hidden. A pass repeats " <>
      "past `--runs` until the path has 1,000 samples, so a p50 of a sub-100 µs sample " <>
      "is not decided by a handful of scheduler hiccups, and one path's measurement " <>
      "spans a second or more. `materialize` is `multi_get` " <>
      "over `cf_actions` plus `decode_payload` — query and group listing reach the " <>
      "envelope only through this path, so they share its price. `catch_up` is " <>
      "`multi_get` plus the full decode plus `ActionScope.updates_for_group/2`; the " <>
      "`cf_group_actions` page read that hands it the GSNs is shape-independent and " <>
      "excluded. `export` is a `range_iterator` over `cf_actions` plus the full " <>
      "decode; its cursor bookkeeping is excluded. For `:companion`, the full decode " <>
      "pays its second point read per Action, and `materialize` pays nothing extra " <>
      "because it never reads the scopes.\n"
  end

  defp stored_section(shapes) do
    rows =
      Enum.map(shapes, fn shape ->
        stored = shape.stored

        [
          shape.shape,
          stored.value_bytes,
          stored.extra_bytes,
          stored.value_bytes + stored.extra_bytes,
          stored.puts_per_action
        ]
      end)

    "## Stored bytes per Action\n\n" <>
      Bench.Report.table(
        [
          "Shape",
          "`cf_actions` value (B)",
          "Extra key+value (B)",
          "Total (B)",
          "`cf_actions` records/Action"
        ],
        rows
      ) <>
      "\n\nMeasured on one Action from the configured workload " <>
      "(updates-per-action included); ETF, not a wire encoding. `Extra key+value` is " <>
      "the companion's second record — its key plus its scopes term — and 0 for the " <>
      "shapes that carry the scopes inside the value. These bytes are not what " <>
      "decides the question: the write leg is bounded by op count and fsync, and the " <>
      "read legs by decode calls, so read those tables.\n"
  end

  defp methodology(config) do
    [
      "One isolated boot for the whole run (`EbbServer.Bench.Boot`, a temp data dir, " <>
        "the `:ebb_server` application not started). Every shape lives in its own " <>
        "disjoint GSN window of that one DB (the windows are fixed by " <>
        "`EbbServer.Bench.Envelope.Runner`), so the shapes' records never touch " <>
        "while every sample is taken " <>
        "against the same DB, WAL, and compaction state. A separate boot per shape " <>
        "would also have measured the host at a different moment, which is a larger " <>
        "effect than the envelope itself.",
      "The encode leg builds one list of 1,000 Action inputs (payload ETF, scopes, " <>
        "GSN) outside the timer and then times `Shapes.cf_actions_value/2` plus " <>
        "`Shapes.extra_ops/2` over that list, per shape: the per-Action value " <>
        "construction with no RocksDB call and no batch assembly. It is the " <>
        "envelope's own share of a write, separable from op assembly and fsync.",
      "The write leg builds the exact op list one flush commits — " <>
        "`EbbServer.Bench.Workbook.build_action/4` + " <>
        "`ActionValidator.to_validated_action/1`, the `cf_actions` value in the shape " <>
        "under test, then the dedup, group-index, entity-index, and type-entity rows — " <>
        "and times only `RocksDB.write_batch(ops, sync: true)` (the NIF call plus its " <>
        "fsync). Action construction, validation, ETF encoding, key building, and " <>
        "batch assembly are outside the timer, as in " <>
        "`EbbServer.Bench.WriteBatch.commit/2`.",
      "Each write round measures every shape once at the same flush size, with the " <>
        "shape order rotated by the round number, so host drift lands on every shape " <>
        "equally instead of always on the first one.",
      "Before the measured rounds, one unmeasured round per configured flush size " <>
        "writes every shape, so WAL creation and first-page allocation are not " <>
        "charged to the measured samples. `--runs` is a floor: the runner measures at " <>
        "least 51 write rounds per size, 51 encode samples per shape, and 1,000 read " <>
        "samples per path, because a few-millisecond window on a shared host lets one " <>
        "scheduler hiccup decide a p50.",
      "For the read legs, every shape is seeded into its own read window of that same " <>
        "DB first (#{config.reads} Actions through the shape's own write path: its own " <>
        "`cf_actions` value, plus the companion's scopes put). Each path then runs its " <>
        "passes interleaved across the shapes with the same rotation, so a path's " <>
        "shape-to-shape comparison is made against the same block-cache state.",
      "Each path model performs the gets and decode calls of the production function " <>
        "it names and nothing else; the work around that function (the group-index " <>
        "page read, the export cursor) is excluded because it does not read the " <>
        "envelope. The companion's second read is modelled as one `get` per Action " <>
        "inside the decode — a batched second `multi_get` would be cheaper, so this is " <>
        "an upper bound on the companion's read price.",
      "One unmeasured pass over every shape warms the RocksDB block cache before " <>
        "sampling, so the reported µs/Action is the steady-state price of the decode " <>
        "and the gets, not a cold-disk read. `materialize` samples 16 GSNs (an " <>
        "entity's Action history), `catch_up` and `export` sample 200 GSNs (a log " <>
        "page).",
      "No Writer, cache, watermark, or fan-out is involved: every number is the " <>
        "envelope's own share of the write and the read, not the system's latency at " <>
        "an operating point. Compare percentages here, then confirm at the operating " <>
        "point with `mix bench.actions` and `mix bench.materialize`.",
      "The companion's scopes key is a bench-only namespace inside `cf_actions` " <>
        "(`\"bench:envelope:companion:\" <> gsn`), chosen so no GSN range scan or " <>
        "point get can reach it without changing the production schema. A real " <>
        "companion form would add a column family; this measurement prices that form " <>
        "without taking the schema change."
    ]
    |> Enum.join("\n\n")
  end

  defp format_ms(value), do: decimal(value, 2)
  defp format_us(value), do: decimal(value, 2)

  defp run_spread(%{run_p50_min: min, run_p50_max: max}),
    do: "#{format_us(min)}–#{format_us(max)}"

  defp decimal(value, decimals) do
    :erlang.float_to_binary(value * 1.0, decimals: decimals)
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
