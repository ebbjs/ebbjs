defmodule EbbServer.Storage.PreparedAction do
  @moduledoc """
  The immutable boundary between the Writer (sequencer) and the
  `EbbServer.Storage.Committer`.

  The sequencer owns everything that needs a live view of the system
  caches or the resolution frontier: dedup, pre-claim payload build and
  ETF encode, the GSN claim, group resolution, the per-Update
  `update_scopes` snapshot, and the provisional dirty marks.
  `PreparedAction` is what is left over — the Action's durable content,
  already encoded, plus every cache-derived decision the Committer needs —
  so op assembly and the durable write can run in another process without
  reading any cache.

  ## Fields

  - `id`, `actor_id`, `hlc` — Action identity, as validated.
  - `updates` — the validated Updates, in order.
  - `payload_etf` — the pre-claim ETF of the GSN-free Action payload
    (`id`, `actor_id`, `hlc`, `updates`). `update_scopes` stay outside it
    because they are cache-dependent; the Committer wraps the two at
    claim time without re-encoding the payload.
  - `update_scopes` — group ids per Update, index-aligned with `updates`.
    Stored as the outer scopes of the `cf_actions` wrapper; it cannot be
    re-derived after the commit, so it doubles as the fan-out delivery
    contract.
  - `groups` — the union of `update_scopes`; each group is indexed once
    per Action in `cf_group_actions`.
  - `type_entity_keys` — `cf_type_entities` keys for the Action's
    Updates, empty when the bench-only `:entity_index` phase is ablated.
  - `affected_entities` — `{subject_id, subject_type}` pairs to mark
    dirty, deduplicated within the Action. The sequencer unions them
    across a batch for the provisional and settled marks.
  """

  @enforce_keys [
    :id,
    :actor_id,
    :hlc,
    :updates,
    :payload_etf,
    :update_scopes
  ]
  defstruct [
    :id,
    :actor_id,
    :hlc,
    :updates,
    :payload_etf,
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
          payload_etf: binary(),
          update_scopes: [[String.t()]],
          groups: [String.t()],
          type_entity_keys: [binary()],
          affected_entities: [entity_mark()]
        }
end
