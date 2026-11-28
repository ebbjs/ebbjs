---
"@ebbjs/storage": minor
---

State the whole index movement on every `ReplicaChange` (#1024).

`ReplicaChange.delta` is required and `ChangeDelta`'s three parts are required.
A change always says what it moved, and states nothing moved as an empty part
instead of omitting it, so a derived reader never has to tell "nothing moved
there" from "the journal cannot say". ADR 0006.

- `existence` — `{ added, removed }`, both `[]` when no component arrived or
  left.
- `edges` — one part per `(as, type)` whose targets moved, `[]` when none did.
- `membership` — `{ before, after }`, each a `MembershipSide` or `null`; both
  `null` when no pair moved. A value write that keeps its pair names neither
  side, so it cannot touch every scoped read.

"Nothing moved" is therefore exactly `edges: []`,
`existence: { added: [], removed: [] }`, `membership: { before: null, after:
null }` — what a value-only write carries, never the pair the row still states.
A departure still names the edges and the pair it left, which is the only place
that state survives.

The movement stays a diff of the row's canonical keys: storage names no query
index, so a derived index over the same relation needs no change here. Nothing
is persisted and no revision or transition semantics move; a journal entry grows
by three usually-empty fields.

`changeDeltaOf` returns `ChangeDelta`, never `undefined`, and `ChangeEdge` is
exported beside `ChangeDelta`. Tests that hand-build a `ReplicaChange` now
supply an empty movement, which is the point: the type stops permitting an
unstateable change.
