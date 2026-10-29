defmodule EbbServer.Bench.Runner do
  @moduledoc """
  Drives one benchmark run: boot, seed, warmup, measure, sample, report.

  A run is one measured pass per requested `--in-flight` depth, each against
  a freshly booted and freshly seeded DB. In sweep mode a t0 depth-1 pass is
  measured first as the no-regression baseline. Workers are fed across warmup
  and measurement so connections and cache state are reuse-warm; only samples
  after the measurement start are retained. Each worker owns its own reservoir
  slice, so the total sample count stays near `@latency_cap` regardless of
  concurrency.

  A depth above 1 keeps that many `Writer.write_actions/1` calls outstanding
  per worker (`pipelined/6`), so the harness can exercise temporal parallelism
  across GSN ranges. Depth 1 stays the original serial worker loop.
  """

  alias EbbServer.Bench.{
    Baseline,
    Boot,
    Guardrails,
    Http,
    Metrics,
    Options,
    Report,
    Sampler,
    SocketSubscribers,
    Subscriber,
    Telemetry,
    Workbook,
    WriteBatch
  }

  alias EbbServer.Storage.{ActionValidator, Writer}

  @latency_cap 200_000
  @await_buffer_ms 120_000
  @reply_timeout_ms 30_000

  @doc """
  Runs the benchmark described by `config` and writes its Markdown report.

  `run_fun` is the per-pass measurement, injectable so the guardrail and
  report pipeline can be exercised without booting storage.
  """
  @spec run(Options.t()) :: {:ok, String.t()}
  @spec run(Options.t(), (Options.t() -> map())) :: {:ok, String.t()}
  def run(%Options{} = config, run_fun \\ &run_pass/1) do
    baseline = load_baseline(config)
    {runs, failures} = collect(config, run_fun)
    guardrails = Guardrails.evaluate(runs, config, baseline)

    result = %{
      runs: runs,
      sweep?: sweep?(config),
      failures: failures,
      guardrails: guardrails
    }

    report = Report.render(config, result)
    path = Report.write(report, config)
    IO.puts(report)
    IO.puts("\nReport written to #{path}")

    raise_failures(failures)
    Guardrails.enforce!(guardrails, config)
    {:ok, path}
  end

  defp load_baseline(%Options{baseline: nil}), do: nil

  defp load_baseline(%Options{baseline: path}) do
    case Baseline.load(path) do
      {:ok, baseline} -> baseline
      {:error, message} -> raise "invalid --baseline: #{message}"
    end
  end

  @doc """
  Runs every pass, keeping the passes that finished when one fails.

  A sweep is minutes of measurement, so a failure in a later pass must not
  throw away the earlier ones. `run_fun` is the per-pass measurement, injected
  so the schedule and its failure handling can be tested without storage.
  Failed passes are returned with their depth and label so the report can name
  what is missing instead of silently showing fewer rows.
  """
  @spec collect(Options.t(), (Options.t() -> map())) :: {[map()], [map()]}
  def collect(%Options{} = config, run_fun) when is_function(run_fun, 1) do
    {runs, failures} =
      config
      |> passes()
      |> Enum.reduce({[], []}, fn %{config: pass, depth: depth, label: label}, {runs, failures} ->
        case run_safely(run_fun, pass) do
          {:ok, metrics} ->
            {[%{depth: depth, label: label, metrics: metrics, config: pass} | runs], failures}

          {:error, error} ->
            {runs, [%{depth: depth, label: label, tier: pass.tier, error: error} | failures]}
        end
      end)

    {Enum.reverse(runs), Enum.reverse(failures)}
  end

  defp run_safely(run_fun, pass) do
    {:ok, run_fun.(pass)}
  rescue
    error -> {:error, Exception.message(error)}
  catch
    :exit, reason -> {:error, "exited: #{inspect(reason)}"}
  end

  defp raise_failures([]), do: :ok

  defp raise_failures(failures) do
    detail =
      Enum.map_join(failures, "; ", fn %{label: label, depth: depth, error: error} ->
        "#{label} depth #{depth}: #{error}"
      end)

    raise "bench pass failed, report is incomplete: #{detail}"
  end

  @doc """
  The ordered per-run configurations a run costs.

  One pass per requested depth, each a single-depth config so `Options.depth/1`
  is total. A sweep first measures a t0 depth-1 pass as the no-regression
  baseline unless the requested sweep already starts at t0 depth 1 with the
  plain serial workload — then that pass is the baseline and no extra boot is
  spent on a duplicate.
  """
  @spec passes(Options.t()) :: [%{config: Options.t(), depth: pos_integer(), label: String.t()}]
  def passes(%Options{} = config) do
    requested = Enum.map(config.in_flight, &pass(config, &1))

    cond do
      not sweep?(config) -> requested
      Enum.any?(requested, &baseline?(&1.config)) -> requested
      true -> [pass(baseline_config(config), 1) | requested]
    end
  end

  defp sweep?(%Options{in_flight: depths}), do: length(depths) > 1

  defp pass(config, depth) do
    pass_config = %{config | in_flight: [depth]}
    %{config: pass_config, depth: depth, label: label(pass_config)}
  end

  # The label names a pass's role in a sweep: the plain t0 depth-1 config is
  # the no-regression baseline, everything else is the pipelined workload.
  defp label(config) do
    if baseline?(config), do: "t0 baseline", else: "pipeline"
  end

  defp baseline?(%Options{} = config) do
    Options.depth(config) == 1 and config.tier == :t0 and config.concurrency == 1 and
      config.rate == 0 and config.subscribers == 0 and config.subscriber_lean == false and
      config.subscriber_socket == false
  end

  # The baseline is the pre-pipeline headline shape: one serial t0 caller with
  # no pacing and no subscribers, on this run's batch size, distribution, and
  # durability.
  defp baseline_config(config) do
    %{
      config
      | tier: :t0,
        concurrency: 1,
        in_flight: [1],
        rate: 0,
        subscribers: 0,
        subscriber_lean: false,
        subscriber_socket: false,
        socket_processes: 0
    }
  end

  defp run_pass(config) do
    boot = Boot.start(config)

    try do
      ctx = Workbook.seed(config)
      :ok = Boot.schedule_stall(config)
      measure(config, ctx)
    after
      Boot.stop(boot)
    end
  end

  defp measure(config, ctx) do
    unless Options.bypasses_writer?(config),
      do: Http.setup(config.concurrency * Options.depth(config))

    source = subscriber_source(config)
    {subscribers, measure_start} = start_fanout(source, config, ctx)
    deadline = measure_start + config.duration * 1_000_000

    sampler = Sampler.start(fn -> fanout_delivered(source, subscribers) end, measure_start)
    telemetry = Telemetry.start(measure_start)

    try do
      workers =
        for id <- 1..config.concurrency do
          Task.async(fn -> worker(id, config, ctx, measure_start, deadline) end)
        end

      timeout = (config.warmup + config.duration) * 1000 + @await_buffer_ms
      worker_stats = Enum.map(workers, &Task.await(&1, timeout))
      resource_samples = Sampler.stop(sampler)
      fanout = stop_fanout(source, subscribers)
      server = Telemetry.stop(telemetry)

      Metrics.analyze(config, ctx, worker_stats, resource_samples, fanout, server)
    after
      Telemetry.detach(telemetry)
    end
  end

  @doc """
  The fan-out subscriber implementation for a run: the real-socket clients
  when `--subscriber-socket` is set, the in-process subscribers otherwise, and
  `nil` on a tier with no subscribers.
  """
  @spec subscriber_source(Options.t()) :: module() | nil
  def subscriber_source(%Options{tier: tier}) when tier not in [:t3, :t4], do: nil
  def subscriber_source(%Options{subscriber_socket: true}), do: SocketSubscribers
  def subscriber_source(%Options{}), do: Subscriber

  @doc """
  Starts the run's subscribers and returns them with the instant the warmup
  window begins.

  The socket subscriber starts its OS processes and waits for every SSE
  connection to be up, so the warmup clock starts from readiness rather than
  from process spawn. The in-process subscribers keep their original timing.
  """
  @spec start_fanout(module() | nil, Options.t(), map()) :: {term(), integer()}
  def start_fanout(nil, config, _ctx) do
    {nil, System.monotonic_time(:microsecond) + config.warmup * 1_000_000}
  end

  def start_fanout(SocketSubscribers, config, ctx) do
    subscribers = SocketSubscribers.start_all(config.subscribers, ctx, socket_opts(config))
    {subscribers, subscribers.measure_start}
  end

  def start_fanout(Subscriber, config, ctx) do
    subscribers =
      Subscriber.start_all(config.subscribers, ctx,
        lean: config.subscriber_lean,
        count_only: config.subscriber_count_only
      )

    {subscribers, System.monotonic_time(:microsecond) + config.warmup * 1_000_000}
  end

  @doc """
  The options `EbbServer.Bench.SocketSubscribers` needs from a run.
  """
  @spec socket_opts(Options.t()) :: keyword()
  def socket_opts(%Options{} = config) do
    [
      port: config.port,
      processes: config.socket_processes,
      warmup: config.warmup,
      duration: config.duration
    ]
  end

  @doc """
  Cumulative deliveries for the sampler, or `nil` when the run has no
  subscribers. Dispatches on the subscriber source so the sampler keeps one
  shape for every fan-out mode.
  """
  @spec fanout_delivered(module() | nil, term()) :: non_neg_integer() | nil
  def fanout_delivered(nil, _subscribers), do: nil
  def fanout_delivered(source, subscribers), do: source.delivered(subscribers)

  @doc """
  Stops the run's subscribers and returns the fan-out summary the metrics,
  report and guardrails read.
  """
  @spec stop_fanout(module() | nil, term()) :: map() | nil
  def stop_fanout(nil, _subscribers), do: nil
  def stop_fanout(source, subscribers), do: source.stop_all(subscribers)

  defp worker(id, config, ctx, measure_start, deadline) do
    :rand.seed(:exsss, {config.seed, id, 0})
    cap = max(div(@latency_cap, config.concurrency), 1)
    stats = new_stats(cap, measure_start)
    depth = Options.depth(config)

    if depth == 1 do
      loop(id, config, ctx, measure_start, deadline, stats)
    else
      call = fn seq -> perform(config.tier, config, ctx, id, seq) end
      pipelined(depth, measure_start, deadline, stats, call, seq_step: config.batch_size)
    end
  end

  defp loop(id, config, ctx, measure_start, deadline, stats) do
    now = System.monotonic_time(:microsecond)

    if now >= deadline do
      stats
    else
      {latency, accepted, rejected, errors} = perform(config.tier, config, ctx, id, stats.seq)
      stats = record(stats, now - measure_start, latency, accepted, rejected, errors)
      stats = sample_in_flight(stats, 1, now - measure_start)
      stats = %{stats | next_due_us: pace(config, stats.next_due_us, deadline)}
      loop(id, config, ctx, measure_start, deadline, stats)
    end
  end

  @doc """
  The per-worker accumulator: counters, throughput buckets, the latency
  reservoir, the next t4 pacing slot, and the observed pipeline occupancy.
  """
  @spec new_stats(pos_integer(), integer()) :: map()
  def new_stats(cap, measure_start) do
    %{
      accepted: 0,
      rejected: 0,
      errors: 0,
      buckets: %{},
      rejected_buckets: %{},
      reservoir: Metrics.reservoir_new(cap),
      seq: 0,
      next_due_us: measure_start,
      in_flight_peak: 0,
      in_flight_sum: 0,
      in_flight_samples: 0
    }
  end

  @doc """
  Runs the pipelined worker loop for one depth.

  `depth` calls stay outstanding: each runs in its own `spawn_link`ed process
  so the harness never blocks the worker on a call, reports
  `{latency, accepted, rejected, errors}` back by message, and gets its own
  `seq` — `seq_step` apart, which keeps every call's Actions distinct. The
  link carries a call's real exit reason into the worker instead of leaving it
  to surface as a reply timeout. No new call starts after `deadline`; the
  outstanding ones are drained and every reply is recorded. A call that never
  replies raises rather than letting the run under-report, and the occupancy
  observed at each measured completion feeds the peak/mean the report prints.
  """
  @spec pipelined(
          pos_integer(),
          integer(),
          integer(),
          map(),
          (non_neg_integer() ->
             {integer(), non_neg_integer(), non_neg_integer(), non_neg_integer()}),
          keyword()
        ) :: map()
  def pipelined(depth, measure_start, deadline, stats, call, opts \\ []) do
    opts = %{
      seq_step: Keyword.get(opts, :seq_step, 1),
      reply_timeout_ms: Keyword.get(opts, :reply_timeout_ms, @reply_timeout_ms)
    }

    drain(depth, measure_start, deadline, stats, call, opts, %{})
  end

  defp drain(depth, measure_start, deadline, stats, call, opts, outstanding) do
    {stats, outstanding} = fill(depth, measure_start, deadline, stats, call, opts, outstanding)

    if map_size(outstanding) == 0 do
      stats
    else
      {stats, outstanding} = await_reply(stats, outstanding, opts.reply_timeout_ms)
      drain(depth, measure_start, deadline, stats, call, opts, outstanding)
    end
  end

  defp fill(depth, measure_start, deadline, stats, call, opts, outstanding) do
    now = System.monotonic_time(:microsecond)

    if now < deadline and map_size(outstanding) < depth do
      parent = self()
      ref = make_ref()
      seq = stats.seq

      spawn_link(fn -> send(parent, {ref, call.(seq)}) end)

      outstanding = Map.put(outstanding, ref, now - measure_start)
      stats = %{stats | seq: seq + opts.seq_step}
      fill(depth, measure_start, deadline, stats, call, opts, outstanding)
    else
      {stats, outstanding}
    end
  end

  defp await_reply(stats, outstanding, timeout) do
    receive do
      {ref, {latency, accepted, rejected, errors}} when is_map_key(outstanding, ref) ->
        observed = map_size(outstanding)
        started = Map.fetch!(outstanding, ref)
        outstanding = Map.delete(outstanding, ref)

        stats = record_completion(stats, started, latency, accepted, rejected, errors)
        {sample_in_flight(stats, observed, started), outstanding}
    after
      timeout ->
        raise "pipelined call never replied within #{timeout}ms at depth " <>
                "#{map_size(outstanding)}"
    end
  end

  # T4 is a single producer paced to a target Actions/sec: each iteration
  # waits out its slot before the next call. Whole intervals are advanced
  # until the due time is in the future so a slow iteration cannot build
  # unbounded debt, and the wait never runs past the deadline.
  defp pace(%Options{tier: :t4} = config, next_due_us, deadline) do
    interval = Options.batch_interval_us(config)

    if System.monotonic_time(:microsecond) < next_due_us do
      sleep_until(next_due_us, deadline)
    end

    advance_due(next_due_us + interval, interval, System.monotonic_time(:microsecond))
  end

  defp pace(_config, next_due_us, _deadline), do: next_due_us

  defp advance_due(due_us, _interval, now) when due_us > now, do: due_us

  defp advance_due(due_us, interval, now) when interval > 0,
    do: advance_due(due_us + interval, interval, now)

  defp advance_due(_due_us, _interval, now), do: now

  defp sleep_until(due_us, deadline) do
    wake_us = min(due_us, deadline)
    now = System.monotonic_time(:microsecond)
    if wake_us > now, do: Process.sleep(div(wake_us - now, 1000))
  end

  defp perform(tier, config, ctx, id, seq) when tier in [:t0, :t4] do
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

  # T5 spikes the NIF itself: the op list and the RocksDB batch are built
  # before the timer starts, so the sample covers `write_batch` alone. One
  # worker is one BEAM process and each owns a disjoint GSN range.
  defp perform(:t5, config, ctx, id, seq) do
    ops = WriteBatch.build_ops(config, ctx, id, seq)
    batch = WriteBatch.batch(ops)

    case WriteBatch.commit(batch, config.durability == :sync) do
      {:ok, latency} -> {latency, config.batch_size, 0, 0}
      {:error, latency, _reason} -> {latency, 0, 0, config.batch_size}
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
    record_completion(stats, offset_us, latency, accepted, rejected, errors)
  end

  defp record_completion(stats, offset_us, latency, accepted, rejected, errors) do
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

  # Sampled once per completed call, counting that call, so the report gets a
  # mean as well as a peak without sampling the loop from another process.
  # Warmup completions stay out of the occupancy mean, exactly like their
  # latency samples, so the reported mean describes the measured window.
  defp sample_in_flight(stats, _observed, offset_us) when offset_us < 0, do: stats

  defp sample_in_flight(stats, observed, _offset_us) do
    %{
      stats
      | in_flight_peak: max(stats.in_flight_peak, observed),
        in_flight_sum: stats.in_flight_sum + observed,
        in_flight_samples: stats.in_flight_samples + 1
    }
  end

  defp bump(buckets, _second, 0), do: buckets
  defp bump(buckets, second, count), do: Map.update(buckets, second, count, &(&1 + count))
end
