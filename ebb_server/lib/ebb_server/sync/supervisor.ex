defmodule EbbServer.Sync.Supervisor do
  @moduledoc """
  Supervisor for the sync layer.

  `one_for_one`, except that `FanOutFrontier` must outlive a `FanOutRouter`
  restart, so it is started first and never restarted with the Router.
  """

  use Supervisor

  def start_link(opts) do
    Supervisor.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(_opts) do
    children = [
      EbbServer.Sync.FanOutFrontier,
      EbbServer.Sync.FanOutRouter,
      EbbServer.Sync.GroupDynamicSupervisor,
      EbbServer.Sync.SSEConnectionSupervisor,
      EbbServer.Sync.PresenceRateLimit.Buckets
    ]

    Supervisor.init(children, strategy: :one_for_one)
  end
end
