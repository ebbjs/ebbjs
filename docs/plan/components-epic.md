# epic(components): components are the unit of identity

Status: accepted, 2026-11-09; renumbered 2026-11-11 and amended for the system-component contract.
Slices 1–5 landed (#794–#798); 6–14 open. **Redirects** #775 (a document preset becomes a `ComponentDef`, not
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

`ReplicaChange` carries `components: readonly string[]` instead of `type`. A query plan declares
`readComponents`. The cache intersects on components, so a `title` write stops invalidating a plan
that only reads `status`.

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
storage     cf_component_entities (component, id)      → replaces cf_type_entities, ebb/* first
            replica: modelIndex + componentIndex      → replaces typeIndex
                      (+ archetypeIndex, optional)    → an afterthought, not the model
            ReplicaChange { components }               → replaces { type }
client      query(model) reads declared components    → set intersection, not one Set lookup
            plan.readComponents                        → replaces readTypes
            conflictScope "component"                  → replaces STRUCTURAL_MODELS
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
      `isOptional`, `loadingOf`, `conflictScopeOf`, `permissionOf`.
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
- [ ] The append-only guard becomes a **position path** check: `isLogPosition(component, ["updates"])` rather
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

**Current state.** The client and storage half shipped in [#799](https://github.com/ebbjs/ebbjs/issues/799):
`typeIndex` is `modelIndex` in the replica, `ReplicaChange` carries the components a change touched
(computed from the composed view, so a `title` write invalidates `note/title` only), and the
IndexedDB `entities` store carries a `multiEntry` index over a denormalized component-name array
that `EntityStore.queryByComponent` reads after materializing the component's model. Four
commitments are recorded rather than resolved: `ReplicaChange.type` stays until #800 removes it;
**`archetypeIndex` is not added** — open question 1 is still unmeasured, and a speculative index
that can grow faster than the rows is exactly what the issue warned against; the schema bump to 11
**resets** rather than migrating (decision 9, gated like the v9 cell-format reset so a later bump
declares its own migration); and a tombstoned row keeps its index entries, so existence reads filter
on liveness at read time. Still owned by this slice: `cf_component_entities` and deleting
`cf_type_entities`, the SQLite expression index, the k = 2/4/8 write-amplification measurement that
decides open question 1, and #813's empty-scope delivery.

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
of a ladder with nothing in between. That missing rung is why `STRUCTURAL_MODELS` hardcodes
a list of row types that skip conflict detection.

**Scope.** A third scope; the hold keyed per `(entity, component)` instead of per subject;
`STRUCTURAL_MODELS` replaced by a declaration. #781's verbs, report, and durable-hold
decisions stand unchanged.

**Work.**

- [ ] `conflictScope: "component"` accepted on a component; the default for anonymous components
      stays whatever the model declares today.
- [ ] Subject hold becomes a component hold: a held component does not block a sibling component's
      flush.
- [ ] `conflict-slots.ts` keys on component instead of `subjectType`; `LwwFieldOracle` becomes
      `(component, leaf) => boolean`.
- [ ] The `ebb/link`, `ebb/membership`, and `ebb/grant` system components declare their own
      scope, replacing `STRUCTURAL_MODELS`.
- [ ] `EntityDiff` path reporting gains the component segment.

**Acceptance.** `rg "STRUCTURAL_MODELS" packages/client/src` returns nothing. Two actors
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
`RelationshipCache` and the `rowId → yieldedId` layer of `reverse-index.ts` go; the server keeps a
reverse index `(type, target_id) → source ids`. `contained: true` becomes a resolution-time rule
(`source ∪ target`).

**The gate.** Price the containment hop inside the authorizer against the ~21k Actions/s budget
before committing; `docs/research/membership-and-links-as-components.md` §6 is the measurement.

**Work.**

- [ ] `ebb/link` as a keyed component of the source; one Update per `(source, field, target)`.
- [ ] Delete the edge row, the mirrored `entityGroup` rows, `RelationshipCache`'s forward direction,
      and `reverse-index.ts`'s row layer.
- [ ] Server reverse index `(type, target_id) → source ids`, rebuilt at boot like the others.
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
can be windowed; it is the one slice that adds machinery rather than removing it. Slice 7 is the
cheapest win in the epic and should be pulled forward once 6 lands.

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
components matter: one Update for a whole membership or edge instead of two or four. The k-rows-per-
indexed-component cost is the other half, and slice 6 measures it at k = 2/4/8.

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

1. Does the archetype index earn its keep over intersecting component sets? Slice 6 measures.
2. Is `data: FieldValue` (one component per Update) the right envelope, or does Update-count growth
   dominate payload growth? **Measured in slice 4** (see [Measurement](#measurement-the-envelopes-cost-slice-4-797)):
   payload grows 50% for a five-field edit, Updates/s rises 79% while logical edits/s falls 28% at
   the hot write path. The cost is per Update, so a single-field write is unchanged and a create is
   where it lands. The envelope stands; slice 6 must keep `indexed: false` the default for the same
   reason.
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
