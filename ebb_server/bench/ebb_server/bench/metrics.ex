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
      correctness: correctness(merged, resource_samples),
      resources: resources(resource_samples),
      fanout: fanout_summary(fanout),
      server: server_summary(config.duration, telemetry),
      context: %{
        preloaded_entities: length(ctx.entities),
        distribution: config.distribution,
        seeded_actions: ctx.seeded_actions
      }
    }
  end

  @doc """
  Counts GSNs in `1..max_gsn` that have no `cf_actions` record.

  A commitment failure deliberately abandons its claimed range, so this
  should be zero on a clean run.
  """
  @spec count_gsn_holes() :: non_neg_integer()
  def count_gsn_holes do
    max_gsn = RocksDB.get_max_gsn()

    if max_gsn == 0 do
      0
    else
      present =
        RocksDB.cf_actions()
        |> RocksDB.range_iterator(
          RocksDB.encode_gsn_key(1),
          RocksDB.encode_gsn_key(max_gsn + 1)
        )
        |> Enum.count()

      max_gsn - present
    end
  end

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
      window_samples =
        samples
        |> Enum.filter(fn {offset_us, _latency} ->
          offset_us >= w.from_us and offset_us < w.to_us
        end)
        |> Enum.map(&elem(&1, 1))
        |> Enum.sort()

      %{
        window: w.name,
        count: length(window_samples),
        p50: percentile(window_samples, 50),
        p95: percentile(window_samples, 95),
        p99: percentile(window_samples, 99)
      }
    end)
  end

  defp correctness(merged, resource_samples) do
    %{
      accepted: merged.accepted,
      rejected: merged.rejected,
      errors: merged.errors,
      gsn_holes: count_gsn_holes(),
      watermark_lag_high: samples_max(resource_samples, &lag/1),
      watermark_lag_final: final_lag(resource_samples)
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

  defp fanout_summary(nil), do: nil
  defp fanout_summary([]), do: nil

  defp fanout_summary(stats) do
    lags = stats.lags |> Enum.sort()
    subscribers = stats.subscribers

    %{
      subscribers: subscribers,
      delivered_total: stats.delivered_total,
      delivered_avg: if(subscribers > 0, do: stats.delivered_total / subscribers, else: nil),
      control_total: stats.control_total,
      lag_count: length(lags),
      lag_p50: percentile(lags, 50),
      lag_p99: percentile(lags, 99)
    }
  end

  # Server-side samples come from `EbbServer.Bench.Telemetry` as
  # `%{tag => [{offset_us, duration_us}]}`. `latency/2` windows them and
  # drops warmup samples (negative offset), like the client-side worker.
  defp server_summary(duration, telemetry) do
    %{
      writer_batch: latency(duration, samples(telemetry, :writer_batch)),
      http_request: latency(duration, samples(telemetry, :http_request)),
      fanout_push: latency(duration, samples(telemetry, :fanout_push))
    }
  end

  defp samples(telemetry, tag), do: Map.get(telemetry, tag, [])
end
