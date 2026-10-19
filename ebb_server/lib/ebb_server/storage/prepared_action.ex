defmodule EbbServer.Storage.PreparedAction do
  @moduledoc """
  The immutable boundary between the Writer (sequencer) and the
  `EbbServer.Storage.Committer`.

  The sequencer owns everything that needs a live view of the system
  caches or the resolution frontier: dedup, the GSN claim, group
  resolution, the per-Update `update_scopes` snapshot, and the provisional
  dirty marks. `PreparedAction` is what is left over — the Action's
  durable content plus every cache-derived decision the Committer needs —
  so op assembly and the durable write can run in another process without
  reading any cache.

  ## Fields

  - `id`, `actor_id`, `hlc` — Action identity, as validated.
  - `updates` — the validated Updates, in order.
  - `intra_action_context` — `entity_id => [group_id]` for membership
    rows created in the same Action, the input to group resolution.
  - `update_scopes` — group ids per Update, index-aligned with `updates`.
    Persisted as `"update_scopes"`; it cannot be re-derived after the
    commit, so it doubles as the fan-out delivery contract.
  - `groups` — the union of `update_scopes`; each group is indexed once
    per Action in `cf_group_actions`.
  - `type_entity_keys` — `cf_type_entities` keys for the Action's
    Updates, empty when the bench-only `:entity_index` phase is ablated.
  - `affected_entities` — `{subject_id, subject_type}` pairs to mark
    dirty, deduplicated within the Action. The sequencer unions them
    across a batch for the provisional and settled marks.
  """

  @enforce_keys [:id, :actor_id, :hlc, :updates, :intra_action_context, :update_scopes]
  defstruct [
    :id,
    :actor_id,
    :hlc,
    :updates,
    :intra_action_context,
    :update_scopes,
    groups: [],
    type_entity_keys: [],
    affected_entities: []
  ]

  @type entity_mark :: {entity_id :: String.t(), subject_type :: String.t()}

  @type t :: %__MODULE__{
          id: String.t(),
          actor_id: String.t(),
          hlc: integer(),
          updates: [map()],
          intra_action_context: %{optional(String.t()) => [String.t()]},
          update_scopes: [[String.t()]],
          groups: [String.t()],
          type_entity_keys: [binary()],
          affected_entities: [entity_mark()]
        }
end
