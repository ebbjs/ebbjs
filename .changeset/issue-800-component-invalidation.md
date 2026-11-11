---
"@ebbjs/client": minor
"@ebbjs/storage": minor
---

Invalidate cached query results per component instead of per row model, and stop
journalling a change's row type.

`Plan.readTypes` is removed. `Plan.readComponents` records the components a
change must touch to alter a plan's matching-id result — the fields its
predicates and ordering name, the components its existence tests name, and the
`relationship` and `entityGroup` models its edge and membership indices read. A
query that cannot name what it depends on (a full scan, or a disjunction with a
branch that only excludes) reads its model whole (`<model>/*`).
`rowReadComponentsFor(query)` carries the superset a projected-row result reads,
because a projected row keeps the whole shape plus its `groupIds`.

`ReplicaChange.type` is removed. A change names only the components it touched,
and a write that moves a row between models names each field under both
prefixes. A change that names none — a tombstone or eviction of a row that
carried no component — invalidates every whole-model read.

`QueryCache` tests a change's `components` against the entry's compiled reads,
memoised once per component set and shared by every entry that reads it. A
`title` write no longer re-runs a collection plan that reads only `status`; a
full scan still invalidates on any component of the model it scans. A
projected-row result keeps the whole shape, so it still reads its source and
joined models whole; the precision lands where a result keeps only matching ids.

`Plan.readTypes` and `ReplicaChange.type` are removed, not deprecated; use
`readComponents` and `components`. Pre-alpha, a removal lands as a minor step:
there are no major changesets until the packages are post-alpha.
