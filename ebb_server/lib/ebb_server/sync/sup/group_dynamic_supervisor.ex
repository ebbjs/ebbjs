defmodule EbbServer.Sync.GroupDynamicSupervisor do
  @moduledoc """
  Dynamic supervisor for per-Group GenServers.
  """

  use DynamicSupervisor

  def start_link(_opts) do
    DynamicSupervisor.start_link(__MODULE__, [], name: __MODULE__)
  end

  @impl true
  def init(_opts) do
    DynamicSupervisor.init(strategy: :one_for_one, max_restarts: 100, max_seconds: 1)
  end
end
