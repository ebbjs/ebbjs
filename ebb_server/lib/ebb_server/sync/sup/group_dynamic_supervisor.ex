defmodule EbbServer.Sync.GroupDynamicSupervisor do
  @moduledoc """
  Dynamic supervisor for per-Group GenServers.

  Uses `one_for_one` strategy with max 100 restarts per second
  to support frequent group creation/destruction.
  GroupServers are transient and do not restart after normal shutdown.
  """

  use DynamicSupervisor

  def start_link(_opts) do
    DynamicSupervisor.start_link(__MODULE__, strategy: :one_for_one, name: __MODULE__)
  end

  @impl true
  def init(_opts) do
    DynamicSupervisor.init(strategy: :one_for_one, max_restarts: 100, max_seconds: 1)
  end
end
