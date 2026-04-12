defmodule EbbServer.Application do
  @moduledoc false

  use Application

  @impl true
  def start(_type, _args) do
    port = Application.get_env(:ebb_server, :port, 4000)

    children = [
      EbbServer.Storage.Supervisor,
      {Registry, keys: :unique, name: EbbServer.Sync.GroupRegistry},
      EbbServer.Sync.Supervisor,
      {Bandit, plug: EbbServer.Sync.Router, port: port}
    ]

    opts = [strategy: :one_for_one, name: EbbServer.Supervisor]
    Supervisor.start_link(children, opts)
  end
end
