defmodule EbbServer.Sync.Supervisor do
  @moduledoc """
  Supervisor for the sync layer.

  Owns `FanOutRouter`, `GroupDynamicSupervisor`, and `SSEConnectionSupervisor`.
  Uses `one_for_one` strategy since each child is independent.
  """

  use Supervisor

  alias EbbServer.Storage.{GroupCache, RelationshipCache}

  def start_link(opts) do
    Supervisor.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(_opts) do
    # Boot order: Storage.Supervisor runs first and populates the
    # per-cache `:persistent_term` entries. We read them here so the
    # FanOutRouter has the by-id table names without depending on
    # them being passed through the supervisor tree.
    relationships_by_id =
      :persistent_term.get(
        {RelationshipCache, :relationships_by_id},
        :ebb_relationships_by_id
      )

    group_members_by_id =
      :persistent_term.get(
        {GroupCache, :group_members_by_id},
        :ebb_group_members_by_id
      )

    children = [
      {EbbServer.Sync.FanOutRouter,
       relationships_by_id: relationships_by_id, group_members_by_id: group_members_by_id},
      EbbServer.Sync.GroupDynamicSupervisor,
      EbbServer.Sync.SSEConnectionSupervisor
    ]

    Supervisor.init(children, strategy: :one_for_one)
  end
end
