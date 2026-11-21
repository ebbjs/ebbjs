# @ebbjs/write

## 1.2.0

### Minor Changes

- ded31b2: The sync client's HTTP contract, its routes, its composite keys, and its value
  comparison each have one owner.

  `client/src/sync/http.ts` owns the actor header, the base-URL shape, and one body-read
  policy for every request. `client/src/sync/endpoints.ts` names every route the client
  calls — the group listing included, which test mocks now dispatch on instead of
  re-deriving its prefix. `client/src/sync/keys.ts` builds composite keys with their parts
  escaped, so a part that contains a separator no longer aliases two entries. `@ebbjs/core`
  gains `structuralEqual` and `canonicalKey`, which replace the query cache's `sameValue`,
  the query executor's `valuesEqual`, the schema hash's `stableStringify`, and the entity
  diff's `stableValueString`.

  `canonicalKey(value, { undefinedAs })` keeps both spellings of an absent value: the schema
  hash keeps `"null"`, the entity diff keeps `"undefined"` so absence and a stored `null`
  stay distinct. Both encode byte-for-byte as before.

  No wire value changed. No schema hash changed. The conflict-slot, hold, migration, and
  query-cache key strings changed, all in memory only — none is persisted or sent.

  ```diff
  -const response = await this.fetchImpl(`${this.serverUrl}/sync/handshake`, init);
  -if (!response.ok) {
  -  const text = await response.text().catch(() => "");
  -  throw new Error(`handshake failed: ${response.status} ${text}`);
  -}
  +const data = await requestJson<HandshakeResponse>(
  +  this.fetchImpl,
  +  `${this.serverUrl}${handshakePath()}`,
  +  init,
  +  "handshake",
  +);
  ```

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

- c7fcfdf: Permissions name the component a write names, and grants match by ancestry.

  There is no opt-in. `permission: "own"` is deleted from `defineComponent`; a schema that still
  declares it now fails at load with an unknown-option error rather than being accepted quietly.
  `ModelRegistry.permissionOf` is deleted.

  A grant covers a write when its subject is the write's subject or an ancestor of it, and its verb
  matches or is `*`:

  ```text
  "note.*"       // covers note/title and note/body
  "note/title.*" // covers note/title, not note/body
  "note.update"  // covers both: the model is the ancestor of its components
  ```

  A user row's create and delete still name no component, so they check the model: `note.create` and
  `note.delete` keep their meaning. A value write checks the component named on the wire, so a
  `note/body` update requires `note/body.update`. `note.*` covers it, and so does a grant whose
  subject is the model (`note.update`), because the model is an ancestor of every component under
  it. Every component an Action writes must be covered; an Action that writes `note/title` and
  `note/body` needs a grant for both.

  The platform's four components need no special case: `ebb/grant` is a subject under `ebb`, so
  `ebb.*` covers it. `fullGroupPermissions` is one `<model>.*` wildcard per model instead of one per
  component.

  Writes can be field-granular; reads cannot. Read filtering remains a group fan-out property, so a
  component grant narrows what a member may write, not what they may read.

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

- dcd7063: An edge is a keyed component of its **source** row: `ebb/link` carries
  `{ <field>: { <type>: { <targetId>: true } } }` instead of being a row of its own.

  ```diff
  -Update { subject_id: "rel_9f3", component: "ebb/link", method: "replace",
  -         data: { value: { source_id: "todo_1", target_id: "todo_2",
  -                          type: "todo", field: "dependsOn" } } }
  +Update { subject_id: "todo_1", component: "ebb/link", method: "merge",
  +         data: { map: { dependsOn: { map: { todo: { map: { todo_2: { value: true } } } } } } } }
  ```

  The edge's key is its whole identity — accessor, `type`, target — so two edges cannot share one, and
  removing one edge is a `merge` whose value tombstones that key (`value: null`) rather than a row
  delete. `drop` stays component-granular.

  A link's group scope is its source row's membership by construction, so a source that moves takes its
  edges with it and a peer that missed one obtains it by backfilling the source. There is no `rel_*`
  id, and no mirrored `<source>/<as>` field.

  `@ebbjs/client`: `setLinks({ replace })` refuses when the source row is not locally readable
  rather than writing a partial set; `link` / `unlink` still write the key they name.

  `@ebbjs/core` adds the value readers — `linkEdges`, `linkTargets`, `carriesLink`, `fieldComponent` —
  and `RelationshipSeed` loses its `id`: an edge seeds as one merge on its source.
  `systemValue`/`systemValueString` still answer for the three atomic platform components and answer
  `null`/`false` for the keyed one.

  `@ebbjs/write`: `buildRelationshipWrite` takes `sourceId` and an optional `currentTargets` (the live
  set a `{ replace }` or a one-cardinality move diffs against) and returns the `ebb/link` Updates;
  `buildRelationshipUpdate`, `buildManyEntityUpdate`, `collectManyTargetIds` and `relationshipSubjectId`
  are deleted. `VerbResolution` is `{ groupsOf, targetsOf }` — `relationshipIdFor` and `fkTargetsOf`
  are gone, because a target names the key an unlink removes. A many-cardinality `relate` is an add
  unless `replace` is set; `replace` refuses when the live targets are unknown rather than writing a
  partial set. `LinkWriteIds` is folded into `SystemRowIds`, and `linkEdgeUpdate` is no longer exported.

  `@ebbjs/storage`: forward traversal is a component read, so `RelationshipLink` and
  `queryByRelationshipSource` are deleted and the client's forward adjacency index with them;
  `queryByRelationship` still answers the reverse direction. `DirtyTracker` gains `getDirty()` for the
  reads that must materialize every dirty row. The IndexedDB read model moves to v17 and starts empty.

  Only `link` is reserved on a user model, because `ebb/link` is the one platform overlay that shares
  a row's field name; `group`, `grant` and `membership` are rows of their own under `ebb`, so
  `defineModel` still accepts fields by those names. A link write authorizes as `ebb/link.<verb>` in
  the source's group set, so `ebb.*` covers it and a model grant does not.

  Server data is discarded: there is no migration and no dual shape.

- 58835c6: One name per concept across the server and the client.

  A row's committed model is `model`, not `type`, on the wire, in SQLite, in IndexedDB, in
  the persisted replica record, and in `Entity`. `query(type)` is `query(model)`, `byType`
  is `byModel`, `getDirtyForType` is `getDirtyForModel`, and the replica's `typeIndex` is
  `modelIndex`. `type` now means one thing: a relationship's name.

  The id → committed-model map is the model cache, not an index: `EntityTypeCache` is
  `EntityModelCache`, `entity_types` is `entity_models`, `put_type`/`get_type` are
  `put_model`/`get_model`. It is not the component existence index, which is unchanged.

  The server's caches are named after the components they project: `EntityGroupCache` →
  `MembershipCache`, `GroupCache` → `GrantCache`. The old model vocabulary is gone with
  them — `entityGroupId` is `membershipRowId`, `LiveGroupMember` is `LiveGrant`,
  `groupMembersOf` is `grantsOf`, the `last_group_member` refusal is `last_grant`, and the
  seed types are `MembershipSeed` and `GrantSeed`. `ebbSystemEntity` is `ebbModel`;
  `EntityIndex`, which resolves scope rather than indexing, is `EntityScope`; component
  existence reads `carries?` rather than `present?`.

  ```diff
  -const entity = await replica.get(id); entity.type;
  +const entity = await replica.get(id); entity.model;
  -EntityTypeCache.put_type(id, "todo");
  +EntityModelCache.put_model(id, "todo");
  -entityGroupId(id, groupId);
  +membershipRowId(id, groupId);
  ```

  Persisted shapes moved incompatibly, so each is discarded rather than migrated:
  IndexedDB schema v15 renames the `entities` and `dirty` index and the `replica` key; the
  SQLite read model moves to v3 (`entities.model`, `idx_entities_model`) and rebuilds from
  the Action log; the replica record is format 5, now exported as
  `REPLICA_RECORD_FORMAT`.

- 2024699: One `ctx` port, declared where both sides already look.

  The handler's port was declared twice — once in the SDK's typings and once in the runtime
  that implements it — and the copies had drifted: the runtime grew `log` and `env`, the SDK
  never heard of them. The port now lives in `@ebbjs/write`, with the verbs left open over
  the entity name, so `@ebbjs/server`'s `Context<S>` narrows the names to the schema's
  models and `@ebbjs/functions-runtime`'s `Context` adds `log` and `env`, and neither
  restates a verb signature or an option shape. `RelationshipTarget`, `CreateOptions`,
  `WriteOptions`, `UnrelateOptions`, `CommitOutcome`, `Caller`, and `CallerKind` live beside
  it, re-exported where they were imported before.

  `EntityResponse` moved with it, because `ctx.get`'s read shape is now part of that shared
  port and the port cannot depend on the client that parses the same JSON. `@ebbjs/client`
  still exports `EntityResponse` and `EntityResponseSchema`; only the definition's home
  changed.

  ```diff
  -import type { Context } from "@ebbjs/server";
  +import { createContext, type Context } from "@ebbjs/functions-runtime";
  ```

  `@ebbjs/runner` no longer depends on `@ebbjs/server`: its one use was that type.

### Patch Changes

- Updated dependencies [ded31b2]
- Updated dependencies [fae4e88]
- Updated dependencies [ed66062]
- Updated dependencies [baf0bfd]
- Updated dependencies [e30f842]
- Updated dependencies [a682fe8]
- Updated dependencies [c7fcfdf]
- Updated dependencies [0c5c5d5]
- Updated dependencies [437c80d]
- Updated dependencies [dcd7063]
- Updated dependencies [0b61d7c]
- Updated dependencies [58835c6]
  - @ebbjs/core@1.2.0
  - @ebbjs/schema@1.2.0

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

- Updated dependencies [cbac1a0]
  - @ebbjs/schema@1.1.0
  - @ebbjs/core@1.1.0

## 1.0.0

### Major Changes

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

- 6e2df83: Read types state absence: a field with a declared default reads as `T`, a field
  without one reads as `T | undefined`. `EntityDef` gains `createShape`, the
  inverse relation (a defaulted field may be omitted on create, a field without
  one is required), so `ShapeFields` is no longer the mirror of the validation
  wrap. `where()` / `or()` accept `null` as the "no live value" predicate.
  Duplicate validation and system-entity creates accept absence per field rather
  than requiring a complete row.
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

- 48e9b64: Read entity history from the replica's Action log.

  `client.history({ entityId, limit?, beforeGsn? })` returns one `HistoryEvent` per Action that touched the entity, newest first, with the actor, HLC, GSN, the entity's Update methods, and the field-level `changes` in the same `EntityDiff` vocabulary the conflict view uses. `client.replay({ entityId, at: { actionId } })` folds the log up to a past Action and returns the row as it stood then, including the retained fields of a tombstone.

  The read is bounded by the local log: local writes appear only after their echo, `limit` slices a full `getForEntity` read, and compaction (#123) will shorten the window. Those cases — unknown entity, tombstoned entity, absent history, late joiner — are documented in the new "Entity history" page.

  Internally the conflict diff (`EntityDiff`, `diffEntity`) moved to `@ebbjs/write` and the per-entity fold (`foldEntityAction`) moved into `@ebbjs/storage`'s materialization helpers, so history, the conflict view, and both entity stores share one projection and one fold. `EntityDiff` remains exported from `@ebbjs/client`.

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

- Updated dependencies [3df4a29]
- Updated dependencies [ce74122]
- Updated dependencies [6e2df83]
- Updated dependencies [6e2df83]
- Updated dependencies [6e2df83]
- Updated dependencies [6e2df83]
- Updated dependencies [6e2df83]
- Updated dependencies [6e2df83]
- Updated dependencies [6e2df83]
- Updated dependencies [6e2df83]
- Updated dependencies [b8f0567]
- Updated dependencies [b113df5]
- Updated dependencies [b8fe081]
- Updated dependencies [ad79662]
  - @ebbjs/schema@1.0.0
  - @ebbjs/core@1.0.0
