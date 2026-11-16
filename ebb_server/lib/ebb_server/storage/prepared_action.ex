defmodule EbbServer.Storage.PreparedAction do
  @moduledoc """
  The immutable boundary between the Writer (sequencer) and the
  `EbbServer.Storage.Committer`.

  The sequencer owns everything that needs a live view of the system
  caches or the resolution frontier: dedup, the GSN claim, group
  resolution, the per-subject `subject_scopes` snapshot, and the provisional
  dirty marks. The GSN-free payload build and ETF encode happened in the
  `EbbServer.Storage.PreparePool` before the call entered the pipeline.
  `PreparedAction` is what is left over — the Action's durable content,
  already encoded, plus every decision the Committer and the post-commit
  apply need — so op assembly and the durable write can run in another
  process without reading any cache.
  """

  @enforce_keys [
    :id,
    :actor_id,
    :hlc,
    :updates,
    :payload_etf,
    :subject_scopes
  ]
  defstruct [
    :id,
    :actor_id,
    :hlc,
    :updates,
    :payload_etf,
    :subject_scopes,
    groups: [],
    component_entity_ops: [],
    affected_entities: []
  ]

  @type entity_mark :: {entity_id :: String.t(), model :: String.t() | nil}

  @type t :: %__MODULE__{
          id: String.t(),
          actor_id: String.t(),
          hlc: integer(),
          updates: [map()],
          payload_etf: binary(),
          subject_scopes: [EbbServer.Storage.ActionFormat.subject_scope()],
          groups: [String.t()],
          component_entity_ops: [EbbServer.Storage.ComponentEntityIndex.op()],
          affected_entities: [entity_mark()]
        }
end
