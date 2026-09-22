defmodule EbbServer.Application do
  @moduledoc false

  use Application

  @impl true
  def start(_type, _args) do
    data_dir = runtime_data_dir()
    port = runtime_port()

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

  # Resolution order for the storage data directory:
  #   1. `Application.get_env(:ebb_server, :data_dir)` (set by `config/*.exs`)
  #   2. `EBB_DATA_DIR` environment variable (set by containerized deployments)
  #   3. `./data` (the historical default for `mix run`)
  #
  # The application env is checked first so that `MIX_ENV=test mix test`
  # honors the path declared in `config/test.exs` instead of leaking test
  # state into `./data` at the project root.
  defp runtime_data_dir do
    Application.get_env(:ebb_server, :data_dir) || System.get_env("EBB_DATA_DIR") || "./data"
  end

  @doc false
  def runtime_port do
    case {Application.get_env(:ebb_server, :port), parse_env_port()} do
      {port, _} when is_integer(port) ->
        port

      {_, port} when is_integer(port) ->
        port

      _ ->
        4000
    end
  end

  defp parse_env_port do
    case System.get_env("EBB_PORT") do
      nil ->
        nil

      raw ->
        case Integer.parse(raw) do
          {port, ""} -> port
          _ -> raise "EBB_PORT must be an integer, got #{inspect(raw)}"
        end
    end
  end
end
