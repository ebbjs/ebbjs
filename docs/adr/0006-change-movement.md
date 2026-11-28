# 0006 — A change states the whole index movement

**Status:** accepted

Every derived index on the client reads the same journal, and the movement a
change carries is optional: a change may carry `edges`, `existence`, or
`membership`, and a resolver answers `null` when the part it needs is absent.
`null` means "the journal cannot say", and the dispatcher responds by touching
every subscription that declared the index. This decision makes the movement
complete and the resolvers total: a change always states what it moved, and a
resolver always answers a key set. The fallback and its second registration
table are deleted.

## Context

Three rounds added a part each (#1004, #1010/#1020, #1005). The result is three
optional parts whose absence has three different meanings:

- a part present and empty — nothing moved there;
- a part absent — either nothing moved there or the change predates the part;
- the whole delta absent — the journal cannot say.

The first two are indistinguishable today, and only the third is a state the
system actually needs. `ChangeDelta` is computed in `resync` and `evict`, where
the previous and next snapshots are both in hand, and every journal path goes
through one of them. Nothing in the repository constructs a change without a
delta except tests, so `null` is not a state the system needs; it is a state
the type permits.

Permitting it costs more than the type:

- `IndexResolver` returns `readonly string[] | null`, so every family carries a
  "cannot say" branch no production path can reach.
- The dispatcher keeps `byIndexAll`, a second registration of every entry under
  every index it declared, used only for that branch. Every add and remove
  writes both tables.
- The membership resolver reads the changed row back through `Replica.get`
  because a departed membership row no longer states the entity it filed. The
  delta's `before` side already states it.
- A typo'd index name is indistinguishable from "cannot say", so it silently
  widens dispatch to the full fallback. The now-closed #1006 proposed a
  development-only warning; with a complete movement it can be an error.

## Decision

1. `ReplicaChange.delta` is required and complete. Every change carries all
   three parts, empty when nothing moved. A value-only write carries an empty
   movement, never an absent one:
   - `existence` — components added and removed;
   - `edges` — one part per `(as, type)` whose targets moved, with `added` and
     `removed`;
   - `membership` — `{before, after}`, each a side or `null`; both `null` when
     no pair moved.
2. The movement is computed once, in `resync` and `evict`, from the previous and
   next snapshots. It stays a diff of the row's canonical keys, not a per-index
   format: storage names no query index.
3. `IndexResolver` answers `readonly string[]`, never `null`. A resolver may
   still answer a superset — the changed row, every touched component — where a
   covered dependency requires it. Totality is not minimality.
4. An index name with no resolver is a programming error: the dispatcher throws
   when an entry declares it (superseding #1006). The batch-level `try/catch`
   stays and still hands every entry the batch, so one bad entry cannot lose a
   batch for the rest.
5. `byIndexAll` is deleted. Each declared index has one bucket map.
6. The membership resolver stops reading the changed row. With
   `delta.membership` complete, `createIndexResolvers` no longer takes a
   `Replica`.

## Consequences

- A journal entry grows to three parts on every change, empty when nothing
  moved. A value-only write carries three empty fields instead of none. The
  parts are arrays that were usually empty already, so the growth is bounded.
- `resync` computes the same diff it already computes: no new work per write,
  one shape instead of three.
- The dispatcher loses a branch, a map, and one write per index per re-index.
  A resolved key's lookup count is unchanged; the fallback lookup disappears.
- The three query families and the membership index lose their absence
  branches. `relation-index.ts`, `exists-index.ts`, `scope-index.ts` and
  `membership-index.ts` each get smaller.
- A new derived index over an existing relation (edges, existence, membership)
  needs no storage change. A genuinely new relation still adds a part; this
  decision records that limit rather than solving it.
- #1006 is superseded: a missing resolver is an unconditional error, not a
  development-only warning. The batch guard covers a throwing resolver.
- Tests that hand-build a `ReplicaChange` without a delta must supply an empty
  movement. That is the point: the type stops permitting an unstateable change.

## What this decision does not change

- **Coverage stays.** `covered` is what lets a narrower index key replace a
  broader component key in the dispatch set (`relationCovers`, #961/#1003).
  Removing it would revert the relationship benchmark from 100 touched
  subscriptions to 1,000 on the same batch. The four-part relation proof is the
  cost of the narrowing, not a wart on it.
- **Component keys stay.** A content change to a predicate component of a row
  a result does not hold yet cannot be seen by a row watch, so the component
  key (or a value index) is the only key that can. Dispatch on held row ids
  plus structural keys is a different, unmeasured trade, not a replacement.
- **Residency policy** is #975's decision, not this one. `isAlwaysResident`'s
  `ebb/` namespace check remains a policy-in-code wart until that lands.
- **One query semantics** between the server's wire `Filter`/SQL path and the
  replica engine is a separate decision, out of scope for #965.
- **Server derived caches** are a separate concern. `apply_post_commit/2`
  feeds the grant, membership, group-apps and component indexes after the
  durable commit; a Writer-only restart in that window leaves them stale. That
  gap is #1026.

## Alternatives

- **Keep optional parts and the `null` fallback.** Rejected: it hides a missing
  key as "touch everyone", keeps a second registration table, and makes a typo
  indistinguishable from an unstateable change.
- **Journal full `before`/`after` row keys.** Rejected for size: a high-degree
  row would carry its whole edge set twice on every change. The journal carries
  the diff, which is what a reader needs.
- **Journal a generic `(index, key, added | removed)` list.** Rejected here:
  index names are a client concern, and the row index must not know the
  families. Canonical parts keep storage index-agnostic while staying complete.
- **Make existence resolution structural-only** — fire only when a component
  appears or disappears. Rejected: `exists:<component>` covers the component's
  projection as well as the predicate, so a value change to a covered component
  must still touch the read. The touched-component list is the correct key.
- **Dispatch by row identity and drop `covered`.** Rejected after review; see
  "What this decision does not change".

## Transitional, and what deletes it

| Thing                                                        | Why it exists                                                       | Deleted by                       |
| ------------------------------------------------------------ | ------------------------------------------------------------------- | -------------------------------- |
| `storeRows`, `fullyResident`                                 | A row could have values the replica did not hold                    | #981                             |
| `replica` and `storage.entities.queryBy*` both serve reads   | The per-component store and the row index are both live             | #980, #981                       |
| `isAlwaysResident`'s `ebb/` check                            | No declared residency policy yet                                    | #975                             |
| Optional delta parts, `IndexResolver`'s `null`, `byIndexAll` | This decision's starting point                                      | #1024, #1025                     |
| Server derived caches                                        | Applied after durable commit; a Writer-only restart skips the apply | #1026                            |
| `componentRowView`                                           | Platform components are atomic; the public read shape is the value  | stays — it is a view             |
| `covered`, `relationCovers`                                  | The mechanism that makes index keys narrower than component keys    | stays — removing it reverts #961 |

References: #965, #1004, #1005, #1006, #1020, #961, #1003, ADR 0002, ADR 0004.
