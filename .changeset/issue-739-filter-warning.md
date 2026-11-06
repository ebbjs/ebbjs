---
"@ebbjs/schema": minor
"@ebbjs/client": minor
---

Warn when a filter skips a defaulted field's absence.

Defaults never participate in filtering, so `{ priority: "normal" }` excludes
rows nobody set while the row renders as "normal". `EntityRegistry.filterWarnings`
returns a hint (never a thrown violation) once per defaulted field named with a
non-null value in a filter that has no `{ field: null }` term in any group.
`client.queryEntities` emits it on the existing `onRegistryViolation` channel
with `direction: "outbound"` and runs the query; fatal violations still throw
before any fetch. `[{ priority: "normal" }, { priority: null }]` is silent.
