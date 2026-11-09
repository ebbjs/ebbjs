# Membership and links as components on the entity

Design investigation. No code changed. The question: **should membership, links, and group
membership stop being their own rows and become components on the entities they describe?**

This is not a new question — #790 is mid-design on exactly it, and has already decided the part
that turns out to be decisive (§1). Slice 12 of [#793](https://github.com/ebbjs/ebbjs/issues/793)
deliberately does _not_ do this; this note is what would have to be true to change that.

Evidence labels: **[source]** = `file:line` or a quoted design decision; **[derived]** = arithmetic
or inference over sourced facts; **[judgment]** = mine, and contestable; **[open]** = not
established, with what would settle it.

---

## TL;DR

- **Links should become components of their source. Membership should not. `groupMember` is a
  maybe.** The reason is one property, and it is not performance.
- **The deciding property is who owns the relation's visibility.** #790 already decided links are
  _source-owned_ — "a link is visible wherever its source is, and nowhere else" **[source]**. A
  component of the source is the representation that makes that decision structural instead of
  something the fan-out and membership code must uphold. Membership is the mirror image: a
  membership is an attribute of the _group's_ member list, and its delivery scope is the group.
- **Membership-as-component does not delete an index.** Group → entities is unbounded and has to be
  paginated, so the index survives whatever the truth is stored as. You would pay
  payload-derived delivery scope for a row you still have to index.
- **Links-as-component deletes three real things**: duplicate edges become unrepresentable, a missed
  link arrives with its source (backfill today only fetches `entityGroup`-referenced ids
  **[source]**), and five eviction branches in `scope-eviction.ts` collapse.
- **It also kills #789's whole bug class** — but it makes #790's `contained: true` a resolution-time
  rule instead of a stored one, which costs a hop.
- **Client memory is the one place with a large number attached**, and it is relationship-heavy
  fixture arithmetic, not a measurement. Re-run
  `packages/client/src/benchmark/replica-read-model.ts` before believing it.

---

## 1. The three candidates, and why one is already decided

| Candidate         | Today                                        | As a component                                                             |
| ----------------- | -------------------------------------------- | -------------------------------------------------------------------------- |
| `ebb/link`        | a row: `{source_id, target_id, type, field}` | a keyspace on the **source**: `ebb/link: { <field>: { <targetId>: {} } }`  |
| `ebb/membership`  | a row: `{entity_id, group_id}`               | a keyspace on the **entity**: `ebb/membership: { <groupId>: {} }`          |
| `ebb/groupMember` | a row: `{group_id, actor_id, permissions}`   | a keyspace on the **group**: `ebb/groupMember: { <actorId>: permissions }` |

The rule that separates them is **which end owns the relation's visibility**, because that is what
the delivery scope is computed from:

- A link is an attribute of its source. #790 decided it is visible wherever its source is, and
  nowhere else. If the link is a component of the source, its scope _is_ the source's scope, by
  construction, with no code to get wrong.
- A membership is an attribute of the group. "You were added to G" must reach G. If the membership
  is a component of the entity, the update is addressed to the entity, whose scope after the write
  no longer includes G — so the scope must be assembled from the payload (old ∪ new groups) rather
  than read off the subject. `update_scopes` is stored **one list per Update** at commit time
  **[source]** (`action_scope.ex:5-7`), so this is not a small change: it makes the scope of a write
  depend on keys inside the write.
- A `groupMember` row is also an attribute of the group, which favours the component — but it is the
  authorization primitive (it carries `permissions`), so it has the largest blast radius and the
  least to gain.

**[judgment] Model the relation on the end that owns its visibility.** That single rule gives the
verdict for all three without appealing to performance.

---

## 1.5 The link row is a denormalized index, and #789 is the denormalization bug

This is the strongest form of the argument, and it only became visible after #790's decisions were
written down.

A link's delivery scope is, by #790's decision 1, **always** a function of its endpoints: the
source's groups, unioned with the target's when `contained: true`. #790 rejected intersection-owned
visibility on the grounds that it "changes the meaning of the primitive rather than fixing its
bookkeeping" **[source]**. So there is no case where a link's scope is independent of the two rows
it joins.

Which means every `entityGroup` row a link owns is **a cached value of a function of two other
rows**. And the cache has to be maintained: when the source moves, re-derive; when the target moves,
re-derive. #790 says the mechanism for this — `changeGroups` re-emitting the edge (#777) — "is
deleted: membership rows replace it" **[source]**. So the repository has already built one
maintenance mechanism for this denormalization and then deleted it in favour of another.

**#789 is not a bug in the mechanism; it is the denormalization.** "A relationship's group scope is
frozen at write time" is what a cached derivation does when its input changes and nobody
invalidates.

The component representation stores the function's **input** — the link, on its source — and lets
the scope be read off the source at commit time, where `update_scopes` freezes it correctly for that
Action. Everything that motivated the rows then falls out:

| What the row bought                         | Under components                                                                                                                   |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| A delivery subject with its own scope       | The update is addressed to the source, so the scope _is_ the source's. Free, and correct after a move, a bootstrap, or a backfill. |
| An id to `unlink` by                        | The map key. Simpler — no minted id, no `entityGroupId(relId, groupId)` arithmetic.                                                |
| "When did this link appear?"                | The leaf's HLC. `created_hlc` per edge is lost, the timestamp is not.                                                              |
| An ordered structure for incoming traversal | **Survives, and must.** See §2.                                                                                                    |

**The honest trade, stated once:** the row is currently both the truth _and_ the reverse index. Under
components the truth moves to the source and the reverse index becomes a _pure_ index. That is
strictly better, because a pure index can be rebuilt from truth, whereas a row acting as an index
cannot be rebuilt without replaying history — and when it goes stale, it is a permission scope bug,
not a slow query.

**[judgment] The reverse index does not disappear on the server.** `cf_component_entities (ebb/link,
sourceId)` tells you which sources carry any link; it cannot answer "who points at T" without
reading them all. So the server needs `cf_link_targets (type, target_id) -> source ids`. The
information is not deleted, it is moved from a row to an index — which is the whole point. The client
already works this way: `ReverseIndex` is derived from materialized rows on every `resync`.

## 2. What the current representation actually costs

### Caches

Five cache modules own ten ETS tables, all hand-enumerated in `CacheTables` **[source]**:

| Module              | Tables                                                           |
| ------------------- | ---------------------------------------------------------------- |
| `EntityGroupCache`  | `entity_groups` (`:bag`), `_by_id`, `_by_group` (`:ordered_set`) |
| `RelationshipCache` | three, mirroring the above                                       |
| `GroupCache`        | `group_members` by group, by id                                  |
| `GroupAppsCache`    | one                                                              |
| `EntityTypeCache`   | one                                                              |

`EntityGroupCache`'s own moduledoc explains the third table: an `:ordered_set` of
`{{group_id, entity_id}}` exists "so a membership write is O(log N) rather than the O(group size) a
`:bag` look-up costs" **[source]**. That is a hand-built ordered index inside an ETS table — which
is to say the _index_ is the hard part, not the row.

### Index and pagination

`docs/research/476-group-scoped-listing.md` found that **no index serves group → entities**, and
that the set of rows a group owns is wider than `entityGroup` because `group` and `groupMember` rows
carry no membership row of their own **[source]**. The shipped listing is keyset pagination over
`idx_entities_entity_group_page` and `idx_entities_group_member`, with a `MATERIALIZED` CTE and index
hints whose comments explain why a `LIMIT` re-cut would drop the page's own tail **[source]**
(`sqlite.ex:160-195`).

**[derived] That machinery is independent of the representation.** Whatever a membership is stored
as, "page the entities in group G, ordered, resumable" needs an ordered structure keyed by
`(group, entity)`. Turning the membership into a JSON key set does not remove the index; it removes
the _row_ and keeps the index, so the truth and the index diverge and you need the cache to bridge
them — which is what the cache already is.

### Client-side duplication

The replica's `ReverseIndex` keys **on the row, not the edge**: `IndexRows = Record<rowId,
yieldedId>`, and its moduledoc says why — "two rows may share a natural key (same source, field,
type, target), and dropping one must not erase a source the other still supplies" **[source]**
(`reverse-index.ts:26-28`).

**[judgment] That sentence is a defect description.** Duplicate edges are representable today, and
three layers of code exist to tolerate them. A keyspace component makes the key the identity, so
duplicates are unrepresentable and that whole class of reasoning goes away.

---

## 3. The client case, with numbers

`docs/research/503-replica-read-model.md` measures a 10,000-document workspace at **41.0 MB**: 29.4
MB of row objects and 11.7 MB of replica structures, of which **9.9 MB is the adjacency indices**
**[measured]**.

The fixture is deliberately relationship-heavy: 10,000 `page`, **29,999 `relationship`**, and 10,001
`entityGroup`/`group` rows **[measured]**.

If links become components of the source:

- **The ~30,000 relationship rows stop existing** as rows. At ~588 bytes per row (29.4 MB ÷ ~50,000
  rows **[derived]**), that is on the order of 17 MB — **but relationship rows are shorter than
  page rows**, so the true figure is lower **[derived, uncertain]**.
- **The forward half of the adjacency index stops being needed.** Forward traversal becomes a field
  read. The reverse half survives, and gets _smaller_: without the `rowId → yieldedId` layer it is
  keyed directly on `(field, type, target)` → source ids, so roughly half the entries and one less
  indirection **[derived]**.
- **`scope-eviction.ts` loses a branch.** It currently documents five: "Group rows, group-member
  rows, and membership rows follow their own `group_id`; content rows follow their live
  `entityGroup` memberships; a relationship row follows an evicted endpoint" **[source]**. Links
  travel with their source, so the last branch disappears.
- **Backfill gets a new capability, not just a speedup.** `backfill.ts`'s visible set is "the entity
  ids its `entityGroup` rows name" **[source]**, and #476 confirms #475 "only ever fetches
  `entityGroup`-referenced ids" **[source]**. **Today a client that misses a link never backfills
  it.** If the link lives on the source, the missed link arrives with the source and the gap closes
  by construction. That is the strongest argument in this note, and it is correctness, not speed.

**[judgment] Do not quote the 17 MB.** The fixture's ratio does not generalise, and part of those
edges (#775's document bodies) disappear under the redirect anyway. The honest claim is "the row
objects are dominated by edges in the only fixture we have", and the harness to settle it already
exists.

## 4. The server case

Three effects, in descending confidence.

**Strong — #789's bug class disappears.** #789 is "a relationship's group scope is frozen at write
time", and #790 diagnoses the cause: the link has no `entityGroup` rows, so its scope is derived
from `source_id` at write time and cached in `update_scopes` **[source]**. Moving the source later
leaves the link in the old groups. If the link has no stored membership at all, there is nothing to
go stale. **[judgment] This is the cleanest win in the investigation**, because it removes the class
rather than the instance.

**Moderate — the cache surface shrinks.** `RelationshipCache`'s forward direction becomes a field
read on the source row. `EntityGroupCache` and `GroupCache` are unchanged (membership stays a row). So
roughly one of five cache modules and its three tables go.

**Weak — boot rebuild.** `SystemCache.populate_caches_from_indexes/1` rebuilds system caches from the
`cf_*` indexes at boot. Component-based data is rebuilt by a range scan over
`cf_component_entities (component, entity_id)` and then expanding each row's keys, which is
comparable work to reading the equivalent rows **[derived]**. Not a blocker in either direction.

### What it costs on the server

**`contained: true` stops being storable.** #790 decision 2 mirrors the _target's_ memberships into
the link's own `entityGroup` rows, so a contained target moves with its source. A link with no
membership rows cannot mirror anything. Containment would have to become a **resolution-time** rule:
when resolving a link's groups, union the source's and the target's. That is simpler in one way (no
mirrored rows to keep in sync — which is precisely what produced #789) and more expensive in another
(the resolution now walks one hop, on the authorize path, per update). **[open]** Whether that hop
is affordable is measurable against the ~21k Actions/sec write budget, and it is the single number
that decides this half of the question.

---

## 5. Verdict

| Candidate                                    | Verdict                     | Because                                                                                                                                                                                                                                                        |
| -------------------------------------------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ebb/link` as a keyspace on the source       | **Yes — worth prototyping** | Source-owned visibility is already decided; forward traversal becomes free; duplicate edges become unrepresentable; missed links become backfillable; #789's class disappears. Costs one resolution hop for `contained`.                                       |
| `ebb/membership` as a keyspace on the entity | **No**                      | Group-owned scope; the group → entity index survives regardless; you would trade a row for payload-derived delivery scope.                                                                                                                                     |
| `ebb/groupMember` as a keyspace on the group | **Not yet**                 | Group-owned and bounded in cardinality (dozens to hundreds per the README), so it _would_ fit. But it is the authorization primitive, the payoff is two ETS tables, and the blast radius is every permission check. Defer until links have proven the pattern. |

**[judgment] The asymmetry is the finding.** "Make the relations components" sounds like one change
and is three, and only the one whose visibility is owned by the entity holding it is a clear win.

---

## 6. What would settle it

1. **Re-run `packages/client/src/benchmark/replica-read-model.ts` with links folded into the source**
   — resident bytes, forward-traversal cost, reverse-index size. This is the only large number in
   play, and the harness exists.
2. **Price the containment hop.** Resolve a link's groups as `source ∪ target` for a `contained`
   link and measure it inside the authorizer against the ~21k Actions/sec budget.
3. **Count the duplicate edges in the fixtures.** If the test tree and the doc fixture contain none,
   the "duplicates become unrepresentable" argument is theoretical, and should be priced as such.

## 7. Relationship to the plan

This note does **not** change
[#805 `refactor(storage)`: the four system types become system components](https://github.com/ebbjs/ebbjs/issues/805),
which keeps every row and renames the type. It proposes a **follow-on** to it, and it makes
[#790 epic(relationships): relationships are first-class entities — they own their group membership](https://github.com/ebbjs/ebbjs/issues/790)
the place to decide, since #790 currently specifies the opposite for links (own `entityGroup` rows).

Sequencing: #790 must land first either way, because it fixes the derivation bug. Whether links then
_keep_ their own membership rows or lose them entirely is a decision #790 should record rather than
discover later. Doing links-as-components before #793's component plumbing exists would mean writing
the keyspace merge twice.
