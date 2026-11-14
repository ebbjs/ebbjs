# @ebbjs/schema

## 1.2.0

### Minor Changes

- a682fe8: Conflict scope is declared and held per component.

  `conflictScope` gains the middle rung on the ladder and is read per
  component rather than per model: `"field"` surfaces an overlapping map
  position, `"component"` any concurrent touch of the same component, and
  `"entity"` any concurrent touch of the row. A field- or component-scope
  loss holds only the contested component, so a sibling component of the same
  row keeps flushing; an entity-scope loss holds the whole subject. The hold
  is still derived from the durable `conflicted` rows. The persisted conflict
  payload changed shape, so a store from an earlier release is discarded.

  `structural: true` is the exemption the system rows declare. `STRUCTURAL_MODELS`
  is gone: every component of `relationship`, `entityGroup`, and `groupMember`
  opts out of detection, so an offline edge, membership, or grant write
  converges and is never surfaced or held. A schema-less client resolves those
  static declarations without a per-client registry. The exemption is a
  component flag, not a fourth scope.

  `EntityDiff` now reports `component` — the full `<model>/<field>` name —
  beside `path`, matching the slot vocabulary, instead of a bare field name.
  `Conflict` and `ConflictEntry` carry `holds`, the positions kept off the
  wire.

  Ebb is pre-1.0, so the breaking API changes ship as a minor, following the
  #692 precedent.

- 0c5c5d5: Read migrations are declared per component, not per model.

  `defineComponent` already carried `version`; it now validates it as an integer >= 1.
  `defineMigration(component, from, to, fn)` declares one up-only step that transforms a
  component's projected value, and `defineSchema({ migrations })` proves the steps form one
  contiguous chain from version 1 to each declared version. A gap, step past the
  declaration, duplicate `(component, from)` pair, or migration for an undeclared component
  throws from `defineSchema` — boot, not the first read.

  The replica persists a `componentVersions` map beside a record's rows and bumps the record to
  format 4. A write stamps its component at the declared version; a loaded record keeps the
  stamps it persisted. Projection compares that stamp with the declaration and runs the composed migration
  chain, memoised per `(component, from, declared)`. A component stored at a version newer
  than the client declares throws `ComponentVersionAheadError` instead of being read as the
  older shape. The Action log and the materialized base are untouched; `replica.get`,
  `toRaw()`, and history still read the stored shape.

  The wire and the log carry no version, so a value materialized by the current session is
  assumed current. Migrations therefore cover the client's own persisted upgrade path, not
  data another client wrote against an older schema.

- 437c80d: The four system types are now `ebb/*` components of one `ebb` model.

  `group`, `groupMember`, `entityGroup` and `relationship` are `ebb/group`, `ebb/grant`,
  `ebb/membership` and `ebb/link`: four **atomic** components, each carrying one object value in one
  Update. A torn edge, membership or grant is unrepresentable.

  ```diff
  -Update { component: "relationship/source_id", method: "patch", data: { value: "todo_1" } }
  -Update { component: "relationship/target_id", method: "patch", data: { value: "todo_2" } }
  -Update { component: "relationship/type",      method: "patch", data: { value: "todo" } }
  -Update { component: "relationship/field",     method: "patch", data: { value: "dependsOn" } }
  +Update { component: "ebb/link", method: "replace",
  +         data: { value: { source_id: "todo_1", target_id: "todo_2",
  +                          type: "todo", field: "dependsOn" } } }
  ```

  `ebb/membership`'s pair, `ebb/link`'s source and `ebb/grant`'s group are fixed at create; moving one
  is a delete plus a create.

  Permission subjects are the component: `group.*` → `ebb/group.*`, `groupMember.*` → `ebb/grant.*`,
  `relationship.update|delete` → `ebb/link.update|delete`. A membership write authorizes as the
  entity's `<model>.create` / `.update`, unchanged.

  A group's `apps` is the list of app ids it is in scope for (`["notes"]`) rather than a map, because
  an atomic value cannot contain a map. Absent is unscoped, `[]` is no app, and a scope edit writes
  the whole `ebb/group` value.

  `@ebbjs/core` exports the component vocabulary — `EBB_COMPONENTS`, `systemValue` — and no longer
  declares the `Group`, `GroupMember` and `Relationship` row schemas; the component values are the
  shapes. `GroupSeed.apps` is a `string[]`.

  The client's replica store moves to v13 and starts empty: its adjacency index keys name components,
  and a stored row is one atomic value.

### Patch Changes

- Updated dependencies [437c80d]
  - @ebbjs/core@1.2.0

## 1.1.0

### Minor Changes

- cbac1a0: Add `e.object(fields)` — a nested object as one atomic component value.

  `e.object` is a closed object (`additionalProperties: false`) behind the same
  `.default()` chain as every other builder, and a write carries it as one LWW
  leaf (`{ value: {...} }`), so two concurrent whole-object writes converge on
  one authored value rather than a synthesized one. Nested properties are
  declared exactly as authored (`Type.Optional(...)` is how one is optional), and
  a map nested inside an object is refused at declaration because it would lose
  its per-key merge.

  Definition and validation now agree on nested shapes: `admitsNull` recurses
  into object properties and array items, and a nested `unset` (inside an object
  or an array item) is refused once, with its path and a pointer at `e.map`,
  instead of being stripped into a shape error. `wrapFields` throws rather than
  sending the sentinel or an empty object.

  A query compares an object or array field value structurally, so
  `where("anchor", { x: 1, y: 2 })` matches the stored value regardless of key
  order. Ordering is scalar-only: `orderBy` refuses an object or array field at
  the type level and at runtime instead of tying every row on `[object Object]`.

### Patch Changes

- @ebbjs/core@1.1.0

## 1.0.0

### Major Changes

- b113df5: Collaborative text now stores immutable run cells and additive cut cells.

  A text body is a `content` map of cells — a run is a fixed string anchored at
  `(parentRunId, offset)`, and a delete is a cut `[from, to)` over the run it
  belongs to. Runs are never split, rewritten, or extended: an insert at the end
  of a run is a new run anchored at that run's length, and an insert mid-run is a
  new run anchored at the offset, so editing one run cannot invalidate another
  replica's writes. Cuts union per run, so concurrent deletes and delete-vs-insert
  commute.

  This changes what a persisted text body means:
  - The internal encoding of a text body changed. The `content` map is
    **append-only** — a cell id, once written, is never rewritten — and the body
    now carries a `version` leaf declaring the cell format. Every write stamps
    it; a read of an unknown version fails with `DocumentVersionError`. A body
    without the leaf (an empty seeded document) is read as the current version.
  - `deleted` and tombstone cell encodings are gone. Deletes are cut cells, and
    projection hides the covered characters of the owning run, leaving text
    inserted around them visible.
  - Conflict slots collapse for text. Concurrent same-run edits are no longer
    conflicts, because runs and cuts merge without a losing action: the merged
    `content` map is the whole state. Text surfaces no conflict slots.
  - An old IndexedDB database resets at open. `@ebbjs/storage` bumps
    `EBB_SCHEMA_VERSION` to 9; a database below 9 is discarded and rebuilt empty
    rather than migrated, so a tab carrying pre-release text rows does not
    half-read the new cell format. Server-side actions are untouched — this is a
    local-store reset.

  `@ebbjs/client` and `@ebbjs/codemirror` follow the same cell format, and both
  re-export the constants a caller needs (`DOC_CONTENT_FIELD`, `DOC_VERSION_FIELD`,
  `CURRENT_TEXT_VERSION`, the cell schemas).

- b8fe081: `e.collaborativeText()` and the derived-body mechanism are deleted.

  A text body is no longer a hidden part of its parent. A document is an entity
  the app declares, and a relationship it declares:

  ```ts
  const note = defineEntity("note", { title: e.string() });
  const textDocument = defineEntity(
    "text_document",
    { content: e.map(TextCellSchema), version: e.number() },
    { materialization: "on-demand" },
  );
  const schema = defineSchema({
    entities: { note, text_document: textDocument },
    relationships: {
      body: defineRelationship({
        source: note,
        target: textDocument,
        as: "body",
        sourceCardinality: "one",
      }),
    },
  });
  ```

  Creating a note with its document is `create` + `create` + `link` inside one
  `defineAction`, so both rows and their link still land in one Action. No body
  input, no generated entity, and no hidden part is involved.

  What else changes:
  - `defineSchema` produces exactly the entities and relationships it is given.
    Nothing is generated, so no schema hash, permission string, entity name, id,
    or row accessor is minted behind the app's back.
  - A forward-one accessor over a document relationship resolves the target
    entity, like any other link. Read an on-demand document through its own
    namespace — `client.text_document.get(id)` — which also pins it;
    `client.textDocument(id, type)` and `client.openDerivedTextDocument(id, type)`
    still return the editing handle, but they neither read nor pin the row, so
    hydrate it from the row's `content` / `version`. Both openers go away in #779.
  - `defineSchema` rejects an entity-map key that differs from the definition's
    own `name` with `EntityKeyMismatchError`. A preset keyed under another name
    would otherwise have addressed another entity type — and another permission
    string.
  - Deleted: `e.collaborativeText`, `EntityDef.derived`, `DerivedKeys`,
    `DerivedAccessors`, `DerivedFieldDef`, `WireFields`, `expandDerivedFields`,
    `derivedBodyIds`, `generatedDocEntityName`, `isCollaborativeText`,
    `RelationshipKind` and the relationship `kind`, the `generatedParts`
    capability, and the reserved `text_document__` entity prefix. Every public
    `Derived*` / `CollaborativeText*` / `Generated*` type and error class goes with
    them, as do `DERIVED_DOC_ENTITY_PREFIX`, `hasDerivedDocPrefix`,
    `TextDocumentFields`, `buildTextDocumentEntity`, `ReadCapability.openTextDocument`,
    and `ChangeGroupsInput.generated`.
  - Moving a note between groups does **not** move its document, and duplicating a
    note does not duplicate its document. Both gaps are deliberate: relationships
    will own their group membership (#790) and subgraph copy lands in #784, so no
    interim cascade ships here.

### Minor Changes

- ce74122: App scope: a group can declare which apps pull it into their replica.

  `group.apps` is a per-key-merging map from app id to boolean. A group is in
  scope for an app iff its entry is `true`; an absent field (or `null`) means
  unscoped, so every app keeps seeing it. Scope is a **sync/residency filter, not
  an authorization boundary** — the actor's group grants remain the only
  boundary.

  ```ts
  const notes = createClient({ serverUrl, actorId, appId: "notes" });
  const { groups } = await notes.handshake(); // only groups scoped to "notes"
  ```

  - `createClient({ appId })` is a local label; it is never sent as a header or
    token and grants nothing.
  - `client.seed()` scopes every seeded group without an explicit `apps` map to
    the client's app, and `group.create` writes the same scope on the bootstrap
    put. Later edits are single-key patches (`apps.docs = false`), which the
    wire's per-key merge handles per app id. A seed is a put, so re-seeding a
    group replaces its scope map rather than merging it.
  - `handshake()` drops out-of-scope groups and reconciles an active
    subscription: a group whose scope stops naming the app is evicted and the
    live stream reopens without it. Newly in-scope groups are not auto-added to
    an existing subscription.
  - `@ebbjs/schema`'s `groupSystemEntity` gains the field, so `GroupFields`
    includes `apps` on every client group read. `@ebbjs/core`'s `GroupSeed`
    gains an optional `apps` map.

  Live scope changes (`groups_changed`) are tracked separately; today a scope
  edit takes effect on the app's next handshake.

- 6e2df83: Absence, defaults, and null filters (breaking summary).

  Absence is first-class: a field declares a read-time default with
  `.default(v)`, and projection resolves `stored ?? default`. A defaulted field
  reads as `T`; a field without one reads as `T | undefined`. A tombstone is
  absence with an HLC, not a stored null, so no field schema admits `Null` and
  `.nullable()` is gone.

  `create()` may omit exactly the defaulted fields. A draft or committed update
  clears a field with `unset` — `update(todo, { dueDate: unset })`, or one map key
  with `{ tags: { a: unset } }` — which compiles to the existing tombstone
  envelope; a literal `null` in a payload is rejected with a message naming
  `unset`.

  A query filter is a disjunction of groups (`where` ANDs within a group, `or`
  starts a new one) and `null` means "no live value". Defaults never widen a
  filter: a bare equality excludes rows nobody set, and `client.queryEntities`
  emits a non-fatal warning when a filter compares a defaulted field without a
  `{ field: null }` term in any group.

  Wire-compatible on storage: tombstones, HLCs, the merge rule, and
  `fixtures/merge_vectors.json` are unchanged. Filters gain the group shape on the
  wire; `{ field: null }` now emits `IS NULL`.

- 6e2df83: Add `e.array(value)`, the list-field builder, with the same `.default()`
  chain as the other builders. It keeps array fields (such as a
  many-relationship's canonical FK set) in the `e` vocabulary instead of
  dropping to raw TypeBox, so their create/read shape is the one the SDK owns.
- 6e2df83: Declarative field defaults: `e.string().default("normal")` stamps a plain JSON
  Schema `default` annotation on the field's property schema. The annotation is
  inert for validation (`Value.Check` ignores it) and for the wire, but it is
  enumerable, so a default change is already a `schema_hash` change. A derived
  collaborative-text field cannot declare one.
- 6e2df83: A filter is now a disjunction of groups.

  ```ts
  type FilterGroup = Record<string, string | number | boolean | null>;
  type Filter = readonly FilterGroup[];
  ```

  Keys within a group are ANDed; groups are ORed. `[{ priority: "normal" }]` is the
  old single-object filter, `[{ priority: "normal" }, { priority: null }]` reads as
  normal or unset, and `[]`, `[{}]`, `null`, or an omitted filter is unfiltered —
  an empty conjunction is TRUE, so any empty group drops the whole filter. A
  `null` entry (`[null]`) is malformed and rejected as `invalid_filter`; a `null`
  value inside a group (`[{ priority: null }]`) is the predicate "no live value"
  and stays distinguishable from it. The 64-key budget applies per group.

  `EntityRegistry.validateFilter` takes the group list (or `null`) and reports
  violations per group, naming the group index. `client.queryEntities` forwards
  the list unchanged. `filterToGroups` lowers a `Filter` to the builder's existing
  DNF `Query.groups`, so both paths evaluate one predicate language.

  On the server, `QueryFilter.normalize/1` accepts `nil`, `[]`, or a list of
  groups, and `build_filter_clauses` ANDs each group's clauses inside
  parentheses, joins groups with `OR`, and wraps the disjunction so it composes
  with the base `WHERE`.

- 6e2df83: Warn when a filter skips a defaulted field's absence.

  Defaults never participate in filtering, so `{ priority: "normal" }` excludes
  rows nobody set while the row renders as "normal". `EntityRegistry.filterWarnings`
  returns a hint (never a thrown violation) once per defaulted field named with a
  non-null value in a filter that has no `{ field: null }` term in any group.
  `client.queryEntities` emits it on the existing `onRegistryViolation` channel
  with `direction: "outbound"` and runs the query; fatal violations still throw
  before any fetch. `[{ priority: "normal" }, { priority: null }]` is silent.

- 6e2df83: Read types state absence: a field with a declared default reads as `T`, a field
  without one reads as `T | undefined`. `EntityDef` gains `createShape`, the
  inverse relation (a defaulted field may be omitted on create, a field without
  one is required), so `ShapeFields` is no longer the mirror of the validation
  wrap. `where()` / `or()` accept `null` as the "no live value" predicate.
  Duplicate validation and system-entity creates accept absence per field rather
  than requiring a complete row.
- 6e2df83: Remove `.nullable()`.

  No field schema may admit `Null` any more: `{ value: null }` is the wire
  tombstone, not a stored null, so a field that admits one has no meaning.
  `defineEntity` rejects a `Null`-admitting field at registration and points at
  declarations (`default()` for a read value, `unset` to clear one).

  The two production fields that used it are ordinary optional reads:
  `relationship.target_id` is absent on a deleted edge (the edge is deleted, not
  nulled) and `group.apps` is absent on an unscoped group (absent means every
  app, while `{}` means none — neither takes a default). Their read types are
  now `T | undefined`. The bundled runner is rebuilt.

- 6e2df83: Clear a field with `unset`, not `null`.

  ```ts
  update(todo, { dueDate: unset });
  update(todo, { tags: { a: unset } }); // one map key
  ```

  `unset` is a frozen singleton recognised by `isUnset`, exported from
  `@ebbjs/core` and re-exported from `@ebbjs/write` and `@ebbjs/client`. The
  draft and committed update payload types accept it per field (and per map key);
  `wrapFields` compiles it to the existing tombstone envelope
  (`{ value: null, update_id, hlc }`), so the merge rule, the merge vectors, and
  the Elixir side are unchanged. `validatePayload` skips the marker — it is not a
  value — and rejects a literal `null` in a payload with a message naming
  `unset`. A literal `null` still passes through `wrapFields`, because tombstones
  arrive from other producers; rejecting it belongs at validation, where the
  intent is knowable. A `null` filter value keeps meaning "no live value".

- b8f0567: Add `e.enum(values)` — a closed-set field builder. The field reads as the
  members' literal union, so `EntityValues` narrows and a `switch` over it can be
  exhaustive, and a write carrying a value outside the set fails local validation
  through the same path as a wrong type. `.default()` takes a member and composes
  like the other builders.

  Strings are the app case; numbers and booleans are accepted as literals.
  `orderBy` follows the stored value — numbers numerically, everything else by
  locale, an absent value last — not declaration order.

  The schema README also documents the TypeBox escape hatch: anything `e` does
  not cover, including nested `Type.Object` values for `e.map`, can be passed
  straight to `defineEntity`.

### Patch Changes

- 3df4a29: Extract the shared write planner into `@ebbjs/schema` and `@ebbjs/write`.

  `@ebbjs/schema` now owns the entity, relationship, and schema definitions, the
  registry, validation, system entities, reserved names, and the
  collaborative-text field type. `@ebbjs/write` owns the operation vocabulary and
  the pure wire builders: create/update/delete/duplicate, membership scope and the
  membership refusals, the committer, relationship and `entityGroup` Updates,
  generated-part types, pointer normalization, and field projection.

  `@ebbjs/client` re-exports everything it exported before, so its public API is
  unchanged; the dependency direction is now `core → schema → write → client`.
  Nothing on the wire or in storage changes: this is a move, and the existing
  client suite is the regression gate. The functions runtime can build Updates
  from `@ebbjs/write` without depending on the client.

- ad79662: Declare components as the unit of a model's identity.

  `@ebbjs/schema` now exports `defineComponent`, `ComponentDef`, `ModelDef`, and
  `ModelRegistry`. `defineModel` accepts named components and bare field builders
  in one map; a builder normalises to an anonymous component named
  `<model>/<field>`, so existing field declarations keep their meaning.
  `ModelDef.components` records the declarations and `ModelDef.shape` is derived
  from them. Components declare their policy, including `loading: "eager" | "lazy"`. `defineSchema` takes `models` instead of `entities`, and rejects a
  component whose name does not belong to its model.

  This is a shape change only: the wire, storage, and merge rules are unchanged.
  The rename is mechanical — `defineEntity` → `defineModel`, `EntityDef` →
  `ModelDef`, `EntityRegistry` → `ModelRegistry` — and has no compatibility alias.

- Updated dependencies [ce74122]
- Updated dependencies [6e2df83]
- Updated dependencies [6e2df83]
  - @ebbjs/core@1.0.0
