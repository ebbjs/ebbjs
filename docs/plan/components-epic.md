# epic(components): components are the unit of identity

Status: accepted, 2026-11-09; renumbered 2026-11-11 and amended for the system-component contract.
Slices 1–7 and 9 landed (#794–#800, #802); 8 and 10–14 open. **Redirects** #775 (a document preset becomes a `ComponentDef`, not
an `EntityDef`, and the body becomes a component of the owning row) and folds in #760, #124, #195,
and the scope half of #781. Does not supersede #790. Rationale and the ECS readings:
[`docs/research/ecs-rearchitecture.md`](../research/ecs-rearchitecture.md).

## Summary

Ebb has one identity per row and it does six jobs. `entity.type` is simultaneously the storage
key (`cf_type_entities`), the query source (`query("note")` → `iterate("note")`), the projection
shape (`projectEntity`), the permission string (`<type>.<verb>`), the residency policy
(`materialization: "held" | "on-demand"`), and the conflict policy (`conflictScope`, plus the
hardcoded `STRUCTURAL_MODELS`). Because it is one immutable string committed by the first
write, **variation in a row is expensive**: optional data has to be a tombstone, large data has to
be a synthetic second entity, and a piece of a row that needs different policy has nowhere to
declare it.

This epic splits those six jobs. A **component** becomes the unit that owns existence, loading,
conflict scope, and version. A **model** — today's `defineEntity` — becomes the name
of a declared component set, used for permissions, query sources, and projection. `type` stops
being identity and becomes a name for a set.

The public API barely moves. A field builder is sugar for an anonymous component, so
`defineModel("note", { title: e.string() })` has the same shape it has today, and every existing
field keeps its meaning — only the factory's name changes. The new surface is one opt-in import, used only where a field needs one of the
four powers.

**The claim this epic can be falsified against:** after it lands, `@ebbjs/core`, `@ebbjs/storage`,
`@ebbjs/client`, and `ebb_server` contain no site that dispatches on a _row type string_ to decide
storage, residency, conflict, existence, or scope behaviour. Type names survive in exactly two
places — the permission string and the query source — and both read from the model.

## The model

```
leaf        the mergeable position: { value, update_id, hlc } or { map: { <key>: leaf } }
component   a named value. One leaf (e.string, e.object) or one key space (e.map, e.log).
            Carries: existence, loading, conflict scope, version, optional own permission.
model     a named component set and the component namespace. What defineModel declares. What
            client.<name> namespaces. Carries: the permission subject, the query source, the typed
            projection. An entity carries one model's components.
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
- A write to a component the model does not declare is rejected by the **client** at validation
  (`ModelRegistry.validateAction`). **The server stays schema-free** and never learns the declared
  set: it checks that every component of a row names the id's committed model, so a component
  cannot borrow another model's permission. It cannot reject an undeclared leaf and does not try.
  That closes #624's identity story without giving the server a schema.
- **The prefix is the brand.** User components are namespaced by their model, so an entity carries
  exactly one _user_ model. `ebb/*` components are the platform's overlay: they may sit on any row,
  are authorized by their own permission, and never change the row's committed model or its model
  entry. Multi-brand _user_ entities are a non-goal.
- A component declared `optional: true` may be absent. A row with zero components is possible and
  means "an id that exists and has nothing attached"; only `delete` removes the id.

### Permissions

- Verbs are unchanged: `create` (first write to a row), `update` (`merge`/`replace`/`drop` on an
  existing row), `delete`, `read`.
- Scale is the model: `<model>.<verb>` and `<model>.*`, checked exactly as
  `PermissionHelper.check_permission/3` does today.
- A component may opt in to its own permission with `permission: "own"`, yielding
  `<model>/<component>.<verb>`. **Off by default for user components**, because permissions are
  about domain objects, not data layout, and a permission per component across a large schema is a
  table nobody can administer. **Required for every `ebb/*` component**, because all four share the
  `ebb` prefix and the model-level string would collapse them to `ebb.create`.
- **Field-level permissions are not in this epic.** Read granularity is a fan-out property — a
  replica is a local copy of everything the client was sent — so field-level _read_ permissions
  would require filtering at the delivery boundary, not a new permission string. That is a
  separate design.

### Invalidation

`ReplicaChange` carries `components: readonly string[]`, and a query plan declares
`readComponents`. The cache tests a change's components against a plan's reads, so a `title` write
stops invalidating a plan that only reads `status`.

What a plan reads depends on what the result keeps. A `collection` result is the matching id list,
so it reads only the components its predicates, ordering, existence tests, and edge/membership
indices name. A `rows` result holds whole projected rows, so it reads every component of its source
and joined models — a projection read a plan cannot narrow until projections are component-scoped.
When a query cannot name the components it depends on (a full scan, or a disjunction with a branch
that only excludes), the plan reads the model whole (`<model>/*`). A change names only its
components: a write that moves a row between models names each field under both prefixes, and a
change that names none (a tombstone or eviction of a row that carried no component) invalidates
every whole-model read. `ReplicaChange.type` is gone with #800.

## Decisions

Decisions 1–13 live in [`docs/adr/0001-component-model.md`](../adr/0001-component-model.md). This
epic schedules them; where the two disagree, the ADR wins. Three arrived with the system-component
contract: 11 (scope is declared per `ebb/*` component), 12 (every `ebb/*` component carries its own
permission), and 13 (system components are atomic and key-immutable).

Two notes this epic owns rather than the ADR:

- **Model is not archetype.** A model is _declared_; an archetype is _actual_. One model's entities
  occupy one archetype per subset of present components.
- **The rename landed in [#795](https://github.com/ebbjs/ebbjs/issues/795).** `defineEntity` was
  already misnamed — it declares a kind of row, not a row. `defineEntity` → `defineModel`,
  `EntityDef` → `ModelDef`, `EntityRegistry` → `ModelRegistry`, `defineSchema({ entities })` →
  `defineSchema({ models })`. Avoid _class_, _table_, _collection_: a model carries data and policy,
  never behaviour.

## Target architecture

```text
schema      defineComponent / defineModel(model)       → Model { components, permission }
            a bare builder is an anonymous component
core        Update { subject_id, component, method, data: FieldValue }
            mergeFieldValue unchanged                  → one convergence definition
protocol    component replaces subject_type            → one Update per (entity, component)
systems     scope table + permission table + projections
            one scope owner per ebb/* component        → replaces resolve_groups_cached/3's cases
storage     derived index (component, id) in ETS    → replaces cf_type_entities, ebb/* first
            replica: modelIndex + componentIndex      → replaces typeIndex
                      (+ archetypeIndex, optional)    → an afterthought, not the model
            ReplicaChange { components }               → replaces { type }
client      query(model) reads declared components    → set intersection, not one Set lookup
            plan.readComponents                        → replaces readTypes
            structural component declaration           → replaces STRUCTURAL_MODELS
auth        component prefix = committed model         → #624 cannot borrow a model's permission
            ebb/* component names its permission       → ebb/group.create, not ebb.create
```

## What this supersedes, folds, or leaves alone

| Issue                                                                                                                                                                                                   | Disposition                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **#760** `e.object`                                                                                                                                                                                     | **Folded in** as sub-issue 3. Do not ship it separately.                                                                                                                                                                                                                                                                                   |
| **#124** schema evolution                                                                                                                                                                               | **Folded in** as sub-issue 14. Per-component `version` replaces per-type.                                                                                                                                                                                                                                                                  |
| **#195** system-type enumeration                                                                                                                                                                        | **Superseded** by sub-issue 10. The constants module is a patch on the problem.                                                                                                                                                                                                                                                            |
| **#781** one generic conflict                                                                                                                                                                           | **Partly folded in** as sub-issue 8 (adds the third scope). Its report/verb decisions stand.                                                                                                                                                                                                                                               |
| **#775** documents / engine presets                                                                                                                                                                     | **Redirected, not superseded.** Its direction holds, but a preset becomes a `ComponentDef` factory rather than an `ModelDef` factory, and an upgrade archives into an archive component instead of a `versions` relationship. #776, #778, #779, #783, #785, #773, #782 keep their scope; #775 decisions 3 and 11 need amending. See below. |
| **#790** relationships as entities                                                                                                                                                                      | **Not superseded.** Slice 10 keeps the edge row (atomic value, immutable source); slice 13 moves it onto its source as a keyed pair. #790 decides whether 13 proceeds.                                                                                                                                                                     |
| **#665** out-of-band payloads                                                                                                                                                                           | Depends on sub-issue 9. Payloads become component-valued.                                                                                                                                                                                                                                                                                  |
| **#664** bytes leaves, **#173** counter fields                                                                                                                                                          | Unaffected — both are leaf-level additions.                                                                                                                                                                                                                                                                                                |
| **#194** cache accessors                                                                                                                                                                                | Still valid; the cache row shapes change under sub-issue 10.                                                                                                                                                                                                                                                                               |
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
const body = yjsDocument(); // defineComponent("…/body", e.log(entry), { loading: "lazy" })
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

**Why the edge question is two steps, not one.** The field's usual answer to relationships is pair
components — `(Likes, Bob)`. #790 shows why an edge cannot own its own group set here: ebb's edges
are permission subjects, and membership attaches to _entities_. Slice 10 therefore keeps the edge
row and makes its value atomic, which kills tearing with today's semantics. Slice 13 then moves the
edge onto its source as a keyed pair, which kills the mirrored `entityGroup` rows (#789's cause) and
the duplicate-edge tolerance layer — an edge then inherits its source's scope by construction.
Steps, not a contradiction: 10 is the row form, 13 is the pair form, and #790 decides whether 13
proceeds.

---

## Sub-issues

Each is independently shippable. Numbers are the current numbering (2026-11-11); the issue that
carries each is listed below. Old references read "slice 12" for the system-component contract —
that is now slice 10, with 11 and 13 splitting the scope table and the link follow-on out of it.

| #   | Issue                                                             | #   | Issue                                                               |
| --- | ----------------------------------------------------------------- | --- | ------------------------------------------------------------------- |
| 1   | [#794](https://github.com/ebbjs/ebbjs/issues/794) ADR             | 8   | [#801](https://github.com/ebbjs/ebbjs/issues/801) conflict scope    |
| 2   | [#795](https://github.com/ebbjs/ebbjs/issues/795) schema shape    | 9   | [#802](https://github.com/ebbjs/ebbjs/issues/802) residency         |
| 3   | [#796](https://github.com/ebbjs/ebbjs/issues/796) `e.object`      | 10  | [#805](https://github.com/ebbjs/ebbjs/issues/805) system components |
| 4   | [#797](https://github.com/ebbjs/ebbjs/issues/797) wire envelope   | 11  | [#819](https://github.com/ebbjs/ebbjs/issues/819) scope table       |
| 5   | [#798](https://github.com/ebbjs/ebbjs/issues/798) existence       | 12  | [#803](https://github.com/ebbjs/ebbjs/issues/803) authz             |
| 6   | [#799](https://github.com/ebbjs/ebbjs/issues/799) component index | 13  | [#820](https://github.com/ebbjs/ebbjs/issues/820) link pair         |
| 7   | [#800](https://github.com/ebbjs/ebbjs/issues/800) invalidation    | 14  | [#804](https://github.com/ebbjs/ebbjs/issues/804) versioning        |

### 1. `design(components)`: ADR — the component model, vocabulary, and boundary

**Why.** `CONTEXT.md` has no entry for component, model, existence, or leaf, and #787's
vocabulary ADR is the natural home. Every later slice depends on the words being settled, and the
two decisions that are expensive to reverse are in this list.

**Scope.** Record in `CONTEXT.md` and an ADR: leaf, component, model, row, existence, loading, residency,
conflict scope, system component, scope owner, grant, system; the value-vs-key-space axis #760
records; the wire envelope from this epic; and the boundary rule — _a component may not own a group
set, it may name the entity whose scope it borrows, and anything you paginate must have rows._

**Work.**

- [ ] `CONTEXT.md`: **leave the app-level Presence section untouched** — it is the ephemeral
      cursor/camera primitive and must not be confused with component existence. Add Component,
      Model, Existence, Leaf; revise Entity, Field, Materialization,
      Conflict.
- [ ] ADR recording Decisions 1–13, with the `type`-survives-as-model limit stated explicitly and
      the `ebb/*` alphabet in Decision 13.
- [ ] Record the three reversal-expensive questions: atomic-vs-keyspace per builder, whether
      opt-in component permissions are worth the table growth, and whether an `ebb/*` component
      may declare its own scope (Decision 11).
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
model declare" and "is this component optional / eager / what scope".

```ts
const title = e.string();                                  // anonymous: note/title
const body  = defineComponent("note/body", { … }, {         // named: the four powers
  optional: true, loading: "lazy", conflictScope: "component",
});
const note  = defineModel("note", { title, status: e.enum([…]), body });
```

**Work.**

- [ ] `defineComponent` + option validation; reject a component whose name is not
      `<model>/<leaf>`-shaped, and reject a component the model does not declare.
- [ ] `defineModel` accepts builders and components in one map; normalisation is total and
      reversible.
- [ ] `ModelRegistry`: `componentsOf(model)`, `componentOf(model, name)`,
      `isOptional`, `loadingOf`, `isStructural`, `conflictScopeOf`, `permissionOf`.
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
Validator, `ActionFormat`, dedup, the scope list (now `subject_scopes` — #814), catch-up frames,
`InboundSubject`, the outbox, and the fixtures move with it.

**Work.**

- [ ] `UpdateSchema` / `UpdateInputSchema` per the epic's wire; `FieldValue` is the only `data`.
- [ ] `method: "replace"` refused for keyspace components, at validation, with the component named.
- [ ] `ActionFormat` rejects the old shape (no read-through; #552 precedent).
- [ ] The append-only guard becomes a **position path** check: `isLogPosition(component, ["updates"])` rather
      than `isLogField(subjectType, field)` (#778). A log now sits at a named position inside a
      component instead of being the whole field, so the guard — and the `refuseContentRewrites`
      special case it replaces — both key on a path.
- [ ] `cf_entity_actions` still coalesces per subject per flush. (#814 superseded the per-component
      scope keying this bullet originally planned: scope belongs to the subject, so the stored frame
      carries one `subject_scopes` entry per subject and nothing is keyed per component.)
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
- [ ] Delete `STRUCTURAL_MODELS`-style pathing that exists to express "this row has no
      fields", since existence now says it directly.

**Acceptance.** An entity that drops its only optional component and is re-read reports absent, not
tomblestone-with-default; `has` and `hasNot` are index plans in the recorded plan; the projection
state table has two states per optional component instead of four.

**Depends on.** 3, 4. **Blocks** 6, 9.

**Current state.** Shipped in [#798](https://github.com/ebbjs/ebbjs/issues/798): `optional` components
refuse a declared default (so absence and a cleared leaf both project as `undefined`), `drop` is an
ordinary client write, and `has`/`hasNot` are existence predicates backed by an in-memory replica
component index and planned ahead of filters. The replica row carries an explicit `exists` bit;
`created_hlc` is the server's first-write stamp and is never a predicate. Three limits are recorded,
not silently resolved: `drop` on a system component is refused until slice 10's `ebb/*` components
owner the torn-edge rules (slice 12 refuses undeclared writes as well); `has`/`hasNot` stay
builder-only because the wire `Filter` has no component predicate until slice 6 owns the server
index (and `hasNot` is an index difference against the model scan, so it costs the row count, not
just an index range); and creating a row with zero components needs a wire `create` (a row-scoped
method or a separate endpoint), so the testing seed keeps its `version` write until a slice changes
the envelope. The client replica record format bumps to 2 for the `exists` bit, which resets local
records rather than migrating them, as decision 9 already allows.

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

**Two parts of that scope were amended in the implementation.**

- **The server is schema-free (#803), so "indexed components only" is not enforceable there.**
  `cf_component_entities` carries a **model entry** `(model, id)` once per row — the existence signal
  `EntityTypeCache` resolves and the row's committed model, which must survive a row dropping its
  last component — plus a **component entry** `(<model>/<field>, id)` for every component a write
  names. A component entry is deleted by `drop`; a row `delete` leaves stale ones (fail-closed, the
  model entry is what remains). The `indexed` flag stays a schema-level intent; enforcing it
  server-side would require the declared set the server must not grow.
- **SQLite cannot index `json_each`.** It is a table-valued function, and SQLite refuses it in an
  index expression (`no such function: json_each`). The row keeps the derived `data.components`
  list — `EntityView` projects it away before the wire — and a normalized
  `entity_components(entity_id, component)` table with `idx_entity_components_component` is the
  indexable form. `idx_entities_type` stays for the model, permission and listing paths.

**Work.**

- [x] `Replica`: `modelIndex` and `componentIndex` are required; `iterate(model)` reads
      `modelIndex`, and `has` reads `componentIndex`.
- [x] `archetypeIndex` is **kept out**. No plan names an exact component set yet: `has` predicates
      intersect the component ranges they name, so there is no archetype lookup to price against
      today. Open question 1 stays open; adding the index speculatively would take the growth risk
      the issue warned about with no reader to pay it back.
- [x] `ReplicaChange.components` maintained from the composed view, in `resync`. It carries the
      components the change touched (present-and-differing fields, plus all of them on a tombstone
      transition), which is what #800 invalidates on.
- [x] `cf_component_entities` written once per `(component, entity)`; `cf_type_entities` deleted.
      (Later moved in memory by #849.)
- [x] SQLite: `data.components` plus the normalized `entity_components` mirror (see the amendment
      above); `idx_entities_type` kept.
- [x] IndexedDB: `multiEntry` index on the component-name array; version 11; reset, no migration.
- [x] **Measure write amplification at k = 2, 4, 8 components per entity** through the real Writer
      pipeline (`mix bench.component_index`). Table below; the cost is accepted.
- [x] #813's empty-scope delivery hole: the Writer's `fan_out_preference` now reads the row shape
      earlier Actions of the same flush left behind (`:flush_rows`), so a `groupMember`/`entityGroup`
      or `relationship` write that names only one component still carries its group/source. It is no
      longer committed undeliverable, and the stored `subject_scopes` / `cf_group_actions` row are
      what catch-up and fan-out read. The issue's second clause — reject an Action whose scope is
      still `[]` — is **not** taken: a row that genuinely belongs to no group (an unshared user row)
      is legal today, and rejecting would change authorization rather than delivery. A system row
      that cannot name its group/source now falls back to the flush row before it can reach `[]`.

**Acceptance.** The k = 2/4/8 table is recorded in the epic and the resulting write cost is
accepted or the design is amended. An existence query touches one index range per component named
and filters the row-level tombstone: `ComponentEntityIndex.component_entry_ids/2` is the raw range
on the in-memory index (a delete leaves its entries as candidates), and
`SQLite.query_component_ids/2` joins `deleted_hlc IS NULL` on the read model. No scan path reads `type` to find an entity's rows:
`iterate` reads `modelIndex`, and the server's model entries are existence and committed-model
lookups, not row scans. The SQLite listing paths keep `idx_entities_type`, as this slice's scope
says they do.

**Depends on.** 4, 5.

**Current state.** Shipped in [#799](https://github.com/ebbjs/ebbjs/issues/799), then the index's
storage became derived state in [#849](https://github.com/ebbjs/ebbjs/issues/849): the column
family is gone, the Writer applies the same ops to an in-memory ETS index after the range is
durable, and every boot reconstructs it by replaying `cf_actions`. The key kinds, writers, and
readers are unchanged; the resident set is the documented gate. The client replica's
`typeIndex` is `modelIndex`; `ReplicaChange` carries `components`; the IndexedDB `entities` store has
a `multiEntry` component index that `EntityStore.queryByComponent` reads; the schema bump to 11
resets rather than migrating. On the server, the derived component index replaces
`cf_type_entities` with a model entry plus a component entry per component, `SystemCache` boot
replays the log to rebuild both, and a drop deletes its component entry while a delete leaves the
model entry and the row's component entries in place (the entries are existence candidates; the
row tombstone is the liveness filter). SQLite mirrors components into `entity_components` and answers
`query_component_ids/2` from `idx_entity_components_component`. The k = 2/4/8 Writer measurement is
recorded below and the cost is accepted. The server read seam is exercised by tests but is not yet a
wire query: `has`/`hasNot` remain builder-only (#798's limit) until a slice owns the component
predicate; the client replica's `has` already reads its component index. Five things are recorded
rather than resolved:
`ReplicaChange.type` is removed by #800; `archetypeIndex` is out until a plan can name an exact
component set; the server indexes every component because #803 forbids it a schema; the SQLite
expression index is the normalized mirror because `json_each` cannot be indexed; and a row `delete`
leaves its component entries as existence candidates, with the row tombstone the liveness filter.

---

### 7. `feat(client)`: component-granular invalidation

**Why.** Independently valuable even if nothing else lands: today a change to one field of one row
invalidates every cached query over that row's type, and the code calls this "coarse-first". Precise
invalidation is the cheapest quality-of-life win in the epic.

**Scope.** `ReplicaChange.components`; `Plan.readComponents` replacing `readTypes`; `QueryCache`
intersecting on components; a result invalidating only when a component it read changed.

**Work.**

- [x] `readComponentsFor(query)` derived from the plan, including the edge and membership
      components a projected row carries.
- [x] `QueryCache` invalidation on component intersection; keep the coarse type path as a
      fallback only while a plan cannot express its reads.
- [x] A compiled-plan memo keyed by component set, so the intersection is not recomputed per change.

**Acceptance.** A `title` write does not re-run a plan that reads only `status`, asserted against
the recorded plan; a full-scan query still invalidates on any change to a component it scans.

**Depends on.** 6.

**Current state.** Shipped in [#800](https://github.com/ebbjs/ebbjs/issues/800).
`Plan.readComponents` records the components a plan's operations read; `rowReadComponentsFor(query)`
is the superset a projected-row result reads (every component of the source and each joined model,
plus membership for the `groupIds` each row carries), kept out of the plan so the execution path
never computes it. `readComponentsFor(query)` derives the first
set from the query alone: the fields its predicates and ordering name, the components its existence
tests name, the edge and membership models an adjacency/membership predicate or join reads, and
`<model>/*` when no branch requires a source component. `QueryCache` compiles each dependency set
once — memoised by component set and shared by every entry that reads it — and a change matches when
it names an exact component, a component of a model read whole, or no component at all (which every
whole-model read treats as a hit). Two things are recorded rather than resolved: the `rows` surface
stays coarse on its source because a projected row carries the whole shape, so the acceptance's
`title`-versus-`status` precision is asserted against a collection plan and its recorded plan; and a
`type`-free journal is what covers a tombstoned row that carried no component, at the price of
invalidating every whole-model read rather than one model's.

---

### 8. `refactor(client)`: `conflictScope: "component"`

**Why.** Folds in the scope half of #781, which is landing with `"field" | "entity"` — the two ends
of a ladder with nothing in between. That missing rung is why `STRUCTURAL_MODELS` hardcodes
a list of row types that skip conflict detection.

**Scope.** A third scope; the hold keyed per `(entity, component)` instead of per subject;
`STRUCTURAL_MODELS` replaced by a declaration. #781's verbs, report, and durable-hold
decisions stand unchanged.

**Work.**

- [x] `conflictScope: "component"` accepted on a component; the default for anonymous components
      stays whatever the model declares today.
- [x] Subject hold becomes a component hold: a held component does not block a sibling component's
      flush.
- [x] `conflict-slots.ts` keys on component instead of `subjectType`; `LwwFieldOracle` stays
      `(model, component) => boolean` and the hold key becomes `(subject, component)`.
- [x] The `ebb/link`, `ebb/membership`, and `ebb/grant` system components declare their own
      scope, replacing `STRUCTURAL_MODELS`.
- [x] `EntityDiff` path reporting gains the component segment.

**Acceptance.** `rg "STRUCTURAL_MODELS" packages/client/src` returns nothing. Two actors
editing different components of one row do not hold each other; two actors editing the same
component do.

**Depends on.** 4, 6.

**Current state.** Shipped in [#801](https://github.com/ebbjs/ebbjs/issues/801). Scope resolves per
component from the registry (`conflictScopeOf(model, component)`), and the outbox keys its durable
hold by `(subject, component)`: a field- or component-scope loss holds the contested component, and
an entity-scope loss holds the whole subject. The persisted conflict payload changed shape, so a
store from an earlier release is discarded at v12 rather than read. A component-scope slot names
the component as a whole (`path: []`), while
a field-scope slot keeps its map-key path. `STRUCTURAL_MODELS` is gone: `relationship`,
`entityGroup`, and `groupMember` declare `structural: true` on every component, and a
schema-less client resolves those static declarations without a per-client registry. `EntityDiff`
now reports `component` (the full `<model>/<field>` name) beside `path`. `LwwFieldOracle` stays
`(model, component) => boolean`, as the issue required; the epic's `(component, leaf)` sketch was
not needed.

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

- [x] "A row is resident iff any of its components is held, or the row is pinned."
- [x] `open`/`close`/`readEntity` address a `(entity, component)`; the cold-read seam returns one
      component's value.
- [x] `ReplicaStats` reports per-component residency.
- [x] The `materialization` option on `defineModel` becomes a default for its components.
- [x] Prove the #775 case end to end: a note whose body is an on-demand component holds 200 bytes
      of metadata and zero body bytes, and opening the body reads one component.

**Acceptance.** A row with one on-demand component and three held components reports exactly one
component non-resident; a cold read reads exactly one component from storage; the 10k-document
benchmark in `503-replica-read-model.md` re-runs with resident bytes attributed per component.

**Depends on.** 5, 6. **Unblocks** #665.

**Current state.** Shipped in [#802](https://github.com/ebbjs/ebbjs/issues/802).
`MaterializationPolicy.holds` takes a component (`<model>/<leaf>`) rather than a row type, and the
client derives it from `ModelRegistry.loadingOf`, so a model-level `materialization: "on-demand"`
seeds `lazy` on each of its components and a single lazy component on a held model works without a
model declaration. The replica's base row is partial: it carries held and pinned component values,
while `dormant` names the components it knows exist without holding. `components()` reads held and
dormant presence, so `has()` still answers on an unopened body, and a component the replica never
retains does not advance the row's metadata or journal a change. Pins are keyed
`(entity, component)`, so `open(id, component)` reads exactly that component through the
`readComponent` seam and `close(id, component)` releases exactly it; there is no row-level open.
`pinnedCapacity` and the TTL count component pins, and `ReplicaStats.pinned` is the pin count
per component (`pinnedComponents` splits it by name). `ReplicaStats` adds `components`,
`residentComponents`, `heldComponents`, `pinnedComponents`, `nonResidentComponents`, and
`nonResident`.

Three limits are recorded rather than resolved. `toRecord` bumps the replica record to format 3:
persisted rows carry their held components and `notResident` carries the absent components'
existence, so a restart keeps `has(note/body)` without the body. The local `EntityStore` is still
row-shaped, so `readComponent` projects a component out of one by-id row read; a per-component
store read is #665's payload path, not this slice's. And a row that carries no component stays
resident even though the rule says "any component is held": there is nothing to retain, and its
existence must survive so a later component write attaches to it.

---

### 10. `refactor(storage)`: the four system types become `ebb/*` components

**Why.** #195 exists because the system-entity enumeration is duplicated across `EntityIndex`,
`PermissionHelper`, `Authorizer`, `Writer`, and `SystemCache`, and a fifth system entity force-edits
five files. That is the `type`-doing-six-jobs problem in its purest form, and a constants module
removes one symptom of it. Naming the four as components is also what makes the torn-value defects
unrepresentable: today `ebb/link` is four independent LWW leaves and `ebb/membership` is two, so a
concurrent partial write can produce an edge with a new target and an old source, or a membership
whose `group_id` disagrees with its row id.

**Scope.** `ebb/group`, `ebb/grant` (today's `groupMember`), `ebb/membership` (today's
`entityGroup`), and `ebb/link` (today's `relationship`) as atomic components on ordinary rows; each
declares `permission: "own"` (Decision 12) and its own conflict scope; dispatch on the component;
`SYSTEM_ENTITY_NAMES`, `RESERVED_ENTITY_NAMES`, `PermissionHelper.system_models/0`, and
`GroupListing`'s copy disappear. **Membership and its pair are immutable after create** (Decision
13): re-pointing an existing `ebb/membership` is refused, and moving an entity between groups is a
delete plus a create.

**The rows stay.** A membership does not become a key on the member's row, and a grant does not
become a key on the group's row. Both are tempting — `ebb/membership: {grp1: {}, grp2: {}}` would
make "which groups is this in?" a field read and cut filing into three groups from three Updates to
one — and both fail on the same rule: **anything you paginate must have rows.** Group and membership
listing are keyset pagination over `idx_entities_entity_group_page`, `idx_entities_group_member`, and
`GroupListing`, and a JSON key set cannot serve an ordered window.

**Work.**

- [ ] Name and register the four components; delete the four enumerations.
- [ ] `ebb/link` carries `source_id`, `target_id`, `type`, `field` as one **atomic** value, so a
      torn edge is unrepresentable.
- [ ] `ebb/membership` carries `entity_id`, `group_id` as one atomic value and refuses a re-point;
      `ebb/grant` carries `actor_id`, `group_id`, `permissions` atomically for the same reason.
- [ ] `ebb/*` components declare `permission: "own"` and their own conflict scope.
- [ ] An `ebb/*` write never re-models its host: the existence index's model entry is the row's
      committed model, so an overlay component adds only its component entry. `RowMutations`'
      folded model must resolve the committed model for an `ebb/*`-only write instead of reporting
      `ebb`. (#799 owns the index; this is the rule it recorded as a departure.)
- [ ] **The SQLite read model stops hardcoding system field names.** Eight generated columns
      (`source_id`, `target_id`, `rel_type`, `rel_field`, `actor_id`, `entity_id`, `group_id`,
      `permissions`) and four partial indexes (`WHERE type = 'relationship'` etc.) name both the
      type _and_ the field layout of the system entities. Each path gains a component segment, and
      each `WHERE type = …` guard becomes a component-existence guard that has to be indexable —
      this is the deepest coupling in the slice and the one most likely to be missed.
- [ ] Re-derive the bespoke caches only where the component makes them redundant:
      `entity_groups*`, `group_members*`, and `entity_types` survive (membership, grants, and the
      committed model stay rows); `relationships*`' forward half goes with slice 13.

**Acceptance.** No module in `ebb_server/lib` dispatches on a model string to decide storage,
conflict, or existence behaviour. A concurrent write cannot produce an edge with a new target and
an old source, a membership with a mismatched pair, or a membership re-pointed in place.

**Depends on.** 4, 6, 8. **Not blocked by** #790.

**Current state.** Shipped in [#805](https://github.com/ebbjs/ebbjs/issues/805).
`@ebbjs/schema`'s `ebbSystemEntity` is the one model carrying `ebb/group`, `ebb/grant`,
`ebb/membership` and `ebb/link`; the names and the value readers live in `@ebbjs/core`, and
`SYSTEM_ENTITY_NAMES`, `RESERVED_ENTITY_NAMES`, `PermissionHelper.system_models/0` and
`GroupListing`'s copy are gone (the reserved name is now the platform namespace, `ebb`). Each row is
one atomic component value, written by one Update: `Relationship` became `ebb/link`,
`groupMember` became `ebb/grant`, `entityGroup` became `ebb/membership`, and a group is
`ebb/group`. On the server, `Storage.SystemComponent` is the only module that names them, the fold
carries the row's components and kind, and every dispatch that was on a model string now reads that
kind (`EntityIndex.kind/2` answers it for a delete, which names no component). Atomicity deleted
machinery rather than moving it: the cache planner projects the whole value with no "wire wins, cache
supplies the rest" merge, and decision 13 makes the membership pair, a grant's `group_id` and a
link's `source_id` immutable, so a move is a delete plus a create (the old "needs the permission in
both groups" rule is gone). Permission subjects are `ebb/<leaf>.<verb>`, which preserves the four
distinct grants. SQLite follows the value into the component and guards each listing on the
generated column's non-nullness — the component-existence guard, and indexable; `EXPLAIN QUERY PLAN`
tests pin all four listings, and the read model now carries a schema version so an upgraded database
is rebuilt from the Action log instead of answering empty pages. Four things are recorded rather
than resolved: a group's `apps` is a **list of app ids** rather than a map, because `e.object`
refuses a nested map (absent is unscoped, `[]` is nobody, and a scope edit writes the whole value);
`drop` of a platform component is still refused by the client's write path, as #798 left it;
decision 12's `ebb/*` overlay on a user row is #820's, so the validator refuses two component
prefixes on one subject and the overlay has no write path; and a delete whose id nothing models keeps
its kind `nil`, which is the pre-existing unresolvable-delete behaviour. `EntityIndex`'s scope
resolution still dispatches on the kind — that table is slice 11.

---

### 11. `refactor(storage)`: scope resolution is a declared table

**Why.** `EntityIndex.resolve_groups_cached/3` is five function heads — one per system model — and
`Authorizer` carries ~200 lines of prose explaining which model resolves through which field. That
is a system layer written as string dispatch. Decision 11 makes the scope owner a declaration on
the component, so the surface becomes a table read plus one recursion, and a fifth `ebb/*` component
is added in one place.

**Scope.** `scope: "self" | "<field>"` on `ebb/*` components; `EntityIndex.resolve_groups*` and
`fan_out_preference` driven by the declaration; `PermissionHelper`'s system-model list gone; the
`intra_action`/`Overlay` snapshot rule stated once, as the predicate class's read rule (stored state
plus this Action's own prefix).

| Component        | Scope owner             |
| ---------------- | ----------------------- |
| `ebb/group`      | `self`                  |
| `ebb/grant`      | `group_id`              |
| `ebb/membership` | `group_id`              |
| `ebb/link`       | `source_id`             |
| anything else    | the entity's membership |

Groups and grants carry no membership row: a group's scope is itself and a grant's is the group it
names. `ebb/membership` is never written for either.

**Work.**

- [ ] `scope:` accepted on `ebb/*` only; a user component that declares one is rejected at schema
      load, because a component that can name a group could mint its own delivery scope.
- [ ] `EntityIndex`: one table read plus one recursion, replacing the five clauses.
- [ ] `fan_out_preference` reads the declaration rather than naming `relationship`/`entityGroup`/
      `groupMember`.
- [ ] A membership write's scope is the `old ∪ new` group set; the authorizer checks the entity's
      `<model>.update` in the old set and `ebb/membership.create` in the new one.
- [ ] Delete `PermissionHelper.system_models/0` and `GroupListing`'s copy.
- [ ] Record the snapshot rule: predicates read stored state unioned with the current Action's
      earlier Updates, never the caches.
- [ ] Delete the model-string dispatch in `EntityIndex`, `Writer`, `SystemCache`, and `Authorizer`.

**Acceptance.** No module dispatches on a model string to decide scope. Adding a fifth `ebb/*`
component changes one registration and no dispatch site. Every #624/#623/#789 vector still rejects.

**Depends on.** 10. **Blocks** 12, 13.

---

### 12. `feat(auth)`: per-component permissions, with the server schema-free

**Why.** The declaration half of the identity story, with one hard constraint: **the server stays
schema-free.** The wire no longer carries `subject_type` (#797), so the forgeable identity claim is
gone, and #624's committed-model check landed separately in #639. The client refuses a component its
model does not declare (`ModelRegistry.validateAction`); the server cannot, because it has no schema
and must not grow one. What the server can enforce is that a component's prefix is the id's
committed model, so a component cannot borrow another model's permission.

**Scope.** Committed-model enforcement (already in the Authorizer; keep and test it); per-component
permissions from Decision 12; the model→component mapping in the schema hash (already covered by
`computeSchemaHash`); the scope table from slice 11 consumed here, not re-derived. No server-side
schema, registry, or declared-set validation.

**Work.**

- [x] The client rejects a component the model does not declare (`ModelRegistry.validateAction`).
- [ ] The server rejects a component whose prefix is not the id's committed model, and never
      consults a schema. A component `note/<anything>` under committed model `note` is accepted;
      record that as the accepted residual (no privilege escalation — the actor already holds
      `<model>.<verb>`).
- [ ] `ebb/<component>.<verb>` checked when the component declares `permission: "own"`;
      `<model>.<verb>` otherwise; `<model>.*` unchanged.
- [x] Schema hash covers the model→component mapping, so a permission cannot be borrowed across
      models.
- [ ] Keep #624's committed-model regression tests green (#639), and add a vector for a component
      whose prefix matches the committed model but whose leaf is undeclared.
- [ ] Document the read/write asymmetry: field-granular _write_ permissions are available,
      field-granular _read_ permissions are out of scope because read filtering is a fan-out
      property.

**Acceptance.** The server reads no schema: no component registry, schema file, or declared-set
lookup exists in `ebb_server/lib`. Every vector in `624-committed-type-authz.md` stays a rejected
write. A component whose prefix is not the id's committed model is refused. An undeclared leaf under
the committed model is refused by the client and accepted by the server; the slice records that as
an accepted residual, because it grants no authority the actor did not already have.

**Depends on.** 4, 6, 11.

---

### 13. `refactor(storage)`: `ebb/link` becomes a keyed pair on its source

**Why.** `docs/research/membership-and-links-as-components.md` argues the edge row is a
denormalized index of its endpoints' scopes, and that #789 is what that denormalization does when
its input moves. If a link names its source and lives on it, its delivery scope is the source's by
construction, forward traversal becomes a component read, duplicate edges become unrepresentable,
and a link a replica missed arrives with its source during backfill — which today it never does.

**Scope.** `ebb/link` moves from an atomic value on its own row to a keyed component of its source;
the edge row and the `entityGroup` rows it mirrors are deleted; the forward half of
`RelationshipCache` and the `rowId → yieldedId` layer of `reverse-index.ts` go; the server keeps an
**in-memory** reverse index `(type, target_id) → source ids`, with no column family. `contained: true` becomes a resolution-time rule
(`source ∪ target`).

**The gate.** Price the containment hop inside the authorizer against the ~21k Actions/s budget
before committing; `docs/research/membership-and-links-as-components.md` §6 is the measurement.

**Work.**

- [ ] `ebb/link` as a keyed component of the source; one Update per `(source, field, target)`.
- [ ] Delete the edge row, the mirrored `entityGroup` rows, `RelationshipCache`'s forward direction,
      and `reverse-index.ts`'s row layer.
- [ ] Server reverse index `(type, target_id) → source ids` in memory, rebuilt at boot like the
      component index (#849).
- [ ] `contained: true` as a resolution-time union; measure the hop.
- [ ] Backfill: a missed link arrives with its source; assert it.
- [ ] The source keeps its committed model: `ebb/link` is an overlay component, so it adds a
      component entry and leaves the source's model entry alone (slice 10's rule).

**Acceptance.** Duplicate `(source, field, type, target)` edges are unrepresentable. Moving a source
never leaves a link in a stale group (#789). The containment hop is measured and recorded.

**Depends on.** 11. **Blocked by** #790.

---

### 14. `feat(schema)`: per-component version and read migrations

**Why.** Folds in #124. Versioning by entity type means renaming one field bumps the whole type and
forces one migration function to know every field. Per-component versioning makes read migrations
composable and makes "which declarations changed" answerable.

**Scope.** `version` on a component; a read migration registry keyed `(component, fromVersion)`;
the client compares the stored component version against the declared one at materialization. Up
migrations only, as #124 specifies; the log stays untouched.

**Work.**

- [x] `version` on `defineComponent`, defaulting to 1; the schema hash covers it.
- [x] `defineMigration(component, from, to, fn)`; the registry rejects gaps and cycles.
- [x] Materialization runs migrations per component, memoised by `(component, version)`.
- [x] `minSupportedVersion` stays per model (it gates the handshake, which is a whole-client
      question), not per component.
- [x] A component whose stored version exceeds the declared one fails loudly (#698's surface).

**Acceptance.** A renamed leaf on one component migrates without touching the other components of
the same row; a missing migration step fails at boot, not at read.

**Depends on.** 2.

**Current state.** Shipped in [#804](https://github.com/ebbjs/ebbjs/issues/804). `version` is
declared on `defineComponent` (an integer >= 1, default 1) and is already in the schema hash
through the model's component map. `defineMigration(component, from, to, fn)` declares one up step;
`defineSchema({ migrations })` builds the registry and validates it at boot: every step names a
declared component, the chain starts at 1, is contiguous and acyclic, and lands exactly on the
declared version, so a missing step throws from `defineSchema` rather than surfacing on a read. The
replica persists a `componentVersions` map beside a record's rows and bumps the record to format
4, stamps a write at the declared version, and exposes
`componentVersion(id, component)`. Projection (`projectEntity` / `projectedFieldValue`) applies the
composed chain, memoised per `(component, from, declared)` with a projected map memoised by value
identity; a stored version above the declaration throws `ComponentVersionAheadError`.
`minSupportedVersion` stays the schema's handshake floor, not a per-component declaration.

Three limits are recorded rather than resolved. The wire and the log carry no version, so a value
this session materialized from the log or a cold read is assumed current: read migrations cover
the client's own persisted upgrade path, not data another client wrote against an older schema.
Migrations run at projection, so the materialized base keeps the stored shape — `replica.get`,
`toRaw()`, conflict slots, and history read the log-side value, while projected rows, ordering, and
the relationship/membership/reverse accessor chains see the migrated one. A forward-one accessor
returns the stored `Entity` and a field _filter_ still compares the stored wire value, so a renamed
leaf is not visible there until the discipline's write populates it. And `defineComponent` now
validates `version`, so a non-integer or non-positive declaration fails at construction instead of
being stored and comparing oddly.

---

## Ordering

```text
1 ADR
└── 2 schema shape
    ├── 3 e.object ─────────────┐
    ├── 4 wire envelope ────────┼── 5 existence ── 6 index ──┬── 7 invalidation
    │                           │                          ├── 8 conflict scope
    │                           │                          ├── 9 residency ── (#665, #775)
    │                           │                          └── 10 system components
    │                           │                                └── 11 scope table
    │                           │                                      ├── 12 authz
    │                           │                                      └── 13 link pair ── (#790)
    └── 14 versioning (parallel)
```

Slices 3 and 14 are parallel lanes: neither blocks the critical path and both are useful alone.

**Slice 9 is on the critical path** because #775's body-as-component is only viable once a component
can be windowed; it is the one slice that adds machinery rather than removing it. Slice 7, the
cheapest win in the epic, shipped once 6 landed.

**The system-component contract is 10 → 11 → 12.** Naming and atomicity (10) is a pure rename plus
immutability with today's semantics, so it lands first and unblocks the table (11); authz (12)
consumes the table instead of re-deriving it, which is why it moved behind them. Slice 13 is the
follow-on the research note argues for and is gated on #790 and the containment hop.

## What it buys, and what it costs

Stated plainly, because the two are not the same currency and conflating them is how this kind of
refactor gets oversold.

**Buys — correctness.** #624 becomes unrepresentable rather than fixed: a write names a component
the model declares, so there is no identity claim to forge. A torn or re-pointed `ebb/link`,
`ebb/membership`, or `ebb/grant` becomes unrepresentable, because those components are atomic and
key-immutable. And scope stops being something five modules each derive differently: one
declaration per `ebb/*` component decides it.

**Buys — deleted special cases.** `STRUCTURAL_MODELS`, the generated document-entity family
(the mechanism; #776 still deletes the call sites), the system-type enumeration across five modules
(#195), the five-clause scope dispatch in `EntityIndex` with its ~200 lines of authorizer prose, the
per-type residency plumbing, and `InboundSubject.replaced` all exist because _one_ string had to
serve six jobs. This is where most of the diff is, and it is negative.

**Buys — existence as a fact.** Optional data stops being a tombstone that reads like an absence.
Projection loses two of its four states per optional component, and `has()` becomes an index
predicate instead of a null filter.

**Buys — latency.** Component-granular invalidation, projection over the components a caller asked
for, cold reads and backfill sized to a component, and a read cache (#516) that a body write no
longer evicts. These are the real performance wins and they are all latency, not throughput.

**Costs — throughput, measured, and not slight.** Five components per edit is +50% Action payload
and, at the hot write path, −28% accepted Actions/s with +70% p95 (slice 4). A single-field write is
unchanged; creates and multi-component edits pay. The same per-Update cost is why atomic system
components matter: one Update for a whole membership or edge instead of two or four. Slice 6 adds
`k + 1` index entries per row against one before — 11–21% of accepted Actions as k goes 2 → 8,
rising with the component count — and the schema-free server indexes every component rather than an
`indexed` subset, because it has no schema to read the flag from (decision 8's opt-in stays a
client-side intent).

**Costs — replica persistence complexity, and it is not optional.** `toRecord` persists held rows on
one rule; partial rows mean a second store keyed by `(entity, component)`. Slice 9 owns this and it
is net new complexity, not a simplification — and #775 cannot land without it.

**Does not buy — throughput.** Nothing in this epic makes a scan faster in a way that shows up in a
benchmark of the current workloads. If the epic is justified on speed it will fail its own
acceptance criteria.

## Measurement: the envelope's cost (slice 4, #797)

Two measurements, both on `recsy-vps` (AMD EPYC 7763, 4 schedulers, Elixir 1.17.3 / OTP 27),
both reproducible from the tree:

**Payload.** `mix bench.components` builds one logical five-field `update()` in both shapes.
It is the counterfactual the epic priced, as a number:

| Measure                           | Row record (before) | Components (after) |  Delta |
| --------------------------------- | ------------------: | -----------------: | -----: |
| Updates per edit                  |                   1 |                  5 |     +4 |
| Stored `cf_actions` payload (ETF) |               764 B |            1,148 B | +50.3% |
| Request body (JSON)               |               630 B |              948 B | +50.5% |

**Commit throughput.** `mix bench.actions --tier t0 --duration 20 --concurrency 8
--batch-size 100 --distribution hot` — the real `Writer`, no HTTP, `sync: true` — with the
logical Action held constant: one `todo` row write (3 components) plus its `entityGroup` row
(2 components). Before the envelope that Action is 2 Updates carrying 5 field leaves; after it
is 5 Updates carrying one component value each. Three runs per side, paired on an otherwise idle
machine (the "before" tree is `origin/main` in a separate checkout); median, with the range in
brackets:

| Measure                            | Before (2 Updates)    | After (5 Updates)   | Delta |
| ---------------------------------- | --------------------- | ------------------- | ----: |
| Accepted Actions/s (logical edits) | 10,030 (9,665–10,600) | 7,200 (7,200–7,255) |  −28% |
| Updates/s committed                | 20,060                | 36,000              |  +79% |
| Client p50 per Action              | 89.7 ms               | 101.5 ms            |  +13% |
| Client p95 per Action              | 103.1 ms              | 175.2 ms            |  +70% |

**What it says.** The cost is per Update, not per byte: Updates/s rises by half while logical
edits/s falls by a third, and the payload grows only 50% for five components because each
Update's fixed envelope is paid once per component. A single-field write is one Update in both
envelopes, so the common edit is free; the cost is paid exactly by writes that touch many
components at once — creates, and multi-field edits. That is the throughput figure the epic's
original guess — "costs — throughput, slightly" — was hedging on, and it is steeper at the hot
write path than "slightly": at 8 callers and a 400-Action flush, roughly a quarter of the accepted
write rate moves from doing useful edits to carrying per-Update overhead. The latency figures are the same
effect at flush granularity, not a second cost. Slice 4 also removed the Writer's per-flush
quadratic list build, which recovered ~17% of this path on its own; the remaining gap is the
envelope's fixed cost per component.

The open question this answers (below, question 2) is whether Update-count growth dominates
payload growth. It does not dominate payload — payload is sublinear in fields — but it is the
measure that matters for throughput, and it is bounded by how many components a write touches
rather than by how much data it carries.

## Measurement: the component index (slice 6, #799)

`mix bench.component_index` writes a fixed 20,000-Action workload through the real `Writer` (sync
durability, no HTTP, eight concurrent callers, 25 Actions per call) on a fresh database after a
2,000-Action warm-up. Each Action creates a k-component `todo` row plus its `entityGroup` row. The
three arms are interleaved inside every run. Five runs per k; medians, with the range in brackets.
`Added cost` is the ratio of the two displayed medians. Host: 4 vCPU, 15 GB, Elixir 1.17.3 / OTP 27.

| Measure                                      |               k = 2 |               k = 4 |               k = 8 |
| -------------------------------------------- | ------------------: | ------------------: | ------------------: |
| Index entries added per entity               |                   2 |                   4 |                   8 |
| Index key bytes added per entity             |                  68 |                 136 |                 272 |
| Actions/s, model entry only (before)         | 4,853 (4,651–5,045) | 3,783 (3,621–4,099) | 3,080 (2,855–3,272) |
| Actions/s, model + component entries (after) | 4,166 (3,754–4,511) | 3,383 (2,325–3,769) | 2,433 (2,276–2,673) |
| Added commit cost                            |               14.2% |               10.6% |               21.0% |
| Actions/s, no index (context only)           |               5,270 |               4,340 |               3,222 |

**What it says.** The added cost is noisy across passes — two independent five-run passes put k = 2
at 11–14%, k = 4 at 11–15%, and k = 8 at 21% both times — so read it as roughly 10–15% through
k = 4 and 21% at k = 8. The table above is the pass the tree produces. That is the price of the
index rows, and it is linear in components: each entry is its own RocksDB
op with an empty value, so a row with k components writes k + 1 entries — k component entries plus
the model entry that keeps the row's existence and committed model — against one before. At k = 8
that is nine times the index rows for the same row. The cost is accepted for the measured range:
21% at the largest set still leaves the write path dominated by the log and the payload, and the
common single-field edit adds exactly one component entry over the old shape. The share is not
flat, though — a model that puts many components on one row pays proportionally, which is the case
#815's "index only declared components" candidate exists for.

**What it does not say.** Absolute rates are this host's and will not reproduce elsewhere. The
no-index arm is context only: it removes the model entry as well, so it is not the pre-#799 shape,
and its ranges are wider. It does not answer open question 1: no client plan names an exact component
set, so there is still no archetype lookup to price against intersection, and `archetypeIndex` stays
out.

## Non-goals

- **Archetype/chunk storage.** The locality payoff needs dense POD arrays; ebb's rows are
  `Record<string, FieldValue>` in V8 over IndexedDB, and its churn is concentrated in exactly the
  archetype-hostile places — edges, memberships, existence.
- **A system scheduler.** No ordering graph, no frames, no global tick. Local derived components
  run after ingest in arbitrary order and are recomputable.
- **Behaviour on components.** A component with a method is a design failure.
- **Entity id recycling.** Ids are CRDT keys and are referenced from other rows.
- **Field-level read permissions.** A separate fan-out design.
- **Components that own a group set.** A component may name the entity whose scope it borrows —
  that is how `ebb/link` and `ebb/grant` work — but it never owns memberships of its own.
- **Membership as a pair component on the member.** Anything you paginate must have rows, and group
  listing is keyset pagination. Recorded so it is not re-derived.
- **Multi-brand entities.** One entity carries one model's components; a component name is
  namespaced by its model. Removing that would give the server a schema.

## Open questions

1. Does the archetype index earn its keep over intersecting component sets? **Not measured, and
   kept out.** No client plan names an exact component set today — `has` predicates intersect the
   component ranges they name — so there is no archetype lookup to price. Revisit when a plan can
   supply its exact set; slice 6's structural write cost is measured below.
2. Is `data: FieldValue` (one component per Update) the right envelope, or does Update-count growth
   dominate payload growth? **Measured in slice 4** (see [Measurement](#measurement-the-envelopes-cost-slice-4-797)):
   payload grows 50% for a five-field edit, Updates/s rises 79% while logical edits/s falls 28% at
   the hot write path. The cost is per Update, so a single-field write is unchanged and a create is
   where it lands. The envelope stands; slice 6's component index adds ~15% at every k, and the
   schema-free server indexes every component rather than an `indexed` subset.
3. Should `replace` exist at all, or is `merge` plus an explicit `drop` sufficient? `replace` is
   the only method a keyspace component must refuse, so removing it removes a rule.
4. Does `optional` belong on the component or on the model (a model-level "all components
   optional" default)? Decided in [#798](https://github.com/ebbjs/ebbjs/issues/798): on the
   component, and `optional` refuses a declared default.
5. How does per-component residency interact with #123's compaction low-water mark?
6. What does the containment hop cost when `ebb/link` moves onto its source? Slice 13 is gated on
   it; `docs/research/membership-and-links-as-components.md` §6 is the measurement.
7. Does the group → members index survive the `ebb/*` rename, or does it collapse into the
   component index? Slice 11 measures it at k = 2/4/8 alongside the scope table.
