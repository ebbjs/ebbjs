# @ebbjs/storage

## 1.2.0

### Minor Changes

- ed66062: One owner per duplicated concept, in `@ebbjs/core`.

  `@ebbjs/storage` deliberately does not depend on `@ebbjs/schema`, and both already depend on
  `@ebbjs/core`, so the vocabulary they must agree on now lives there once.

  ```diff
  -# schema/src/platform-model.ts   export const GROUPS_ACCESSOR = "groups"
  -# schema/src/reserved.ts        export const RESERVED_MEMBERSHIP_NAMES = ["groups"] as const
  -# storage/src/internal/reverse-index.ts  const MEMBERSHIP_ACCESSOR = "groups"
  +# core/src/system.ts            export const GROUPS_ACCESSOR = "groups"
  ```

  - `GROUPS_ACCESSOR` is declared in `@ebbjs/core` and re-exported by `@ebbjs/schema`. The storage
    adjacency index's membership accessor and `RESERVED_MEMBERSHIP_NAMES` both derive from it, so the
    reserved name and the index key cannot drift apart.
  - `ConflictScope` (`"field" | "component" | "entity"`) is declared in `@ebbjs/core` and aliased by
    `@ebbjs/schema`, by `OutboxConflict.scope`, and by the client's catch-up pass. A fourth scope is
    now a compile error at the declaration, the persisted payload, and the comparison, rather than a
    silently-rejected persisted shape.

  `@ebbjs/storage` grows two names and one default:
  - `DEFAULT_DB_NAME` is the database an IndexedDB adapter opens when the caller passes none.
  - `RESET_VERSIONS` replaces the seven `*_RESET_VERSION` constants and the hand-re-listed array built
    from them: one list of `{ version, reason }`, which `createEbbStores` and the doc block both read.
    A gate added to the list is a gate the reset runs; versions and behaviour are unchanged.
  - `DEFAULT_JOURNAL_CAPACITY` and `DEFAULT_PINNED_TTL_MS` are exported, and the `ReplicaOptions`
    docs reference them instead of restating their numbers.

- baf0bfd: Internals that nothing reached are gone; no public API changed.

  `@ebbjs/core` drops an unexported module of typebox-wrapping validators that no importer,
  package export, or test referenced. `@ebbjs/storage` drops the component-set helpers the
  per-component existence index superseded, with their cases moved onto the surviving
  functions. `@ebbjs/schema` drops the anchor comparator and the cut-coverage helper the
  projection already inlines. `@ebbjs/client` drops an unused conflict-oracle alias, keeps
  three conflict and query-plan helpers private to their own modules, and trims two presence
  fields that were written and never read.

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

- c89ddbb: Remove the replica's pin cap: a read keeps every component it selects.

  `ReplicaOptions.pinnedCapacity` and `SyncClientOptions.pinnedCapacity` are gone, along
  with the LRU trim that released the least recently opened component once the window
  filled. Opening a component no longer releases another one, so a row with more on-demand
  components than the old default of 16 no longer comes back partial: the components
  requested first were dropped silently, with no error and no event. Memory is bounded by
  `close` and `pinnedTtlMs` alone — a component stays resident until it is closed and its
  TTL elapses — and `DEFAULT_PINNED_CAPACITY` is no longer exported.

- c8c14fc: Add the component lease table: a refcounted claim on one `(entity, component)` value.

  `createLeaseTable` is the residency primitive the replica's pins are being replaced by
  (#935, part of #933). A caller acquires the components it reads and gets a single-shot
  release back; two callers on the same key share one value and one read, and only the last
  release starts the grace period. One `residencyTtlMs` (default 60s) decides how long an
  inactive value stays warm, and expiry checks that nothing holds the key and that it is
  still the generation the timer was armed for, so a remount inside the TTL cancels expiry
  and a stale timer cannot free a re-acquired value. `stats()` reports `leased`,
  `inactive`, `resident`, `timers`, and `oldestInactiveMs`. There is no cap and no
  eviction by size. Nothing wires it into the replica yet.

- c2df5ba: Replace the replica's pins with component leases.

  `open` / `close` are gone: residency is a lease the replica takes for a read and releases
  when the value is installed. A released value stays resident for `residencyTtlMs` (default
  60s, was a 30s pin TTL), a leased value is never released, and there is still no cap. Reads
  go through `replica.read(id, components)`, which installs the non-held components the caller
  names and returns the composed row; `client.<entity>.get(id)` and a cold join use it. The
  pin table, its LRU order, `isOpen`, and the pin stats are deleted. `ReplicaStats.pinned` and
  `pinnedComponents` are replaced by `ReplicaStats.leases` (`leased`, `inactive`,
  `oldestInactiveMs`, overall and per component), and `ReplicaOptions.pinnedTtlMs` by
  `residencyTtlMs`. Acquiring or releasing a value no longer advances the content revision:
  installing an on-demand component and expiring one are residency events, so neither journals
  an entry and neither makes a cached query re-run.

  BREAKING CHANGE: `Replica.open`, `Replica.close`, and `Replica.isOpen` are removed in favour
  of `Replica.read`; `ReplicaOptions.pinnedTtlMs` is renamed `residencyTtlMs`;
  `ReplicaStats.pinned` and `ReplicaStats.pinnedComponents` are removed in favour of
  `ReplicaStats.leases`.

- ef309da: Add the subscription registry and the replica claim a subscription holds.

  Every live query and row subscription now lives in one registry
  (`createSubscriptionRegistry`), exposed as `client.subscriptions`. An entry owns
  its read set, its own revision cursor, the result its consumer published, the
  claims its dependencies need, and whether it is still live. The registry holds
  the one replica subscription and dispatch cursor, reads the journal once per
  batch, and hands the changes to the entries they touch. A caught-up entry's
  cursor advances through the batch before its listeners run, so one consumer's
  throwing listener is reported and cannot skip a peer or lose its own batch; an
  entry whose consumer is still processing an earlier revision — an async re-run
  in flight — keeps its cursor there until the run settles, so a peer's unrelated
  write cannot report a stale result as caught up. `entries()` returns non-owning
  snapshots for leak visibility. The query cache and the row subscriptions both
  mount on the registry instead of running their own loops.

  Residency follows the subscription: a live entry holds the components its result
  reads, and unsubscribing releases them, which starts the residency grace period.
  Two subscriptions reading one `(row, component)` share one resident value and
  one claim. The query cache keeps its inactive-result TTL for now; that lifetime
  merges with `residencyTtlMs` in #941, and indexed dispatch replaces the scan in
  #938.

  `Replica.acquire(id, components)` is the long-lived counterpart of
  `Replica.read`: it claims the values a subscription depends on, installing any
  the replica does not hold, and returns one idempotent release. A held component
  needs no claim, a component the row does not carry is not claimed, and a claim
  that resolves after its subscription ended releases what it took.

  A live entry claims only the components its result already has resident: it does
  not re-materialize a value that left the replica, even though `acquire` would
  install it. A row that lost a component to an earlier expiry stays partial under
  its subscription until the next read or re-run, which is #940's selection work.

  BREAKING CHANGE: `ReplicaSignal` and `client.replicaSignal` are removed — the
  registry owns dispatch and reads the journal itself, so the extra fan-out cursor
  had no consumer. `ReplicaAccess.signal` is replaced by
  `ReplicaAccess.subscriptions`, and `createQueryCache` takes the subscription
  registry where it took the replica signal.

- 9d9008c: Separate a value change from a row entering or leaving the set it is read from.

  A `ReplicaChange` used to describe both with one shape, so "this row entered the
  model's set" was encoded as `components: []` and a reader could not tell it apart
  from a row that carried nothing. Every change now names its kind:

  ```ts
  { kind: "content", revision, id, deleted, components: ["note/title"] }
  { kind: "membership", revision, id, deleted, membership: "entered" | "left" | "changed-model", models }
  ```

  A content change names the components it touched and is the only kind that does.
  A membership change says what the row's place in a model's set did and names the
  models instead, because a row can enter or leave carrying any component. A create
  and a delete are each exactly one membership change; a component write is exactly
  one content change naming that component. A write that moves a row out of the set
  it was in is a membership change; a write on a row that was not observable
  journals nothing. `deleted` now reports whether the row is tombstoned, so a
  soft delete and a scope eviction are distinguishable without reading the row.

  Installing or releasing a residency value still journals nothing and still never
  advances the content revision. `unloaded` is driven from that lease loss rather
  than from a journal entry: a subscription's change listener receives the
  components it was holding that the replica dropped as its third argument, so a
  row that leaves the replica reads as an unloaded value rather than as a change.
  Query dispatch matches a content change by component as before, and a membership
  change against every reader of the model it names, exact or whole — which is why
  a component-scoped read is invalidated by a delete it never saw a component for.

  Dispatch cost moves with it: 100 changes over 5,000 subscriptions now report
  **3,810 touched** where #938 measured 2,621, at the same 280 lookups. The extra
  1,189 are required, not waste. A membership change names no component, so no
  read over `note` can prove it ignores a row entering or leaving `note`: every
  reader of that model — whole-model and exact-component alike — has to see it.
  The old 2,621 was a content-only count, because the one change kind that
  described a row leaving named every component it carried and was matched as
  content; the new count is the honest one for a set change. Exact readers of
  other models stay untouched, which is what the same test asserts.

- 9352c06: Merge the query cache and the residency TTLs into one inactive lifetime.

  A released query result is now an inactive subscription in the registry: it keeps
  its result, its revision cursor, and the component leases its result read for one
  `residencyTtlMs` (default 60s), then result and claims end together. A remount
  inside that lifetime performs no store read and no re-run when nothing relevant
  changed; a change that touched the read set marks the result stale and the remount
  re-runs once. The query cache is a view over that registry — it holds no result,
  no entry map, and no timer of its own — so there is one answer to how long an
  unwatched read stays warm.

  Breaking changes:
  - `SyncClientOptions.queryTtlMs`, `DEFAULT_QUERY_TTL_MS`, and
    `QueryCacheOptions` are gone. `residencyTtlMs` is the one inactive lifetime for
    both a released component value and an inactive query result; a non-positive or
    non-finite value disables expiry for both.
  - `createQueryCache(replica, subscriptions?)` no longer takes a lifetime option.
    `createSubscriptionRegistry(replica, { residencyTtlMs })` owns it.
  - A query subscription's entry stays registered after its last subscriber leaves
    and reports `state: "inactive"`, with its claims still leased. `SubscriptionState`
    gains `inactive`, `SubscriptionStats` gains `inactive`, and a registry entry now
    carries the consumer state it was opened with.
  - A change listener receives the entry's writer as its fourth argument, so an
    inactive result can publish `stale` without holding a subscriber.

  For `@ebbjs/storage`: `@ebbjs/storage/replica` now exports `residencyTtlOf` and
  `unrefTimer`, the two decisions both stages of one residency lifetime read. The
  client's registry called its own copies of them, and a divergence would have let
  `0` or `NaN` mean different things for a result and for the values it claims.
  They are additive exports, not a behaviour change.

- 0b61d7c: Remove the declared read-residency policy: `loading` and `materialization` are gone.

  `ComponentOptions.loading` (`"eager"` / `"lazy"`), `ModelOptions.materialization`
  (`"held"` / `"on-demand"`), the `ComponentDef.loading` and `ModelDef.materialization`
  fields, and `ModelRegistry.loadingOf` are deleted. A declaration that still names one
  fails at `defineComponent` / `defineModel` rather than being ignored. Residency is now
  decided by what the replica folded and by the leases a read holds: a synced row carries a
  value for every component it knows, and a row the replica does not hold — one outside the
  client's subscribed scope, or one the persisted view did not carry — is served by the
  entity store on read and released again after `residencyTtlMs`. There is still no cap, and
  a component selection is the only thing that narrows what a read projects. A value the log
  folded has no lease, so nothing reclaims it today: it stays resident for the session, and
  reclaiming it needs a memory budget tracked in #957.

  `MaterializationPolicy`, `holdAll`, `Replica.isHeld`, and `Replica.isRowHeld` are removed;
  `Replica.fullyResident(row)` replaces the last of them as the store-mirror rule. `readComponent`
  may return the whole row: the replica adopts it, keeping any value it already holds for
  itself. `ReplicaStats` loses `held`, `heldByModel`, `heldComponents`, `residentComponents`,
  `nonResident`, and `nonResidentComponents`; `entities`, `byModel`, `components`, and
  `leases` remain. `ReplicaRecord.notResident` is gone, so a persisted record carries only
  rows the replica held at the time.

  Durability is unchanged: the entity store still receives every synced row whether or not
  its components are resident, and a record written by this build carries the same rows it
  did before the removal. `REPLICA_RECORD_FORMAT` bumps 6 → 7, because a pre-#943 record
  names a row's unpersisted components only in `notResident`; reading one would adopt a
  partial row as whole, so it is discarded and the client replays the Action log instead.

  BREAKING CHANGE: component `loading` and model `materialization` are removed with no alias;
  `MaterializationPolicy`, `holdAll`, `Replica.isHeld`, `Replica.isRowHeld`, the `held` /
  `nonResident` replica stats, and `ReplicaRecord.notResident` are removed. `Replica.fullyResident(row)`
  replaces `isRowHeld`.

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

- 3698b0a: One list of storage types, re-exported from both entries.

  The root entry and `@ebbjs/storage/types` were two hand-maintained copies of the same
  export list, and they had drifted: `ConflictHold`, `ConflictRemoteAction`, and
  `ReplicaStats` were in `types/index.ts` but missing from the root entry's own module. The
  list now lives in `src/types/index.ts` and the root entry re-exports it whole, so both
  paths always publish the same types — the three names included — and can no longer
  disagree about what `@ebbjs/storage` exports.

  ```diff
  -import type { StorageAdapter } from "@ebbjs/storage";
  +import type { StorageAdapter, ConflictHold } from "@ebbjs/storage";
  ```

  The redundant re-export block in `types/storage-adapter.ts` is gone; that module now
  exports only `StorageAdapter`.

### Patch Changes

- Updated dependencies [ded31b2]
- Updated dependencies [fae4e88]
- Updated dependencies [ed66062]
- Updated dependencies [baf0bfd]
- Updated dependencies [437c80d]
- Updated dependencies [dcd7063]
- Updated dependencies [58835c6]
  - @ebbjs/core@1.2.0

## 1.1.0

### Minor Changes

- 0ed2c5f: Add a durable component existence index and journal the components a change touched.

  `ReplicaChange` now carries `components: readonly string[]` — the components the
  composed-view change actually touched — so a derived reader can invalidate on what
  it read rather than on the row's whole model. `EntityStore` gains
  `queryByComponent(component)`, and the IndexedDB adapter stores the row's component
  names behind a `multiEntry` index, which resets a database below schema version 11
  rather than migrating it.

  Both additions are required members, so an out-of-tree `EntityStore` implementer or
  anything constructing a `ReplicaChange` must update; pre-alpha, that is recorded as
  a minor step rather than a major one. No wire or stored-action shape moves. The
  server-side half (`cf_component_entities`, the SQLite `entity_components` mirror) is
  internal to `ebb_server` and unpublished.

- 606ee0d: Invalidate cached query results per component instead of per row model, and stop
  journalling a change's row type.

  `Plan.readTypes` is removed. `Plan.readComponents` records the components a
  change must touch to alter a plan's matching-id result — the fields its
  predicates and ordering name, the components its existence tests name, and the
  `relationship` and `entityGroup` models its edge and membership indices read. A
  query that cannot name what it depends on (a full scan, or a disjunction with a
  branch that only excludes) reads its model whole (`<model>/*`).
  `rowReadComponentsFor(query)` carries the superset a projected-row result reads,
  because a projected row keeps the whole shape plus its `groupIds`.

  `ReplicaChange.type` is removed. A change names only the components it touched,
  and a write that moves a row between models names each field under both
  prefixes. A change that names none — a tombstone or eviction of a row that
  carried no component — invalidates every whole-model read.

  `QueryCache` tests a change's `components` against the entry's compiled reads,
  memoised once per component set and shared by every entry that reads it. A
  `title` write no longer re-runs a collection plan that reads only `status`; a
  full scan still invalidates on any component of the model it scans. A
  projected-row result keeps the whole shape, so it still reads its source and
  joined models whole; the precision lands where a result keeps only matching ids.

  `Plan.readTypes` and `ReplicaChange.type` are removed, not deprecated; use
  `readComponents` and `components`. Pre-alpha, a removal lands as a minor step:
  there are no major changesets until the packages are post-alpha.

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

### Minor Changes

- 48e9b64: Read entity history from the replica's Action log.

  `client.history({ entityId, limit?, beforeGsn? })` returns one `HistoryEvent` per Action that touched the entity, newest first, with the actor, HLC, GSN, the entity's Update methods, and the field-level `changes` in the same `EntityDiff` vocabulary the conflict view uses. `client.replay({ entityId, at: { actionId } })` folds the log up to a past Action and returns the row as it stood then, including the retained fields of a tombstone.

  The read is bounded by the local log: local writes appear only after their echo, `limit` slices a full `getForEntity` read, and compaction (#123) will shorten the window. Those cases — unknown entity, tombstoned entity, absent history, late joiner — are documented in the new "Entity history" page.

  Internally the conflict diff (`EntityDiff`, `diffEntity`) moved to `@ebbjs/write` and the per-entity fold (`foldEntityAction`) moved into `@ebbjs/storage`'s materialization helpers, so history, the conflict view, and both entity stores share one projection and one fold. `EntityDiff` remains exported from `@ebbjs/client`.

- e543a97: One generic conflict: scope is declared, policy is application code.

  Ebb holds and reports; the application copies a backup, resolves, does
  nothing, or writes again. Ebb is pre-1.0, so the breaking surface ships as a
  minor rather than a major, following the #692 precedent.

  Removed:
  - `client.conflicts.resolve(conflictId, "retry" | "discard")`,
    `client.conflicts.resolveEntries(entryIds, ...)`, and the
    `ConflictResolution` type.
  - `Conflict.remoteWins()`. It was an entity-level aggregate of a position-level
    question. Read `entry.slots[i].remoteWins()` for field scope; an
    entity-scope entry has no slots.
  - The `retry` re-stamp path (`restampField`, `restampUpdate`, `restampAction`,
    and the `stampAction` / `hlc` / `generateUpdateId` collaborators). Re-stamping
    every leaf recursed into map entries and rewrote their `update_id` and HLC —
    the only code path that could silently fabricate ordering on an append-only
    log. "Make my value win" is a normal write through `defineAction` with a
    fresh clock.
  - `Outbox.retryConflicted(originalId, action)`. It is replaced by
    `releaseConflict(actionId)`, which returns the row to `pending` with its
    Action untouched.

  New verbs:
  - `client.conflicts.sendLocalActions(conflictId)` clears the hold and submits
    the held Actions verbatim — same action id, Update ids, and field HLCs.
  - `client.conflicts.clearLocalActions(conflictId)` drops the held Actions and
    the local writes the hold was keeping off the wire, converging those
    subjects on the server's view.

  Subject hold:
  - Every subject named by an open conflict is held. A later local write to it is
    durable and applied optimistically, but `pending()` and the flush exclude it
    until the conflict resolves.
  - The hold is derived from the durable `conflicted` rows, so a reload preserves
    it with no second store.
  - The hold applies to `pending` writes only; an `acknowledged` write is already
    on the server and is never re-held. Detection now considers `pending` writes
    only for the same reason.
  - `Outbox.heldPending(subjects)` snapshots the writes a hold excludes and
    `Outbox.dropHeld(actionIds)` removes exactly those; a write made after the
    hold lifts is never dropped.

  Report additions: `Conflict.scope` and `Conflict.remoteActions` (actor id,
  action id, GSN of the concurrent missed Actions). The per-subject `before` /
  `after` rows and their `EntityDiff` already existed. `ConflictEntry.slots` is
  now absent for an entity-scope entry, and `ConflictEntry` carries its own
  `scope` and `remoteActions`. `OutboxConflict` gains required `scope` and
  `remoteActions` fields, persisted under IndexedDB schema version 10 (additive:
  a pre-v10 row reads as field scope with no recorded remote context).
  `ConflictRemoteAction` is exported from `@ebbjs/storage/types` and
  `@ebbjs/client`; `ConflictScope` remains the single declaration exported from
  `@ebbjs/schema`. The IndexedDB outbox store normalizes a pre-v10 payload on
  read, so a row written before the bump cannot make the conflict view
  unreachable.

  `clearLocalActions` drops the pending writes to the conflict's subjects, so the
  subjects really converge. An Action writing several subjects is held or
  dropped whole; an Action cannot be sent in part. In a partial pass, only the
  subjects the resolved entries released are converged; a subject a failed entry still names stays held and keeps its
  writes. A durable-store fault in the final drop or flush rejects rather than
  returning a partial result.

### Patch Changes

- Updated dependencies [ce74122]
- Updated dependencies [6e2df83]
- Updated dependencies [6e2df83]
  - @ebbjs/core@1.0.0

## 0.3.0

### Patch Changes

- @ebbjs/core@0.3.0

## 0.2.0

### Minor Changes

- a46e201: `receiveRemoteHLC` now refuses only a remote HLC more than 120s ahead of the wall clock, mirroring the server's `ActionValidator`, and validates the remote value before mutating the clock so a refused merge is a no-op. Any past HLC is accepted because it only loses the merge. This narrows the public `MAX_FUTURE_DRIFT_MS` to a bound on the remote value rather than the merged local clock, and removes `MAX_PAST_DRIFT_MS` from `@ebbjs/core`'s exports.

### Patch Changes

- Updated dependencies [a46e201]
  - @ebbjs/core@0.2.0

## 0.1.1

### Patch Changes

- d19bff2: Republish through npm trusted publishing to validate the OIDC release path.
  No functional change. `0.1.0` was bootstrapped with a granular token and is the
  only version of these packages published without provenance.
- Updated dependencies [d19bff2]
  - @ebbjs/core@0.1.1

## 0.1.0

### Minor Changes

- 2004274: First public release. All `@ebbjs/*` packages share one version and ship together; `@ebbjs/server` and `@ebbjs/www` stay private.

### Patch Changes

- Updated dependencies [2004274]
  - @ebbjs/core@0.1.0
