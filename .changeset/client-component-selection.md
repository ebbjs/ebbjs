---
"@ebbjs/client": minor
---

Reads can select the components they project instead of reading a model whole.

`query().select({ title: true })` and `get(id, { select })` make one declaration
the projection, the lease set, and the invalidation key. A selected field is
returned, held, and watched; an unselected component write no longer invalidates
the result. System components stay planner-supplied: `groupIds` is on every
query row, a relationship predicate or join adds `ebb/link`, and a membership
predicate or the `groups` join adds `ebb/membership` — none is selectable, and
`groupIds` is structural rather than selected.

A query that projects a component the replica does not hold narrows the ids
first, then acquires the page. An unlimited projection is therefore a full read
of the type; page it with `limit`.

Breaking changes:

- `get(id, { select })` replaces the on-demand query refusal: there is no
  `OnDemandQueryError`, no `modelIsHeld`, and no whole-model read fallback. A
  query over a type with non-resident components narrows first and reads the
  page it projects.
- Joins are leased dependencies on one-shot and cached reads rather than a
  special on-demand path (`coldJoins`, `openJoinedRows`, `hasOnDemandJoin`).
- `EntityRow.subscribe` now takes a listener over `EntityEvent`
  (`snapshot` / `unloaded`) instead of a bare `EntitySnapshot`. A snapshot is
  the current projection, a tombstone included; `unloaded` names one released
  component, or omits the component when the row left the replica.
- Two selections of one query are distinct cache entries, and two selections of
  one row are distinct subscriptions: each leases what it reads, and a released
  component is reported once per reader.
