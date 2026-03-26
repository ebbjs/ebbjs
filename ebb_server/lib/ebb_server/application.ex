defmodule EbbServer.Application do
  @moduledoc false

  use Application

  @impl true
  def start(_type, _args) do
    children = [
      # TODO: EbbServer.Storage.Supervisor
      # TODO: Plug.Cowboy HTTP server
    ]

    opts = [strategy: :one_for_one, name: EbbServer.Supervisor]
    Supervisor.start_link(children, opts)
  end
end
