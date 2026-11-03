---
"@ebbjs/schema": patch
"@ebbjs/write": patch
"@ebbjs/client": patch
---

Extract the shared write planner into `@ebbjs/schema` and `@ebbjs/write`.

`@ebbjs/schema` now owns the entity, relationship, and schema definitions, the
registry, validation, system entities, reserved names, and the
collaborative-text field type. `@ebbjs/write` owns the operation vocabulary and
the pure wire builders: create/update/delete/duplicate, membership scope and the
membership refusals, the committer, relationship and `entityGroup` Updates,
generated-part types, pointer normalization, and field projection.

`@ebbjs/client` re-exports everything it exported before, so its public API is
unchanged; the dependency direction is now `core → schema → write → client`.
Nothing on the wire or in storage changes: this is a move, and the existing
client suite is the regression gate. The functions runtime can build Updates
from `@ebbjs/write` without depending on the client.
