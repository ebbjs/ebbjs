defmodule EbbServer.Telemetry.Sampler do
  @moduledoc """
  Periodic gauges for live-sync liveness and read-path backlog.

  Emits `ebb.watermark.lag` (max GSN − committed watermark) and
  `ebb.dirty_set.size` on an interval. Both are instantaneous values with
  no natural event to hang off, so they need a poller; it runs in its own
  process so the sampling reads never land on the Writer or a request path.

  Each source is read and emitted independently: a failing read is logged
  and that gauge is skipped for the tick, leaving the other gauge and the
  sampling loop running.

  Disable with `enabled: false` (the default in `MIX_ENV=test`) or by
  setting `config :ebb_server, EbbServer.Telemetry.Sampler, enabled: false`.
  """

  use GenServer
  require Logger

  alias EbbServer.Storage.{DirtyTracker, RocksDB, WatermarkTracker}
  alias EbbServer.Telemetry

  @default_interval_ms 1_000
  @default_rocks_name EbbServer.Storage.RocksDB
  @default_watermark_tracker EbbServer.Storage.WatermarkTracker

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    opts = Keyword.merge(Application.get_env(:ebb_server, __MODULE__, []), opts)
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  @impl true
  def init(opts) do
    if Keyword.get(opts, :enabled, true) do
      state = %{
        interval_ms: Keyword.get(opts, :interval_ms, @default_interval_ms),
        rocks_name: Keyword.get(opts, :rocks_name, @default_rocks_name),
        watermark_tracker: Keyword.get(opts, :watermark_tracker, @default_watermark_tracker),
        dirty_set: Keyword.get(opts, :dirty_set, default_dirty_set())
      }

      schedule(state.interval_ms)

      {:ok, state}
    else
      :ignore
    end
  end

  @impl true
  def handle_info(:sample, state) do
    emit_watermark_lag(state)
    emit_dirty_set_size(state)
    schedule(state.interval_ms)

    {:noreply, state}
  end

  # The lag is the raw difference: a negative value is meaningful (the tail
  # was abandoned past the durable max) and must not be clamped away.
  defp emit_watermark_lag(%{rocks_name: rocks_name, watermark_tracker: watermark_tracker}) do
    max_gsn = RocksDB.get_max_gsn(rocks_name)
    watermark = WatermarkTracker.committed_watermark(watermark_tracker)

    Telemetry.execute([:watermark, :lag], %{lag: max_gsn - watermark}, %{})
  rescue
    error ->
      Logger.warning("watermark lag sample failed: #{inspect(error)}")
  end

  defp emit_dirty_set_size(%{dirty_set: dirty_set}) do
    Telemetry.execute([:dirty_set, :size], %{size: DirtyTracker.size(dirty_set)}, %{})
  rescue
    error ->
      Logger.warning("dirty set size sample failed: #{inspect(error)}")
  end

  defp default_dirty_set do
    :persistent_term.get({DirtyTracker, :dirty_set}, :ebb_dirty_set)
  end

  defp schedule(interval_ms) do
    Process.send_after(self(), :sample, interval_ms)
  end
end
