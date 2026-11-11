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

  @doc "Starts the sampler process with no delivery counter."
  @spec start() :: pid()
  def start, do: start(fn -> 0 end, System.monotonic_time(:microsecond))

  @doc """
  Starts the sampler process.

  `delivered_fn` is polled at each 1Hz sample and its value stored as
  `delivered`; the fixed-rate tier passes the cumulative subscriber
  delivery counter so `EbbServer.Bench.Metrics` can derive a delivered
  Actions/sec. Each sample carries `offset_us`, its offset from
  `measure_start`, so metrics can window to the measured period.
  """
  @spec start((-> non_neg_integer() | nil), integer()) :: pid()
  def start(delivered_fn, measure_start) when is_function(delivered_fn, 0) do
    :erlang.system_flag(:scheduler_wall_time, true)

    spawn(fn ->
      watchdog = spawn(fn -> pause_watchdog(System.monotonic_time(:microsecond), 0) end)
      loop(delivered_fn, measure_start, sched_snapshot(), cpu_snapshot(), watchdog, [])
    end)
  end

  @doc """
  Stops the sampler and returns the samples it collected, oldest first.
  """
  @spec stop(pid()) :: {[map()], non_neg_integer() | nil}
  def stop(pid) do
    ref = make_ref()
    send(pid, {:stop, self(), ref})

    receive do
      {:samples, ^ref, samples, max_pause} -> {samples, max_pause}
    after
      10_000 -> {[], nil}
    end
  end

  defp loop(delivered_fn, measure_start, previous_sched, previous_cpu, watchdog, acc) do
    receive do
      {:stop, from, ref} ->
        max_pause = stop_watchdog(watchdog)
        send(from, {:samples, ref, Enum.reverse(acc), max_pause})
    after
      @interval_ms ->
        {sample, sched, cpu} =
          take_sample(delivered_fn, measure_start, previous_sched, previous_cpu)

        loop(delivered_fn, measure_start, sched, cpu, watchdog, [sample | acc])
    end
  end

  # The hypervisor can pause a vCPU for tens of milliseconds. The pause is
  # invisible to scheduler utilization (the CPU is not running) and it lands in
  # every p95/p99 a run reports, so a 1 ms tick measures it directly.
  defp pause_watchdog(last_us, max_gap) do
    receive do
      {:stop, from, ref} -> send(from, {:max_pause, ref, max_gap})
    after
      @interval_ms ->
        now = System.monotonic_time(:microsecond)
        pause_watchdog(now, max(max_gap, now - last_us))
    end
  end

  defp stop_watchdog(nil), do: nil

  defp stop_watchdog(watchdog) do
    ref = make_ref()
    send(watchdog, {:stop, self(), ref})

    receive do
      {:max_pause, ^ref, max_pause} -> max_pause
    after
      5_000 -> nil
    end
  end

  defp take_sample(delivered_fn, measure_start, previous_sched, previous_cpu) do
    sched = sched_snapshot()
    cpu = cpu_snapshot()
    at_us = System.monotonic_time(:microsecond)

    sample = %{
      offset_us: at_us - measure_start,
      delivered: delivered_fn.(),
      watermark: WatermarkTracker.committed_watermark(),
      max_gsn: RocksDB.get_max_gsn(),
      dirty: dirty_size(),
      memory: :erlang.memory(:total),
      rss_kb: rss_kb(),
      sched_active: delta(previous_sched, sched, 0),
      sched_total: delta(previous_sched, sched, 1),
      # Host CPU accounting from /proc/stat: `steal` is CPU time the hypervisor
      # took away from this guest, `cpu_ticks` is the whole aggregate line.
      steal_ticks: max(cpu.steal - previous_cpu.steal, 0),
      cpu_ticks: max(cpu.total - previous_cpu.total, 0)
    }

    {sample, sched, cpu}
  end

  # The aggregate `cpu` line: user nice system idle iowait irq softirq steal.
  # Guest fields are excluded because they are already counted in user/nice.
  defp cpu_snapshot do
    fields =
      "/proc/stat"
      |> File.read!()
      |> String.split("\n", parts: 2)
      |> hd()
      |> String.split()
      |> Enum.drop(1)
      |> Enum.map(&String.to_integer/1)

    %{total: fields |> Enum.take(8) |> Enum.sum(), steal: Enum.at(fields, 7, 0)}
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
