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
      {EbbServer.Storage.Writer, []},
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
