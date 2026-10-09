defmodule EbbServer.Bench.Sampler do
  @moduledoc """
  Low-rate resource and correctness sampler.

  Runs in its own process at ~1Hz so the sampling itself never lands on a
  worker's hot path. Scheduler utilization is derived from the delta
  between consecutive `:erlang.statistics(:scheduler_wall_time)`
  snapshots, not from an instantaneous reading.
  """

  alias EbbServer.Storage.{RocksDB, WatermarkTracker}

  @interval_ms 1_000
  @dirty_set :ebb_dirty_set

  @doc "Starts the sampler process."
  @spec start() :: pid()
  def start do
    :erlang.system_flag(:scheduler_wall_time, true)
    spawn(fn -> loop(sched_snapshot(), []) end)
  end

  @doc """
  Stops the sampler and returns the samples it collected, oldest first.
  """
  @spec stop(pid()) :: [map()]
  def stop(pid) do
    ref = make_ref()
    send(pid, {:stop, self(), ref})

    receive do
      {:samples, ^ref, samples} -> samples
    after
      10_000 -> []
    end
  end

  defp loop(previous_sched, acc) do
    receive do
      {:stop, from, ref} ->
        send(from, {:samples, ref, Enum.reverse(acc)})
    after
      @interval_ms ->
        {sample, sched} = take_sample(previous_sched)
        loop(sched, [sample | acc])
    end
  end

  defp take_sample(previous_sched) do
    sched = sched_snapshot()

    sample = %{
      watermark: WatermarkTracker.committed_watermark(),
      max_gsn: RocksDB.get_max_gsn(),
      dirty: dirty_size(),
      memory: :erlang.memory(:total),
      rss_kb: rss_kb(),
      sched_active: delta(previous_sched, sched, 0),
      sched_total: delta(previous_sched, sched, 1)
    }

    {sample, sched}
  end

  defp sched_snapshot do
    :erlang.statistics(:scheduler_wall_time)
    |> Map.new(fn {id, active, total} -> {id, {active, total}} end)
  end

  defp delta(previous, current, index) do
    Enum.reduce(current, 0, fn {id, values}, acc ->
      case Map.get(previous, id) do
        nil -> acc
        prev -> acc + (elem(values, index) - elem(prev, index))
      end
    end)
  end

  defp dirty_size do
    case :ets.info(@dirty_set, :size) do
      :undefined -> nil
      size -> size
    end
  end

  defp rss_kb do
    case File.read("/proc/self/status") do
      {:ok, content} ->
        case Regex.run(~r/^VmRSS:\s+(\d+)\s+kB/m, content) do
          [_, kb] -> String.to_integer(kb)
          _ -> nil
        end

      _ ->
        nil
    end
  end
end
