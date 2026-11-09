---
"@ebbjs/schema": minor
"@ebbjs/write": minor
"@ebbjs/client": minor
---

Target containment is a declared relationship property.

`defineRelationship({ ..., contained: true })` marks the target as part of the
source's access scope. A membership change on the source then carries the target
into the same groups, in the same Action: the target gets the added
`entityGroup` rows, its edge is re-emitted under the new scope, and its
memberships are deleted alongside the source's. The walk is one hop; there is no
transitivity.

Containment is not link visibility. A relationship's own delivery scope follows
its source but is frozen when the relationship is written, so moving an entity
between groups leaves a non-contained link behind (#789). This change only
re-emits the link for a contained target.

This replaces the derived-body-only "generated parts" path with a generic one:

- `GeneratedParts`, `GeneratedDocument`, `GeneratedEdge`, `GeneratedMembership`,
  and `NO_GENERATED_PARTS` are gone from `@ebbjs/write`. `CascadeParts`,
  `CascadeTarget`, `CascadeEdge`, `CascadeMembership`, and `NO_CASCADE` replace
  them.
- `@ebbjs/client`'s `readGeneratedParts` becomes `readCascadeParts`, and the
  draft capability is `cascadeParts`.
- `RelationshipDef` gains `contained: boolean`; `defineRelationship` defaults it
  to `false`.
- A derived collaborative-text body keeps working through the same mechanism:
  its generated relationship now declares `contained: true`. #776 will delete
  that expansion and the mechanism stays.

A one-cardinality contained link is resolved or minted in the draft planner, so
the same batch's membership change re-emits it after the group puts and the
server scopes it to the new group. That also means an `unlink` or re-point in
the same batch is not undone: the stored edge is filtered out of the cascade
before it can be re-emitted.

Remaining limitation: a **many-cardinality** contained link, or a contained
pointer set at `create` time, mints its edge ids inside the write and cannot be
re-emitted by the same batch's membership change. Its memberships are still
correct; the edge itself is scoped to the source's groups at that moment. Pass
the final groups to `create`/`setLinks`, or make the group change a separate
call.
