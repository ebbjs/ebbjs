# 0001 — Components are the unit of identity

**Status:** proposed, 2026-11-09 · accepted when [#794](https://github.com/ebbjs/ebbjs/issues/794) merges
**Epic:** [#793](https://github.com/ebbjs/ebbjs/issues/793) · **Rationale:** [`docs/research/ecs-rearchitecture.md`](../research/ecs-rearchitecture.md) · **Plan:** [`docs/plan/components-epic.md`](../plan/components-epic.md)
**Amends:** `CONTEXT.md` — adds a Components section; revises Entity, Field, Committed model, and Materialization.

ADRs live in `docs/adr/`, numbered, one decision each. The location is decided here, because [#787](https://github.com/ebbjs/ebbjs/issues/787) leaves it to be decided and #794 lands first; the boundary ADR takes the next number.

---

## Context

`entity.type` is one immutable string doing six jobs:

| Job               | Where it is read                                 |
| ----------------- | ------------------------------------------------ |
| storage key       | `cf_type_entities (type, 0x00, entity_id)`       |
| query source      | `query("note")` → `iterate("note")`              |
| projection shape  | `projectEntity` selects the shape by type        |
| permission string | `<type>.<verb>`                                  |
| residency policy  | `materialization: "held" \| "on-demand"`         |
| conflict policy   | `conflictScope`, plus `STRUCTURAL_SUBJECT_TYPES` |

Because it is one string, fixed by the first write, **variation inside a row is expensive**: optional
data has to be a null tombstone, large data has to become a synthetic second entity, and a piece of
a row needing different policy has nowhere to declare it.

Three defects follow, all present in the tree:

1. **A client-supplied identity claim.** `subject_type` reaches the authorizer, the materialized
   row's type, the type-entity index, the SQLite type column, and the replica's row type, and
   nothing compares it to what the id was committed under ([#624](https://github.com/ebbjs/ebbjs/issues/624)).
2. **Tearing.** `ebb/link`, `ebb/membership`, and `ebb/groupMember` are each several independent
   last-writer-wins leaves. Only a whole-value write keeps them coherent, so a concurrent partial
   write can produce an edge with a new target and an old source — or a membership filing an entity
   into a group its `group_id` disagrees with, which is a permission scope change.
3. **Special-case sets.** `STRUCTURAL_SUBJECT_TYPES` (rows that are "not documents"), the generated
   document-entity family, and the system-type enumeration duplicated across five server modules all
   exist because one string had to serve six jobs.

## Decision

**A component is the unit that existence, residency, conflict scope, indexing, and version attach
to. A model is the unit of permission, query source, and projection. `type` stops being identity and
becomes the name of a declared component set.**

1. **`type` survives as the model.** It remains the permission subject, the query source, and the
   projection shape. It stops being the storage, residency, conflict, or existence key. Claims that
   "ebb no longer has types" are wrong and would produce a worse permission model.
2. **A bare field builder is an anonymous component.** No existing declaration changes meaning. This
   is what keeps the public surface stable: `defineModel("note", { title: e.string() })` takes what
   `defineEntity` takes today.
3. **`e.object` and a component are one machinery at two levels of ceremony.** A component's write
   envelope is defined once, including nested `unset` refusal, closed properties, and object-valued
   query comparison.
4. **Merge granularity is declared per component, not assumed.** Fields inside a component merge by
   the builder the component was declared with; the component chooses.
5. **Existence is a bit, not a tombstone.** For an `optional` component, absent means absent. The
   tombstone survives only for a _present_ leaf whose value was cleared, and that is a value.
6. **Residency is per component.** `materialization` moves from the model to the component. An
   on-demand component is fetched, pinned, and evicted independently of its row.
7. **Conflict scope gains a middle rung.** `"field" | "component" | "entity"`, declared per
   component. A component-scope hold holds one component, not the whole row.
8. **Indexing is opt-in per component.** A component declared `indexed: true` gets an existence row;
   one that is not is reachable only by id. Today _every_ entity sits in `cf_type_entities` whether
   or not anything queries by type; this inverts that default.
9. **No compatibility.** Ebb is greenfield with no consumers. The client store resets, server data is
   discarded, and there is no migration, alias, or deprecation path.
10. **Everything lands behind one primitive.** No second write path, no second merge rule, no second
    envelope. `mergeFieldValue` remains the single definition of convergence.

### The wire

```elixir
Update { subject_id, component, method: "merge" | "replace" | "drop", data: FieldValue | nil }
Update { subject_id, method: "delete", data: nil }        # entity delete; names no component
```

- One Update writes exactly one `(entity, component)`. A three-field edit **inside** one component
  is still one Update; across three components it is three.
- `merge` is the existing rule, unchanged. `replace` is refused for a keyed component, because a
  wholesale replace would discard a concurrent writer's siblings. `drop` detaches a component and
  leaves the row. `delete` tombstones the row.
- `data` carries the component's _value_, so `data.fields` leaves the wire entirely.

### The two questions that are expensive to reverse

1. **Merge granularity is chosen per component, by its builder.** An atomic component
   (`e.object({a, b})`) is **one** merge position — the record is replaced whole, so its fields
   cannot tear. A keyed component (`e.map({a, b})`, `e.log(entry)`) is **N** positions — each field
   merges on its own. A merge position may not contain a merge position of another kind: an atomic
   value cannot wrap an append-only log, because the parent would replace the child wholesale. That
   is why a document body is a keyed component holding `engine` and `updates`, not an object.
2. **`indexed` defaults to off.** A component is indexed only if something filters on it.

## Boundary rule

**A component inherits its entity's groups. Anything that needs its own group membership must be its
own entity, not a component.**

That rule decides more than it looks like:

- Ebb's edges stay entity rows rather than pair components, because a link's visibility is a
  question about groups and groups attach to entities ([#790](https://github.com/ebbjs/ebbjs/issues/790)).
- A document body is a component because it is visible exactly where its note is. An app that needed
  a body readable by people who cannot read the note would declare the body as an entity — the
  mechanism allows it, the platform does not invent it.
- Membership stays a row, not a key on the member's row: a membership is an attribute of the
  _group's_ member list, and its delivery scope is the group.

## Consequences

### What becomes impossible

- A write naming a component the id's committed model does not declare.
- A field whose meaning is "absent" — existence is a bit, so absence has no value to misread.
- Once [#805](https://github.com/ebbjs/ebbjs/issues/805) lands, an edge or membership whose leaves
  disagree with each other.

### What gets harder

- **Update count grows with components, not fields.** [#797](https://github.com/ebbjs/ebbjs/issues/797)
  measures the delta before the envelope is accepted.
- **Replica persistence splits a row.** `toRecord` persists held rows on one rule; partial rows mean
  a second store keyed by `(entity, component)`. That is
  [#802](https://github.com/ebbjs/ebbjs/issues/802), and it is net new complexity.
- **Component-scoped reads become required** on the entity endpoint once a large component can live
  on a row that used to be small.

### The committed model is not the committed type

A refinement worth recording, because the epic's phrasing is looser than the design:

The **forgeable claim** disappears — a write no longer asserts an identity, it names a component.
But the _mechanism_ survives: the server still needs to know which model an id was committed as, so
later writes can be checked for **subscription** rather than string equality. "Does the model this id
was committed under declare this component?" is strictly stronger than "does this type string equal
the committed type string", and it is what
[#803](https://github.com/ebbjs/ebbjs/issues/803) implements. `CONTEXT.md` records it as **Committed
model**.

### What this does not decide

- Whether links become components of their source. [#790](https://github.com/ebbjs/ebbjs/issues/790)
  decides that; `docs/research/membership-and-links-as-components.md` argues yes and explains why
  membership is the opposite case.
- Whether per-component residency pays for itself. [#802](https://github.com/ebbjs/ebbjs/issues/802)
  measures it, and a failure there changes whether a document body can be a component.
- Field-level **read** permissions. Read filtering is a fan-out property, not a wire or permission
  string property, and it is out of scope.
- Whether `replace` should exist at all, and whether `optional` is declared on the component or
  defaulted by the model.
- How component existence interacts with [#123](https://github.com/ebbjs/ebbjs/issues/123)'s
  compaction low-water mark.
