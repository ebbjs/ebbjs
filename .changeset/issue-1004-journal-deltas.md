---
"@ebbjs/storage": minor
---

Journal the edge, existence and group deltas a resolver needs (#1004).

A `ReplicaChange` now optionally carries `delta`, recording what the change moved
in the row index rather than only what it touched in the row. All three parts are
optional and omitted when nothing moved, so an ordinary value write carries no
delta at all:

- `edges` — live `ebb/link` target ids added and removed under each `(as, type)`,
  ascending. A tombstoned row contributes no live edge, so deleting a row removes
  all of its targets. A link write can now name the target it dropped, which the
  post-change row cannot.
- `existence` — components whose existence changed, as opposed to components
  whose value changed. Never the ephemeral Presence primitive.
- `groups` — the row's own `ebb/membership` group ids on each side: a move names
  both groups, and a row that left or was evicted names the one it left.

The delta rides every change the journal already records — content and membership
alike, through `ingest`, `optimistic`, `discard` and `evict` — because the journal
is the last place the old state is still in hand. `ChangeDelta` is exported from
`@ebbjs/storage/replica` and `@ebbjs/storage/types`. The fields are optional, so
existing change shapes and hand-built test changes still type. Nothing is
persisted: no `ReplicaRecord`, revision or membership-transition semantics move.
