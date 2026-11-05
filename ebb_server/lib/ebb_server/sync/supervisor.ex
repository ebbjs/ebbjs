defmodule EbbServer.Sync.Supervisor do
  @moduledoc """
  Supervisor for the sync layer.

  Owns `FanOutFrontier`, `FanOutRouter`, `GroupDynamicSupervisor`,
  `SSEConnectionSupervisor`, and `PresenceRateLimit.Buckets`. Uses
  `one_for_one` strategy since each child is independent — except that
  `FanOutFrontier` must outlive a `FanOutRouter` restart, so it is started
  first and never restarted with the Router. `Buckets` owns the presence
  token-bucket table; a restart empties it, which only hands every actor a
  fresh burst.
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
