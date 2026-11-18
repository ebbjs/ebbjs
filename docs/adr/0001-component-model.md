# 0001 — Components are the unit of identity

**Status:** accepted, 2026-11-09; amended 2026-11-11 for the system-component contract ([#805](https://github.com/ebbjs/ebbjs/issues/805)); amended 2026-11-16 for the component-subject permission rule ([#803](https://github.com/ebbjs/ebbjs/issues/803)); amended 2026-11-18 for the link pair ([#820](https://github.com/ebbjs/ebbjs/issues/820))
**Epic:** [#793](https://github.com/ebbjs/ebbjs/issues/793) · **Rationale:** [`docs/research/ecs-rearchitecture.md`](../research/ecs-rearchitecture.md) · **Plan:** [`docs/plan/components-epic.md`](../plan/components-epic.md)
**Amends:** `CONTEXT.md` — adds a Components section; revises Entity, Field, Committed model, and Materialization.

ADRs live in `docs/adr/`, numbered, one decision each. The location is decided here, because [#787](https://github.com/ebbjs/ebbjs/issues/787) leaves it to be decided and #794 lands first; the boundary ADR takes the next number.

---

## Context

`entity.type` is one immutable string doing six jobs:

| Job               | Where it is read                           |
| ----------------- | ------------------------------------------ |
| storage key       | `cf_type_entities (type, 0x00, entity_id)` |
| query source      | `query("note")` → `iterate("note")`        |
| projection shape  | `projectEntity` selects the shape by type  |
| permission string | `<type>.<verb>`                            |
| residency policy  | `materialization: "held" \| "on-demand"`   |
| conflict policy   | `conflictScope`, plus `STRUCTURAL_MODELS`  |

Because it is one string, fixed by the first write, **variation inside a row is expensive**: optional
data has to be a null tombstone, large data has to become a synthetic second entity, and a piece of
a row needing different policy has nowhere to declare it.

Three defects follow, all present in the tree:

1. **A client-supplied identity claim.** `subject_type` reaches the authorizer, the materialized
   row's type, the type-entity index, the SQLite type column, and the replica's row type, and
   nothing compares it to what the id was committed under ([#624](https://github.com/ebbjs/ebbjs/issues/624)).
2. **Tearing.** `ebb/link`, `ebb/membership`, and `ebb/grant` are each several independent
   last-writer-wins leaves. Only a whole-value write keeps them coherent, so a concurrent partial
   write can produce an edge with a new target and an old source — or a membership filing an entity
   into a group its `group_id` disagrees with, which is a permission scope change.
3. **Special-case sets.** `STRUCTURAL_MODELS` (rows that are "not documents"), the generated
   document-entity family, and the system-type enumeration duplicated across five server modules all
   exist because one string had to serve six jobs.

## Decision

**A component is the unit that existence, loading, conflict scope, indexing, and version attach
to. A model is the unit of permission, query source, and projection. `type` stops being identity and
becomes the name of a declared component set.**

1. **`type` survives as the model.** It remains the permission subject, the query source, and the
   projection shape. It stops being the storage, residency, conflict, or existence key. Claims that
   "ebb no longer has types" are wrong and would produce a worse permission model.
   **The prefix is the brand.** A component is named `<namespace>/<field>`. For a user component
   the namespace is its model, so an entity carries components of exactly one _user_ model and the
   server derives the permission subject from the name without a schema. `ebb/` is the platform's
   namespace: an `ebb/*` component may sit on any row (that is how a link lives on its source), is
   its own permission subject under `ebb` (decision 12), and never determines or changes the row's
   committed model. A row's committed model is the model of its user components, or `ebb` when it
   carries only platform components; `ebb` is not a model an app declares. Multi-brand _user_
   entities remain a non-goal.
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
6. **Loading is per component.** A component declares `loading: "eager" | "lazy"`. An eager
   component is held in the replica; a lazy component is fetched, pinned, and evicted independently
   of its row.
7. **Conflict scope gains a middle rung.** `"field" | "component" | "entity"`, declared per
   component. A component-scope hold holds one component, not the whole row. Separately, a
   component may declare `structural: true`: its writes converge and are never surfaced or held.
   The SDK's `relationship`, `entityGroup`, and `groupMember` components declare it, which replaces
   `STRUCTURAL_MODELS`. This is an exemption from detection, not a fourth granularity, and it is
   never persisted as a conflict scope.
8. **Indexing is opt-in per component.** A component declared `indexed: true` gets an existence row;
   one that is not is reachable only by id. Today _every_ entity sits in `cf_type_entities` whether
   or not anything queries by type; this inverts that default. **As shipped in #799 the server indexes
   every component**, because it has no schema (#803) and must not grow one; `indexed` remains a
   schema-level intent whose server-side enforcement needs a declared set this design forbids the
   server to hold. The client's component index follows presence, not the flag, for the same reason.
9. **No compatibility.** Ebb is greenfield with no consumers. The client store resets, server data is
   discarded, and there is no migration, alias, or deprecation path.
10. **Everything lands behind one primitive.** No second write path, no second merge rule, no second
    envelope. `mergeFieldValue` remains the single definition of convergence.
11. **Scope is declared per `ebb/*` component.** Every system component names how its write's group
    set resolves: `scope: "self"` (the entity's own id), `scope: "<field>"` (the entity named by
    that value), or the default, inherit the entity's membership. `ebb/group` is `self`;
    `ebb/grant` and `ebb/membership` are `group_id`; `ebb/link` declares no owner at all, because
    it lives on its source and its scope is that row's membership ([#820](https://github.com/ebbjs/ebbjs/issues/820)). Resolution becomes
    one table read instead of `EntityIndex.resolve_groups_cached/3`'s five clauses. The declaration
    is restricted to the `ebb/` namespace: a user component that could name a group could mint its
    own delivery scope.
12. **The permission subject is the component the write names.** A grant
    `<grantSubject>.<verb|*>` covers a write subject `<subject>` when the two subjects are equal or
    `<subject>` descends from the grant's — `String.starts_with?(subject, grantSubject <> "/")` —
    and the verb is equal or `*`. `Component.split/1` guarantees exactly one `/` in a component
    name, so the test is unambiguous. A row create or delete names no component and checks the
    model (`note.create`, `note.delete`); a write that names a component checks that component
    (`note/body.update`). Ancestry is what keeps existing grants working: `note.*` covers
    `note/body` and every field declared later, while `note/title.*` covers `note/title` and
    nothing else. It is also what the four system components need, with no special case —
    `ebb/grant` is a subject under `ebb`, so `ebb.*` covers it, and `ebb/link.create` stays
    distinct from `ebb/group.create` without a second rule for platform components. There is no
    deny, so narrowing an actor who holds `note.*` means rewriting that grant to enumerate what
    they keep: restriction is a property of grants, not of declarations. Writes can be
    field-granular; reads cannot, because read filtering is a fan-out property of the delivery
    boundary rather than a permission string. The server reads no schema for any of it: the subject
    and the verb are both wire facts.

    **The opt-in is dropped, not deprecated.** An earlier form of this decision had a component
    declare a permission flag of its own in the client's schema, with
    `<model>/<component>.<verb>` checked only for components that did. A server branching on "this
    component opted in" is performing a declared-set lookup — the one thing the schema-free
    acceptance forbids — so the flag could not be honoured where it mattered. Naming the subject on
    the wire answers the same question without a schema, and gives user-defined and platform
    components one rule instead of two. The flag and the registry lookup that read it are deleted,
    not deprecated.

13. **System components are atomic and their key is immutable.** One Update writes the whole
    value, so a torn edge, membership, or grant is unrepresentable; the key is fixed once written,
    so moving a membership is a delete plus a create, and moving an edge is two keys.

### The system components

| Component        | Value                                      | Key                     |
| ---------------- | ------------------------------------------ | ----------------------- |
| `ebb/group`      | `{name, apps}`                             | the row id              |
| `ebb/grant`      | `{actor_id, group_id, permissions}`        | `group_id`              |
| `ebb/membership` | `{entity_id, group_id}`                    | `(entity_id, group_id)` |
| `ebb/link`       | `{<field>: {<type>: {<target_id>: true}}}` | the source row          |

`ebb/membership`'s row id stays `entityGroupId(entity, group)`; immutability is what keeps the
derived id truthful.

**`ebb/link` is a keyed component of its source**
([#820](https://github.com/ebbjs/ebbjs/issues/820)). The row carrying the component _is_ the
source, so an edge's key is its whole identity — field, then type, then target id — and the three
nesting levels are the key, not three fields. That keeps two edges from one source to one target
under different accessors (or under different `type` labels) distinct, makes two edges sharing one
identity unrepresentable, and lets one Update write one edge. The leaf's value is presence
(`true`); **removing one edge is a `merge` whose value tombstones that key** (`value: null`), so
`drop` keeps its `(entity, component)` granularity and never names a key. The component name stays
`ebb/link`: it is a wire fact and a permission subject, and the source keeps its committed model
because an `ebb/*` overlay adds a component entry and no model entry.

Naming the component rather than reusing the declared pointer field `<source>/<as>` is what keeps
the server schema-free: whether `<source>/<as>` is an edge at all is a client declaration, so an
index over it would be a declared-set lookup the server is forbidden to make. It also settles the
permission subject — a link write is authorized as `ebb/link.<verb>` in the source's group set, and
`ebb.*` covers it — where `<source>/<as>` would have let a model-level grant for a row's _data_
authorize an _edge_.

**Storage consequence.** A row's model entry in the existence index is its committed model, never
the prefix of the component being written. An `ebb/*` write to a user row adds a component entry and
leaves the model entry alone; a row that carries only platform components is committed under `ebb`.
This is the rule [#805](https://github.com/ebbjs/ebbjs/issues/805) and
[#820](https://github.com/ebbjs/ebbjs/issues/820) need, and it is the departure
[#799](https://github.com/ebbjs/ebbjs/issues/799) recorded against `componentModel/1`.

### The wire

```elixir
Update { subject_id, component, method: "merge" | "replace" | "drop", data: FieldValue | nil }
Update { subject_id, method: "delete", data: nil }        # entity delete; names no component
```

- One Update writes exactly one `(entity, component)`. A three-field edit **inside** one component
  is still one Update; across three components it is three.
- `merge` is the existing rule, unchanged. `replace` is refused for a keyed component, because a
  wholesale replace would discard a concurrent writer's siblings. `drop` detaches a component and
  leaves the row. `delete` tombstones the row. One entry of a keyed component is not a `drop`: it
  is a `merge` whose value tombstones that key, which is how `unlink` removes one edge and leaves
  the source's other edges alone.
- `data` carries the component's _value_, so `data.fields` leaves the wire entirely.

### The questions that are expensive to reverse

1. **Merge granularity is chosen per component, by its builder.** An atomic component
   (`e.object({a, b})`) is **one** merge position — the record is replaced whole, so its fields
   cannot tear. A keyed component (`e.map({a, b})`, `e.log(entry)`) is **N** positions — each field
   merges on its own. A merge position may not contain a merge position of another kind: an atomic
   value cannot wrap an append-only log, because the parent would replace the child wholesale. That
   is why a document body is a keyed component holding `engine` and `updates`, not an object.
2. **`indexed` defaults to off.** A component is indexed only if something filters on it.
3. **Whether an `ebb/*` component may declare its own scope.** Decisions 11–13 are all of this kind
   and together they are the system-component contract: a component whose value names a group
   changes its own subject's delivery scope, so the declaration must be deliberate.

## Boundary rule

**A component may not own a group set; it may name the entity whose scope it borrows.**

A membership is a row because it _is_ the scope; a link names its source; a grant names its group;
a document body inherits its note. **Anything you paginate must have rows**, which is why membership
is reified rather than a key on the member, and why a link may still be a component of its source.

That rule decides more than it looks like:

- An edge's visibility belongs to its source ([#790](https://github.com/ebbjs/ebbjs/issues/790)),
  and since [#820](https://github.com/ebbjs/ebbjs/issues/820) the representation says so: a keyed
  pair on the source, never a row with its own group set.
- A document body is a component because it is visible exactly where its note is. An app that needed
  a body readable by people who cannot read the note would declare the body as an entity — the
  mechanism allows it, the platform does not invent it.
- Membership stays a row, not a key on the member's row: a membership is an attribute of the
  _group's_ member list, and its delivery scope is the group.

## Consequences

### What becomes impossible

- A write naming a component the id's committed model does not declare.
- A field whose meaning is "absent" — existence is a bit, so absence has no value to misread.
- Once [#805](https://github.com/ebbjs/ebbjs/issues/805) lands, an edge, membership, or grant whose
  values disagree with each other, or whose key disagrees with the row's identity.
- An `ebb/*` component with no declared scope owner.
- Since [#820](https://github.com/ebbjs/ebbjs/issues/820): an edge with no field or type, two edges
  sharing one `(source, field, type, target)`, and an edge delivered anywhere its source is not.

### What gets harder

- **Throughput, measured.** Five components per edit costs +50% Action payload and, at the hot
  write path, −28% accepted Actions/s with +70% p95
  ([#797](https://github.com/ebbjs/ebbjs/issues/797)). A single-field write is unchanged; creates and
  multi-component edits pay. Atomic system components are the mitigation: one Update for a whole
  membership or edge, not two or four.
- **The authorizer is the risk surface.** The scope table (decision 11) rewrites `EntityIndex` and
  the rules `Authorizer` carries as prose. The #624, #623, and #789 vectors are the tests to write
  first.
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

### Amendments from slice 10 ([#805](https://github.com/ebbjs/ebbjs/issues/805))

- **`ebb/group`'s `apps` is a list of app ids, not a map.** `e.object` refuses a map nested inside
  an atomic value (`NestedMapError`), because a nested map would lose its per-key merge, so the
  value is `{name, apps?: [appId]}`. Absent stays "every app" and `[]` stays "no app"; the cost is
  that a scope edit writes the whole value, so concurrent edits converge last-writer-wins on the
  value instead of merging per app id (#732's per-key merge is not preserved) — and because `name`
  rides the same value, a rename and a concurrent scope edit clobber each other.
- **Decision 13's immutable keys are enforced for the two that are stored in a value.**
  `ebb/membership`'s `(entity_id, group_id)` and `ebb/grant`'s `group_id` are refused a re-point,
  so moving an actor or a membership between groups is a delete plus a create — which replaces the
  earlier "needs the permission in both groups" rule rather than keeping it as well. `ebb/link`
  left this list in [#820](https://github.com/ebbjs/ebbjs/issues/820): an edge keyed on its source
  has no `source_id` field to re-point, so the refusal and the rule it guarded are gone.
- **`ebb/membership` is a subject under `ebb`, but not the subject a membership write is checked
  against.** A membership write authorizes as the _entity's_ `<model>.create` / `.update`, which is
  what `entityGroup.*` did before #805 and what #121's "Add Entity to Group" row settles. Under
  decision 12's ancestry rule the component name is an ordinary subject — a grant may name it and
  `ebb.*` covers it — but no code path checks a membership write against `ebb/membership.*`. Said
  explicitly so a reader does not assume the string gates something.

### Amendments from slice 5 ([#798](https://github.com/ebbjs/ebbjs/issues/798))

- **`optional` and `.default()` are mutually exclusive.** `optional` says absence is absence;
  `.default()` says absence has a value. Refusing the pair is what makes an optional component's
  projection collapse to two states (absent → `undefined`, present → the stored projection) without
  threading optionality through every projection call.
- **Row existence is a separate word from component existence.** A row exists while it is committed
  and not tombstoned, even with zero components; _Existence_ in `CONTEXT.md` stays component
  presence. The replica's `exists` bit answers the different local question "has this replica seen
  the row's base", and `created_hlc` is the server's first-write stamp, never a predicate.
- **Creating a zero-component row is a wire change.** Dropping the last component leaves a legal
  zero-component row, but every non-`delete` Update names a component, so there is no way to bring an
  id into existence with nothing attached. A row-scoped create method (or a separate endpoint) is a
  later slice's decision; the testing seed keeps its one-component workaround until then.
- **`drop` on a system component is refused for now.** A torn edge or membership is slice 10's
  `ebb/*` component; until then the client refuses to detach a system model's component, and slice
  12's authz rules are where the server-side rule lands.
- **The client replica record format bumps.** `Entity` gained the `exists` bit and a nullable
  `created_hlc`, so `REPLICA_RECORD_FORMAT` goes 1 → 2 and an old record reads as absent. Decision 9
  makes that a reset, not a migration.

### Amendments from the row create ([#817](https://github.com/ebbjs/ebbjs/issues/817))

- **A row is a wire fact.** "One Update names one `(entity, component)`" is revised: an Update
  names either a component or the row. `create` names the row's model, its creation time and no
  component, so `client.create({})` is a legal Action and a zero-component row can be created,
  delivered by catch-up and materialized from a backfill or listing seed.
- **The create's model is authoritative; its HLC is the row's creation time.** There is no prior
  record to contradict the model, so a component Update whose prefix disagrees is a structure
  violation. `created_hlc` is the create's `hlc` and nothing else — the Action HLC cannot serve,
  because a synthetic backfill base is stamped at the row's latest position.
- **An unseen create is held on the client and refused on the server.** Per-subject,
  group-scoped delivery hands a component write to a group that never saw the create; the client
  keeps its `exists: false` placeholder and backfills the base rather than dropping data. A commit
  is never out of order, so the server refuses instead: no create, no `:put`, and an unknown row
  fails authorization. Nothing is ever reconstructed by inference.
- **`<model>.create` means "this Action carries the row's create".** The verb no longer follows the
  existence index, so a drop-only Action is an update and a create is a create by construction.
- **Things the epic listed as compensations are gone:** `fetchedEmpty`, the
  `replace`-implies-create inference, the first-write `created_hlc` stamp, the
  `snapshotAction` synthesis of a base from component Updates, and the testing seed's `version`
  component. `REPLICA_RECORD_FORMAT` bumps 5 → 6 and resets.

### What this does not decide

- **Whether membership becomes a pair component on the member.** No — anything you paginate must
  have rows, and group listing is keyset pagination. Recorded so it is not re-derived.
- Whether per-component residency pays for itself. [#802](https://github.com/ebbjs/ebbjs/issues/802)
  measures it, and a failure there changes whether a document body can be a component.
- Field-level **read** permissions. Read filtering is a fan-out property, not a wire or permission
  string property, and it is out of scope.
- Whether `replace` should exist at all, and whether `optional` is declared on the component or
  defaulted by the model.
- How component existence interacts with [#123](https://github.com/ebbjs/ebbjs/issues/123)'s
  compaction low-water mark.
