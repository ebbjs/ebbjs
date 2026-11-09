# Rearchitecting ebb around a true ECS

Design research note. No code changed. The question: **what would it look like if
ebb were rebuilt around a real Entity-Component-System, and is that the right
move?**

> **Superseded in part.** This note is the rationale and the reading of the ECS sources. The
> actionable plan is [`docs/plan/components-epic.md`](../plan/components-epic.md), and where the two
> differ the epic wins. Two claims below were corrected while designing it: a document body _can_ be
> a component (an upgrade archives into a declared archive component, and a model's component set is
> static per schema version, not immutable), and ebb's edges must _stay_ entities because membership
> attaches to entities — so the special case dies, not the row.

Part 1 establishes what "true ECS" actually commits you to, from the sources that
own the definition. Part 2 reads ebb's shipped architecture in ECS terms — not
as a metaphor, as a literal mapping onto entity / component / archetype / system.
Part 3 is what a true-ECS ebb would be, concretely. Parts 4–6 price it, list what
breaks, and say what I would refuse. Part 7 is the incremental path and part 8 the
open questions.

Evidence labels: **[primary]** = a source that defines the thing; **[code]** =
`file:line` in this repo at `b113df56`; **[derived]** = inference from those two;
**[judgment]** = mine, and contestable.

---

## TL;DR

- **[code] ebb is already 80% of the way to an ECS data model, and 0% of the way
  to an ECS architecture.** The wire (`Update {subject_id, subject_type, method,
data.fields}`) is "attach component data to an entity". The read model is not:
  an entity's component set is a _singleton chosen once and immutable forever_.
- **[derived] The single load-bearing difference is component-set identity.** ECS:
  an entity is an id plus whatever components it happens to carry. ebb: an entity
  is an id plus one `type`, committed by its first write, which every downstream
  stage treats as identity — storage index, permission string, query source,
  projection shape, residency policy, conflict policy.
- **[primary + code] Martin, asked how to persist an entity system, answered
  "one table per component type, keyed by entity id" — which is what ebb already
  stores.** The archetype form is a denormalisation of that shape for locality,
  and ebb does not need the denormalisation. So the useful question is not
  "should ebb be an ECS?" but "which parts of the field's original model has ebb
  not finished?" The answer is the two he deferred: existence as a first-class
  bit, and systems.
- **[derived] That conflation is the direct cause of four real things in this
  codebase**: the `#624` authorization hole (wire `subject_type` treated as
  identity), `STRUCTURAL_SUBJECT_TYPES` (a hardcoded set of "rows that are not
  really documents"), the generated `text_document__<parent>__<field>` entity
  (a synthetic row that exists only so a large body can have its own residency
  policy), and type-granular query invalidation (`readTypes`).
- **[primary] The ECS literature does not support "ECS is a performance
  architecture" as its own claim.** The origin (Bilas 2002, Martin 2007) is an
  _authoring and change-cost_ argument; Martin records that naive ES was
  "disappointingly (unacceptably) poor" in performance; and both principal
  library authors explicitly disclaim architecture — EnTT "does not attempt in
  any way to … control its main loop or process scheduling", and its author says
  the reason to use one is "the code organization and not (only) the
  performance". Archetypes are one storage choice, not the definition; the
  archetype vendor's own FAQ concedes add/remove is faster in its sparse-set
  competitor.
- **[judgment] Adopt the identity model and the system contract. Reject the
  archetype/chunk storage and the scheduler.** The locality payoff needs dense
  arrays of POD; ebb's rows are `Record<string, FieldValue>` in V8 over
  IndexedDB. Ebb's measured bottlenecks are fan-out per delivery and
  per-traversal projection (`README.md#performance`), neither of which
  archetypes address. And the scheduling burden is exactly the part that ECS
  moves rather than removes.
- **[judgment] A whole-program rewrite is not justified. Four slices are, and
  they are independently shippable:** component-granular change journal →
  component namespace on the wire → component-set identity → declared
  read/write sets on Functions.

---

## 1. What "true ECS" actually commits you to

The term has a definition and an implementation tradition, and conflating them is
the most common way this discussion goes wrong. This section is built from the
sources that own the definitions; URLs are in [Sources](#sources).

### 1.1 The four commitments

1. **An entity is an identity and nothing else.** Bevy: _"On its own, the
   `Entity` type is a simple identifier: it has neither behavior nor data."_
   Martin hardens it: _"entities have NO data and NO methods … An entity is
   really just a name."_ **[primary]**
2. **A component is typed data attached to an entity, and existence is a bit**,
   distinct from a null value. Mertens' checklist: _"Entities can contain zero or
   more components / Entities can change components dynamically."_ Every primary
   source prefers absence-plus-query-filtering over nullable fields. **[primary]**
3. **A system is where behaviour lives, and it is driven by a query** — a
   description of the component set it wants. Mertens: _"systems, which are
   functions matched with entities that have a certain set of components."_
   **[primary]**
4. **A world owns the ids, the component storage, and the schedule.** Bevy: _"a
   catch-all container for *stuff*"_; Mertens: _"A world is the container for all
   ECS data."_ **[primary]**

### 1.2 What is _not_ part of the definition

This is the part that decides whether ebb "needs" archetypes, and the sources
are unusually explicit.

- **Archetypes and chunks.** Unity: an archetype is _"a unique identifier for
  all the entities in a world that have the same unique combination of component
  types"_, stored in _"uniform blocks of memory called chunks"_ of 16 KiB.
  Bevy stores archetypes as dense arrays. EnTT instead _"implements a sparse set
  based model"_ and Quantum uses sparse sets too. **All are ECS.** The storage
  model is a workload choice, and the vendors say so themselves: flecs' FAQ
  concedes _"Add/remove operations are faster in EnTT / Single component queries
  are faster in EnTT / Multi-component queries are faster in Flecs"_.
  **[primary]**
- **Bitmask component masks.** An encoding for a compile-time-closed component
  set. EnTT is explicitly _"type-less and bitset-free"_ and still ECS.
  **[primary]**
- **Data-oriented design.** Mertens, asked directly: _"Is ECS the same as DoD?
  No. It is possible to write code that uses DoD principles without it being ECS,
  and it is possible to create an ECS that does not leverage DoD."_ **[primary]**
- **Being an "architecture" in the control-inversion sense.** EnTT's wiki: _"It
  does not attempt in any way to take over the user codebase, nor to control its
  main loop or process scheduling."_ **[primary]**

### 1.3 What the origin actually argued

The origin is a **change-cost and authoring** argument, not a cache argument, and
this matters because ebb's version of the question is also a change-cost question.

- Bilas, GDC 2002 (Dungeon Siege): _"Throw away the hierarchy, break the tasks
  down into C++ and script components, and assemble the components into objects.
  Data-drive the assembly process and now you have a powerful and quick system for
  building new types that requires no engineering time to manage!"_ The stated
  advantages are _"Designers can very quickly have their ideas prototyped"_ and
  _"Memory efficient"_ — not throughput. His 2002 `Go` is also **not** a modern
  ECS: components hold logic (_"Nearly all logic is done in the components"_) and
  are looked up **by name** (_"You can query for a component by name"_).
  **[primary]**
- Martin, 2007: the motivation is post-launch change and network/persistence
  fan-out, and he records that the naive form _"can make runtime performance
  disappointingly (unacceptably) poor."_ **[primary]**
- Fabian names the actual mechanical lever: _"Having the managers control when the
  code is executed is a large part of the leap towards fully parallelisable
  code."_ Inversion of _dispatch_ — not layout — is what unlocks parallelism.
  **[primary]**

**[judgment] So "ECS is fast" is a downstream, conditional claim.** It holds when
component sets are stable enough for column storage to pay, which is exactly the
condition Unity and flecs document as a constraint (see 1.5).

### 1.4 Where the sources disagree

| term                | disagreement                                                                                                                                                                                                             | why it matters here                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| **system**          | Martin wants 1:1 system↔aspect and later **renamed System → "Processor"**; Mertens: _"an executable object"_; EnTT refuses to schedule; Unity has ordered groups; Bevy has schedules that _"run in parallel"_ by default | "system" spans one function to one frame stage. Ebb would have to pick, and the pick constrains determinism.         |
| **entity**          | Bevy/Martin: a bare id. Fabian deletes it: _"As an entity is its current configuration of components … there is no entity"_                                                                                              | Whether the id is _vestigial_ or _load-bearing_. Ebb's ids are CRDT keys, so vestigial is not available.             |
| **component**       | Mertens: _"plain datatypes without behavior"_. Bilas and early Martin put logic in components                                                                                                                            | "Pure data" is a modern convention, not the definition. `AGENTS.md` already prefers it, so this costs ebb nothing.   |
| **definition test** | Mertens, deflationary: _"A framework that lets you add `things` to entities, with a way to query for entities that have some things but not other things, is generally considered to be an ECS."_                        | By this test, a component-set ebb **qualifies**. By Martin's stricter one it does not, because there are no systems. |

### 1.5 Is ebb an ECS today?

The honest answer depends on the test, and both tests are worth running:

- **Mertens' loose test: no, but nearly.** Ebb can add _fields_ to entities and
  query for entities with some fields and not others — but field existence is a
  tombstone and merge state, not a component, and there is no notion of
  _attaching_ something the entity did not have. The gap is one operation.
- **Martin's strict test: no, and the gap is the whole behaviour half.** No
  systems, no world-owned schedule, no component-set queries.

**[judgment] Ebb is a _document store with a required discriminant_.** That is not
an insult: the discriminant is what makes typed projections, `<type>.<verb>`
permissions, and per-type residency possible. It is also precisely why ECS's
ontology fits ebb's hard problems so badly (section 5.1).

### 1.6 The critiques, with their primary statements

- **"ECS is just composition, and it is an ad-hoc relational model."** Strongest
  statement, Brooke Hodgman: _"it's just an an ad-hoc version of the relational
  model"_, and _"this code is re-implementing the existing language feature of
  composition as a runtime library instead of a language feature."_ Friendly
  sources corroborate the principle: Martin's own wiki says a CES _"follows the
  Composition over Inheritance principle"_. **[primary]** The novelty is about
  mechanism, not principle.
- **Structural change is expensive, and it is a first-class design constraint.**
  Unity: _"Moving entities frequently is resource-intensive and reduces the
  performance of your application"_, and structural changes _"can only perform
  them on the main thread; not from jobs"_ and _"invalidate all direct references
  to any component data."_ Caini: on every add/remove _"an entity and all its
  components are moved from an archetype to another one"_, and _"the number of
  archetypes could explode."_ flecs documents **fragmentation** as a named cost
  with a mitigation flag. **[primary]**
- **System ordering is the hard part, and ECS relocates it rather than solving
  it.** Bilas listed it as a 2002 disadvantage: _"Various operations may become
  order-dependent on the components."_ Bevy exposes `ConflictingSystems` and
  admits "ambiguous" ordering for exclusive systems; Unity requires declared
  `UpdateBefore`/`UpdateAfter` and re-sorts groups. **[primary]**
- **It is an in-memory architecture, not a domain model.** Fabian, as a
  principle: _"Data is not the problem domain … data is intentionally and
  consistently without meaning."_ Martin's own persistence answer is **relational
  tables keyed by `entity_id`** (_"The entire data for any given system is fully
  isolated into its own table"_), with serialization promised as a later post.
  Quantum keeps dynamic data outside components. **[primary]**
- **"ECS gives you networking / consistency."** Unsupported. Unity ghosts are
  _"a snapshot of the current state of all ghosts"_ with _"eventual consistency"_
  in the last-writer-snapshot sense, not merge semantics; Replicon is
  _"server-authoritative"_ with opt-in per component; Quantum's determinism comes
  from fixed-point math and input-only exchange, not from ECS. **ECS+CRDT:
  NOT FOUND** in any authoritative source. **[primary + absence]**

### 1.7 What is actually load-bearing

Four properties, each with a source that argues for it:

1. **Uniform addressing of state by (component type, entity id).** Every source
   agrees, and every benefit routes through it. It makes "the set defined by data
   shape" a primitive, and makes capability change cheap in _design_ terms
   (Bilas's authoring argument, Martin's post-launch argument). **[primary]**
2. **Column-wise storage, conditional on stable component sets.** Unity, Bevy,
   flecs and Fabian all tie the cache argument to stability; flecs' FAQ shows the
   win flipping to sparse sets under churn. Real, and conditional — stated by the
   vendors, not by critics. **[primary]**
3. **Enumerating "everything with X and Y" without an object registry.**
   Martin's MMOG argument and Quantum's replication argument both rest on this,
   not on cache lines. **[primary]**
4. **Blittable, uniformly-typed state → cheap snapshot and bulk transfer.**
   Quantum: _"blittable memory-aligned C# structs"_; Unity's server _"processes
   ghosts per entity chunk, rather than per entity"_. A consequence of 1+2, and
   the only rigorously documented ECS↔network link found. **[primary]**

And the cargo cult, which the sources actively contradict:

- _"ECS is an architecture"_ — both principal library authors disclaim it, and
  Martin renamed System→Processor.
- _"ECS makes code reusable"_ — a composition claim that predates ECS.
- _"ECS gives parallelism for free"_ — it makes access _declarable_; the parallel
  executor is a separate machine (Bevy's dependency graph, EnTT's absent
  scheduler).
- _"Fragmentation is a minor perf detail"_ — flecs documents it as a named cost;
  Caini says it _"defeats a bit the purpose of using an ECS"_.

**[judgment] The one-line version the sources support:** ECS is a _storage and
dispatch discipline over (id, typed data) pairs_. Reliable wins: uniform
addressing, query-by-shape, bulk traversal of stable sets. Reliable costs:
structural-change moves, table growth, and the system-ordering problem landing in
your codebase. The larger claims are about composition in general or a particular
engine's add-ons.

---

## 2. ebb as it stands, in ECS terms

### The mapping, literally

| ECS concept                   | ebb today                                                                                                                              | Evidence                                                                                      |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Entity                        | `Entity {id, type, data.fields, created_hlc, updated_hlc, deleted_hlc, last_gsn}`                                                      | `packages/core/src/types/entity.ts:9`                                                         |
| Entity set (existence)        | `entity.deleted_hlc === null`; deletion is a tombstone, never a free                                                                   | `entity.ts:15`, `packages/storage/src/replica/replica.ts` `resync`                            |
| Component **type**            | `entity.type` — **exactly one, immutable after first write**                                                                           | `CONTEXT.md` "Committed type"; `#624` note                                                    |
| Component **data**            | `entity.data.fields` — an _untyped_ `Record<string, FieldValue>`, one LWW envelope per field                                           | `packages/core/src/types/action.ts:33`                                                        |
| Component existence           | **not modelled.** A field is always "there"; a cleared field is a `null` leaf tombstone that projection hides                          | `action.ts:60-70`, `query-builder.ts` projection states                                       |
| Archetype                     | **does not exist.** The nearest thing is `typeIndex: Map<type, Set<id>>` — a one-component world where every type is its own archetype | `replica.ts:115`                                                                              |
| Archetype index (server)      | `cf_type_entities (type, 0x00, entity_id) -> <<>>`, an existence index                                                                 | `ebb_server/lib/ebb_server/storage/rocks_db.ex:48`                                            |
| Relationship / pair           | first-class row: `relationship {source_id, target_id, type, field}` + a bidirectional adjacency index                                  | `packages/schema/src/system-entities.ts:43`, `packages/storage/src/internal/reverse-index.ts` |
| Tag component                 | `entityGroup {entity_id, group_id}` — a row whose existence scopes permission                                                          | `system-entities.ts:60`                                                                       |
| Transient/ephemeral component | `presence` channel per `(entity, channel)` — never in the log, lossy on disconnect                                                     | `CONTEXT.md` "Presence"; `packages/client/src/presence/`                                      |
| System                        | **does not exist on the client.** Server-side `Function` is an RPC handler, not a query-driven, read/write-set-declared system         | `ebb_server/lib/ebb_server/functions/`, `packages/server/src/function.ts`                     |
| Query                         | `client.<type>.query()` — source is always one nominal type, DNF field filters, one-level joins                                        | `packages/client/src/sync/query-builder.ts`, `query-plan.ts`                                  |
| World                         | `Replica` (client) / `EntityStore` + `ActionLog` (server)                                                                              | `packages/storage/src/replica/`, `ebb_server/lib/ebb_server/storage/`                         |

### Finding 1: the wire model is already ECS-shaped

```
Update { subject_id, subject_type, method: put|patch|delete, data: {fields: Record<string, FieldValue>} }
```

Read naively, that is "set the fields of entity X". Read as ECS, `patch` is
_merge into a component bag on entity X_, and the only thing missing is that the
bag has no name other than "X's whole row". `subject_type` is a component tag
that must be identical on every write to X, forever.

That asymmetry — writes are component-ish, reads are row-ish — is the whole
finding. The system's read path has to reconstruct a fixed shape from a bag
whose shape was fixed at first write, which is why `projectEntity` takes a
TypeBox `shape` and re-derives defaults, and why tombstones exist at all: a
"missing" field has to be distinguishable from "never written" _and_ from
"deleted", and a component-set model gets all three for free.

### Finding 2: `type` is doing six unrelated jobs

This is the crux. `entity.type` is simultaneously:

1. **Storage key** — `typeIndex`, `cf_type_entities`, SQLite `entities(type)`.
2. **Query source** — `query("issue")` means `iterate("issue")`; a scan is
   always single-type (`query-execute.ts:33`, `createReplicaExecutor.scan`).
3. **Projection identity** — the argument that selects which `ModelDef.shape`
   to project a row through (`projectEntity`).
4. **Permission string** — `<type>.<verb>`, resolved in
   `authorizer.ex:768-778` from the _wire_ `subject_type`.
5. **Residency policy** — `materialization: "held" | "on-demand"` is declared
   per entity type (`packages/schema/src/entity.ts:403`).
6. **Merge/conflict policy** — `conflictScope: "field" | "entity"` per type
   (`entity.ts:42`), plus the hardcoded `STRUCTURAL_SUBJECT_TYPES` set that
   exempts `relationship`, `entityGroup`, `groupMember` from conflict detection
   (`packages/client/src/sync/conflict-slots.ts:35`).

In ECS these six are six independent axes: component identity, component
existence, the query, the permission on the component, the residency of the
component's storage, and the component's merge rule. Collapsing them into one
immutable string is what forces each of them to be a special case.

### Finding 3: four real artefacts of the collapse

These are not hypotheticals — they are in the tree:

**(a) `#624`: `subject_type` is client input treated as identity.** The
authorization research note (`docs/research/624-committed-type-authz.md`) shows
`subject_type` reaching the authorizer, the materialized row's `type`, the
type-entity index, the SQLite `type` column, and the client replica's row type,
while nothing compares it to the type the id was committed under. In an ECS,
that bug is _unrepresentable_: a write names a component, and a component the
entity does not have is a `drop`-of-absent, not an identity claim. Existence is
checked per component, and component existence is a schema fact checked at
validation.

**(b) `text_document__<parent>__<field>`.** `e.collaborativeText()` expands into
a _generated entity type_ plus a generated relationship
(`packages/schema/src/collaborative-text/schema.ts:115`), carrying
`materialization: "on-demand"`. That entity exists for exactly one reason:
residency is a property of a type, so a large body cannot live on the parent row
without dragging the parent's residency along with it. In an ECS the body is a
component, and residency is a property of the component. The generated entity,
the generated relationship, `DERIVED_DOC_ENTITY_PREFIX`, the reserved-name
assertions, and `DerivedDocNameCollisionError` all stop existing.

**(c) `STRUCTURAL_SUBJECT_TYPES`.** Three named types that are "rows, but not
documents" and therefore exempt from conflict detection. ECS does not need this
set: an edge is a pair component, a membership is a tag component, and whether a
component merges by LWW or by existence is declared on the component.

**(d) Type-granular invalidation.** `ReplicaChange` is
`{revision, id, type, deleted}` (`packages/storage/src/replica/types.ts:17`), and
`QueryCache` invalidates an entry when a change's `type` intersects the plan's
`readTypes` (`query-plan.ts:84`). So a change to one field of one `issue` row
invalidates every cached query over `issue`. This is deliberate — the code calls
it "coarse-first" — and it is the correct first cut. It is also exactly what
component-granular change records fix, and that fix does not require anything
else from ECS.

### Finding 4: Martin's own persistence answer is ebb's read model

This is the finding that reframes the whole question. Martin, having spent five
posts arguing that entities have no data and components hold all of it, answers
"how do you persist this?" with **relational tables**:

> "The entire data for any given system is fully isolated into its own table.
> It's easy to print to screen (for debugging), serialize (for saving / bug
> reports), parallelize…" — Part 5

One table per component type, rows keyed by entity id, columns being the
component's fields. That is _literally_ what ebb already stores: `entities(id,
type, data, …)` with `cf_type_entities (type, 0x00, entity_id)` as the existence
index (`rocks_db.ex:48`), plus generated columns for the edge and membership
fields (`sqlite.ex:83-90`).

So the field's own founder, when asked for a durable form, produced the shape ebb
has. The archetype/chunk form is a _denormalisation of that shape for locality_ —
and ebb does not need the denormalisation, because it is not iterating millions
of rows per frame. **[judgment] The useful question is not "should ebb be an
ECS?" but "which of Martin's five posts should ebb finish implementing?" The
answer is the two he explicitly deferred: existence as a first-class bit, and
systems.**

### Finding 5: the `Action` log is the right substrate for structural change

The folklore objection to ECS — structural changes are expensive, so add
components once and never remove them — assumes the entity's component set is
only ever in memory, so a change is a memcpy between archetype blocks.

Ebb does not have that problem, because it has an append-only log. "Add a
component to an existing entity" is an `Update` with an HLC, and it merges like
anything else. Structural change is _the normal case_, historically ordered,
replicable, and cheap. **[judgment] This is ebb's structural advantage over every
published ECS**: the one thing ECS implementations are worst at is the thing
ebb's architecture was built for.

---

## 3. What a true-ECS ebb would be

### 3.1 The data model

```
Component  = a named, schema'd, typed field map with its own merge rule and
             conflict scope. Not a class; a declaration plus a value shape.
Entity     = { id, components: Set<ComponentName>, deleted_hlc }
Model    = a named component set. `defineEntity("issue", [...])` is a model,
             not a type: it names a shape the app talks about, not an identity
             the row is locked into.
```

The change from today is one sentence long: **`type` stops being identity and
becomes a name for a set.** Nothing else in the model has to move.

```ts
const title = defineComponent("issue/title", e.string(), {
  conflict: "position",
});
const status = defineComponent("issue/status", e.enum(["open", "closed"] as const));
const body = defineComponent("issue/body", textDocument(), {
  residency: "on-demand",
});

const issue = defineEntity("issue", [title, status, body]);
```

Three details worth being explicit about:

- **Optional components are the feature, not a wart.** ECS's `add`/`remove` is
  how you express "this issue has a draft" or "this document is checked out".
  Today that is a nullable field with a tombstone; as a component it is existence,
  and a query can ask for `has(draft)` without a `null` filter.
- **Existence wants three states, not two.** flecs ships `disabled` as a middle
  state and explains why: _"Disabling a component is a cheaper alternative to
  removing it … as it relies on setting a bit vs. moving an entity to another
  table."_ **[primary]** Ebb's analogue is free: a `disabled` bit on the field
  envelope is a projection change, while `drop` is an index update. Offer both,
  and call the middle state what it is.
- **Component _identity_ is a string in a namespace, not a TypeScript type.**
  It has to be: it appears on the wire, in the schema hash, in a permission
  string, and in a RocksDB key. This is also the original design — Bilas's 2002
  components were looked up _"by name"_ **[primary]** — so it is not a
  degradation forced by a dynamic language.

### 3.2 The write model

```
Update { subject_id, component, method: "merge" | "replace" | "drop", fields }
Action { id, actor_id, hlc, gsn, updates }
```

- `subject_type` → `component`. Same position in the envelope; the value is now
  a component name instead of a row type.
- `put` → `replace` (whole component), `patch` → `merge` (per-field LWW,
  unchanged), `delete` → `drop` (remove the component; the entity survives).
- Entity deletion becomes "drop every component and tombstone the entity", which
  is what `deleted_hlc` already is. One new op, not a new concept.

The merge rule does not change at all. `mergeFieldValue`
(`packages/core/src/types/action.ts:96`) stays the single definition, mirrored
by the server and every adapter. **[judgment] This is the most reassuring thing
in the whole analysis**: ebb's convergent core is orthogonal to ECS. Component
identity is a re-labelling of the envelope, not a change to convergence.

### 3.3 Storage and indices

Client (in `Replica`):

```
entities:    Map<id, {components: Set<name>, deleted_hlc}>
components:  Map<componentName, Map<id, ComponentInstance>>   // component-major
archetypes:  Map<componentSetKey, Set<id>>                    // sorted names joined
adjacency:   unchanged — ReverseIndex stays exactly as it is
overlay:     Map<id, OptimisticWrite[]>                       // unchanged
```

Server: `cf_type_entities (type, entity_id)` becomes
`cf_component_entities (component, entity_id)` — same shape, same cost, one row
per (component, entity) instead of one per (type, entity). Rows with _k_
components pay _k_ index rows instead of 1, which is the honest price of
component-set identity: **index write amplification proportional to component
count.** At four components per entity that is 4× on one column family; against
the measured ~21k Actions/sec single-Writer budget this needs a number before it
ships. **[derived] It is the single biggest measurable risk in the design.**

The prototype entity blob does _not_ change shape on disk for v1: keep
`data.fields` as the stored row and treat components as a _view_ — a mapping
from component name to the subset of fields it owns. That buys the whole model
without touching the materializer, the record format, or `#552`'s "one value
shape or raise" contract.

### 3.4 Query

A query is over a component set, and the planner's job becomes set intersection:

```
q = query(issue).where(status, "open").with(assignee)
  → archetype(components ⊇ {issue/title, issue/status})   // index read
  → filter components["issue/status"][id] === "open"      // per-component column read
  → project only the requested components
```

Three structural improvements, none of which need archetype storage:

1. **Filters read a component column, not a whole row.** Today `scan(type)`
   materialises the row list and filters project the full shape.
2. **The relationship and membership indices become ordinary indexed component
   columns.** `ReverseIndex` is already keyed `(as, type)`; under a component
   model that key _is_ the component namespace, and `PlanPredicate`'s
   `adjacency` / `membership` / `filter` trichotomy collapses to "indexed
   component" and "column filter".
3. **Invalidation becomes exact.** `ReplicaChange` grows
   `components: readonly string[]`, `readTypes` becomes `readComponents`, and a
   `status` write stops invalidating the query that only reads `title`. This is
   the change I would ship first, because it is small, measurable, and
   independently valuable.

### 3.5 Systems

This is the part that would be new, and the part most likely to be got wrong.

```ts
defineSystem({
  name: "issue/search-text",
  reads: [issue / title, issue / body],
  writes: [search / text], // a local-only component
  run: async (ctx) => {
    // runs after ingest, off the journal delta
    for (const [id, { title }] of ctx.changed(issue / title)) {
      await ctx.set(id, search / text, tokenize(title));
    }
  },
});
```

Two classes, with a hard boundary between them:

- **Local systems.** Derived components that exist only on this replica and are
  never replicated. They are memos over the log, so they may be recomputed from
  scratch at any time; that makes them safe under any ordering. **This is where
  ECS-style behaviour belongs on the client.** `collaborativeText`'s projection
  is already the first one of these, hand-written.
- **Replicated systems.** A `Function` with a _declared_ `reads`/`writes`, which
  the server can use for permission pre-checks, cache keys, and invalidation
  without parsing the handler. Running one optimistically on a client would
  require determinism under HLC-partial ordering, which ebb does not have and
  should not manufacture. Quantum is the cautionary precedent: its determinism
  comes from fixed-point math and input-only exchange, and it keeps dynamic data
  _outside_ the ECS precisely so the ECS half stays blittable. **[primary]**

**[judgment] The declared read/write set — not the scheduler — is the payoff.**
That is what Bevy's parallel executor actually consumes (`ConflictingSystems`
reports "pairs of systems that conflict … along with the components they conflict
on"), what Unity consumes to build `UpdateBefore`/`UpdateAfter` order, and what
every source that claims a scheduling benefit is standing on. Ebb would consume
it for three things it does not have today: exact query invalidation, cache keys,
and permission pre-checks that do not require running the handler.

And be honest that the schedule is a burden, not a gift: Bilas listed
"order-dependent" components as a 2002 _disadvantage_, and every implementation
since has shipped a mechanism for declaring order rather than a way to avoid
needing one. **[primary] Do not put a scheduler in the core.** Local systems that
run after ingest, in arbitrary order, with recomputable outputs, have no ordering
problem by construction.

What a system must _not_ be: a place to put business logic that mutates
replicated state on the client. Ebb's optimistic-write story is "the client
writes an Action and the server orders it". A client-side system that derives a
replicated value is a second, unsynchronised writer, and it will diverge.

### 3.6 The public API does not have to change

This is what makes the whole thing tractable:

```ts
client.issue.query().where({ status: "open" }); // unchanged
client.issue.update(id, { title: "..." }); // unchanged
```

`defineEntity("issue", [...])` remains the thing apps declare, because "a named
set of components" is exactly what a domain object is. The ECS is an internal
representation — model → component set → existence index → component columns —
and the TypeScript surface stays a typed row over a model.

**[judgment] Whether that counts as "ECS" depends on which test you use, and it
is worth being precise rather than flattering the result.** By Mertens'
deflationary test — _"lets you add things to entities, with a way to query for
entities that have some things but not other things"_ — yes, it does. By Martin's
strict test — entities with no data, all data in components, systems running per
aspect — only if slice 4 ships. **The honest label is "component sets as the
internal representation of a typed document", and the honest claim is that this
is the part of ECS that transfers to a syncing data store while the archetype
half does not.**

---

## 4. What it buys, priced

| Claim                                             | Verdict                                     | Reasoning                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Faster iteration / scans                          | **No, and worse than neutral here**         | The win in the literature is cache locality over dense POD arrays, and both vendors tie it to _stable_ component sets (flecs' FAQ shows the win flipping to sparse sets under churn). Ebb rows are `Record<string, FieldValue>` with optional HLCs in V8, and ebb's churniest state is exactly the archetype-hostile kind: edges, memberships, and components that come and go. Adding archetypes would buy no locality and inherit fragmentation. |
| Fewer round trips, less projection                | **Small, real**                             | Per-component columns mean a filter or a sort reads one component, not a projected full row; `projectEntity` runs at the end over requested components only. Worth measuring against the `1.5–12 µs` wrapper costs in `#503`.                                                                                                                                                                                                                      |
| Finer cache invalidation                          | **Yes, and independently shippable**        | `{components}` in the journal + `readComponents` in the plan. Removes the "any `issue` change invalidates every `issue` query" floor.                                                                                                                                                                                                                                                                                                              |
| Fewer special cases                               | **Yes, large**                              | `STRUCTURAL_SUBJECT_TYPES`, the generated doc entity family, `#624`'s class of bug, and the per-type `materialization` plumbing all become ordinary component rules. This is where most of the code deletion is.                                                                                                                                                                                                                                   |
| Structural flexibility (optional components)      | **Yes**                                     | Add/remove a component as an ordinary `Update`. Ebb's log makes this cheap where ECS implementations make it expensive.                                                                                                                                                                                                                                                                                                                            |
| Systems as a behaviour layer                      | **Only with a hard local/replicated split** | Local derived components: safe, useful, already half-built. Replicated client systems: a divergence generator.                                                                                                                                                                                                                                                                                                                                     |
| Compatibility with the existing 1119 client tests | **Cost, not benefit**                       | `subject_type` appears in fixtures, conflict slots (`LwwFieldOracle(subjectType, field)`), permission strings, the outbox, and the catch-up frames. A rename is mechanical; a semantic change is not.                                                                                                                                                                                                                                              |
| Write amplification                               | **A real cost**                             | _k_ index rows per entity instead of 1. Needs a benchmark before commit.                                                                                                                                                                                                                                                                                                                                                                           |

**[judgment] Net: the identity model pays for itself in deleted special cases
and in the `#624` class of bug, not in throughput. Anyone selling ECS to this
codebase on performance is selling something the substrate will not deliver.**

---

## 5. What breaks, specifically

1. **Permissions.** Ebb's permission strings are `<type>.<verb>`. Under
   components they would be `<component>.<verb>`, which is the wrong
   granularity — permissions are about _domain objects_, not data layout. A
   reviewer with `issue.update` should be able to write `issue/status` and the
   body, not to hold a permission per component. **[judgment] Keep permissions
   keyed on the model; make the model→component mapping part of the schema
   hash so a permission cannot be borrowed across models.** This is the place
   ECS's ontology is genuinely inadequate for ebb, and pretending otherwise
   would produce a worse permission model than the one there is.
2. **Group resolution.** `EntityIndex.resolve_groups/3`
   (`ebb_server/lib/ebb_server/storage/entity_index.ex`) dispatches on
   `subject_type`, with system types special-cased. In a component model the
   dispatch is "does this entity carry the membership component", which is
   strictly simpler — but it is a rewrite of the single most security-sensitive
   module in the server, and the tests for it are the ones that must be written
   first.
3. **Conflict detection.** `LwwFieldOracle(subjectType, field)` and
   `conflict-slots.ts` both key on `subject_type`. `ConflictScope` already
   exists as `"field" | "entity"`; it becomes a per-component declaration, and
   the optimizer (`#390`/`#392`) keys on component instead of type.
4. **Catch-up and delivery.** Delivery and `update_scopes` are per Action per
   Group and do not change. Catch-up frames carry rows; a component model wants
   to carry "these components of this row", which changes the frame payload —
   the one place where the wire does change shape, and the reason to keep the
   stored row blob as-is for v1.
5. **Entity ids.** Do _not_ adopt ECS id recycling with generation counters.
   Ebb ids are CRDT keys, they are referenced from other entities' fields, and
   `derived-ids` (`#695`) mints them deterministically. A recycled id would
   silently rebind every reference to it. Note this is not the same win as ECS
   gets: ebb's `deleted_hlc` tombstone already owns entity lifetime, so there is
   no id pressure to relieve — dropping a component reclaims that component's
   storage, not the id. **[derived]**
6. **Residency.** `materialization` moves from per-type to per-component, which
   is the win in Finding 3(b) — but `Replica`'s pin/TTL logic
   (`replica.ts:120-220`) is keyed on row ids, not component names, and would
   need to become "a row is resident iff any of its components is held or it is
   pinned".

---

## 6. What I would refuse

- **Archetype/chunk storage.** No payoff in this substrate, large blast radius,
  and it is not even definitional (1.2). Unity pays for it with main-thread-only
  structural changes and reference invalidation; ebb would pay for it with write
  amplification and get nothing back.
- **A scheduler in the core.** Static ordering rots; a dependency graph is a new
  subsystem with new bugs; neither is needed for the systems ebb actually wants
  (local derived components, run after ingest).
- **Behaviour on components.** If a component ever has a method, the design has
  failed. `AGENTS.md` already says pure functions and immutable data; ECS's
  "components are data" is the same rule, so this costs nothing to honour.
- **Replicated client-side systems.** Same reason as above: two writers, one
  truth.
- **"Ebb is an ECS now."** The honest description is "ebb stores a typed document
  as a declared component set". Saying more than that will mislead the next
  maintainer and the next agent that reads this repo.

---

## 7. If it proceeds: four independently shippable slices

Each one is useful alone, and the first two are useful even if the rest never
happens.

1. **Component-granular change journal.** `ReplicaChange` gains
   `components: readonly string[]`; the plan's `readTypes` gains
   `readComponents`; `QueryCache` intersects on components. No wire change, no
   storage change, no schema change. Ship it for invalidation precision and
   measure it against `#503`'s numbers.
2. **Component namespace on the wire.** `subject_type` → `component`, with the
   model's name as a single component that owns all of its fields. Repeated
   `put`/`patch`/`delete` semantics unchanged; the value is just a namespaced
   string. This is a mechanical rename that makes the next slice possible and
   makes `STRUCTURAL_SUBJECT_TYPES` a declared property instead of a set.
3. **Component-set identity.** Multiple components per entity, `drop`, existence
   as a bit, per-component residency and conflict scope; retire the generated
   document entity and the `#624` class of bug. This is the real change, and it
   is where the index write amplification must be measured before commit.
4. **Declared `reads`/`writes` on Functions.** Independent of 1–3. Gives
   permission pre-checks, cache keys, and invalidation from a declaration rather
   than from parsing a handler.

---

## 8. Open questions

- What is the index write amplification at _k_ = 2, 4, 8 components per entity,
  measured through the real Writer pipeline (not a storage primitive), against
  the ~21k Actions/sec budget?
- Does component-major storage actually beat the current adjacency-index
  traversal costs, or does it only move where the `Map` lookup happens?
- Is `Model` a schema-level concept (a declared component set the server
  validates against) or a client convenience? It has to be schema-level if
  permissions are keyed on it.
- Does the schema hash need to include the model→component mapping? (I think
  yes, for permission integrity.)
- What does `ctx.get(type)` mean in the Functions runtime under a component
  model — a model projection, or a component set?

---

## Sources

Primary sources for every ECS claim above. Each was fetched and quoted from the
URL listed; the two 404-prone ones are noted inline. Fetch notes and verbatim
extracts: `/tmp/ebb-ecs-primaries.md` (session scratch, not committed).

**Definitions and origin**

- Adam Martin, "Entity Systems are the future of MMOG development", parts 1–5.
  Part 1 <https://t-machine.org/index.php/2007/09/03/entity-systems-are-the-future-of-mmog-development-part-1/> ·
  Part 2 <https://t-machine.org/index.php/2007/11/11/entity-systems-are-the-future-of-mmog-development-part-2/> ·
  Part 3 <https://t-machine.org/index.php/2007/12/22/entity-systems-are-the-future-of-mmog-development-part-3/> ·
  Part 4 <https://t-machine.org/index.php/2008/03/13/entity-systems-are-the-future-of-mmos-part-4/> ·
  Part 5 <https://t-machine.org/index.php/2009/10/26/entity-systems-are-the-future-of-mmos-part-5/>.
  _(The widely-cited `entity-systems-are-the-future-of-mmogs` slug now 404s; the
  `mmog-development-part-N` slugs are live.)_
- Adam Martin's wiki: <http://entity-systems.wikidot.com/> ·
  terminology (incl. System→"Processor" rename) <http://entity-systems.wikidot.com/es-terminology> ·
  approaches ("no accepted right way … yet") <http://entity-systems.wikidot.com/es-approaches>
- Scott Bilas, GDC 2002, "A Data-Driven Game Object System".
  Paper: <https://web.archive.org/web/2012/http://scottbilas.com/files/2002/gdc_san_jose/game_objects_paper.html> ·
  Slides with speaker notes: <https://web.archive.org/web/2016/http://scottbilas.com/files/2002/gdc_san_jose/game_objects_slides_with_notes.pdf>.
  _(Live `scottbilas.com` is gone; archive copies only. The paper is an outline
  with TODO markers — prose quotes are sound, the argument is not complete.)_

**Implementations**

- Sander Mertens, ECS FAQ: <https://github.com/SanderMertens/ecs-faq>
- flecs docs: relationships and pairs (incl. fragmentation, pair id overhead)
  <https://raw.githubusercontent.com/SanderMertens/flecs/master/docs/Relationships.md> ·
  FAQ (Flecs-vs-EnTT trade-off) <https://raw.githubusercontent.com/SanderMertens/flecs/master/docs/FAQ.md> ·
  entities/components (incl. `disabled`, `Sparse`) <https://raw.githubusercontent.com/SanderMertens/flecs/master/docs/EntitiesComponents.md>
- Bevy Book, "Storing Data": entities/components
  <https://raw.githubusercontent.com/bevyengine/bevy-website/main/content/learn/book/storing-data/entities-components.md> ·
  world/archetypes <https://raw.githubusercontent.com/bevyengine/bevy-website/main/content/learn/book/storing-data/world.md> ·
  queries <https://raw.githubusercontent.com/bevyengine/bevy-website/main/content/learn/book/storing-data/queries.md> ·
  resources <https://raw.githubusercontent.com/bevyengine/bevy-website/main/content/learn/book/storing-data/resources.md> ·
  relations <https://raw.githubusercontent.com/bevyengine/bevy-website/main/content/learn/book/storing-data/relations.md> ·
  systems <https://raw.githubusercontent.com/bevyengine/bevy-website/main/content/learn/book/control-flow/systems.md> ·
  `bevy_ecs::schedule` (`ConflictingSystems`) <https://docs.rs/bevy/latest/bevy/ecs/schedule/index.html>
- EnTT: README <https://raw.githubusercontent.com/skypjack/entt/master/README.md> ·
  ECS wiki (sparse sets, views vs groups, "Build your own")
  <https://github.com/skypjack/entt/wiki/Entity-Component-System>
- Michele Caini, "ECS back and forth": index <https://skypjack.github.io/tags#ecs> ·
  part 1 (code organization over performance) <https://skypjack.github.io/2019-02-14-ecs-baf-part-1/> ·
  part 2 (archetype cost, archetype explosion) <https://skypjack.github.io/2019-03-07-ecs-baf-part-2/> ·
  part 4 (fragmentation) <https://skypjack.github.io/2019-06-25-ecs-baf-part-4/> ·
  part 7 (chunks and shared components) <https://skypjack.github.io/2020-02-02-ecs-baf-part-7/>
- Unity Entities 1.0: archetypes/chunks
  <https://docs.unity3d.com/Packages/com.unity.entities@1.0/manual/concepts-archetypes.html> ·
  structural changes <https://docs.unity3d.com/Packages/com.unity.entities@1.0/manual/concepts-structural-changes.html> ·
  system update order <https://docs.unity3d.com/Packages/com.unity.entities@1.0/manual/systems-update-order.html>
- Richard Fabian, _Data-Oriented Design_: component-based objects and "there is
  no entity" <https://dataorienteddesign.com/dodbook/node5.html> · "data is not
  the problem domain" <https://dataorienteddesign.com/dodbook/node2.html>

**Critique**

- Brooke Hodgman, "OOP is dead, long live OOP" (the relational-model critique).
  Live URL 403s to non-browser clients; read via
  <https://web.archive.org/web/2020/https://www.gamedev.net/blogs/entry/2265481-oop-is-dead-long-live-oop/>

**Replication and determinism**

- Unity Netcode for Entities, ghost snapshots (chunk-wise send, snapshot
  "eventual consistency") <https://docs.unity3d.com/Packages/com.unity.netcode@1.3/manual/ghost-snapshots.html>
- Bevy Replicon (server-authoritative, opt-in per component)
  <https://docs.rs/bevy_replicon/latest/bevy_replicon/>
- Photon Quantum (deterministic ECS; determinism from fixed-point, dynamic data
  kept outside ECS) <https://doc.photonengine.com/quantum/current/getting-started/quantum-intro>

**Recorded absences** (checked, not found — do not cite as if they exist):

- **ECS + CRDT / per-field merge replication:** no authoritative source. Unity's
  "eventual consistency" is snapshot convergence, not merge semantics.
- **Mertens arguing ECS is "not a silver bullet":** no such piece. What exists is
  the deflationary definition and the explicit "Is ECS the same as DoD? No."
  Neither is a rebuttal of the architecture reading, so none is attributed to him.
- **Unity's own text on shared-component "combinatorial chunk expansion":** the
  relevant docs revision could not be opened; only Caini's quotation of it is
  verified, and that is his commentary, not Unity's words.

**This repo**

- `docs/research/624-committed-type-authz.md` — the `subject_type`-as-identity
  defect.
- `docs/research/503-replica-read-model.md` — the read-path costs quoted in §4.
- `docs/research/575-entity-actions.md`, `docs/research/552-action-envelope.md` —
  the "no compatibility layer, throw the database away" position that makes §7's
  slices greenfield rather than migrations.
