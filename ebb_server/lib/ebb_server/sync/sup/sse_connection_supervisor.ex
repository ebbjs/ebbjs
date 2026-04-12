defmodule EbbServer.Sync.SSEConnectionSupervisor do
  @moduledoc """
  Dynamic supervisor for per-client SSE connections.

  Children are started on demand via `start_child/3`. All children use
  `restart: :temporary` so they are never automatically restarted
  (SSEConnection handles its own cleanup on client disconnect).
  """

  use DynamicSupervisor

  def start_link(opts) do
    DynamicSupervisor.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(_opts) do
    DynamicSupervisor.init(strategy: :one_for_one, max_restarts: 100, max_seconds: 1)
  end

  @spec start_child(Plug.Conn.t(), [String.t()], %{String.t() => non_neg_integer()}) ::
          {:ok, pid()} | {:error, term()}
  def start_child(conn, group_ids, cursors) do
    spec = %{
      id: SSEConnection,
      start: {SSEConnection, :start_link, [conn, group_ids, cursors]},
      restart: :temporary
    }

    DynamicSupervisor.start_child(__MODULE__, spec)
  end
end
