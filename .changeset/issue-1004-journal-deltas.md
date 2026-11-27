---
"@ebbjs/storage": minor
---

Journal the edge, existence and membership deltas a resolver needs (#1004).

A `ReplicaChange` now optionally carries `delta`, recording what the change moved
in the row index rather than only what it touched in the row. Every part is
optional and omitted when nothing moved, so an ordinary value write carries no
delta at all:

- `edges` — live `ebb/link` target ids added and removed under each `(as, type)`,
  ascending. A tombstoned row contributes no live edge, so deleting a row removes
  all of its targets. A link write can now name the target it dropped, which the
  post-change row cannot.
- `existence` — components whose existence changed, as opposed to components
  whose value changed. Never the ephemeral Presence primitive.
- `membership` — the `ebb/membership` pair the row stated on each side, as
  `MembershipSide = { entityId, groupId }` or `null` for a side that stated none:
  a move names both sides, and a row that left or was evicted names the pair it
  left. One part per side, because the value carries exactly one pair — the
  member a row-subscription resolver keys on and the group a scoped resolver
  keys on are read from the same side instead of from two parts that can drift.

The delta rides every change the journal already records — content and membership
alike, through `ingest`, `optimistic`, `discard` and `evict` — because the journal
is the last place the old state is still in hand. `ChangeDelta` and
`MembershipSide` are exported from `@ebbjs/storage/replica` and
`@ebbjs/storage/types`. The fields are optional, so existing change shapes and
hand-built test changes still type. Nothing is persisted: no `ReplicaRecord`,
revision or membership-transition semantics move.
