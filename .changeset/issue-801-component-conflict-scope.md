---
"@ebbjs/schema": minor
"@ebbjs/write": minor
"@ebbjs/storage": minor
"@ebbjs/client": minor
"@ebbjs/react": minor
---

Conflict scope is declared and held per component.

`conflictScope` gains the middle rung on the ladder and is read per
component rather than per model: `"field"` surfaces an overlapping map
position, `"component"` any concurrent touch of the same component, and
`"entity"` any concurrent touch of the row. A field- or component-scope
loss holds only the contested component, so a sibling component of the same
row keeps flushing; an entity-scope loss holds the whole subject. The hold
is still derived from the durable `conflicted` rows. The persisted conflict
payload changed shape, so a store from an earlier release is discarded.

`structural: true` is the exemption the system rows declare. `STRUCTURAL_MODELS`
is gone: every component of `relationship`, `entityGroup`, and `groupMember`
opts out of detection, so an offline edge, membership, or grant write
converges and is never surfaced or held. A schema-less client resolves those
static declarations without a per-client registry. The exemption is a
component flag, not a fourth scope.

`EntityDiff` now reports `component` — the full `<model>/<field>` name —
beside `path`, matching the slot vocabulary, instead of a bare field name.
`Conflict` and `ConflictEntry` carry `holds`, the positions kept off the
wire.

Ebb is pre-1.0, so the breaking API changes ship as a minor, following the
#692 precedent.
