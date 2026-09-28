defmodule EbbServer.Sync.Supervisor do
  @moduledoc """
  Supervisor for the sync layer.

  Owns `FanOutRouter`, `GroupDynamicSupervisor`, and `SSEConnectionSupervisor`.
  Uses `one_for_one` strategy since each child is independent.
  """

  use Supervisor

  def start_link(opts) do
    Supervisor.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(_opts) do
    children = [
      EbbServer.Sync.FanOutRouter,
      EbbServer.Sync.GroupDynamicSupervisor,
      EbbServer.Sync.SSEConnectionSupervisor
    ]

    Supervisor.init(children, strategy: :one_for_one)
  end
end
