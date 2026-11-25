---
"@ebbjs/client": minor
---

Resolve the relation, existence and scope indices from journal deltas (#1005).

The three query index families now answer from `ReplicaChange.delta` instead of
falling back whenever a change does not name the component an index reads:

- **relation** — a link write or a membership change answers the targets the
  delta's `edges` part added and removed under the `(as, type)` the index name
  encodes, plus the changed row. A delta with no part for that pair moved no
  target under it, so the row alone answers.
- **existence** — a content change answers from the components it names, since
  one Action can move one component's value while another arrives; a membership
  change answers `delta.existence`, and answers nothing when the delta moved
  some other component's. Only a change carrying no delta at all falls back.
- **scope** — `delta.membership` answers the group on each side a move touched,
  the one an eviction left, and nothing for a change that moved no pair.

`null` now remains only for a change whose shape cannot say what moved: a link
write or a membership change with no delta. A delta that simply lacks the part
one resolver reads is a change that moved nothing there, and answers "nothing to
touch" — never a fallback. The failure mode is still an extra touch, never a
miss.

A read with a relationship join keeps `ebb/link` in the dispatch set. The index
keys the predicate's targets, while a join projects the source row's edges, so a
link write on that row can move the join without moving a predicate target;
narrowing that needs a keyed observation of the source row, which this change
does not add.

The relation dispatch benchmark is now a 100-change link-write batch over 1,000
subscriptions for a relationship predicate read. The component read set touches
all 1,000 subscriptions; the delta resolves the batch to 10. #961's resolver
answered `null` for a link write and would fall back to all 1,000 on the same
batch. The previous value-write batch resolved to 100 and imposed no delta work.
