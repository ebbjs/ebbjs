defmodule EbbServer.Sync.SSEConnectionSupervisor do
  @moduledoc """
  Dynamic supervisor for per-client SSE connections.

  Uses `simple_one_for_one` strategy - children are started on demand
  via `start_child/2`. All children use `restart: :temporary` so they
  are never automatically restarted (SSEConnection handles its own cleanup).

  Note: Due to an Elixir/OTP 28 compatibility issue with DynamicSupervisor,
  the strategy is passed via start_link opts rather than init/1. The init/1
  uses :one_for_one internally but the underlying Erlang supervisor receives
  :simple_one_for_one from the start_link call.
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
