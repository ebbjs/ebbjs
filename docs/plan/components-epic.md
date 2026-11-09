# epic(components): components are the unit of identity

Status: proposal, 2026-11-09. **Redirects** #775 (a document preset becomes a `ComponentDef`, not
an `EntityDef`, and the body becomes a component of the owning row) and folds in #760, #124, #195,
and the scope half of #781. Does not supersede #790. Rationale and the ECS readings:
[`docs/research/ecs-rearchitecture.md`](../research/ecs-rearchitecture.md).

## Summary

Ebb has one identity per row and it does six jobs. `entity.type` is simultaneously the storage
key (`cf_type_entities`), the query source (`query("note")` → `iterate("note")`), the projection
shape (`projectEntity`), the permission string (`<type>.<verb>`), the residency policy
(`materialization: "held" | "on-demand"`), and the conflict policy (`conflictScope`, plus the
hardcoded `STRUCTURAL_SUBJECT_TYPES`). Because it is one immutable string committed by the first
write, **variation in a row is expensive**: optional data has to be a tombstone, large data has to
be a synthetic second entity, and a piece of a row that needs different policy has nowhere to
declare it.

This epic splits those six jobs. A **component** becomes the unit that owns existence, residency,
conflict scope, and version. A **model** — today's `defineEntity` — becomes the name
of a declared component set, used for permissions, query sources, and projection. `type` stops
being identity and becomes a name for a set.

The public API barely moves. A field builder is sugar for an anonymous component, so
`defineModel("note", { title: e.string() })` has the same shape it has today, and every existing
field keeps its meaning — only the factory's name changes. The new surface is one opt-in import, used only where a field needs one of the
four powers.

**The claim this epic can be falsified against:** after it lands, `@ebbjs/core`, `@ebbjs/storage`,
`@ebbjs/client`, and `ebb_server` contain no site that dispatches on a _row type string_ to decide
storage, residency, conflict, or existence behaviour. Type names survive in exactly two places —
the permission string and the query source — and both read from the model.

## The model

```
leaf        the mergeable position: { value, update_id, hlc } or { map: { <key>: leaf } }
component   a named value. One leaf (e.string, e.object) or one key space (e.map, e.log).
            Carries: existence, residency, conflict scope, version, optional own permission.
model     a named component set. What defineModel declares. What client.<name> namespaces.
            Carries: the permission subject, the query source, the typed projection.
row         an entity id plus the components currently attached to it.
```

A plain field builder is an **anonymous component**: present, held, model-scoped, version 1.
That is what makes the refactor non-breaking at the surface — every existing declaration already
means something under the new model.

### Wire

```elixir
Update {
  subject_id : binary,
  component  : binary,                       # "note/title", "ebb/link"
  method     : "merge" | "replace" | "drop",
  data       : FieldValue | nil              # the component's own value, never a row's field record
}

Update {                                   # entity delete, unchanged shape
  subject_id, method: "delete", data: nil  # no component: a delete names the row
}
```

| Property   | Rule                                                                                                                                                                                    |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One Update | one `(entity, component)` pair. A three-field edit inside one component is **one** Update; across three components it is three. A component has as many fields as its declaration says. |
| `merge`    | the existing rule, unchanged: `mergeFieldValue` at every leaf, keyspaces union by key                                                                                                   |
| `replace`  | the component's value is replaced whole. **Refused for keyspace components** (`e.map`, `e.log`) — a wholesale replace would wipe a concurrent writer's siblings                         |
| `drop`     | the component is detached; the row survives. Deleting the last component is not a row delete                                                                                            |
| `delete`   | tombstones the row, implies detaching every component; names no component                                                                                                               |
| `data`     | a component's _value_, not a field record. `data.fields` disappears from the wire                                                                                                       |
| Ordering   | unchanged: HLC then `update_id`, per leaf                                                                                                                                               |

**The cost is explicit: Update count grows.** Today `update(id, {a,b,c})` is one Update carrying
three fields; after it is three Updates carrying one component each. `cf_entity_actions` coalesces
per subject per flush (`docs/research/575-entity-actions.md`), so the index row count does not
grow with Update count, but the Action payload does. This is the price of per-component
authorization, invalidation, and conflict scope, and it must be measured before the envelope
lands.

### Model and identity

- `defineModel(name, components, opts)` declares the **reachable** component set. Which of them
  are attached is dynamic; which of them _can_ be attached is static.
- A write to a component the model does not declare is rejected at validation. **This is the
  structural fix for #624** — `subject_type` stops being a client-supplied identity claim, because
  there is no identity claim to make: the component set is a schema fact and the row's existence is
  the only per-row question.
- A component declared `optional: true` may be absent. A row with zero components is possible and
  means "an id that exists and has nothing attached"; only `delete` removes the id.

### Permissions

- Verbs are unchanged: `create` (first write to a row), `update` (`merge`/`replace`/`drop` on an
  existing row), `delete`, `read`.
- Scale is the model: `<model>.<verb>` and `<model>.*`, checked exactly as
  `PermissionHelper.check_permission/3` does today.
- A component may opt in to its own permission with `permission: "own"`, yielding
  `<model>/<component>.<verb>`. **Off by default**, because permissions are about domain objects,
  not data layout, and a permission per component across a large schema is a table nobody can
  administer.
- **Field-level permissions are not in this epic.** Read granularity is a fan-out property — a
  replica is a local copy of everything the client was sent — so field-level _read_ permissions
  would require filtering at the delivery boundary, not a new permission string. That is a
  separate design.

### Invalidation

`ReplicaChange` carries `components: readonly string[]` instead of `type`. A query plan declares
`readComponents`. The cache intersects on components, so a `title` write stops invalidating a plan
that only reads `status`.

## Decisions

1. **`type` survives as the model.** It remains the permission subject, the query source, and the
   projection shape. It stops being the storage, residency, conflict, or existence key. Claims that
   "ebb no longer has types" are wrong and would produce a worse permission model.
   **Model is not archetype:** a model is _declared_, an archetype is _actual_. One model's rows
   occupy one archetype per subset of present components.
   **Why "model":** `defineEntity` was already misnamed — it declares a _kind_ of row, not a row, and
   every instance is an entity. `CONTEXT.md` defines Entity as _a row_ and ECS defines it as _a bare
   id_, so "entity" would be ambiguous in exactly the wrong way. "Model" is the ORM and
   domain-modelling word for the declaration, which is the lineage ebb belongs to.
   **Vocabulary split:** a **model** is a declaration (`defineModel`, `ModelDef`, `ModelRegistry`,
   `modelIndex`); an **entity** is a row (`EntityStore`, `EntityView`, `entityGroup`, `entity_id`).
   Nothing that means "row" is renamed.
   **Costs of the rename, accepted:** `defineEntity` → `defineModel`, `EntityDef` → `ModelDef`,
   `EntityRegistry` → `ModelRegistry`, `defineSchema({ entities })` → `defineSchema({ models })`,
   across docs, `packages/www`, examples, fixtures, and tests. Greenfield, and mechanical.
   **Avoid:** _class_, _table_, _collection_ — a model carries data and policy, never behaviour.
2. **A field builder is an anonymous component.** No existing declaration changes meaning. This is
   what makes the surface stable.
3. **`e.object` and a component are the same machinery at two levels of ceremony.** #760's four
   touch points (`admitsNull`, `stripUnsetEntries`, the `unset`-in-object envelope, query equality
   and ordering) are exactly a component's four touch points. Build them once.
4. **Cohesion is declared, not assumed.** A component may hold many fields; the declaration picks
   how they merge. `e.object({a, b})` is one merge position — the record is replaced whole, so it
   cannot tear. A keyed component (`e.map({a, b})`, `e.log(entry)`) is N merge positions — each
   field merges on its own, so a concurrent write to one leaves its siblings alone. This is the
   value-vs-key-space axis #760 records, and it is chosen **per component**, not per field. It is
   also the middle rung `conflictScope` is missing.
5. **Existence is a bit, not a tombstone.** For an `optional` component, absent means absent. The
   `value: null` tombstone survives only for a _present_ leaf whose value was cleared, and that is
   a value, not an absence.
6. **Residency is per component.** `materialization` moves from the model to the component. A
   component that is on-demand is fetched, pinned, and evicted independently of its row.
7. **Conflict scope gains a middle rung.** `"field" | "component" | "entity"`, declared per
   component. A component-scope hold holds one component, not the whole row.
8. **Indexing is opt-in per component.** A component declared `indexed: true` gets an row in
   `cf_component_entities`; one that does not is reachable only by id. Today _every_ entity sits in
   `cf_type_entities` whether or not anything queries by type. This is the decision that keeps the
   write-amplification cost bounded, and it must be taken in slice 2 (the declaration) even though
   slice 6 is where it pays off.
9. **No compatibility.** Ebb is greenfield with no consumers. The client store resets, server data
   is discarded, and there is no migration, alias, or deprecation path — the same rule #775 and
   #790 already state.
10. **Everything lands behind one primitive.** This epic adds no second write path, no second merge
    rule, and no second envelope. `mergeFieldValue` remains the single definition of convergence.

## Target architecture

```text
schema      defineComponent / defineModel(model)       → Model { components, permission }
            a bare builder is an anonymous component
core        Update { subject_id, component, method, data: FieldValue }
            mergeFieldValue unchanged                  → one convergence definition
protocol    component replaces subject_type            → one Update per (entity, component)
storage     cf_component_entities (component, id)      → replaces cf_type_entities
            replica: modelIndex + componentIndex     → replaces typeIndex
                      (+ archetypeIndex, optional)   → an afterthought, not the model
            ReplicaChange { components }               → replaces { type }
client      query(model) reads declared components   → set intersection, not one Set lookup
            plan.readComponents                        → replaces readTypes
            conflictScope "component"                  → replaces STRUCTURAL_SUBJECT_TYPES
auth        write validated against declared set      → #624 is unrepresentable
```

## What this supersedes, folds, or leaves alone

| Issue                                                                                                                                                                                                   | Disposition                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **#760** `e.object`                                                                                                                                                                                     | **Folded in** as sub-issue 3. Do not ship it separately.                                                                                                                                                                                                                                                                                   |
| **#124** schema evolution                                                                                                                                                                               | **Folded in** as sub-issue 11. Per-component `version` replaces per-type.                                                                                                                                                                                                                                                                  |
| **#195** system-type enumeration                                                                                                                                                                        | **Superseded** by sub-issue 12. The constants module is a patch on the problem.                                                                                                                                                                                                                                                            |
| **#781** one generic conflict                                                                                                                                                                           | **Partly folded in** as sub-issue 8 (adds the third scope). Its report/verb decisions stand.                                                                                                                                                                                                                                               |
| **#775** documents / engine presets                                                                                                                                                                     | **Redirected, not superseded.** Its direction holds, but a preset becomes a `ComponentDef` factory rather than an `ModelDef` factory, and an upgrade archives into an archive component instead of a `versions` relationship. #776, #778, #779, #783, #785, #773, #782 keep their scope; #775 decisions 3 and 11 need amending. See below. |
| **#790** relationships as entities                                                                                                                                                                      | **Not superseded.** It is the strongest evidence _against_ modelling edges as components. Sub-issue 12 depends on it.                                                                                                                                                                                                                      |
| **#665** out-of-band payloads                                                                                                                                                                           | Depends on sub-issue 9. Payloads become component-valued.                                                                                                                                                                                                                                                                                  |
| **#664** bytes leaves, **#173** counter fields                                                                                                                                                          | Unaffected — both are leaf-level additions.                                                                                                                                                                                                                                                                                                |
| **#194** cache accessors                                                                                                                                                                                | Still valid; the cache row shapes change under sub-issue 12.                                                                                                                                                                                                                                                                               |
| **#113, #114, #115, #123, #146, #156, #201, #224, #259, #272, #320, #348, #429, #430, #442–#445, #516, #636, #661, #667, #682, #691, #692, #698, #702, #703, #746, #748, #749, #750, #764, #786, #787** | Unaffected. #787 should record this epic's vocabulary.                                                                                                                                                                                                                                                                                     |

**How #775 changes: a document is a component preset, not an entity preset.** An earlier draft of
this section argued a body must stay an entity for addressability. That argument does not survive
scrutiny, and it is recorded here so it is not re-derived.

The original split was a **performance** decision: keep the body out of the held row so a 10k
workspace holds 41 MB of metadata instead of 323 MB (`docs/research/503-replica-read-model.md`). It
was never a permission decision, and with #790's `contained: true` a child entity mirrors its
parent's groups, so **membership is not a differentiator in either direction.**

Each of the four reasons a body "needs its own id" fails on inspection:

| Claim                                                  | Reality                                                                                                                                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A codec upgrade needs somewhere to put the old entries | A model can declare an **archive component** up front. The upgrade moves the old log into `note/bodyArchive[upgradeId]` and writes new entries into `note/body`. No id needed. |
| Backfill is per entity (#475)                          | Needs a per-component path — but slice 9 needs that path anyway. Not a new requirement, a moved one.                                                                           |
| A row must be copyable at a point in history (#784)    | **Components make this easier.** Copying the row copies the body; today you must also copy the document and re-point the relationship.                                         |
| Retention and GC are per row (#123, #665)              | **Components make this easier.** A body that is part of a live row dies with it; there is no orphaned blob to sweep.                                                           |

My "Decision 1 makes it impossible" argument was also wrong: the reachable component set is static
_within a schema version_, and a version bump may declare a different set. That is what #124's read
migrations are for. Static is not immutable.

So a document preset is `defineComponent`, and the note carries its body:

```ts
const body = yjsDocument(); // defineComponent("…/body", e.log(entry), { residency: "on-demand" })
const note = defineModel("note", { title: e.string(), body });
```

**Two details fall out of this and are not optional.**

1. **A document component must be a _keyed_ component, not an _atomic object_.** A body is
   `{ engine, updates }` — two fields on one component, which is ordinary. What it cannot be is
   `e.object({…})`, because an object is a single merge position: every keystroke would replace the
   whole 300 KB body and the append-only contract in #778 would be unenforceable. Declared as a
   keyed component, `engine` merges on its own (written once at create, #775 decision 4) and
   `updates` is an append-only key space. **One component, two fields.** This corrects an earlier
   draft that split `engine` into a sibling component; that was only necessary under the atomic
   reading.
2. **Component-scoped reads stop being an optimisation and become required.** With a body inline,
   `GET /entities/:id` returns 200 bytes of note plus 300 KB of body unless the read names the
   components it wants. Slice 4's catch-up change and the entity endpoint both have to carry a
   component filter.

**What this costs, honestly.** The body-as-component design _forces_ per-component residency,
because a held note whose body is a component is a 300 KB held row. So slice 9 stops being
optional: it is the enabling slice for #775, and it is where the split-row persistence model in
`toRecord` (`replica.ts:533`) lands. On the other side of the ledger, 10,000 document entities,
10,000 `relationship` rows and 20,000 adjacency entries stop existing — roughly a third of the
9.9 MB adjacency index at 10k documents **[derived from #503]**.

Net: this is a real trade, not a clear win. It moves cost from the data model into the residency
machinery, and it simplifies #775's preset story (a `ComponentDef` factory instead of an
`ModelDef` factory) at the price of making slice 9 load-bearing.

**Why #790 disproves edges-as-components.** The field's usual answer to relationships is pair
components — `(Likes, Bob)`. #790 shows why that cannot work here: ebb's edges are permission
subjects, and membership attaches to _entities_. A component cannot own `entityGroup` rows. Edges
stay rows. What dies is the special case: the edge row carries an `ebb/link` component that
declares its own conflict and merge behaviour, instead of `STRUCTURAL_SUBJECT_TYPES` naming it.

---

## Sub-issues

Each is independently shippable. Numbers are assigned on filing.

### 1. `design(components)`: ADR — the component model, vocabulary, and boundary

**Why.** `CONTEXT.md` has no entry for component, model, existence, or leaf, and #787's
vocabulary ADR is the natural home. Every later slice depends on the words being settled, and the
two decisions that are expensive to reverse are in this list.

**Scope.** Record in `CONTEXT.md` and an ADR: leaf, component, model, row, existence, residency,
conflict scope; the value-vs-key-space axis #760 records; the wire envelope from this epic; and the
boundary rule — _a component inherits its entity's groups, so anything needing its own membership
is an entity._

**Work.**

- [ ] `CONTEXT.md`: **leave the app-level Presence section untouched** — it is the ephemeral
      cursor/camera primitive and must not be confused with component existence. Add Component,
      Model, Existence, Leaf; revise Entity, Field, Materialization,
      Conflict.
- [ ] ADR recording Decisions 1–10, with the `type`-survives-as-model limit stated explicitly.
- [ ] Record the two reversal-expensive questions: atomic-vs-keyspace per builder, and whether
      opt-in component permissions are worth the table growth.
- [ ] Amend #787 to point here.

**Acceptance.** `CONTEXT.md` defines every term the later slices use, and no later slice's
description introduces a term this ADR does not define.

**Depends on.** Nothing. **Blocks** all.

---

### 2. `refactor(schema)`: `defineComponent`, `defineModel`, and a model is a component set

**Why.** This is the shape change with no behaviour change. It gives every later slice a place to
hang metadata and it deletes the ambiguity between "field" and "component" before anyone builds on
it.

**Scope.** `defineComponent(name, shape, opts)` returning a frozen declaration;
`defineModel(name, componentsOrBuilders, opts)` accepting both; a bare builder normalised to an
anonymous component named `<model>/<field>`. `ModelDef.fields` becomes
`ModelDef.components`, with `shape` derived. The registry answers "which components does this
model declare" and "is this component optional / held / what scope".

```ts
const title = e.string();                                  // anonymous: note/title
const body  = defineComponent("note/body", { … }, {         // named: the four powers
  optional: true, residency: "on-demand", conflictScope: "component",
});
const note  = defineModel("note", { title, status: e.enum([…]), body });
```

**Work.**

- [ ] `defineComponent` + option validation; reject a component whose name is not
      `<model>/<leaf>`-shaped, and reject a component the model does not declare.
- [ ] `defineModel` accepts builders and components in one map; normalisation is total and
      reversible.
- [ ] `ModelRegistry`: `componentsOf(model)`, `componentOf(model, name)`,
      `isOptional`, `residencyOf`, `conflictScopeOf`, `permissionOf`.
- [ ] `ModelDef.shape` is derived from the attached components, so `Static<shape>` and every
      projection keep working unchanged.
- [ ] Schema hash includes the model→component mapping (permission integrity; see sub-issue 10).

**Acceptance.** Every existing test in `packages/schema` and `packages/client` passes with no
declaration rewritten; `rg "\.fields\b" packages/schema/src` finds only leaf-level uses; a
declaration naming a component outside its model fails at `defineSchema` with the offending name.

**Depends on.** 1.

---

### 3. `feat(schema)`: `e.object` — the atomic component value

**Why.** Absorbs #760. Nested shapes are the normal way to express a compound value, and today
raw TypeBox "works" only for authoring and `Value.Check`; every other layer guesses, refuses
misleadingly, or silently does the wrong thing. This slice is also where a component's write
envelope is defined, so it must land before slice 5.

**Scope.** #760's proposal as written: a nested object is an ordinary atomic value on the wire
(`{ value: {…} }`); properties closed by default; `admitsNull` and `unset` refused at definition
time with a message naming the right tool; `.default()` composing with the deep-frozen annotation;
`where`/`orderBy` gaining structural comparison for object values.

**Work.**

- [ ] `e.object(fields)` behind `withFieldChain`, closed by default.
- [ ] `admitsNull` recurses into object properties _and_ array items (folds in the
      `Type.Array(Type.Union([String, Null]))` hole #760 notes).
- [ ] Nested `unset` refused at definition time.
- [ ] Query: `===` on object values becomes a structural compare; `String()` ordering on an object
      is refused rather than producing `[object Object]` ties (`query-execute.ts:93,104`).
- [ ] Server `QueryFilter.scalar?/1` continues to reject object filters explicitly.

**Acceptance.** #760's seven-row failure table becomes seven passing assertions.
`rg "\[object Object\]" packages/client` finds no ordering path that can produce it.

**Depends on.** 1, 2. **Blocks** 5.

---

### 4. `core(protocol)`: the component envelope — `component`, and the four methods

**Why.** Nothing after this can be per-component until the wire names a component. It is
mechanical and wide, which is exactly why it should be its own slice with its own test pass.

**Scope.** `subject_type` → `component`; `put`/`patch`/`delete` → `merge`/`replace`/`drop`/`delete`;
`data` carries a component's value rather than a row's field record, so `data.fields` disappears.
Validator, `ActionFormat`, dedup, `update_scopes`, catch-up frames, `InboundSubject`, the outbox,
and the fixtures move with it.

**Work.**

- [ ] `UpdateSchema` / `UpdateInputSchema` per the epic's wire; `FieldValue` is the only `data`.
- [ ] `method: "replace"` refused for keyspace components, at validation, with the component named.
- [ ] `ActionFormat` rejects the old shape (no read-through; #552 precedent).
- [ ] The append-only guard becomes a **path** check: `isLogPosition(component, ["updates"])` rather
      than `isLogField(subjectType, field)` (#778). A log now sits at a named position inside a
      component instead of being the whole field, so the guard — and the `refuseContentRewrites`
      special case it replaces — both key on a path.
- [ ] `update_scopes` and `cf_entity_actions` keyed per `(entity, component)` where scope differs
      from the entity's; `cf_entity_actions` still coalesces per subject per flush.
- [ ] Catch-up frames carry components-of-row rather than whole rows when the request names them.
- [ ] Measure Update-count growth: a 5-component `update()` is 5 Updates; record payload delta and
      commit throughput through the real Writer pipeline, not a storage primitive.

**Acceptance.** `rg "subject_type" packages/core/src ebb_server/lib` finds nothing outside the
migration note; a full client↔server run passes on the new envelope; the Update-count measurement
is recorded in the epic.

**Depends on.** 2. **Blocks** 5, 6, 8, 10, 12.

---

### 5. `feat(schema)`: existence — `optional`, `drop`, and `has()`

**Why.** The highest-value slice. Today absence is a tombstone — a value that _means_ nothing —
which is why projection has null/tombstone/default states and `matchesFieldValue` special-cases
`expected === null`. Existence makes "has a draft" a queryable fact and collapses half the
projection states.

**Scope.** `optional: true`; `drop` as an ordinary write; `has(component)` and `hasNot(component)`
as query predicates; projection reducing to present/absent for optional components; the tombstone
kept only for a present leaf whose value was cleared.

**Work.**

- [ ] `drop` accepted for any declared component; the row survives; deleting the last component is
      not a `delete`.
- [ ] Projection states for an optional component: absent → `undefined` (no default resolution, no
      tombstone); present → the stored projection.
- [ ] `has`/`hasNot` planned as an index predicate, not a row filter, so an existence query costs its
      index.
- [ ] `put` on a row that omits a present component no longer implies "absent" — only `drop` does.
- [ ] Delete `STRUCTURAL_SUBJECT_TYPES`-style pathing that exists to express "this row has no
      fields", since existence now says it directly.

**Acceptance.** An entity that drops its only optional component and is re-read reports absent, not
tomblestone-with-default; `has` and `hasNot` are index plans in the recorded plan; the projection
state table has two states per optional component instead of four.

**Depends on.** 3, 4. **Blocks** 6, 9.

---

### 6. `feat(storage)`: component existence index and archetype index

**Why.** Existence and per-component reads need a component-keyed index on both sides. This is the
slice with the only genuine throughput risk in the epic, so it is also the measurement slice.

**Scope.** Three indices, not two. Today's `typeIndex` is doing all three jobs at once, because with
one mandatory component per row they are the same index:

| Index            | Key → value                   | Answers                                                                              |
| ---------------- | ----------------------------- | ------------------------------------------------------------------------------------ |
| `modelIndex`     | model → id set                | `query("note")` — every row of that model, whichever optional components are present |
| `componentIndex` | component → id set            | `has(note/draft)`, existence predicates                                              |
| `archetypeIndex` | sorted component set → id set | skip the intersection when a query names an exact set. **Optional**                  |

`modelIndex` is today's `typeIndex` renamed; it is not the same thing as `archetypeIndex`, and a
model's rows spread across up to 2^n archetypes (n = its optional components). Server side:
`cf_type_entities` → `cf_component_entities` (same key shape and encoding) **for indexed components
only**, plus the model column SQLite already indexes. SQLite keeps one row per entity with
`data.components`, plus an expression index over the component-name set.

**Work.**

- [ ] `Replica`: `modelIndex` and `componentIndex` are required; `iterate(model)` reads
      `modelIndex`, and `has` reads `componentIndex`.
- [ ] `archetypeIndex` is optional: add it only if the measurement shows set intersection dominates a
      plan. Measure intersection against an archetype lookup at n = 2, 4, 8 named components and keep
      the loser out. Do not add it speculatively — a model with 4 optional components spans 16
      archetypes, so the index can grow faster than the rows.
- [ ] `ReplicaChange.components` maintained from the composed view, in `resync`.
- [ ] `cf_component_entities` written once per `(component, entity)`; `cf_type_entities` deleted.
- [ ] SQLite: `json_each(data, '$.components')` expression index; keep `idx_entities_type` on the
      model column for permission and listing paths.
- [ ] IndexedDB: `multiEntry` index on the component-name array; version bump; reset, no migration.
- [ ] **Measure write amplification at k = 2, 4, 8 components per entity** through the real Writer
      pipeline. The `entity_index` ablation in `575-entity-actions.md` puts that column family at
      12–25% of commit cost, so this is the number that decides whether the epic proceeds as
      specified.

**Acceptance.** The k = 2/4/8 table is recorded in the epic and the resulting write cost is
accepted or the design is amended. An existence query touches one index range per component named.
No path reads `type` to find an entity's rows.

**Depends on.** 4, 5.

---

### 7. `feat(client)`: component-granular invalidation

**Why.** Independently valuable even if nothing else lands: today a change to one field of one row
invalidates every cached query over that row's type, and the code calls this "coarse-first". Precise
invalidation is the cheapest quality-of-life win in the epic.

**Scope.** `ReplicaChange.components`; `Plan.readComponents` replacing `readTypes`; `QueryCache`
intersecting on components; a result invalidating only when a component it read changed.

**Work.**

- [ ] `readComponentsFor(query)` derived from the plan, including the edge and membership
      components a projected row carries.
- [ ] `QueryCache` invalidation on component intersection; keep the coarse type path as a
      fallback only while a plan cannot express its reads.
- [ ] A compiled-plan memo keyed by component set, so the intersection is not recomputed per change.

**Acceptance.** A `title` write does not re-run a plan that reads only `status`, asserted against
the recorded plan; a full-scan query still invalidates on any change to a component it scans.

**Depends on.** 6.

---

### 8. `refactor(client)`: `conflictScope: "component"`

**Why.** Folds in the scope half of #781, which is landing with `"field" | "entity"` — the two ends
of a ladder with nothing in between. That missing rung is why `STRUCTURAL_SUBJECT_TYPES` hardcodes
a list of row types that skip conflict detection.

**Scope.** A third scope; the hold keyed per `(entity, component)` instead of per subject;
`STRUCTURAL_SUBJECT_TYPES` replaced by a declaration. #781's verbs, report, and durable-hold
decisions stand unchanged.

**Work.**

- [ ] `conflictScope: "component"` accepted on a component; the default for anonymous components
      stays whatever the model declares today.
- [ ] Subject hold becomes a component hold: a held component does not block a sibling component's
      flush.
- [ ] `conflict-slots.ts` keys on component instead of `subjectType`; `LwwFieldOracle` becomes
      `(component, leaf) => boolean`.
- [ ] The `ebb/link`, `ebb/membership`, and `ebb/groupMember` system components declare their own
      scope, replacing `STRUCTURAL_SUBJECT_TYPES`.
- [ ] `EntityDiff` path reporting gains the component segment.

**Acceptance.** `rg "STRUCTURAL_SUBJECT_TYPES" packages/client/src` returns nothing. Two actors
editing different components of one row do not hold each other; two actors editing the same
component do.

**Depends on.** 4, 6.

---

### 9. `feat(storage)`: residency per component

**Why.** **This slice is load-bearing, not optional.** A document body as a component only pays off
if that component can be windowed: a held note whose 300 KB body is a component is a 300 KB held
row. So residency has to become a component declaration. It is also where #665 lands, and it is the
only slice that adds machinery instead of removing it.

**Scope.** `materialization` moves from `ModelDef` options to component options; the replica's pin
and TTL machinery becomes component-aware; on-demand components are fetched, pinned, and evicted
individually.

**Work.**

- [ ] "A row is resident iff any of its components is held, or the row is pinned."
- [ ] `open`/`close`/`readEntity` address a `(entity, component)`; the cold-read seam returns one
      component's value.
- [ ] `ReplicaStats` reports per-component residency.
- [ ] The `materialization` option on `defineModel` becomes a default for its components.
- [ ] Prove the #775 case end to end: a note whose body is an on-demand component holds 200 bytes
      of metadata and zero body bytes, and opening the body reads one component.

**Acceptance.** A row with one on-demand component and three held components reports exactly one
component non-resident; a cold read reads exactly one component from storage; the 10k-document
benchmark in `503-replica-read-model.md` re-runs with resident bytes attributed per component.

**Depends on.** 5, 6. **Unblocks** #665.

---

### 10. `feat(auth)`: the write is validated against the declared component set

**Why.** The structural fix for #624. Today `subject_type` is client input that reaches the
authorizer, the materialized row's type, the type-entity index, the SQLite type column, and the
client replica's row type, and nothing compares it to the type the id was committed under. Per
`docs/research/624-committed-type-authz.md` that is a live authorization defect. Under components
the claim disappears: the component must be one the model declares, existence is the only
per-row question, and `EntityIndex` stops dispatching on a type string.

**Scope.** Validation that a write's component is declared by the model and allowed on the
unresolved id (structural #624 close); `EntityIndex.resolve_groups/3` dispatching on the system
component rather than the type string; opt-in per-component permissions via `permission: "own"`;
the model→component mapping in the schema hash.

**Work.**

- [ ] Unknown component → rejected at validation, not at authz.
- [ ] `<model>/<component>.<verb>` checked when the component opts in; `<model>.<verb>`
      otherwise; `<model>.*` unchanged.
- [ ] `EntityIndex`: system dispatch becomes component dispatch;
      `resolve_groups_cached("relationship")` reads the edge's own membership (#790) instead of
      `source_id`.
- [ ] Schema hash covers the model→component mapping, so a permission cannot be borrowed across
      models.
- [ ] Close #624 with a test per row of its defect table.
- [ ] Document the read/write asymmetry: field-granular _write_ permissions are available,
      field-granular _read_ permissions are out of scope because read filtering is a fan-out
      property.

**Acceptance.** Every vector in `624-committed-type-authz.md` is a rejected write. `rg
"subject_type" ebb_server/lib` finds nothing. A component not declared by the model cannot be
written by any actor holding any permission.

**Depends on.** 4, 6, 12.

---

### 11. `feat(schema)`: per-component version and read migrations

**Why.** Folds in #124. Versioning by entity type means renaming one field bumps the whole type and
forces one migration function to know every field. Per-component versioning makes read migrations
composable and makes "which declarations changed" answerable.

**Scope.** `version` on a component; a read migration registry keyed `(component, fromVersion)`;
the client compares the stored component version against the declared one at materialization. Up
migrations only, as #124 specifies; the log stays untouched.

**Work.**

- [ ] `version` on `defineComponent`, defaulting to 1; the schema hash covers it.
- [ ] `defineMigration(component, from, to, fn)`; the registry rejects gaps and cycles.
- [ ] Materialization runs migrations per component, memoised by `(component, version)`.
- [ ] `minSupportedVersion` stays per model (it gates the handshake, which is a whole-client
      question), not per component.
- [ ] A component whose stored version exceeds the declared one fails loudly (#698's surface).

**Acceptance.** A renamed leaf on one component migrates without touching the other components of
the same row; a missing migration step fails at boot, not at read.

**Depends on.** 2.

---

### 12. `refactor(storage)`: the four system types become system components

**Why.** #195 exists because the system-entity enumeration is duplicated across `EntityIndex`,
`PermissionHelper`, `Authorizer`, `Writer`, and `SystemCache`, and a fifth system entity
force-edits five files. That is the `type`-doing-six-jobs problem in its purest form. Fixing it
with a constants module keeps the shape and removes one symptom.

**Scope.** `ebb/group`, `ebb/groupMember`, `ebb/membership`, `ebb/link` as components on ordinary
rows; dispatch on the component; the cache tables keyed by component; `ebb/link` declaring its own
conflict scope and its own membership rows per #790.

**The rows stay.** A membership does _not_ become a key on the member's row, and a group member does
not become a key on the group's row. Both are tempting — `ebb/membership: { grp1: {}, grp2: {} }` on
the entity would make "which groups is this in?" a field read with no cache, and cut adding an
entity to three groups from three Updates to one. It fails on the paths #790 exists to fix: group
listing, membership listing, and backfill are **keyset pagination** over ordered rows
(`idx_entities_entity_group_page`, `idx_entities_group_member`, `GroupListing`), and a JSON key set
cannot serve an ordered window. It would also move the delivery scope of a membership change from
the row's own identity to keys inside the payload.

**Rule:** anything you paginate must be a row.

**Work.**

- [ ] Name and register the four system components; `SYSTEM_ENTITY_NAMES` and
      `system_entity_types/0` become component lookups or disappear.
- [ ] `EntityIndex`, `Authorizer`, `Writer`, `SystemCache`, `PermissionHelper` dispatch on the
      component.
- [ ] `ebb/link` carries `source_id`, `target_id`, `type`, `field` as one **atomic** component, so a
      torn edge is unrepresentable.
- [ ] `ebb/membership` carries `entity_id`, `group_id` atomically for the same reason: a torn
      membership is a permission scope change.
- [ ] `ebb/link` owns its `entityGroup` rows (#790); groups resolve from the edge's own membership.
- [ ] **The SQLite read model stops hardcoding system field names.** Eight generated columns
      (`source_id`, `target_id`, `rel_type`, `rel_field`, `actor_id`, `entity_id`, `group_id`,
      `permissions`) and four partial indexes (`WHERE type = 'relationship'` etc.) name both the
      type _and_ the field layout of the system entities. Each path gains a component segment, and
      each `WHERE type = …` guard becomes a component-existence guard that has to be indexable —
      this is the deepest coupling in the slice and the one most likely to be missed.
- [ ] The four bespoke caches (`entity_groups_by_id`, `relationships_by_id`, `group_members_by_id`,
      `entity_types`) are re-derived or collapse; `CacheTables` stops enumerating them by hand.

**Acceptance.** `rg "resolve_groups_cached\(\"relationship\"\)"` and the literal system-type
predicates in `ebb_server/lib` return nothing. A concurrent write cannot produce an edge with a
new target and an old source, or a membership with a mismatched actor and group.

**Depends on.** 4, 8, 10. **Blocked by** #790.

---

## Ordering

```text
1 ADR
└── 2 schema shape
    ├── 3 e.object ─────────────┐
    ├── 4 wire envelope ────────┼── 5 existence ── 6 index ──┬── 7 invalidation
    │                           │                          ├── 8 conflict scope
    │                           │                          ├── 9 residency ── (#665, #775)
    │                           │                          └── 10 authz ── 12 system components
    └── 11 versioning
```

Slices 3 and 11 are parallel lanes: neither blocks the critical path and both are useful alone.

**Slice 9 is on the critical path** because #775's body-as-component is only viable once a component
can be windowed; it is the one slice that adds machinery rather than removing it. Slice 7 is the
cheapest win in the epic and should be pulled forward once 6 lands.

## What it buys, and what it costs

Stated plainly, because the two are not the same currency and conflating them is how this kind of
refactor gets oversold.

**Buys — correctness.** #624 becomes unrepresentable rather than fixed: a write names a component
the model declares, so there is no identity claim to forge. A torn `ebb/link` or `ebb/membership`
becomes unrepresentable, because those components are atomic — today their leaves are four
independent LWW leaves and only `put` keeps them coherent.

**Buys — deleted special cases.** `STRUCTURAL_SUBJECT_TYPES`, the generated document-entity family
(the mechanism; #776 still deletes the call sites), the system-type enumeration across five modules
(#195), the per-type residency plumbing, and `InboundSubject.replaced` all exist because _one_
string had to serve six jobs. This is where most of the diff is, and it is negative.

**Buys — existence as a fact.** Optional data stops being a tombstone that reads like an absence.
Projection loses two of its four states per optional component, and `has()` becomes an index
predicate instead of a null filter.

**Buys — latency.** Component-granular invalidation, projection over the components a caller asked
for, cold reads and backfill sized to a component, and a read cache (#516) that a body write no
longer evicts. These are the real performance wins and they are all latency, not throughput.

**Costs — throughput, slightly.** More Updates per Action (slice 4 measures the delta), and k
rows per entity for the components declared `indexed` (slice 6 measures at k = 2/4/8). Both
are bounded and both are measured before the envelope lands.

**Costs — replica persistence complexity, and it is not optional.** `toRecord` persists held rows on
one rule; partial rows mean a second store keyed by `(entity, component)`. Slice 9 owns this and it
is net new complexity, not a simplification — and #775 cannot land without it.

**Does not buy — throughput.** Nothing in this epic makes a scan faster in a way that shows up in a
benchmark of the current workloads. If the epic is justified on speed it will fail its own
acceptance criteria.

## Non-goals

- **Archetype/chunk storage.** The locality payoff needs dense POD arrays; ebb's rows are
  `Record<string, FieldValue>` in V8 over IndexedDB, and its churn is concentrated in exactly the
  archetype-hostile places — edges, memberships, existence.
- **A system scheduler.** No ordering graph, no frames, no global tick. Local derived components
  run after ingest in arbitrary order and are recomputable.
- **Behaviour on components.** A component with a method is a design failure.
- **Entity id recycling.** Ids are CRDT keys and are referenced from other rows.
- **Field-level read permissions.** A separate fan-out design.
- **Components that carry their own group membership.** That is what entities are for.

## Open questions

1. Does the archetype index earn its keep over intersecting component sets? Slice 6 measures.
2. Is `data: FieldValue` (one component per Update) the right envelope, or does Update-count growth
   dominate payload growth? Slice 4 measures.
3. Should `replace` exist at all, or is `merge` plus an explicit `drop` sufficient? `replace` is
   the only method a keyspace component must refuse, so removing it removes a rule.
4. Does `optional` belong on the component or on the model (a model-level "all components
   optional" default)? Slice 5 decides.
5. How does per-component residency interact with #123's compaction low-water mark?
