defmodule EbbServer.Telemetry.Sampler do
  @moduledoc """
  Periodic gauges for live-sync liveness and read-path backlog.

  Emits `ebb.watermark.lag` (max GSN − committed watermark),
  `ebb.dirty_set.size`, `ebb.fanout.active_connections`, and
  `ebb.fanout.active_groups` on an interval. The gauges are instantaneous
  values with no natural event to hang off, so they need a poller; it runs
  in its own process so the sampling reads never land on the Writer or a
  request path.

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
  @default_connection_supervisor EbbServer.Sync.SSEConnectionSupervisor
  @default_group_supervisor EbbServer.Sync.GroupDynamicSupervisor

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
        dirty_set: Keyword.get(opts, :dirty_set, DirtyTracker.dirty_set_name()),
        connection_supervisor:
          Keyword.get(opts, :connection_supervisor, @default_connection_supervisor),
        group_supervisor: Keyword.get(opts, :group_supervisor, @default_group_supervisor)
      }

      schedule(state.interval_ms)

      {:ok, state}
    else
      :ignore
    end
  end

  @impl true
  def handle_info(:sample, state) do
    sample([:watermark, :lag], fn -> watermark_measurements(state) end)
    sample([:dirty_set, :size], fn -> dirty_set_measurements(state) end)

    sample([:fanout, :active_connections], fn ->
      active_children_measurements(state.connection_supervisor)
    end)

    sample([:fanout, :active_groups], fn ->
      active_children_measurements(state.group_supervisor)
    end)

    schedule(state.interval_ms)

    {:noreply, state}
  end

  # Each gauge is read and emitted independently, so one failing source
  # skips only its own gauge for the tick and the loop keeps running.
  defp sample(event, read) do
    Telemetry.execute(event, read.(), %{})
  rescue
    error ->
      Logger.warning("#{inspect(event)} sample failed: #{inspect(error)}")
  catch
    kind, reason ->
      Logger.warning("#{inspect(event)} sample failed: #{inspect({kind, reason})}")
  end

  # The lag is the raw difference: a negative value is meaningful (the tail
  # was abandoned past the durable max) and must not be clamped away.
  defp watermark_measurements(%{rocks_name: rocks_name, watermark_tracker: watermark_tracker}) do
    lag =
      RocksDB.get_max_gsn(rocks_name) -
        WatermarkTracker.committed_watermark(watermark_tracker)

    %{lag: lag}
  end

  defp dirty_set_measurements(%{dirty_set: dirty_set}) do
    %{size: DirtyTracker.size(dirty_set)}
  end

  defp active_children_measurements(supervisor) do
    %{active: active} = DynamicSupervisor.count_children(supervisor)
    %{count: active}
  end

  defp schedule(interval_ms) do
    Process.send_after(self(), :sample, interval_ms)
  end
end
