---
"@ebbjs/client": minor
"@ebbjs/storage": minor
---

Component-scoped reads and observable unloads.

`client.<entity>.get(id)` is now the documented single-row read (`query()` stays
the collection read) and takes `{ components }`: a field key (`"content"`) or a
full name (`"note/content"`), resolved through the schema registry. A selection
opens only the named components that are not held, so reading one lazy log
never materializes its siblings and a provider can read an `engine` before
paying for the log. An undeclared component throws. Omitting the selection
keeps the old behaviour of opening every component the stored row carries, and
the returned row still projects every resident field.

`EntityRow.subscribe` is a breaking change: it now delivers
`EntityEvent<T> = { type: "snapshot"; row: T } | { type: "unloaded"; component?: string }`
instead of a bare snapshot. `close(component)`, the pin TTL, capacity
eviction, and a same-id row of another model each produce exactly one
`unloaded` event — per component, or without a component when the whole row
leaves the replica — so a subscriber can reload instead of silently rendering a
stale row. A soft delete stays a normal snapshot.

Forward-one accessors materialize a lazy target component through the replica's
component open. The default `pinnedCapacity` rises from 16 to 64.

The stale `version` leaf reference in `openDerivedTextDocument`'s doc comment
now names the `content` component.
