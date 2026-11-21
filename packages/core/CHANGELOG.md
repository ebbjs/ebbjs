# @ebbjs/core

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

- fae4e88: MessagePack now carries every value exactly as sent: the HLC-as-integer conversion
  layer is gone.

  `encode`/`decode` and their sync twins wrapped msgpack in `convert.ts`, which walked
  the whole payload turning HLC-shaped strings into numbers on the way out and
  rewriting large integers into strings on the way back. Neither direction did what
  it meant. A packed HLC is `ms << 16`, ~1.1e17, above `Number.MAX_SAFE_INTEGER`, so
  `hlcToInteger` always returned the string it was given — every HLC already travelled
  as a decimal string. The inverse turned any decoded integer above 1e12 into a
  string, because it could not tell an HLC from a phone number, an account id, or an
  11–15 digit code. `SyncClient.submitActions` posts every Action through
  `encodeSync`, so both halves were retyping ordinary data on the live write path.

  The module is deleted rather than gated: nothing outside `msgpack/index.ts`
  imported it and the package never re-exported it. On the wire, a real HLC is
  unchanged.

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

## 1.1.0

No changes in this release.

## 1.0.0

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

## 0.3.0

No changes in this release.

## 0.2.0

### Minor Changes

- a46e201: `receiveRemoteHLC` now refuses only a remote HLC more than 120s ahead of the wall clock, mirroring the server's `ActionValidator`, and validates the remote value before mutating the clock so a refused merge is a no-op. Any past HLC is accepted because it only loses the merge. This narrows the public `MAX_FUTURE_DRIFT_MS` to a bound on the remote value rather than the merged local clock, and removes `MAX_PAST_DRIFT_MS` from `@ebbjs/core`'s exports.

## 0.1.1

### Patch Changes

- d19bff2: Republish through npm trusted publishing to validate the OIDC release path.
  No functional change. `0.1.0` was bootstrapped with a granular token and is the
  only version of these packages published without provenance.

## 0.1.0

### Minor Changes

- 2004274: First public release. All `@ebbjs/*` packages share one version and ship together; `@ebbjs/server` and `@ebbjs/www` stay private.
