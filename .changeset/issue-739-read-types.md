---
"@ebbjs/schema": minor
"@ebbjs/write": minor
"@ebbjs/client": minor
"@ebbjs/react": minor
---

Read types state absence: a field with a declared default reads as `T`, a field
without one reads as `T | undefined`. `EntityDef` gains `createShape`, the
inverse relation (a defaulted field may be omitted on create, a field without
one is required), so `ShapeFields` is no longer the mirror of the validation
wrap. `where()` / `or()` accept `null` as the "no live value" predicate.
Duplicate validation and system-entity creates accept absence per field rather
than requiring a complete row.
