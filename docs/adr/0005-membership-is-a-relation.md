# 0005 — Membership is a relation, not a component of the row

**Status:** accepted

Every projected-row query result declares `ebb/membership`, so a membership
write anywhere re-runs every result. That declaration says membership is a value
of the row being read. It is not: a membership is a row of its own, the row index
#971 already answers it in both directions, and `groupIds` is projected from that
index rather than from a component. This decision records what membership is — a
**relation** — and moves the invalidation from "a component of the source" to
"the membership rows of the rows this result projects".

## Context

The client stores one membership row per `(entity, group)` pair, carrying the
atomic `ebb/membership` value `{entity_id, group_id}`. The row index owns the
derived lookups (`RowEntry.membership`, `entityGroups`, `groupMembers`,
`membershipRows`), keeps every `ebb/*` value resident, and scope eviction keeps a
membership row with its group (#971, #978). A query row's `groupIds` is read from
that index, one lookup per projected row.

Nothing in a read consults a membership value, yet the read set says otherwise:

- `selectionReadComponents` adds `ebb/membership` to every projected-row result,
  "for the `groupIds` every query row carries";
- `compileReadComponents` turns every exact component into an observed model, so
  the same read also observes the `ebb` row set;
- `patchShapeOf` lists membership among the result's keys, so a membership write
  can never be patched;
- the entry adds nothing to the result's claims: a user-model row does not carry
  that component, so the read set buys only a wider match — for dispatch and for
  `isRelevant`.

Two change shapes reach a projected-row result. A membership row arriving or
leaving is journaled as a membership change naming the model `ebb`; a refile is a
content change naming `ebb/membership`. Either matches every projected-row result
through the observed row set or the component, re-runs it in full, and skips the
patch path. The observation is the wider half: every `ebb` row arriving or
leaving names model `ebb`, so a new `ebb/grant` row — an invite — re-runs every
projected-row result too, while a grant value edit touches none. A collection
result keeps only ids, so it declares membership only when a predicate or join
names it — the breadth belongs to projected rows.

That is the one systematic exception to #933's rule that an unselected write does
not invalidate a result, and it is wider than membership: any platform row
arriving does. No narrower key can replace it while the component dependency
stays — the component fires first and broadest. #962 can narrow the read only if
the read set stops claiming a value it never reads.

Vocabulary: _membership_ here is always the `ebb/membership` row — sync scope —
never a grant. The server keeps the two apart on purpose (`MembershipCache`: "a
grant carries permissions and is the authorization primitive; a membership
carries sync scope only") and CONTEXT.md forbids the overlap. One client surface
still says otherwise — `client.membership.create/update/delete` writes
`ebb/grant` rows (#1014) — but nothing in this decision depends on that name, and
the read path already uses the word correctly.

## Decision

1. **Membership is a relation.** The membership row is the truth, and the row
   index is the only read path to it. No read treats a membership as a component
   of the row it describes. `membership-and-links-as-components.md` already
   rejected a group set as a component of the entity, because a membership's
   visibility is owned by its group; this decision is the client-side half of
   that call.
2. **No query declares `ebb/membership` as a component.** A `where("groups", …)`
   predicate declares `scope:<groupId>` (#961) instead. A projected-row result
   and a `groups` join declare `membership:<entityId>` for each row they project
   (#1007). A `groups` join also declares `ebb/group`, because it projects group
   rows. This decision named the dispatcher's `byIndexAll` fallback — a change
   the resolver cannot describe touches every entry that declared the index — as
   the breadth the component dependency used to provide.
   [ADR 0006](0006-change-movement.md) removed that fallback instead: a change
   now states its whole movement, so the resolver always names the keys and no
   entry needs to be touched by default. The breadth is gone, not replaced; the
   differential guard in `dispatch-conservatism.test.ts` is what proves nothing
   was missed.
3. **`groupIds` stays on every replica-backed query row.** Unconditional in the
   row's shape, conditional in the dependency. It remains a projection of the
   relation, per row, as today, and not a selection: no caller opts in, and the
   public docs keep promising it. Dropping it from a read is a memory decision
   with its own measurement (see Alternatives), not part of this one.
4. **The key set belongs to the result, and there is exactly one of it.** A
   result registers `membership:<id>` for the ids it projects through
   `depend(dependencies, indices?)` (#1007). Keys come from ids only — never from
   values, rows, or a group list — so a result that holds only ids after #991
   still holds precise keys. Dispatch, `isRelevant`, and the patch gate read
   that one set; `isRelevant` must not keep a wider second test, because dispatch
   now touches fewer entries than the compiled read set matches. Removing
   `ebb/membership` from the read set without teaching `isRelevant` the new keys
   would silently skip the change, so the two move together.
5. **Resolving a membership change.** The `membership` resolver (#961) already
   answers row subscriptions keyed on the filed entity id; a query result's keys
   mean the same thing. A membership row arriving, refiling, or changing value
   answers its `entity_id`. A departure has no row left to read, so it answers
   the subject the journal delta records, and `null` when the delta cannot say —
   an extra touch of every entry that declared the index, never a miss.
   `ChangeDelta` (#1004) carries the group on both sides today but not the
   subject.
6. **A `groupIds` move is a patch, not a re-run.** A membership change that
   resolves to a row the result holds changes that row's `groupIds` and nothing
   else; the change names a membership row, not the projected row, so the row's
   place in the result is untouched. The patch path re-projects the resolved ids
   rather than `change.id`. Until then a touched result re-runs, which is correct
   but is not yet the win.
7. **The row index stays membership's source of truth.** #978's scope eviction
   keeps reading it, so a value never decides which groups a client is in and #978
   needs no revision. #991's inactive result keeps the ids it projects, so it
   keeps precise keys while it holds no rows.

## Consequences

- A membership write touches only the results that hold that entity; a write to a
  row no result projects touches none. A scoped read is touched only by its own
  groups' keys.
- A projected-row result no longer observes the `ebb` row set. Membership rows
  arriving and leaving stop reaching reads that draw no membership.
- An invite stops invalidating every projected-row result. A new `ebb/grant` row
  is a membership change naming `ebb` and rode the same observation; a grant
  value edit already touched nothing.
- A refile of one row becomes a one-row patch instead of a full re-run per
  result. The re-run path remains for departures a result cannot place.
- The dispatcher's batch cost becomes proportional to the results holding the
  changed entity rather than to the number of results. In the workspace fixture a
  row is in one visible result, so the touched count for one refile drops from
  every projected-row result to one or two.
- A `groups` join still observes the `ebb` row set, because a group row arriving
  is a membership change naming `ebb` and nothing narrower resolves it yet. A
  grant row arriving reaches such a result for the same reason. That is the
  remaining breadth: an `exists:ebb/group` key over the existence delta (#1004)
  narrows both, and it is not a reason to keep the membership component.
- The resolver reads the changed row once per change, not once per key, and it
  memoizes for the batch; a result that declares many keys costs one read, not
  one per key.
- Removing the component from the read sets removes a claim that leased nothing.
  Claims, residency, and `groupIds` semantics are unchanged.
- The benchmark must report the touched count for an unrelated membership write
  and for a refile, the same way #961 reports the relation batch. No measurement
  exists today; #962's acceptance covers it.

## Alternatives

- **Value only: keep `ebb/membership` and make `groupIds` an explicit projection
  the read opts into.** Rejected as the mechanism. It changes a documented row
  shape every consumer uses for offline permission checks, and it buys no
  narrowing: an opted-in read still has to key its projection on the rows it
  projects, so it needs #1007 and this decision's resolver anyway, while an
  opted-out read loses the capability. It survives only as a deferred memory
  option: if a large unpaged projection is measured to pay too much for one
  membership lookup per row, a read may then ask not to project `groupIds` — an
  additive decision that leaves this one intact.
- **Hybrid: project from the relation and keep the component for durability and
  backfill.** Rejected because residency is not decided by a read set. Membership
  rows are durable rows already, scope eviction keeps them with their group
  (#978), and every `ebb/*` value is always resident in the index entry, so
  nothing the component dependency preserved depends on it. Kept as a dispatch
  key it fires first and broadest and defeats the narrowing; kept only as a
  covered read it is this decision. The hybrid collapses into the relation-only
  option.
- **Key a plain read on the groups it cares about (`scope:<groupId>`).** Rejected
  as the projection key. `groupIds` is per entity, and a result holds rows from
  many groups; declaring every group a result's rows are in still misses a
  membership row arriving in a group the result has never seen. The scope key is
  right for a predicate that names a group and wrong for the projection.
- **Denormalize the group set onto the row as a component.** Rejected upstream:
  a membership's visibility is owned by its group, so a value on the entity would
  need payload-derived delivery scope. The client-side copy would need the same
  invalidation this decision declines to pay.

References: #1008, #962, #1007, #1005, #1004, #978, #991, #971, #961, #965.
See also `docs/research/membership-and-links-as-components.md`.
