defmodule EbbServer.Bench.Envelope.Runner do
  @moduledoc """
  Drives the envelope comparison in **one** booted storage tree: the encode
  leg, the write leg at every flush size, and the read legs against a DB
  seeded through every shape.

  ## One boot, disjoint GSN windows

  Every shape is measured inside the same `EbbServer.Bench.Boot` tree, so all
  shapes share one database, one WAL, one compaction state, and one block
  cache. A shape's records live in a GSN window no other shape touches
  (`write_gsn_start/2`, `read_gsn_start/1`), so the samples are disjoint while
  the state they are taken against is identical. That is what makes a
  shape-to-shape difference attributable to the shape: a separate boot per
  shape would also measure the host at a different moment.

  ## Rotation

  Both measured legs measure every shape once per round and rotate the shape
  order by the round number, so host drift (a scheduler hiccup, a background
  compaction, thermal throttling) lands on every shape equally instead of on
  whichever shape is always measured first.

  ## Encode leg

  Times `Shapes.cf_actions_value/2` plus `Shapes.extra_ops/2` over one list of
  1,000 Action inputs, and nothing else: no RocksDB call, no batch assembly.
  That is the envelope's own price of building a stored value, and it is the
  number that explains why the single-record shapes cannot be separated on the
  write leg — the durable flush is bounded by op count and fsync, orders of
  magnitude above the encode.

  ## Write leg

  For each flush size and each round the runner builds the op list one flush
  would commit — the same `cf_actions` + dedup + group-index + entity-index
  rows `EbbServer.Bench.WriteBatch.build_ops/4` builds, with the `cf_actions`
  value in the shape under test — and times the single `write_batch` call.
  Action construction, the `ActionValidator` pass, ETF encoding, key building,
  and batch assembly sit outside the timer, like
  `EbbServer.Bench.WriteBatch.commit/2`, so the number is the durable write
  alone. One unmeasured round per flush size warms the filesystem and WAL
  before the measured samples.

  ## Read legs

  Every shape is seeded with `--reads` Actions, each at the base of its own
  read window. The runner then times three path models over each shape's
  window, interleaving the passes across shapes so a path's shape-to-shape
  comparison is made against the same block-cache state:

    * `materialize` — `multi_get` over `cf_actions` plus `decode_payload`,
      the gets and decode calls of `EntityStore.load_actions/2`;
    * `catch_up` — `multi_get` plus the full decode plus
      `ActionScope.updates_for_group/2`, the work of
      `CatchUp.fetch_actions_by_gsn/1` once the group index has handed it
      the GSNs;
    * `export` — `range_iterator` over `cf_actions` plus the full decode,
      the work of `ActionLog.read/3`.

  A path model times only what the named production function does; the
  shape-independent work around it (the `cf_group_actions` page read, the
  export cursor) is excluded on purpose. The companion's second read is one
  point get per Action inside the decode, which is what a decoder that
  needs the scopes has to pay.

  Every path is sampled in fixed-size GSN slices, so a sample's cost is
  divided by the Actions it consumed and reported as µs/Action. One
  unmeasured pass warms the block cache; the reported samples are the
  steady-state price, not the first, cold-disk read.
  """

  alias EbbServer.Bench
  alias EbbServer.Bench.Envelope.{Options, Report, Shapes}
  alias EbbServer.Bench.Materialize.Stats
  alias EbbServer.Bench.Options, as: WriteOptions
  alias EbbServer.Bench.{Workbook, WriteBatch}
  alias EbbServer.Storage.{ActionFormat, ActionScope, ActionValidator, RocksDB}

  # Every shape owns a disjoint GSN window in the one bench DB, so a flush,
  # a seed, or a range scan can never collide with another shape's records.
  # The windows are 100,000 GSNs apart, far above any GSN a run consumes.
  @write_gsn_base 1_000_000_000
  @read_gsn_base 2_000_000_000
  @gsn_window 100_000_000

  # Consecutive flushes are 10,000 GSNs apart, so a flush's dedup and
  # group-index rows can never alias the next flush's.
  @gsn_stride 10_000

  # Encode-leg inputs are values, never records: they use their own window so
  # nobody reads them as evidence of DB state.
  @encode_gsn_base 3_000_000_000

  @paths [:materialize, :catch_up, :export]

  @path_models %{
    materialize: "EbbServer.Storage.EntityStore.load_actions/2",
    catch_up: "EbbServer.Sync.CatchUp.fetch_actions_by_gsn/1",
    export: "EbbServer.Storage.ActionLog.read/3"
  }

  # A materialization reads the Actions of one entity, not a whole log page;
  # 16 is a small entity history and keeps per-call overhead from dominating
  # the per-Action cost.
  @materialize_chunk 16

  # `CatchUp`'s default page and one export cursor page.
  @page_chunk 200

  @chunks %{materialize: @materialize_chunk, catch_up: @page_chunk, export: @page_chunk}

  @seed_chunk 200

  # One sample of the encode leg is the value construction for this many
  # Actions, so a µs/Action figure is not decided by timer resolution.
  @encode_inputs 1_000

  # `--runs` is a floor, not the whole sample size: a few milliseconds of
  # measurement on a shared host lets one scheduler hiccup decide a p50. The
  # runner repeats until each measurement has this many samples.
  @min_flush_samples 51
  @min_read_samples 1_000
  @min_encode_samples 51

  @doc """
  Runs every configured shape in one booted tree and writes the Markdown
  report.
  """
  @spec run(Options.t()) :: {:ok, String.t()}
  def run(%Options{} = config) do
    plans = plans(config)
    IO.puts(:stderr, "bench.envelope: measuring #{length(plans)} shapes in one tree")
    boot = Bench.Boot.start(%WriteOptions{port: config.port})

    try do
      encode = measure_encode(config, plans)
      write = measure_write(config, plans)
      seeds = seed_reads(config, plans)
      read = measure_reads(config, plans, seeds)

      shapes =
        Enum.map(plans, fn plan ->
          %{
            shape: plan.shape,
            stored: stored_sizes(plan.shape, config),
            encode: Map.fetch!(encode, plan.shape),
            write: Map.fetch!(write, plan.shape),
            read: Map.fetch!(read, plan.shape)
          }
        end)

      report = Report.render(config, %{shapes: shapes})
      path = Report.write(report, config)
      IO.puts(report)
      IO.puts("\nReport written to #{path}")
      {:ok, path}
    after
      Bench.Boot.stop(boot)
    end
  end

  # The plan carries the shape's index in the configured order, which is what
  # pins its GSN window.
  defp plans(config) do
    config.shapes
    |> Enum.with_index()
    |> Enum.map(fn {shape, index} -> %{shape: shape, index: index} end)
  end

  # ---------------------------------------------------------------------------
  # Encode leg
  # ---------------------------------------------------------------------------

  defp measure_encode(config, plans) do
    inputs = encode_inputs(config)
    rounds = sample_count(config.runs, @min_encode_samples)

    samples =
      Enum.reduce(1..rounds, empty_shapes(plans), fn round, samples ->
        encode_round(plans |> rotated(round), inputs, samples)
      end)

    Map.new(plans, fn plan ->
      per_action = samples |> Map.fetch!(plan.shape) |> Enum.reverse()

      {plan.shape,
       %{
         inputs: length(inputs),
         samples: length(per_action),
         us_per_action_p50: Stats.percentile(per_action, 0.5),
         us_per_action_p95: Stats.percentile(per_action, 0.95),
         us_per_action_min: Enum.min(per_action)
       }}
    end)
  end

  defp encode_round(plans, inputs, samples) do
    Enum.reduce(plans, samples, fn plan, samples ->
      {microseconds, _pairs} = timed(fn -> Enum.map(inputs, &encoded(plan.shape, &1)) end)
      Map.update!(samples, plan.shape, &[microseconds / length(inputs) | &1])
    end)
  end

  defp encoded(shape, input),
    do: {Shapes.cf_actions_value(shape, input), Shapes.extra_ops(shape, input)}

  # The inputs carry no shape: every shape constructs a value from the same
  # list, so a sample differs only in the shape's own encoding work.
  defp encode_inputs(config) do
    for offset <- 0..(@encode_inputs - 1) do
      gsn = @encode_gsn_base + offset
      shape_input(build_action(config, gsn), gsn)
    end
  end

  # ---------------------------------------------------------------------------
  # Write leg
  # ---------------------------------------------------------------------------

  defp measure_write(config, plans) do
    seqs = warm_write(config, plans, Map.new(plans, &{&1.shape, 0}))
    rounds = sample_count(config.runs, @min_flush_samples)

    {samples, _seqs} =
      Enum.reduce(
        config.flush_sizes,
        {empty_writes(plans, config.flush_sizes), seqs},
        fn flush_size, state -> measure_write_size(config, plans, flush_size, rounds, state) end
      )

    Map.new(plans, fn plan ->
      rows =
        Enum.map(config.flush_sizes, fn size ->
          write_row(size, samples |> Map.fetch!({plan.shape, size}) |> Enum.reverse())
        end)

      {plan.shape, rows}
    end)
  end

  defp measure_write_size(config, plans, flush_size, rounds, {samples, seqs}) do
    Enum.reduce(1..rounds, {samples, seqs}, fn round, {samples, seqs} ->
      {measured, seqs} = write_round(config, plans, flush_size, round, seqs)
      {put_samples(samples, flush_size, measured), seqs}
    end)
  end

  # Every round measures every shape once, in an order rotated by the round,
  # so host drift lands on every shape equally.
  defp write_round(config, plans, flush_size, round, seqs) do
    plans
    |> rotated(round)
    |> Enum.map_reduce(seqs, fn plan, seqs ->
      {microseconds, seqs} = write_flush(config, plan, flush_size, seqs)
      {{plan.shape, %{microseconds: microseconds, actions: flush_size}}, seqs}
    end)
  end

  # One unmeasured round per flush size: WAL creation and first-page
  # allocation are not charged to the measured samples.
  defp warm_write(config, plans, seqs) do
    Enum.reduce(config.flush_sizes, seqs, fn flush_size, seqs ->
      plans
      |> rotated(0)
      |> Enum.reduce(seqs, fn plan, seqs ->
        {_microseconds, seqs} = write_flush(config, plan, flush_size, seqs)
        seqs
      end)
    end)
  end

  defp write_flush(config, plan, flush_size, seqs) do
    seq = Map.fetch!(seqs, plan.shape)
    ops = flush_ops(plan.shape, config, flush_size, write_gsn_start(plan.index, seq))
    {microseconds, :ok} = timed(fn -> write!(ops) end)
    {microseconds, Map.put(seqs, plan.shape, seq + 1)}
  end

  defp write_gsn_start(shape_index, seq),
    do: @write_gsn_base + shape_index * @gsn_window + seq * @gsn_stride

  defp empty_writes(plans, flush_sizes),
    do: Map.new(for plan <- plans, size <- flush_sizes, do: {{plan.shape, size}, []})

  defp put_samples(samples, flush_size, measured) do
    Enum.reduce(measured, samples, fn {shape, sample}, samples ->
      Map.update!(samples, {shape, flush_size}, &[sample | &1])
    end)
  end

  defp write_row(flush_size, samples) do
    per_flush = Enum.map(samples, & &1.microseconds)
    per_action = Enum.map(samples, &(&1.microseconds / &1.actions))

    %{
      flush_size: flush_size,
      samples: length(samples),
      ms_min: to_ms(Enum.min(per_flush)),
      ms_p50: to_ms(Stats.percentile(per_flush, 0.5)),
      ms_p95: to_ms(Stats.percentile(per_flush, 0.95)),
      us_per_action_p50: Stats.percentile(per_action, 0.5),
      us_per_action_p95: Stats.percentile(per_action, 0.95)
    }
  end

  # The flush op list is `EbbServer.Bench.WriteBatch`'s: the same dedup,
  # group-index, entity-index and flush-scoped type-entity rows, with the
  # `cf_actions` puts supplied by the shape under test.
  defp flush_ops(shape, config, flush_size, gsn_start) do
    stored = fn action, gsn ->
      input = shape_input(action, gsn)

      [{:put, RocksDB.cf_actions(), RocksDB.encode_gsn_key(gsn), value(shape, input)}] ++
        Shapes.extra_ops(shape, input)
    end

    WriteBatch.build_ops(
      %{write_options(config) | batch_size: flush_size},
      ctx(),
      1,
      gsn_start,
      gsn_start,
      stored
    )
  end

  defp value(shape, input), do: Shapes.cf_actions_value(shape, input)

  defp shape_input(action, gsn) do
    %{
      payload_etf: action |> ActionFormat.build() |> ActionFormat.encode(),
      update_scopes: Enum.map(action.updates, fn _ -> [Workbook.group_id()] end),
      gsn: gsn
    }
  end

  # The encode leg times value construction only, so it builds the Actions
  # itself rather than through the shared flush op list.
  defp build_action(config, seq) do
    config
    |> write_options()
    |> Workbook.build_action(ctx(), 1, seq)
    |> ActionValidator.to_validated_action()
  end

  defp write_options(config) do
    %WriteOptions{
      updates_per_action: config.updates_per_action,
      distribution: :spread
    }
  end

  # The envelope bench builds Actions only; nothing here is read back by
  # subject, so the context exists to satisfy `Workbook.build_action/4`'s
  # target selection for the 1-Update shape.
  defp ctx do
    %{
      group_id: Workbook.group_id(),
      actor_id: Workbook.actor_id(),
      entities: Enum.map(1..8, &"todo_envelope_#{&1}"),
      hot_entity_id: "todo_envelope_hot",
      hot_membership_id: "eg_envelope_hot",
      seeded_actions: 0
    }
  end

  defp stored_sizes(shape, config) do
    input = shape_input(build_action(config, 0), 0)

    %{value: value_bytes, extra: extra_bytes} = Shapes.stored_bytes(shape, input)

    %{
      value_bytes: value_bytes,
      extra_bytes: extra_bytes,
      puts_per_action: 1 + length(Shapes.extra_ops(shape, input))
    }
  end

  # ---------------------------------------------------------------------------
  # Read legs
  # ---------------------------------------------------------------------------

  defp seed_reads(config, plans) do
    Map.new(plans, fn plan ->
      gsns =
        Enum.to_list(read_gsn_start(plan.index)..(read_gsn_start(plan.index) + config.reads - 1))

      gsns
      |> Enum.chunk_every(@seed_chunk)
      |> Enum.each(fn chunk -> write!(flush_ops(plan.shape, config, length(chunk), hd(chunk))) end)

      {plan.shape, gsns}
    end)
  end

  defp read_gsn_start(shape_index), do: @read_gsn_base + shape_index * @gsn_window

  defp measure_reads(config, plans, seeds) do
    @paths
    |> Enum.reduce(empty_shapes(plans), fn path, rows ->
      config
      |> measure_path(plans, path, seeds)
      |> Enum.reduce(rows, fn {shape, row}, rows ->
        Map.update!(rows, shape, &[row | &1])
      end)
    end)
    |> Map.new(fn {shape, rows} -> {shape, Enum.reverse(rows)} end)
  end

  # One path measured for every shape, passes interleaved with the same
  # rotation as the write leg, so a path's shape-to-shape comparison is made
  # against the same block-cache state.
  defp measure_path(config, plans, path, seeds) do
    chunk = min(Map.fetch!(@chunks, path), config.reads)
    chunks = Map.new(plans, &{&1.shape, Enum.chunk_every(Map.fetch!(seeds, &1.shape), chunk)})
    funs = Map.new(plans, &{&1.shape, sample_fun(&1.shape, path)})
    slices = chunks |> Map.fetch!(hd(plans).shape) |> length()
    passes = sample_count(config.runs, div_ceil(@min_read_samples, slices))

    # One unmeasured pass over every shape warms the block cache, so all
    # shapes are sampled against a resident DB.
    Enum.each(plans, fn plan -> Enum.each(chunks[plan.shape], funs[plan.shape]) end)

    samples =
      Enum.reduce(1..passes, empty_shapes(plans), fn round, samples ->
        plans
        |> rotated(round)
        |> Enum.reduce(samples, fn plan, samples ->
          pass = Enum.map(chunks[plan.shape], &timed_slice(funs[plan.shape], &1))
          Map.update!(samples, plan.shape, &[pass | &1])
        end)
      end)

    Map.new(plans, fn plan ->
      per_pass = samples |> Map.fetch!(plan.shape) |> Enum.reverse()
      pooled = List.flatten(per_pass)
      medians = Enum.map(per_pass, &Stats.median/1)

      {plan.shape,
       %{
         path: path,
         models: Map.fetch!(@path_models, path),
         chunk: chunk,
         actions: config.reads,
         passes: length(per_pass),
         samples: length(pooled),
         us_per_action_p50: Stats.percentile(pooled, 0.5),
         us_per_action_p95: Stats.percentile(pooled, 0.95),
         run_p50_min: Enum.min(medians),
         run_p50_max: Enum.max(medians)
       }}
    end)
  end

  defp sample_fun(shape, :materialize), do: &materialize_sample(shape, &1)
  defp sample_fun(shape, :catch_up), do: &catch_up_sample(shape, &1)
  defp sample_fun(shape, :export), do: &export_sample(shape, &1)

  # One chunk is one pass slice: the µs it cost divided by the Actions it
  # covered. The per-pass medians let the report show pass-to-pass variance
  # instead of hiding it in a single pooled percentile.
  defp timed_slice(fun, slice) do
    {microseconds, _result} = timed(fn -> fun.(slice) end)
    microseconds / length(slice)
  end

  defp materialize_sample(shape, gsns) do
    gsns
    |> fetch_values()
    |> Enum.zip(gsns)
    |> Enum.map(fn {{:ok, value}, gsn} ->
      Shapes.decode_payload(Shapes.stored(shape, value), gsn)
    end)
  end

  defp catch_up_sample(shape, gsns) do
    gsns
    |> fetch_values()
    |> Enum.zip(gsns)
    |> Enum.flat_map(fn {{:ok, value}, gsn} ->
      action = Shapes.decode(stored(shape, value, gsn), gsn)
      ActionScope.updates_for_group(action, Workbook.group_id())
    end)
  end

  defp export_sample(shape, gsns) do
    to_key = RocksDB.encode_gsn_key(List.last(gsns) + 1)

    RocksDB.cf_actions()
    |> RocksDB.range_iterator(RocksDB.encode_gsn_key(hd(gsns)), to_key)
    |> Enum.map(fn {key, value} ->
      gsn = RocksDB.decode_gsn_key(key)
      Shapes.decode(stored(shape, value, gsn), gsn)
    end)
  end

  defp stored(:companion, value, gsn),
    do: Shapes.stored(:companion, value, Shapes.read_scopes(gsn))

  defp stored(shape, value, _gsn), do: Shapes.stored(shape, value)

  defp fetch_values(gsns) do
    keys = Enum.map(gsns, &RocksDB.encode_gsn_key/1)

    RocksDB.cf_actions()
    |> RocksDB.multi_get(keys)
    |> Enum.map(fn
      :not_found -> raise "cf_actions is missing a seeded GSN"
      found -> found
    end)
  end

  # ---------------------------------------------------------------------------
  # Helpers
  # ---------------------------------------------------------------------------

  defp write!(ops) do
    case RocksDB.write_batch(ops, sync: true, name: RocksDB) do
      :ok -> :ok
      {:error, reason} -> raise "envelope write failed: #{inspect(reason)}"
    end
  end

  defp timed(fun) do
    started = System.monotonic_time(:microsecond)
    result = fun.()
    {System.monotonic_time(:microsecond) - started, result}
  end

  defp rotated([], _offset), do: []

  defp rotated(list, offset) do
    {head, tail} = Enum.split(list, rem(offset, length(list)))
    tail ++ head
  end

  defp empty_shapes(plans), do: Map.new(plans, &{&1.shape, []})

  defp sample_count(runs, floor), do: max(runs, floor)

  defp div_ceil(numerator, denominator), do: div(numerator + denominator - 1, denominator)

  defp to_ms(microseconds), do: microseconds / 1000
end
