---
"@ebbjs/core": major
"@ebbjs/schema": major
"@ebbjs/write": major
"@ebbjs/client": major
"@ebbjs/react": major
---

Absence, defaults, and null filters (breaking summary).

Absence is first-class: a field declares a read-time default with
`.default(v)`, and projection resolves `stored ?? default`. A defaulted field
reads as `T`; a field without one reads as `T | undefined`. A tombstone is
absence with an HLC, not a stored null, so no field schema admits `Null` and
`.nullable()` is gone.

`create()` may omit exactly the defaulted fields. A draft or committed update
clears a field with `unset` — `update(todo, { dueDate: unset })`, or one map key
with `{ tags: { a: unset } }` — which compiles to the existing tombstone
envelope; a literal `null` in a payload is rejected with a message naming
`unset`.

A query filter is a disjunction of groups (`where` ANDs within a group, `or`
starts a new one) and `null` means "no live value". Defaults never widen a
filter: a bare equality excludes rows nobody set, and `client.queryEntities`
emits a non-fatal warning when a filter compares a defaulted field without a
`{ field: null }` term in any group.

Wire-compatible on storage: tombstones, HLCs, the merge rule, and
`fixtures/merge_vectors.json` are unchanged. Filters gain the group shape on the
wire; `{ field: null }` now emits `IS NULL`.
