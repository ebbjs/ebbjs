defmodule EbbServer.Sync.SSEConnectionSupervisor do
  @moduledoc """
  Dynamic supervisor for per-client SSE connections.

  Children are started on demand via `start_child/2`. All children use
  `restart: :temporary` so they are never automatically restarted
  (SSEConnection handles its own cleanup).
  """

  use DynamicSupervisor

  def start_link(opts) do
    DynamicSupervisor.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(_opts) do
    DynamicSupervisor.init(strategy: :one_for_one)
  end
end
