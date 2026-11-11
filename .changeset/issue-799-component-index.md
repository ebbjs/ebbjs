---
"@ebbjs/storage": minor
---

Add a durable component existence index and journal the components a change touched.

`ReplicaChange` now carries `components: readonly string[]` — the components the
composed-view change actually touched — so a derived reader can invalidate on what
it read rather than on the row's whole model. `EntityStore` gains
`queryByComponent(component)`, and the IndexedDB adapter stores the row's component
names behind a `multiEntry` index, which resets a database below schema version 11
rather than migrating it.

Both additions are required members, so an out-of-tree `EntityStore` implementer or
anything constructing a `ReplicaChange` must update; pre-alpha, that is recorded as
a minor step rather than a major one. No wire or stored-action shape moves. The
server-side half (`cf_component_entities`, the SQLite `entity_components` mirror) is
internal to `ebb_server` and unpublished.
