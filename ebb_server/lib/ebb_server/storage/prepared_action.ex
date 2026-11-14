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

  ## Fields

  - `id`, `actor_id`, `hlc` — Action identity, as validated.
  - `updates` — the validated Updates, in order.
  - `payload_etf` — the pre-claim ETF of the GSN-free Action payload
    (`id`, `actor_id`, `hlc`, `updates`). `subject_scopes` stay outside it
    because they are cache-dependent; the Committer frames the two at
    claim time without re-encoding the payload.
  - `subject_scopes` — `{subject_id, group_ids}` per folded subject, in
    first-appearance order. Stored as the scopes half of the `cf_actions`
    frame; it cannot be re-derived after the commit, so it doubles as the
    fan-out delivery contract. Every Update of a subject is delivered
    through that subject's entry, so a row's C components cost one list,
    not C.
  - `groups` — the distinct union of `subject_scopes`; each group is
    indexed once per Action in `cf_group_actions`.
  - `component_entity_ops` — ordered writes the Action's Updates imply for
    the derived component existence index: one put or delete per component
    Update, then one put per folded subject's model. The Writer applies them
    after the range is durable, reduced last-wins across the flush. Empty
    when the bench-only `:component_entities` (or its combined
    `:entity_index` alias) phase is ablated.
  - `affected_entities` — `{subject_id, model}` pairs to mark dirty, one per
    row. The sequencer unions them across a batch for the provisional and
    settled marks.
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
