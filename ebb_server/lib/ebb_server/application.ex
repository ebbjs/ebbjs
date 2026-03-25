defmodule EbbServer.Application do
  # See https://hexdocs.pm/elixir/Application.html
  # for more information on OTP Applications
  @moduledoc false

  use Application

  @impl true
  def start(_type, _args) do
    children = [
      EbbServer.Storage.Supervisor,
      EbbServer.Sync.Supervisor
    ]

    # See https://hexdocs.pm/elixir/Supervisor.html
    # for other strategies and supported options
    opts = [strategy: :one_for_one, name: EbbServer.Supervisor]
    result = Supervisor.start_link(children, opts)

    port = Application.get_env(:ebb_server, :port)
    IO.puts("🔄 Sync server running on port #{port}")

    result
  end
end
