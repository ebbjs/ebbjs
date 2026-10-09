defmodule EbbServer.Bench.Runner do
  @moduledoc """
  Drives one benchmark run: boot, seed, warmup, measure, sample, report.

  Workers are fed across warmup and measurement so connections and cache
  state are reuse-warm; only samples after the measurement start are
  retained. Each worker owns its own reservoir slice, so the total sample
  count stays near `@latency_cap` regardless of concurrency.
  """

  alias EbbServer.Bench.{Boot, Http, Metrics, Options, Report, Sampler, Subscriber, Workbook}
  alias EbbServer.Storage.{ActionValidator, Writer}

  @latency_cap 200_000
  @await_buffer_ms 120_000

  @doc """
  Runs the benchmark described by `config` and writes its Markdown report.
  """
  @spec run(Options.t()) :: {:ok, String.t()}
  def run(%Options{} = config) do
    boot = Boot.start(config)

    try do
      ctx = Workbook.seed(config)
      result = measure(config, ctx)
      report = Report.render(config, result)
      path = Report.write(report, config)
      IO.puts(report)
      IO.puts("\nReport written to #{path}")
      {:ok, path}
    after
      Boot.stop(boot)
    end
  end

  defp measure(config, ctx) do
    Http.setup(config.concurrency)

    subscribers =
      if config.tier == :t3, do: Subscriber.start_all(config.subscribers, ctx), else: nil

    now = System.monotonic_time(:microsecond)
    measure_start = now + config.warmup * 1_000_000
    deadline = measure_start + config.duration * 1_000_000

    sampler = Sampler.start()

    workers =
      for id <- 1..config.concurrency do
        Task.async(fn -> worker(id, config, ctx, measure_start, deadline) end)
      end

    timeout = (config.warmup + config.duration) * 1000 + @await_buffer_ms
    worker_stats = Enum.map(workers, &Task.await(&1, timeout))
    resource_samples = Sampler.stop(sampler)
    fanout = Subscriber.stop_all(subscribers)

    Metrics.analyze(config, ctx, worker_stats, resource_samples, fanout)
  end

  defp worker(id, config, ctx, measure_start, deadline) do
    :rand.seed(:exsss, {config.seed, id, 0})
    cap = max(div(@latency_cap, config.concurrency), 1)

    stats = %{
      accepted: 0,
      rejected: 0,
      errors: 0,
      buckets: %{},
      rejected_buckets: %{},
      reservoir: Metrics.reservoir_new(cap),
      seq: 0
    }

    loop(id, config, ctx, measure_start, deadline, stats)
  end

  defp loop(id, config, ctx, measure_start, deadline, stats) do
    now = System.monotonic_time(:microsecond)

    if now >= deadline do
      stats
    else
      {latency, accepted, rejected, errors} = perform(config.tier, config, ctx, id, stats.seq)
      stats = record(stats, now - measure_start, latency, accepted, rejected, errors)
      loop(id, config, ctx, measure_start, deadline, stats)
    end
  end

  defp perform(:t0, config, ctx, id, seq) do
    actions = build_actions(config, ctx, id, seq)
    validated = Enum.map(actions, &ActionValidator.to_validated_action/1)

    started = System.monotonic_time(:microsecond)
    result = Writer.write_actions(validated)
    latency = System.monotonic_time(:microsecond) - started

    case result do
      {:ok, {gsn_start, gsn_end}, rejected} ->
        {latency, max(gsn_end - gsn_start + 1, 0), length(rejected), 0}

      {:error, _reason} ->
        {latency, 0, 0, config.batch_size}
    end
  end

  defp perform(_tier, config, ctx, id, seq) do
    actions = build_actions(config, ctx, id, seq)

    case Http.post_actions(config.port, actions) do
      {:ok, latency, rejected} -> {latency, config.batch_size - rejected, rejected, 0}
      {:error, latency, _reason} -> {latency, 0, 0, config.batch_size}
    end
  end

  defp build_actions(config, ctx, id, seq) do
    Enum.map(0..(config.batch_size - 1), fn offset ->
      Workbook.build_action(config, ctx, id, seq + offset)
    end)
  end

  defp record(stats, offset_us, latency, accepted, rejected, errors) do
    stats = %{stats | seq: stats.seq + max(accepted + rejected + errors, 1)}

    if offset_us < 0 do
      stats
    else
      second = div(offset_us, 1_000_000)

      %{
        stats
        | accepted: stats.accepted + accepted,
          rejected: stats.rejected + rejected,
          errors: stats.errors + errors,
          buckets: bump(stats.buckets, second, accepted),
          rejected_buckets: bump(stats.rejected_buckets, second, rejected),
          reservoir: Metrics.reservoir_add(stats.reservoir, {offset_us, latency})
      }
    end
  end

  defp bump(buckets, _second, 0), do: buckets
  defp bump(buckets, second, count), do: Map.update(buckets, second, count, &(&1 + count))
end
