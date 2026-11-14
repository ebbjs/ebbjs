# @ebbjs/storage

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

- d2cb29e: Hold, pin, and cold-read replica data per component instead of per row model.

  `MaterializationPolicy.holds` now takes a component (`<model>/<leaf>`), and the client
  derives it from the model registry, so a model's `materialization: "on-demand"` seeds
  `lazy` on each of its components and a single lazy component on a held model works with no
  extra declaration. A row is resident iff any of its components is held, or the row is
  pinned; its base row can be partial, with the components it knows exist but does not hold
  tracked as dormant. `Replica.open(id, component)` / `close(id, component)` address one
  component, the new `readComponent` seam returns one component's value, and
  `ReplicaStats` reports `components`, `residentComponents`, `heldComponents`,
  `pinnedComponents`, `nonResidentComponents`, and `nonResident`. `ReplicaStats.pinned`
  counts component pins, as do `pinnedCapacity` and the TTL.

  The persisted replica record moves to format 3: rows carry their held components and a new
  `notResident` map carries the components whose values are not persisted. An older record
  reads as absent, which resets local records as decision 9 allows.

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
