---
"@ebbjs/client": minor
"@ebbjs/storage": minor
---

Separate a value change from a row entering or leaving the set it is read from.

A `ReplicaChange` used to describe both with one shape, so "this row entered the
model's set" was encoded as `components: []` and a reader could not tell it apart
from a row that carried nothing. Every change now names its kind:

```ts
{ kind: "content", revision, id, deleted, components: ["note/title"] }
{ kind: "membership", revision, id, deleted, membership: "entered" | "left" | "changed-model", models }
```

A content change names the components it touched and is the only kind that does.
A membership change says what the row's place in a model's set did and names the
models instead, because a row can enter or leave carrying any component. A create
and a delete are each exactly one membership change; a component write is exactly
one content change naming that component. A write that moves a row out of the set
it was in is a membership change; a write on a row that was not observable
journals nothing. `deleted` now reports whether the row is tombstoned, so a
soft delete and a scope eviction are distinguishable without reading the row.

Installing or releasing a residency value still journals nothing and still never
advances the content revision. `unloaded` is driven from that lease loss rather
than from a journal entry: a subscription's change listener receives the
components it was holding that the replica dropped as its third argument, so a
row that leaves the replica reads as an unloaded value rather than as a change.
Query dispatch matches a content change by component as before, and a membership
change against every reader of the model it names, exact or whole — which is why
a component-scoped read is invalidated by a delete it never saw a component for.

Dispatch cost moves with it: 100 changes over 5,000 subscriptions now report
**3,810 touched** where #938 measured 2,621, at the same 280 lookups. The extra
1,189 are required, not waste. A membership change names no component, so no
read over `note` can prove it ignores a row entering or leaving `note`: every
reader of that model — whole-model and exact-component alike — has to see it.
The old 2,621 was a content-only count, because the one change kind that
described a row leaving named every component it carried and was matched as
content; the new count is the honest one for a set change. Exact readers of
other models stay untouched, which is what the same test asserts.
