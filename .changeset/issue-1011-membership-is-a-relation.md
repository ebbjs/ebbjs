---
"@ebbjs/client": minor
---

Key a projected row's `groupIds` on the result's own rows (#1011).

Membership is a relation, not a value of the row it describes, so no query read
names `ebb/membership` any more. A projected-row result declares
`membership:<entityId>` for each row it projects — derived from the ids alone,
never from a value or a group list — through the `depend(dependencies, indices?)`
seam #1007 added. A membership write now touches only the results holding that
entity, a write to an entity no result projects touches none, and an invite (a
new `ebb/grant` row) reaches no projected read. A `where("groups", …)` predicate
keeps `scope:<groupId>` as its only membership dependency.

`groupIds` is unchanged: still on every replica-backed query row, still
projected per row from the row index with one lookup each, and still not a
selection a caller opts into. Only the dependency moved.

A refile re-runs the result it touches rather than patching it; patching a
`groupIds` move in place is not part of this change, so those results re-run.

`StructuralReads` gains a `recheck` field: the declared index keys no component
in a read set re-checks, which a retained result must consult before trusting
the result it holds. Today that is a membership predicate's `scope` key. Dispatch
lookup counts are unchanged; the touched counts are smaller.
