defmodule EbbServer.Application do
  @moduledoc false

  use Application

  @impl true
  def start(_type, _args) do
    data_dir = runtime_data_dir()
    port = Application.get_env(:ebb_server, :port, 4000)

    children = [
      {EbbServer.Storage.Supervisor, [data_dir: data_dir]},
      {Registry, keys: :unique, name: EbbServer.Sync.GroupRegistry},
      EbbServer.Sync.Supervisor,
      # Writer needs the WatermarkTracker's registered name so that
      # post-write WatermarkTracker.advance_watermark/1 actually fires.
      # Without it, watermark stays at 0 and SSE subscribers with cursor
      # > 0 get the stale-cursor response (and crash because the response
      # wasn't switched to chunked mode first). The Writer also needs the
      # FanOutRouter's registered name so it can notify it of each
      # committed batch; without that, SSE subscribers never see writes.
      # See docs/investigations/seed-catchup-mismatch.md for the full chain.
      {EbbServer.Storage.Writer,
       watermark_tracker: EbbServer.Storage.WatermarkTracker,
       fan_out_router: EbbServer.Sync.FanOutRouter},
      {Bandit, plug: EbbServer.Sync.Router, port: port}
    ]

    opts = [strategy: :one_for_one, name: EbbServer.Supervisor]
    Supervisor.start_link(children, opts)
  end

  defp runtime_data_dir do
    System.get_env("EBB_DATA_DIR") || "./data"
  end

  defp release? do
    Application.get_env(:elixir, :language) == :elixir
  end
end
