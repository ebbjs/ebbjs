defmodule EbbServer.Sync.FanOutRouter do
  @moduledoc """
  Routes committed action batches to subscribed GroupServers.

  ## Stub Implementation

  Currently a no-op stub. Full implementation will:
  - Receive `{:batch_committed, from_gsn, to_gsn}` from Writer
  - Gate delivery on `WatermarkTracker.committed_watermark/0`
  - Buffer pending notifications and push contiguous GSN ranges
  - Read Actions from RocksDB via `range_iterator`
  - Determine affected Groups via `RelationshipCache.get_entity_group/1`
  - Dispatch to GroupServers via `Registry.lookup/2`
  """

  use GenServer

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(_opts) do
    {:ok, %{}}
  end

  @impl true
  def handle_info({:batch_committed, _from_gsn, _to_gsn}, state) do
    {:noreply, state}
  end
end
