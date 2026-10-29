defmodule EbbServer.Bench.Metrics do
  @moduledoc """
  Pure aggregation for a benchmark run.

  Latency samples are kept with reservoir sampling so a long run cannot
  grow memory without bound; percentiles are nearest-rank over the
  retained sample. Throughput is bucketed per second so burst (the first
  15s) and sustained (61s+) windows can be reported separately.
  """

  alias EbbServer.Bench.Options
  alias EbbServer.Storage.RocksDB
  alias EbbServer.Telemetry

  @burst_seconds 15
  @steady_start_seconds 61
  @steady_end_seconds 120

  @type reservoir :: {pos_integer(), non_neg_integer(), non_neg_integer(), :array.array()}

  @doc "Creates an empty reservoir with the given cap."
  @spec reservoir_new(pos_integer()) :: reservoir()
  def reservoir_new(cap) when cap > 0, do: {cap, 0, 0, :array.new(cap, default: nil)}

  @doc """
  Adds one sample to the reservoir (Algorithm R).
  """
  @spec reservoir_add(reservoir(), {integer(), integer()}) :: reservoir()
  def reservoir_add({cap, seen, size, arr} = reservoir, item) do
    n = seen + 1
    j = :rand.uniform(n)

    cond do
      size < cap -> {cap, n, size + 1, :array.set(size, item, arr)}
      j <= cap -> {cap, n, size, :array.set(j - 1, item, arr)}
      true -> reservoir
    end
  end

  @doc "The retained samples."
  @spec reservoir_items(reservoir()) :: [{integer(), integer()}]
  def reservoir_items({_cap, _seen, 0, _arr}), do: []

  def reservoir_items({_cap, _seen, size, arr}) do
    Enum.map(0..(size - 1), &:array.get(&1, arr))
  end

  @doc "Nearest-rank percentile over an ascending list. `nil` for no samples."
  @spec percentile([number()], number()) :: number() | nil
  def percentile([], _p), do: nil

  def percentile(sorted, p) when is_list(sorted) do
    n = length(sorted)
    rank = max(ceil(p / 100 * n), 1)
    Enum.at(sorted, min(rank, n) - 1)
  end

  @doc """
  Per-bucket post-apply → broadcast-complete latency from
  `ebb.fanout.push_latency_ms` samples.

  The series is the load-bearing signal for the fixed-rate tier: a flat p50
  across buckets means the Router keeps up with the commit stream, a rising
  p50 means the GroupServer queue is falling behind. Buckets start at the
  measured window's zero and step by `bucket_seconds`; samples outside
  `[0, duration)` are dropped—both warmup samples, which carry a negative
  offset, and post-deadline samples, which a worker loop that overruns the
  deadline can produce.
  """
  @spec fanout_series([{integer(), integer()}], pos_integer(), pos_integer()) :: [map()]
  def fanout_series(samples, duration, bucket_seconds \\ 10)
      when duration > 0 and bucket_seconds > 0 do
    0
    |> Stream.iterate(&(&1 + bucket_seconds))
    |> Enum.take_while(&(&1 < duration))
    |> Enum.map(fn from_second -> bucket(samples, from_second, duration, bucket_seconds) end)
  end

  defp bucket(samples, from_second, duration, bucket_seconds) do
    to_second = min(from_second + bucket_seconds, duration)
    values = window_values(samples, from_second * 1_000_000, to_second * 1_000_000)

    %{
      from_second: from_second,
      count: length(values),
      p50: percentile(values, 50),
      p95: percentile(values, 95)
    }
  end

  # Samples whose offset falls in `[from_us, to_us)`, with the measured
  # value kept and sorted ascending for nearest-rank percentiles.
  defp window_values(samples, from_us, to_us) do
    samples
    |> Enum.filter(fn {offset_us, _value} -> offset_us >= from_us and offset_us < to_us end)
    |> Enum.map(&elem(&1, 1))
    |> Enum.sort()
  end

  @doc """
  Delivered Actions/sec over the measured window, for the fixed-rate tier.

  Only t4 samples deliveries, so every other tier gets `nil`. Samples are
  windowed to `[0, duration)` relative to `measure_start`—exactly like
  `latency/2`—so warmup deliveries and any post-deadline sampler ticks are
  excluded; the rate is then the delivery-counter delta over the span
  between the first and last in-window sample. Fewer than two in-window
  samples, a null delivery counter, or a non-positive span all yield `nil`
  rates.
  """
  @spec delivered_rate([map()], Options.t()) :: map() | nil
  def delivered_rate(_samples, %Options{tier: tier}) when tier != :t4, do: nil

  def delivered_rate(samples, %Options{tier: :t4} = config) do
    empty = %{delivered_per_sec: nil, delivered_per_subscriber_per_sec: nil}

    window =
      Enum.filter(samples, fn %{offset_us: offset_us} ->
        offset_us >= 0 and offset_us < config.duration * 1_000_000
      end)

    case window do
      [first, _second | _rest] ->
        last = List.last(window)
        elapsed = (last.offset_us - first.offset_us) / 1_000_000

        if is_integer(first.delivered) and is_integer(last.delivered) and elapsed > 0 do
          rate = (last.delivered - first.delivered) / elapsed

          %{
            empty
            | delivered_per_sec: rate,
              delivered_per_subscriber_per_sec:
                if(config.subscribers > 0, do: rate / config.subscribers, else: nil)
          }
        else
          empty
        end

      _ ->
        empty
    end
  end

  @doc """
  Deliveries the server enqueued per second over the measured window.

  `telemetry` is the map from `EbbServer.Bench.Telemetry.stop/1`; each
  `:fanout_dispatched` row is `{offset_us, count * subscribers}` for one
  dispatched batch. Only rows whose offset falls in `[0, duration)` are
  counted—warmup rows carry a negative offset and post-deadline rows are
  outside the window—and the sum is divided by `duration`. `nil` when no
  dispatched samples were captured at all, so an uninstrumented run reports
  the rate as not measured.
  """
  @spec dispatched_rate(map(), pos_integer()) :: float() | nil
  def dispatched_rate(telemetry, duration) when duration > 0 do
    case dispatched_total(telemetry, duration) do
      nil -> nil
      total -> total / duration
    end
  end

  @doc """
  Deliveries the server enqueued in `[0, duration)`: the same window and rows
  as `dispatched_rate/2`, un-divided. `nil` when nothing was captured.
  """
  @spec dispatched_total(map(), pos_integer()) :: non_neg_integer() | nil
  def dispatched_total(telemetry, duration) when duration > 0 do
    case Map.get(telemetry, :fanout_dispatched, []) do
      [] -> nil
      rows -> Enum.reduce(rows, 0, &add_in_window(&1, &2, duration))
    end
  end

  defp add_in_window({offset_us, value}, acc, duration)
       when offset_us >= 0 and offset_us < duration * 1_000_000,
       do: acc + value

  defp add_in_window(_row, acc, _duration), do: acc

  @doc """
  Aggregates worker stats, resource samples, and fan-out stats into the
  shape `EbbServer.Bench.Report` renders.
  """
  @spec analyze(Options.t(), map(), [map()], [map()], [map()] | nil, map()) :: map()
  def analyze(%Options{} = config, ctx, worker_stats, resource_samples, fanout, telemetry \\ %{}) do
    merged = merge_stats(worker_stats)

    %{
      tier: config.tier,
      throughput: throughput(config.duration, merged),
      latency: latency(config.duration, merged.samples),
      correctness: correctness(merged, resource_samples, config),
      resources: resources(resource_samples),
      fanout: fanout_summary(fanout),
      fanout_metrics: fanout_metrics(config, resource_samples, telemetry),
      fanout_series: fanout_series(samples(telemetry, :fanout_push), config.duration),
      server: server_summary(config.duration, telemetry),
      in_flight: in_flight(worker_stats),
      context: %{
        preloaded_entities: length(ctx.entities),
        distribution: config.distribution,
        concurrency: config.concurrency,
        seeded_actions: ctx.seeded_actions
      }
    }
  end

  @doc """
  Counts GSNs in `1..max_gsn` that have no `cf_actions` record and names
  the first one.

  A commitment failure deliberately abandons its claimed range, so a clean
  run has no holes. `first_missing` is `nil` when the log is contiguous.
  """
  @spec gsn_holes() :: %{count: non_neg_integer(), first_missing: pos_integer() | nil}
  def gsn_holes do
    max_gsn = RocksDB.get_max_gsn()
    if max_gsn == 0, do: %{count: 0, first_missing: nil}, else: scan_gsn_holes(max_gsn)
  end

  defp scan_gsn_holes(max_gsn) do
    RocksDB.cf_actions()
    |> RocksDB.range_iterator(
      RocksDB.encode_gsn_key(1),
      RocksDB.encode_gsn_key(max_gsn + 1)
    )
    |> Stream.map(fn {key, _value} -> RocksDB.decode_gsn_key(key) end)
    |> gsn_hole_stats()
  end

  @doc """
  Counts missing GSNs in `1..last_present` from present GSNs in ascending
  order, and names the first gap.
  """
  @spec gsn_hole_stats(Enumerable.t()) :: %{
          count: non_neg_integer(),
          first_missing: pos_integer() | nil
        }
  def gsn_hole_stats(gsns) do
    {count, first_missing, _next} =
      Enum.reduce(gsns, {0, nil, 1}, fn gsn, {count, first, expected} ->
        missing = max(gsn - expected, 0)
        {count + missing, first || if(missing > 0, do: expected), gsn + 1}
      end)

    %{count: count, first_missing: first_missing}
  end

  @doc """
  Counts GSNs in `1..max_gsn` that have no `cf_actions` record.
  """
  @spec count_gsn_holes() :: non_neg_integer()
  def count_gsn_holes, do: gsn_holes().count

  @doc """
  Throughput windows for a measured window of `duration` seconds.
  """
  @spec windows(pos_integer()) :: [map()]
  def windows(duration) when duration > 0 do
    [window("burst", 0, min(@burst_seconds, duration))] ++
      steady_window(duration) ++ [window("overall", 0, duration)]
  end

  defp steady_window(duration) when duration > @steady_start_seconds do
    [window("steady", @steady_start_seconds, min(@steady_end_seconds, duration))]
  end

  defp steady_window(_duration), do: []

  defp window(name, from_second, to_second) do
    %{
      name: name,
      from_second: from_second,
      to_second: to_second,
      from_us: from_second * 1_000_000,
      to_us: to_second * 1_000_000,
      seconds: to_second - from_second
    }
  end

  defp merge_stats(stats) do
    %{
      accepted: sum(stats, :accepted),
      rejected: sum(stats, :rejected),
      errors: sum(stats, :errors),
      buckets: merge_buckets(stats, :buckets),
      rejected_buckets: merge_buckets(stats, :rejected_buckets),
      samples:
        stats
        |> Enum.flat_map(&reservoir_items(&1.reservoir))
        |> Enum.sort_by(&elem(&1, 0))
    }
  end

  defp sum(stats, key), do: Enum.reduce(stats, 0, &(&2 + Map.fetch!(&1, key)))

  # Occupancy is harness-side: it counts the `write_actions/1` calls the bench
  # workers kept outstanding, not the Writer's in-flight batches (#537). One
  # sample per completed call is enough for the mean; the peak is the max of
  # the per-worker peaks.
  defp in_flight(worker_stats) do
    samples = sum(worker_stats, :in_flight_samples)
    sum = sum(worker_stats, :in_flight_sum)
    peaks = Enum.map(worker_stats, &Map.fetch!(&1, :in_flight_peak))

    %{
      peak: Enum.max(peaks, fn -> 0 end),
      mean: if(samples > 0, do: sum / samples, else: nil)
    }
  end

  defp merge_buckets(stats, key) do
    Enum.reduce(stats, %{}, fn stat, acc ->
      Enum.reduce(Map.fetch!(stat, key), acc, fn {second, count}, buckets ->
        Map.update(buckets, second, count, &(&1 + count))
      end)
    end)
  end

  defp throughput(duration, merged) do
    duration
    |> windows()
    |> Enum.map(fn w ->
      accepted = bucket_sum(merged.buckets, w)
      rejected = bucket_sum(merged.rejected_buckets, w)

      %{
        window: w.name,
        seconds: w.seconds,
        accepted: accepted,
        rejected: rejected,
        rate: rate(accepted, w.seconds)
      }
    end)
  end

  defp bucket_sum(buckets, window) do
    buckets
    |> Enum.filter(fn {second, _count} ->
      second >= window.from_second and second < window.to_second
    end)
    |> Enum.reduce(0, fn {_second, count}, acc -> acc + count end)
  end

  defp rate(_count, 0), do: 0.0
  defp rate(count, seconds), do: count / seconds

  defp latency(duration, samples) do
    duration
    |> windows()
    |> Enum.map(fn w ->
      window_samples = window_values(samples, w.from_us, w.to_us)

      %{
        window: w.name,
        count: length(window_samples),
        p50: percentile(window_samples, 50),
        p95: percentile(window_samples, 95),
        p99: percentile(window_samples, 99)
      }
    end)
  end

  # The watermark frontier is what makes GSN density and lag meaningful. With
  # `:watermark` ablated the frontier never moves, and the t5 spike writes at a
  # synthetic GSN base without ever advancing it, so both are deliberately left
  # unmeasured instead of reporting a number that describes nothing.
  defp correctness(merged, resource_samples, config) do
    frontier? = Options.measures_frontier?(config)
    density? = Options.measures_gsn_density?(config)
    holes = if density?, do: gsn_holes(), else: nil

    %{
      accepted: merged.accepted,
      rejected: merged.rejected,
      errors: merged.errors,
      gsn_holes: holes && holes.count,
      gsn_first_hole: holes && holes.first_missing,
      watermark_lag_high: if(frontier?, do: samples_max(resource_samples, &lag/1), else: nil),
      watermark_lag_final: if(frontier?, do: final_lag(resource_samples), else: nil)
    }
  end

  defp resources([]) do
    %{
      sample_count: 0,
      peak_rss_kb: nil,
      peak_memory_bytes: nil,
      peak_dirty: nil,
      scheduler_utilization: nil
    }
  end

  defp resources(samples) do
    %{
      sample_count: length(samples),
      peak_rss_kb: samples_max(samples, & &1.rss_kb),
      peak_memory_bytes: samples_max(samples, & &1.memory),
      peak_dirty: samples_max(samples, & &1.dirty),
      scheduler_utilization: utilization(samples)
    }
  end

  defp lag(sample), do: sample.max_gsn - sample.watermark

  defp final_lag([]), do: nil
  defp final_lag(samples), do: samples |> List.last() |> lag()

  defp samples_max(samples, fun) do
    samples
    |> Enum.map(fun)
    |> Enum.reject(&is_nil/1)
    |> case do
      [] -> nil
      values -> Enum.max(values)
    end
  end

  defp utilization(samples) do
    active = Enum.reduce(samples, 0, &(&2 + (&1.sched_active || 0)))
    total = Enum.reduce(samples, 0, &(&2 + (&1.sched_total || 0)))
    if total > 0, do: active / total, else: nil
  end

  # The fixed-rate fan-out metrics pair the delivered rate (measured by the
  # subscriber sampler) with the dispatched rate (measured server-side), so a
  # report can tell a server-side limit from a subscriber-side one.
  defp fanout_metrics(config, resource_samples, telemetry) do
    case delivered_rate(resource_samples, config) do
      nil ->
        nil

      delivered ->
        Map.put(delivered, :dispatched_per_sec, dispatched_rate(telemetry, config.duration))
    end
  end

  defp fanout_summary(nil), do: nil
  defp fanout_summary([]), do: nil

  # A socket run reports the client's own view of the stream, so the summary
  # carries it whole under `:socket` (see
  # `EbbServer.Bench.SocketSubscribers.stop_all/1`) and the common rows are
  # projected from the same numbers.
  defp fanout_summary(%{processes: processes} = stats) when is_integer(processes) do
    %{
      subscribers: stats.subscribers,
      delivered_total: stats.delivered_total,
      delivered_avg: avg_delivered(stats.delivered_total, stats.subscribers),
      control_total: stats.control_total,
      lag_count: stats.lag_samples,
      lag_p50: stats.lag_p50,
      lag_p99: stats.lag_p99,
      socket: stats
    }
  end

  defp fanout_summary(stats) do
    lags = stats.lags |> Enum.sort()
    subscribers = stats.subscribers

    %{
      subscribers: subscribers,
      delivered_total: stats.delivered_total,
      delivered_avg: avg_delivered(stats.delivered_total, subscribers),
      control_total: stats.control_total,
      lag_count: length(lags),
      lag_p50: percentile(lags, 50),
      lag_p99: percentile(lags, 99),
      socket: nil
    }
  end

  defp avg_delivered(_delivered, 0), do: nil
  defp avg_delivered(delivered, subscribers), do: delivered / subscribers

  # Server-side samples come from `EbbServer.Bench.Telemetry` as
  # `%{tag => [{offset_us, duration_us}]}`. `latency/2` windows them and
  # drops warmup samples (negative offset), like the client-side worker. The
  # flush phases come from `ebb.writer.flush_phase_ms`, one tagged series per
  # phase plus the per-range accounting total; the fan-out hops come from
  # `ebb.fanout.hop_ms`, one tagged series per hop; the gauges are the
  # Writer's claim/release snapshots, not harness occupancy.
  defp server_summary(duration, telemetry) do
    %{
      writer_batch: latency(duration, samples(telemetry, :writer_batch)),
      writer_commit: latency(duration, samples(telemetry, :writer_commit)),
      http_request: latency(duration, samples(telemetry, :http_request)),
      fanout_push: latency(duration, samples(telemetry, :fanout_push)),
      fanout_hops: fanout_hops(duration, telemetry),
      flush_phases: flush_phases(duration, telemetry),
      flush_total: latency(duration, samples(telemetry, :writer_flush_total)),
      queue_depth: gauge(duration, samples(telemetry, :writer_queue_depth)),
      in_flight_batches: gauge(duration, samples(telemetry, :writer_in_flight)),
      oldest_unreleased_gsn: gauge(duration, samples(telemetry, :writer_oldest_unreleased_gsn))
    }
  end

  defp flush_phases(duration, telemetry) do
    Map.new(Telemetry.writer_flush_phases(), fn phase ->
      {phase, latency(duration, samples(telemetry, {:writer_flush_phase, phase}))}
    end)
  end

  # Every hop in the contract gets windows, empty when the run never reached
  # it: a dropped hop would read as "not part of the pipeline" instead of
  # "not measured here". `router_dwell` is emitted only when a range actually
  # waits, so an empty series is a legitimate zero.
  defp fanout_hops(duration, telemetry) do
    Map.new(Telemetry.fanout_hops(), fn hop ->
      {hop, latency(duration, samples(telemetry, {:fanout_hop, hop}))}
    end)
  end

  # A gauge series is a level, not a duration: the same measured window as
  # `latency/2`, reported as the sample count, mean level, and peak level.
  # `window_values/3` sorts, but `Enum.max` states the peak's intent.
  defp gauge(duration, samples) do
    values = window_values(samples, 0, duration * 1_000_000)

    %{
      count: length(values),
      mean: if(values == [], do: nil, else: Enum.sum(values) / length(values)),
      peak: if(values == [], do: nil, else: Enum.max(values))
    }
  end

  defp samples(telemetry, tag), do: Map.get(telemetry, tag, [])
end
