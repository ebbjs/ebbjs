defmodule EbbServer.Bench.Materialize.Runner do
  @moduledoc """
  Drives the materialization benchmark: boot, seed, measure, aggregate,
  report.

  One run boots an isolated storage tree, seeds every size, then measures
  the read scenarios in an order that keeps each sample honest: cold reads
  happen before the entity is cached, clean reads after, and the dirty
  scenario re-patches one `content` key and re-reads. Queries run last,
  against a pool that has already been materialized, so the sample is the
  decode pass and not a materialization.

  Several runs are aggregated by taking percentiles across every sample and
  also reporting the per-run medians, so run-to-run variance is visible
  rather than hidden by a single pooled number.
  """

  alias EbbServer.Bench.Boot
  alias EbbServer.Bench.Materialize.{Ablation, Collector, Options, Report, Stats, Workload}
  alias EbbServer.Bench.Options, as: WriteOptions
  alias EbbServer.Storage.EntityStore

  @point_paths [:cold, :dirty, :clean]
  @phases [:fetch_decode, :entries_scan, :actions_load, :merge, :encode, :upsert, :format]

  @doc """
  Runs every configured run and writes the Markdown report.
  """
  @spec run(Options.t()) :: {:ok, String.t()}
  def run(%Options{} = config) do
    run_rows = for run <- 1..config.runs, do: run_once(config, run)

    result = %{
      summary: summarize(config, run_rows),
      ablation: Ablation.run(config)
    }

    report = Report.render(config, result)
    path = Report.write(report, config)
    IO.puts(report)
    IO.puts("\nReport written to #{path}")
    {:ok, path}
  end

  defp run_once(config, run) do
    boot = Boot.start(%WriteOptions{port: config.port})

    try do
      collector = Collector.start()

      try do
        ctx = Workload.seed(config, run)
        measure(config, ctx, collector)
        Collector.stop(collector)
      after
        Collector.detach(collector)
      end
    after
      Boot.stop(boot)
    end
  end

  defp measure(config, ctx, collector) do
    cold(config, ctx, collector)
    clean(config, ctx, collector)
    dirty(config, ctx, collector)
    warm_spread(config, ctx)
    query(config, ctx, collector)
  end

  defp cold(config, ctx, collector) do
    if :cold in config.scenarios do
      for n <- config.sizes, dist <- config.distributions do
        measure_get(ctx, collector, n, dist, :cold)
      end
    end
  end

  defp clean(config, ctx, collector) do
    if :clean in config.scenarios do
      for n <- config.sizes, dist <- config.distributions, _rep <- 1..config.reps do
        measure_get(ctx, collector, n, dist, :clean)
      end
    end
  end

  defp dirty(config, ctx, collector) do
    if :dirty in config.scenarios do
      for n <- config.sizes, dist <- config.distributions, rep <- 1..config.reps do
        patch(ctx, n, dist, rep)
        measure_get(ctx, collector, n, dist, :dirty)
      end
    end
  end

  defp patch(ctx, n, dist, rep) do
    entity = sample_entity(ctx, n, dist)
    entity_actor = actor(ctx, n, dist)

    Workload.write_actions!([
      Workload.patch_action(entity, entity_actor, "run_1", "patched-#{rep}")
    ])
  end

  defp measure_get(ctx, collector, n, dist, path) do
    entity = sample_entity(ctx, n, dist)
    entity_actor = actor(ctx, n, dist)

    Collector.measure(collector, scenario(n, dist, path), fn ->
      EntityStore.get(entity, entity_actor)
    end)
  end

  # The query sample is decode-only, so the whole spread pool and the system
  # entities are materialized off the clock first.
  defp warm_spread(config, ctx) do
    if :query in config.scenarios do
      for n <- config.sizes, id <- Map.fetch!(ctx.spread, n) do
        EntityStore.get(id, Map.fetch!(ctx.spread_actors, n))
      end

      [n | _] = config.sizes
      EntityStore.query("todo", nil, Map.fetch!(ctx.spread_actors, n), limit: 1)
    end
  end

  defp query(config, ctx, collector) do
    if :query in config.scenarios do
      for n <- config.sizes, k <- config.query_ks, _rep <- 1..config.reps do
        measure_query(ctx, collector, n, k)
      end
    end
  end

  defp measure_query(ctx, collector, n, k) do
    query_actor = Map.fetch!(ctx.spread_actors, n)

    Collector.measure(collector, scenario(n, :spread, :query, k), fn ->
      EntityStore.query("todo", nil, query_actor, limit: k)
    end)
  end

  defp sample_entity(ctx, n, :hot), do: Map.fetch!(ctx.hot, n)
  defp sample_entity(ctx, n, :spread), do: ctx.spread |> Map.fetch!(n) |> hd()

  defp actor(_ctx, _n, :hot), do: Workload.actor_hot()
  defp actor(ctx, n, :spread), do: Map.fetch!(ctx.spread_actors, n)

  defp scenario(n, dist, path, k \\ nil), do: %{size: n, dist: dist, path: path, k: k}

  defp summarize(config, run_rows) do
    scenarios = all_scenarios(config)

    %{
      totals: Map.new(scenarios, fn sc -> {key(sc), total_stats(run_rows, sc)} end),
      phase_sums: Map.new(scenarios, fn sc -> {key(sc), phase_sum_median(run_rows, sc)} end),
      decodes: Map.new(scenarios, fn sc -> {key(sc), decode_median(run_rows, sc)} end),
      bytes: Map.new(scenarios, fn sc -> {key(sc), bytes_for(run_rows, sc)} end),
      phases: Map.new(scenarios, fn sc -> {key(sc), phase_stats(run_rows, sc)} end)
    }
  end

  defp all_scenarios(config) do
    point =
      for n <- config.sizes,
          dist <- config.distributions,
          path <- @point_paths,
          path in config.scenarios,
          do: scenario(n, dist, path)

    queries =
      for n <- config.sizes,
          k <- config.query_ks,
          :query in config.scenarios,
          do: scenario(n, :spread, :query, k)

    point ++ queries
  end

  defp key(%{size: n, dist: dist, path: path, k: k}), do: {n, dist, path, k}

  defp total_stats(run_rows, sc) do
    per_run =
      run_rows
      |> Enum.map(fn rows ->
        for {:total, ^sc, _sample_id, duration} <- rows, do: duration
      end)
      |> Enum.map(&Stats.median/1)
      |> Enum.reject(&is_nil/1)

    all = for rows <- run_rows, {:total, ^sc, _sample_id, duration} <- rows, do: duration

    %{
      samples: length(all),
      p50: Stats.percentile(all, 0.5),
      p95: Stats.percentile(all, 0.95),
      run_median_min: min_or_nil(per_run),
      run_median_max: max_or_nil(per_run)
    }
  end

  defp bytes_for(run_rows, sc) do
    values =
      for rows <- run_rows,
          {:bytes, ^sc, _sample_id, byte_size, _row_count} <- rows,
          do: byte_size

    Stats.median(values)
  end

  defp decode_median(run_rows, sc) do
    values = for rows <- run_rows, {:read, ^sc, _sample_id, duration} <- rows, do: duration
    Stats.median(values)
  end

  # The per-phase medians are not co-monotonic, so the median of their sum is
  # not the sum of their medians. Summing each sample's phases and taking the
  # median of that gives a number comparable to the sample's wall-clock total.
  defp phase_sum_median(run_rows, sc) do
    sums = Enum.flat_map(run_rows, &phase_sums_for_run(&1, sc))
    Stats.median(sums)
  end

  defp phase_sums_for_run(rows, sc) do
    rows
    |> Enum.filter(fn
      {:phase, ^sc, _sample_id, _phase, _duration} -> true
      _ -> false
    end)
    |> Enum.group_by(fn {:phase, _sc, sample_id, _phase, _duration} -> sample_id end)
    |> Enum.map(fn {_sample_id, phase_rows} ->
      Enum.sum(for {:phase, _sc, _sample_id, _phase, duration} <- phase_rows, do: duration)
    end)
  end

  defp phase_stats(run_rows, sc) do
    Map.new(@phases, fn phase ->
      values =
        for rows <- run_rows, {:phase, ^sc, _sample_id, ^phase, duration} <- rows, do: duration

      {phase, %{mean: mean(values), median: Stats.median(values)}}
    end)
  end

  defp mean([]), do: nil
  defp mean(values), do: Enum.sum(values) / length(values)

  defp min_or_nil([]), do: nil
  defp min_or_nil(values), do: Enum.min(values)

  defp max_or_nil([]), do: nil
  defp max_or_nil(values), do: Enum.max(values)
end
