# @ebbjs/client

## 1.2.0

### Minor Changes

- 6375cdb: `close()` aborts the client's in-flight requests instead of letting them finish.

  Every plain HTTP path — catch-up, writes, entity reads, function calls, the group listing —
  kept running after teardown and then applied rows, persisted replica state, or wrote
  `acknowledged` outbox rows through a storage adapter that may already be closed. One
  `AbortController` per client, aborted only from `close()`, now rides on the single wrapped
  fetch the constructor builds, so every call site inherits it. A caller-supplied
  `init.signal` is merged by hand rather than with `AbortSignal.any`, which cannot detach at
  settle and would leave a listener on the session-long signal per request.

  This is observable, so it ships as a minor. New: `ClientClosedError`, the one shape a
  closed client reports. A `write()` after `close()` throws it before touching the outbox,
  and a `write()` in flight when `close()` lands rejects with it, leaving its outbox entry
  `pending` (the submit threw, so it is `unreachable`, not `error`) rather than marking it
  acknowledged. No request that had not yet responded applies rows or marks an entry
  acknowledged. Abort cannot retract work already past the fetch: a body read before
  `close()` finishes applying, and the final replica save still runs so a clean teardown does
  not lose local writes. A body read the abort interrupts rethrows instead of degrading to an
  empty one, which is what stopped an interrupted `invokeFunction` from reporting a void
  success.

  Three follow-ons keep the guarantee honest: a `keepalive` request is the one the teardown
  leaves on the wire, keyed on the flag rather than on the presence call site, because
  `presence.leave({ keepalive: true })` comes from an unload handler; a backfill or group
  listing a teardown interrupted reports no failures and `client.backfill()` resolves without
  saving once closed; and replacing a session via `subscribe()` or calling a plain
  `unsubscribe()` aborts nothing — only `close()` does.

- 1fdb64d: Reads can select the components they project instead of reading a model whole.

  `query().select({ title: true })` and `get(id, { select })` make one declaration
  the projection, the lease set, and the invalidation key. A selected field is
  returned, held, and watched; an unselected component write no longer invalidates
  the result. System components stay planner-supplied: `groupIds` is on every
  query row, a relationship predicate or join adds `ebb/link`, and a membership
  predicate or the `groups` join adds `ebb/membership` — none is selectable, and
  `groupIds` is structural rather than selected.

  A query that projects a component the replica does not hold narrows the ids
  first, then acquires the page. An unlimited projection is therefore a full read
  of the type; page it with `limit`.

  Breaking changes:
  - `get(id, { select })` replaces the on-demand query refusal: there is no
    `OnDemandQueryError`, no `modelIsHeld`, and no whole-model read fallback. A
    query over a type with non-resident components narrows first and reads the
    page it projects.
  - Joins are leased dependencies on one-shot and cached reads rather than a
    special on-demand path (`coldJoins`, `openJoinedRows`, `hasOnDemandJoin`).
  - `EntityRow.subscribe` now takes a listener over `EntityEvent`
    (`snapshot` / `unloaded`) instead of a bare `EntitySnapshot`. A snapshot is
    the current projection, a tombstone included; `unloaded` names one released
    component, or omits the component when the row left the replica.
  - Two selections of one query are distinct cache entries, and two selections of
    one row are distinct subscriptions: each leases what it reads, and a released
    component is reported once per reader.

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

- a58874a: Give each derived query index one module (#1003).

  The relation, existence and scope index families now own both directions of
  their contract: the index dependencies a read declares, and the keys a change
  resolves to under them. `structuralReads` composes over the same registered
  family list `createIndexResolvers` serves, so a declaration and its resolver
  cannot drift apart, and a hypothetical fourth index is one family module plus
  one entry in that list.

  The relation coverage rule — forward, one-cardinality, non-self, pinned by
  every OR group — moves beside the index it protects. The wire index names,
  `createIndexResolvers`' keyed record, the touched sets, and dispatch lookup
  counts are unchanged. `structuralReads` is exported, and for a read that mixes
  families its `indices` and `covered` arrays now list relation declarations
  first; the members are the same.

- 3ad6434: Resolve the relation, existence and scope indices from journal deltas (#1005).

  The three query index families now answer from `ReplicaChange.delta` instead of
  falling back whenever a change does not name the component an index reads:
  - **relation** — a link write or a membership change answers the targets the
    delta's `edges` part added and removed under the `(as, type)` the index name
    encodes, plus the changed row. A delta with no part for that pair moved no
    target under it, so the row alone answers.
  - **existence** — a content change answers from the components it names, since
    one Action can move one component's value while another arrives; a membership
    change answers `delta.existence`, and answers nothing when the delta moved
    some other component's. Only a change carrying no delta at all falls back.
  - **scope** — `delta.membership` answers the group on each side a move touched,
    the one an eviction left, and nothing for a change that moved no pair.

  `null` now remains only for a change whose shape cannot say what moved: a link
  write or a membership change with no delta. A delta that simply lacks the part
  one resolver reads is a change that moved nothing there, and answers "nothing to
  touch" — never a fallback. The failure mode is still an extra touch, never a
  miss.

  A read with a relationship join keeps `ebb/link` in the dispatch set. The index
  keys the predicate's targets, while a join projects the source row's edges, so a
  link write on that row can move the join without moving a predicate target;
  narrowing that needs a keyed observation of the source row, which this change
  does not add.

  The relation dispatch benchmark is now a 100-change link-write batch over 1,000
  subscriptions for a relationship predicate read. The component read set touches
  all 1,000 subscriptions; the delta resolves the batch to 10. #961's resolver
  answered `null` for a link write and would fall back to all 1,000 on the same
  batch. The previous value-write batch resolved to 100 and imposed no delta work.

- b5ae10c: Let a subscription consumer supply derived-index keys (#1007).

  `SubscriptionWriter.depend` and `Subscription.depend` now take an optional list
  of `IndexDependency` keys beside the claims: `depend(dependencies, indices?)`.
  A result whose keys come from the rows it holds rather than from its query — the
  membership row each projected row is filed by — can declare them there, and the
  registry merges them with the entry's declared keys, dedupes by `(index, key)`,
  and re-indexes that one entry. Adding or removing a key costs the entry's own
  re-index; it re-acquires nothing, does not move the entry's claim generation,
  and does not restart the lease watchdog's quiet period, because no claim moved.

  `indices` absent means "no opinion": the keys the consumer supplied stay in
  force, so the patch path's `depend(dependencies)` is unchanged. That default is
  safe because a patch rewrites a row in place and cannot change the set of rows a
  result holds; a caller that changes its rows must state the new keys, and
  `indices: []` withdraws them. Row subscriptions are unaffected, and
  `depend(dependencies)` keeps its exact behaviour for every existing caller.

  The seam narrows **dispatch** only. A consumer that registers keys has to match
  its own re-checks against the same keys in the same change, which is #1011's
  work for the read path: keys registered here while `isRelevant` still tests the
  old read set would let dispatch deliver a change the consumer then seeks past.
  `IndexDependency` is now exported from the package entry point, so a consumer
  can name the shape of the keys it supplies.

- 255ac38: Resolve a membership departure to the entity it filed (#1010).

  The membership index a row subscription declares now distinguishes "this change
  names no key" from "cannot say". A live membership row answers the entity it
  files — a tombstone still states it. A row that no longer states it, because the
  replica dropped it (an eviction) or the change took the subject away, answers the
  member half of each `delta.membership` pair the change records, so the row
  subscription watching that entity is touched instead of skipped. A refile
  answers both entities it moved the row between, since each lost or gained a
  group.

  `[]` stays reserved for a change that names no membership row this index answers
  for, or one whose delta names no member on either side. Anything else — a change
  with no delta at all, even one whose row is readable — answers "cannot say" and
  touches every row subscription that declared the index: the row only proves the
  side it is on now. The visible effect is that an unshare or an eviction now
  reaches the row subscription for the entity it removed from a group, and the
  fallback breadth survives for a journal that cannot name the subject.

- e30f842: `e.log(entrySchema)` declares an append-only log component: a keyed component whose
  entries may only be added. Its wire shape is an ordinary map, so merge, storage, and the
  server need no new code; the entry payload is opaque and the map key is minted by the
  writer, never parsed. A log must be the component's own shape — a field-map component is
  one atomic merge position — so `defineComponent` now refuses a nested log and an app
  declares the engine leaf and the log as sibling components.

  `SyncClient.write` now drives the append-only guard from the registry
  (`ModelRegistry.isLogField`) and generic schema helpers (`logEntriesOf`, `logRewrites`),
  so a rewrite is refused with the component and keys named for any declared log, not only
  a `/content` component. A caller that kept `content: e.map(TextCellSchema)` loses
  append-only protection and must switch to `e.log(TextCellSchema)`.

  Breaking (pre-release): the text body's `version` leaf is gone. `DOC_VERSION_FIELD`,
  `CURRENT_TEXT_VERSION`, `versionField`, `assertKnownVersion`, `DocumentVersionError`, and
  `TextDocument.hydrate`'s `version` parameter are deleted; an `engine` leaf replaces the
  format check in #783, and the pre-release store reset is the compatibility answer
  (#775 decision 12). Also removed as dead: `appendOnlyRewrites`, `CellFieldValueSchema`,
  `contentKeys`, `readCellFields`, and `isLogPosition`.

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

- 6a2e61f: Remove the surfaces the retired caching model left behind.

  `projectRows` is gone: `projectRow` projects one entity and a caller with a list maps it.
  Repo-wide the only consumers were the barrel and one assertion beside an existing
  `projectRow` check, so no behaviour went uncovered. `StructuralReads.indices` is gone as
  well — nothing registered it in the change dispatcher, and a reader who trusted the field
  learned nothing about how a read invalidates, so #961 adds it back with the resolvers that
  use it. `createLocalQueryStore` is gone: a chain over already-materialized rows (a row
  accessor, or a builder from `buildQueryBuilder`) has no engine cache entry, so `.result()`
  and `.subscribe()` now refuse with a clear error instead of serving a second, uncached store
  that silently ignored `QuerySubscribeOptions.initial`.

  BREAKING CHANGE: `projectRows` and `StructuralReads.indices` are removed, and `.result()` /
  `.subscribe()` throw on a chain over already-materialized rows.

- c89ddbb: Remove the replica's pin cap: a read keeps every component it selects.

  `ReplicaOptions.pinnedCapacity` and `SyncClientOptions.pinnedCapacity` are gone, along
  with the LRU trim that released the least recently opened component once the window
  filled. Opening a component no longer releases another one, so a row with more on-demand
  components than the old default of 16 no longer comes back partial: the components
  requested first were dropped silently, with no error and no event. Memory is bounded by
  `close` and `pinnedTtlMs` alone — a component stays resident until it is closed and its
  TTL elapses — and `DEFAULT_PINNED_CAPACITY` is no longer exported.

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

- 45012d5: Dispatch a change batch through dependency indices instead of every entry.

  Every batch used to be checked against every live query and row subscription,
  so a busy client paid `subscriptions × changes` comparisons for a handful of
  real hits. The subscription registry now declares what each entry reads to one
  change dispatcher: the components and models a query projected, or the row a
  row subscription watches and the membership row that files it. A batch then
  costs the subscriptions it touches plus one index lookup per dependency kind
  per change — 5,000 subscriptions and 100 changes report 2,621 touched and 280
  lookups rather than 500,000 decisions, and one change over the same 5,000
  reports 100 touched and 3 lookups.

  A derived index is a namespace on the dispatcher: a resolver turns a change
  into keys, and a subscription matches on the bare key. `membership` is the only
  one production declares. `scope` exists as the generic namespace for the
  issue's scoped-subscription item — nothing declares it yet, so the
  `scope:<groupId>` item is a namespace awaiting an index, not a wired one.

  The dispatcher also owns the single journal cursor, so a batch reads the
  replica's journal once rather than once per entry, and an entry a batch does
  not touch is never visited: its cursor derives from the dispatcher's own. A
  journal gap — a cursor below the retained window, or an empty batch on an
  advanced revision after a `load` — still re-runs every subscription, and
  patch-versus-re-run stays a per-subscription decision for #942.

  The registry keeps one cursor model: an entry's cursor is the revision its
  consumer has processed. A batch advances it only for a consumer that had caught
  up with the previous one, and advances it before the listeners run, so a
  listener that throws cannot lose its own batch. A consumer whose result still
  reflects an older revision — an async re-run in flight — seeks back to it and
  keeps that lag through later batches, touched or not, until the run settles and
  seeks forward. An entry no batch touches reports the dispatcher's cursor, so an
  idle result stays `current` without a write per entry, while a lagging one keeps
  reporting where its consumer is. Dispatch bookkeeping that throws skips that
  entry without moving it past a batch it never evaluated, so a later gap hands
  it the batch again and its cursor recovers there; a change the indices cannot
  resolve hands the batch to every entry — the same answer a gap gets — rather
  than losing it for all of them.

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

- 53f9801: Patch safe result changes into a cached result instead of re-running the query.

  A change that can only rewrite a projected value of a resident row is now patched:
  the rows it names are re-projected against the replica and spliced into the cached
  result, so a one-row edit reads one row instead of the whole type. Measured on the
  10,000-document fixture: a re-run examines 10,010 rows in ~16–18 ms of plan work; a
  one-row patch examines 1 row in ~16 µs plus ~171 µs to splice it into the result.

  The shapes that will not patch — and re-run exactly as before — are a predicate
  field, an order key, a limited result, a join (its membership or a joined target's
  rows), a row entering or leaving the set (a tombstone, a create, a delete, a scope
  eviction, a membership write that moves `groupIds`), a value the result was holding
  that the replica released, and a journal gap. `QuerySource.patch` is the optional
  seam a source implements to take part — it must answer exactly the ids it was
  handed, one row per id — and a source without it keeps re-running.

  The fast path is not free for every model. An unselected `query()` read projects
  every registered component of its source, so a row that does not carry an optional
  lazy component (or does not have one resident) declines the patch and re-runs. A
  result that has to acquire a projected value still re-runs, which is what makes the
  patch the synchronous run it replaces.

  Also exports `traversalCounter.resultRowsRead`, the rows a propagating result
  materialized: a re-run's scan rows, a patch's by-id reads, or a row subscription's
  one row per change. It is what makes the "10,000 rows to 1" claim observable from
  application code and benchmarks. `SubscriptionWriter` now exposes the claims an
  entry holds (`dependencies`), which the patch path uses to heal them for the rows
  it rewrote.

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

- 08ebd4c: A dev-only lease watchdog, and the React read hooks' lease ownership made explicit.

  The React hooks have owned their subscription since the registry landed — `useSyncExternalStore`
  subscribes once per committed mount and unmounting calls the one release it was handed — but
  nothing said so, and nothing could say when a release never came. Residency has no cap and no
  eviction by size, so a mounted reader whose cleanup never runs holds its values for the life of
  the client; that is the one leak the model cannot heal by itself.

  `createSubscriptionRegistry(replica, { watchdog })` reports two shapes of it: a live entry whose
  claim set has sat unchanged past `staleAfterMs` (default 5 minutes), and a `close()` that leaves
  live readers behind. One warning per quiet period: the period runs from the last claim-set change,
  an entry already reported for its current claim set is not reported again for it, and a reader
  holding no claims is not reported at all. The watchdog is on in development and inert in a
  production build — `process.env.NODE_ENV === "production"`, or a bundle with no `process` at all,
  arms no timer and prints nothing; `watchdog: false` turns it off outright, and `warn` / `now` /
  `intervalMs` exist so a host can route or test the reports.

  The query hook's contract is unchanged and now documented and covered by tests: a mounted result
  leases the components it reads, unmounting releases every one and starts the one `residencyTtlMs`,
  a remount inside that TTL performs no store read and no re-run unless the read set went stale (then
  one re-run), and a render that throws still releases through React's own cleanup. `loading` stays
  a derived first-mount flag (`status === "unloaded"`), not a residency declaration.

- ec969ea: Documentation only: the shipped README and the comments the build emits into
  `dist/index.d.ts` agree that `get(id, { select })` is the public single-row
  read, not internal, and the two known index-dependency gaps now name their
  owners (#961, #962).

  No runtime or type change. The tarball's own docs contradicted the type they
  annotated, which is the kind of thing a reader acts on.

- a6a87dc: Register the relation, existence and scope index resolvers (#961).

  A query read now declares the derived indices its predicates and joins read —
  `relation:<as>/<type>` for each target a relationship predicate or forward join
  names, `exists:<component>` for an existence predicate, and `scope` for each
  group a membership predicate names. The subscription registry serves them from
  resolvers over the row index from #971, so a change is matched by the index key
  it moved rather than by the component it is filed under. On the benchmark's
  relationship-heavy fixture — 1,000 subscriptions, one per relation target, and a
  100-change batch of writes to those targets — subscriptions touched per batch
  fall from 1,000 to 100.

  The fallback is conservative by construction. A resolver that cannot prove the
  keys a change moved answers `null` — a link write never names the target it
  dropped, and an evicted row leaves no membership to read — and dispatch then
  touches every entry that declared that index, which is the breadth the component
  read set gave before. The component dependency stays in the read set for claims
  and re-checks, but leaves the dispatch set where an index covers it, so a
  resolver fallback, never a narrower guess, is what remains.

  The coverage holds once a result claims values: a covered join target model also
  covers the exact components the result claims from it, and a self-relation keeps
  its source model dependency because source and target share one. A differential
  test compares every retained result with a fresh plan run after each write and
  pins both rules (#1002).

- 874dfe1: Rename the query result surface after the model it implements, and stop keeping
  a second copy of the subscription revision.

  `QueryCache`, `createQueryCache`, and `client.queries` described a cache, while
  the module holds no map, no timer, and no snapshot copy: it reads results out of
  the subscription registry, which owns the snapshot, the revision, and the
  claims. It is now `QueryResults`, `createQueryResults`, and `client.results`,
  and the files are `query-results.ts` and `query-results.test.ts`. `QueryStore`
  stays the per-result `getSnapshot` / `subscribe` handle that `.result()` returns;
  `QueryResults` is the container `.watch()` lives on.

  The consumer no longer keeps `QueryRun.at` beside `Subscription.revision`. A
  result's status and its staleness now come from the one revision on its
  registry entry: dispatch moves a caught-up entry's revision after its listeners
  run, unless the consumer set it with `seek` or the new `hold`, so a result that
  still reflects an older revision holds it back without a copy of its own.
  Nothing about the lifecycle changed: an inactive result stays `stale` across
  batches it does not read, a remount inside the residency TTL reads nothing and
  re-runs nothing when nothing relevant landed, a stale result re-runs exactly
  once on remount, a patch advances the entry's revision and reports `current`,
  and a journal gap still re-runs.

  Breaking changes:
  - `QueryCache` is now `QueryResults`.
  - `createQueryCache(replica, subscriptions?)` is now
    `createQueryResults(replica, subscriptions?)`.
  - `client.queries` is now `client.results`; on the exported `ReplicaAccess` and
    `QueryContext` types the field is `results` too.
  - `queryCacheKey(surface, query)` is now `queryResultKey(surface, query)`.
  - `Subscription.cursor` (and every `SubscriptionSnapshot.cursor`) is now
    `Subscription.revision`; `SubscriptionWriter` gains `reflected` (the revision
    the published result reflects) and `hold()` (keep it where it is).
  - The internal `ChangeDispatcher.cursor()` is now `revision()`.

  There are no aliases, per the pre-release policy.

- 2802458: The replica keeps one row index instead of five ad-hoc indices.

  Each row has one entry that owns its model, the components it carries, its
  `ebb/link` edges, its membership, its declared versions, and the leaf and
  `ebb/*` values a query decides on. A separate value cache holds map-shaped user
  components, so installing or dropping one is a residency move that never touches
  an index read and never journals. `iterate`, `components`, `relationships` in
  both directions, `memberships`, `membershipLinks` and `componentVersion` answer
  from the entry alone; `get` composes the entry with the values still resident.

  Query planning and narrowing read index rows. Projection reads the composed row
  after acquisition, so a filter or sort never waits on storage and a page still
  projects every value it selected.

- 53d10ec: Group-scope eviction reads membership from the row index.

  `Replica.membershipRows()` answers every live membership row — membership row
  id, group id and member entity id — from the index entries, and the row index
  exposes the same read with an optional entity id. Scope eviction derives each
  row's groups from that read and the group and grant rows from the component
  map, so removing a value from the cache cannot change which groups a row is in.
  A membership add, remove or tombstone is observed immediately, and the model
  sweep and value reads the old calculation needed are gone.

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

### Patch Changes

- 2fc70c5: Run a cold projection's plan once (#962).

  The reactive path narrows the page with one plan and, when a projected component
  is not resident, hands that narrowed page to acquisition instead of planning it
  again for the acquire-and-project pass. The page is exactly what the second run
  would recompute, so the rows, `groupIds`, patching, and lease lifetime are
  unchanged; the results view still reconciles a change that lands while
  acquisition is in flight. A cold 10,000-row projection drops from two plan runs
  and 30,000 rows examined to one and 20,000. Its wall clock is dominated by the
  acquisition and the result's claims, so that is not where the saving shows: the
  plan a cold read no longer runs is the one removed.

- Updated dependencies [ded31b2]
- Updated dependencies [fae4e88]
- Updated dependencies [ed66062]
- Updated dependencies [baf0bfd]
- Updated dependencies [7546916]
- Updated dependencies [255ac38]
- Updated dependencies [e30f842]
- Updated dependencies [a682fe8]
- Updated dependencies [c7fcfdf]
- Updated dependencies [0c5c5d5]
- Updated dependencies [437c80d]
- Updated dependencies [dcd7063]
- Updated dependencies [c89ddbb]
- Updated dependencies [c8c14fc]
- Updated dependencies [c2df5ba]
- Updated dependencies [ef309da]
- Updated dependencies [9d9008c]
- Updated dependencies [9352c06]
- Updated dependencies [0b61d7c]
- Updated dependencies [a645373]
- Updated dependencies [2802458]
- Updated dependencies [53d10ec]
- Updated dependencies [58835c6]
- Updated dependencies [2024699]
- Updated dependencies [3698b0a]
  - @ebbjs/core@1.2.0
  - @ebbjs/write@1.2.0
  - @ebbjs/schema@1.2.0
  - @ebbjs/storage@1.2.0

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

- Updated dependencies [cbac1a0]
- Updated dependencies [0ed2c5f]
- Updated dependencies [606ee0d]
  - @ebbjs/schema@1.1.0
  - @ebbjs/write@1.1.0
  - @ebbjs/storage@1.1.0
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

- da11172: Presence is a typed, ephemeral, per-entity **channel** API instead of a
  hard-coded text-cursor shape.

  Declare the channels an app broadcasts with `definePresence(...)` and pass the
  registry to `createClient({ presence })`:

  ```ts
  const presence = definePresence({
    cursor: Type.Object({
      anchorId: Type.String(),
      anchorOffset: Type.Number(),
      headId: Type.String(),
      headOffset: Type.Number(),
    }),
    camera: { schema: Type.Object({ x: Type.Number(), y: Type.Number() }), ttlMs: 5_000 },
  });
  const client = createClient({ serverUrl, actorId, presence });
  ```

  `client.presence.set(entityId, channel, value)` checks the channel name and the
  `Static<>` value type at the call site and validates with `Value.Check`; an
  undeclared channel is also an `UndeclaredPresenceChannelError` at runtime, and a
  value that fails its schema is a `PresenceValidationError`. A client built
  without a registry still has `client.presence`, with dynamic string channels and
  unvalidated `unknown` values.

  Sends coalesce per `(entityId, channel)` (a send on one entity or channel never
  drops another's pending send), POST `{entity_id, data: {channel, value}}`, and
  are never queued, retried, or written to the Outbox — a failed send is dropped
  because the next write of that channel carries newer state. An oversized body
  (over 8 KiB serialized) throws `PresencePayloadTooLargeError` synchronously at
  the call site.

  `client.presence.flush()` sends pending coalesced writes immediately (for
  callers that need the last move on the wire before `pagehide`); `close()`
  cancels them instead.

  Reads go through `client.presence.forEntity(entityId, channel)`, a
  `ReadonlyMap<actorId, PeerPresence<T>>`, and `client.presence.onUpdate(cb)`
  reports the changed `(entityId, channel)` so a listener can ignore unrelated
  high-frequency channels. Each channel has a receiver-side TTL (default 30 s;
  `ttlMs: Infinity` opts out) and a per-`(entity, channel)` entry cap (default
  100). `client.presence.clear(entityId, channel)` sends `{channel, value: null}`
  so peers drop just that channel.

  Presence still rides the live stream `subscribe()` opens, so its scope is the
  groups you subscribe to and the peer set is dropped when that stream closes.

  **Breaking:** `PresenceManager`, `presence.start()`, `presence.dispose()`,
  `presence.setLocalCursor()`, and `PresenceEntry` are removed; `PeerPresence<T>`
  replaces `PresenceEntry` and entries carry `data` instead of `cursor`.
  `@ebbjs/codemirror`'s `createPresenceExtension` reads `entry.data`, and
  `getPresence` is typed as `ReadonlyMap<string, PeerPresence<CursorPresence>>`.

- ec52770: Converge on one write interface: every write is now an action.

  Ebb is pre-1.0 and has no consumers yet, so the removed surface ships as a
  minor (0.3.0 → 0.4.0) rather than a major. Nothing persisted changes — no wire
  format, no stored shape, no migration — so there is no upgrade path to protect.

  `defineAction(schema, (drafts, params) => ...)` is the only write surface.
  Mount it at `createClient({ schema, actions })` and call it as
  `client.actions.<name>(params)`. One callback commits as one Action, and a
  rejection throws `ActionRejectedError` instead of returning `rejected`.

  Removed:
  - `client.atomic(...)` — move its callback body into a `defineAction` callback;
    the draft verbs are unchanged.
  - The per-entity write verbs on `client.<entity>` (`create` / `update` /
    `delete` / `duplicate` / `link` / `unlink` / `setLinks` / `addToGroup` /
    `removeFromGroup` / `setGroups`), and the same verbs on `client.group` /
    `client.membership`. Those namespaces are read-only now; call the matching
    draft verb inside an action. `create` still requires `groups`, and `create` /
    `duplicate` still return a handle with `.id` for multi-entity actions.
  - `useEntityMutations` from `@ebbjs/react` — call `client.actions.<name>` from
    `useClient` instead.

  `useClient` now takes the **client type** rather than a schema-plus-actions
  pair: `useClient<AppClient>()` instead of `useClient<Schema, typeof actions>()`.
  Name the client once (`type AppClient = typeof client`) and bind both hooks to it
  with `createEbbHooks<AppClient>()` — components then need no generic, and
  `useQuery((q) => …)` needs no `QueryRoot<Schema>` annotation (a schema type
  argument would drop the row types, since TypeScript does not partially infer
  type arguments). `QueryRootOf<C>` names the read root the bound `useQuery`
  types its `q` as.

  Renamed types: `AtomicActionError` → `ActionRejectedError`, `AtomicDrafts` →
  `ActionDrafts`, `AtomicDraftNamespace` → `DraftNamespace`, `AtomicCreateOptions` →
  `DraftCreateOptions`. The entity namespace's `CreateOptions` / `DuplicateOptions`
  are now `DraftCreateOptions` / `DraftDuplicateOptions`, and a draft `create` /
  `duplicate` returns a `CreatedEntity` handle rather than `CreateResult`.
  `AtomicCreateInput` is gone: a draft `create` now takes the entity's typed wire
  fields (plus derived-body strings and relationship pointers), the way the
  removed namespace `create` did.

  New: `EntityValues<typeof entity>` names the value shape of an entity's wire
  fields, so an action's patch parameter follows the schema instead of
  restating it (`Partial<EntityValues<typeof issue>>`).

  `client.seed(...)` and the low-level `client.write(actions)` are unchanged, as
  are reads, collaborative text, conflicts, and presence.

- e999004: `resolveIdentity` — learn the actor before constructing a client.

  `resolveIdentity({ serverUrl, fetchImpl?, signal? })` calls `GET /sync/identity`
  and returns the actor the server authenticated, so a tailscale deployment does
  not have to ask the browser for an id it cannot know:

  ```ts
  const identity = await resolveIdentity({ serverUrl });
  const client = createClient({ serverUrl, actorId: identity.actorId });
  ```

  The request sends no `x-ebb-actor-id`; the server is authoritative. The result
  carries `actorId`, `provider` (`"bypass" | "external" | "tailscale"`), and the
  provider's optional `displayName` / `providerId`. Payload validation is strict:
  a missing or empty `actor_id`, an unknown provider, or a mistyped optional field
  is an `invalid-response`, never a half-read identity.

  Failures throw `IdentityResolutionError` with a `kind` — `network`,
  `unauthorized` (401), `invalid-response` (an HTML proxy page, a non-JSON body),
  or `http` with the status — so the caller can act instead of retrying in a loop.
  A fetch rejection keeps its original error as `cause`.

  Resolution needs connectivity once: cache `identity.actorId` and start offline
  with it afterwards. A Tailscale login change is a new actor — a cached id then
  earns `actor_mismatch`; re-resolve, rebuild the client, and use the new actor's
  storage.

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

- 085fab5: Live membership changes: a `groups_changed` control event, and a client that
  acts on it.

  The server now pushes `event: control` with
  `{"groups_changed": true, "reason": "membership"}` to every live connection of
  every actor whose group view a committed Action changed — a `groupMember` put,
  patch, delete, or a row re-keyed to another actor. The event carries no delta:
  it is a wake-up. It rides the post-apply fan-out path, so a client that reacts
  immediately cannot handshake into the pre-apply state, and it is coalesced per
  connection per commit. Actions that touch no membership emit nothing, and a
  missed event is covered by the reconnect handshake.

  `SyncClient` handles it by re-handshaking and reconciling the live subscription
  against the previous handshake's membership: a gained group joins the
  subscription, is seeded from its group listing, and streams without a reload; a
  lost group leaves and its replica rows are evicted. Only the membership
  difference is applied, so a group whose membership did not change keeps the
  subscription the app chose. The same refresh runs on each reconnect once a
  handshake has run, so a change whose event died with a dropped stream still
  reconciles. The `behind_watermark` stream restart is unchanged.

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

- 6e2df83: A `null` filter value now means "no live value".

  A field predicate whose value is `null` matches a leaf the row never set and a
  tombstoned (cleared) leaf alike. A non-null value still matches only an equal
  stored value, so a declared schema default never widens a filter: the query
  path stays schema-blind.

  On the server, a `null` value now emits `json_extract(...) IS NULL` instead of
  binding NULL into `= ?`, which SQL evaluates as never true. `json_extract`
  returns SQL NULL for a missing path and for a JSON null alike, so one clause
  covers both absent and tombstoned leaves.

- 6e2df83: Projection resolves a field's declared default: `stored ?? default` for both an
  absent leaf and a tombstoned one. A tombstone with no default now projects as
  `undefined` rather than `null`, so "cleared" and "never set" read the same, and
  ordering compares fields through the same resolution so a sort never disagrees
  with the value a row renders as. Query filtering is unchanged and never sees a
  default.
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

- b809169: `usePresence` — a typed presence subscription hook — and the one presence
  surface that makes it typeable.

  **Breaking (`@ebbjs/client`):** `client.presence` is now a single interface
  keyed by the channel map, instead of two interfaces switched on the registry:

  ```ts
  const presence = definePresence({ camera: Type.Object({ x: Type.Number() }) });
  const client = createClient({ serverUrl, actorId, presence });

  client.presence.forEntity(planId, "camera");
  // ReadonlyMap<string, PeerPresence<{ x: number }>>
  ```

  Without a registry the channel map defaults to the dynamic one: `forEntity`
  takes any string and returns `PeerPresence<unknown>`. The caller-named
  `forEntity<T>()` generic is gone — it promised any payload type without
  checking one, and it made a registered client unassignable to an unregistered
  one. Declare the channels with `definePresence` when you want the payload
  typed. `UntypedPresenceApi` and `TypedPresenceApi` are replaced by
  `PresenceApi<Channels>`, `PresenceChannelsMap`, and `PresenceChannelsOf<R>`.

  Because a registered client is now a plain `SyncClient`, `EbbProvider`,
  `useClient<C>()`, and `createEbbHooks<C>()` keep their original `SyncClient`
  constraint — no erased client surface and no registry union in the React
  package.

  `usePresence(entityId, channel)` snapshots `client.presence.forEntity` and
  subscribes to `client.presence.onUpdate` filtered to the same target, so a 20 Hz
  camera channel does not re-render a cursor consumer. The store already notifies
  on a peer's packet, on TTL expiry, and on stream reset, so a peer that leaves
  stops rendering instead of leaving a stale cursor.

  Bound from `createEbbHooks<C>()`, the channel is checked against the client's
  `definePresence` registry and the peer payload follows the channel's schema:

  ```tsx
  const { usePresence } = createEbbHooks<typeof client>();
  const cameras = usePresence(planId, "camera");
  // ReadonlyMap<string, PeerPresence<{ x: number }>>
  ```

  The standalone `usePresence<T>(entityId, channel)` cannot see the client type
  through React context, so it takes the payload type as its generic.

- 7108176: `client.presence.leave()` retracts every `(entityId, channel)` this session
  announced, posting a `null` for each so peers drop this actor immediately
  instead of waiting out the channel's TTL. It is best-effort and idempotent, and
  flushes through the normal debounced transport rather than waiting a debounce
  window.

  `leave({ keepalive: true })` marks those POSTs `keepalive` so a leave an app
  issues from its own unload handler survives page teardown, where a normal
  presence write would be dropped with the document. Ordinary sends stay
  unmarked. `client.close()` remains local teardown — it cancels pending sends
  and sends no leave, because a transient remount must not broadcast an absence.

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

- da55d18: Typed function invocation: `functionContract`, `client.functions`, and `invokeFunction`.

  A generated contract map imports each function's definition as a type and calls
  `functionContract<typeof foo>("foo")` with its deployed name, so
  `createClient({ functions })` types `client.functions.foo` without importing
  `@ebbjs/server` or shipping any handler code to the browser. The low-level
  `client.invokeFunction(name, input, options?)` posts to `/functions/:name` and
  returns the envelope's `result` and `replayed`; the namespace spreads an object
  result so callers read its fields directly. `functions` needs no schema, and
  mounts alongside `schema` / `actions` when both are present.

  A rejected commit throws the same `ActionRejectedError` a rejected Action batch
  does; every other failure is a `FunctionCallError` carrying the envelope's
  status, code, details, issues, invocation id, and version.

  `idempotencyKey` is the caller's to supply: a key claims a retry is the same
  request, and only the caller knows that, so the client never mints one per call.

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
- Updated dependencies [48e9b64]
- Updated dependencies [b113df5]
- Updated dependencies [b8fe081]
- Updated dependencies [e543a97]
- Updated dependencies [ad79662]
  - @ebbjs/schema@1.0.0
  - @ebbjs/write@1.0.0
  - @ebbjs/core@1.0.0
  - @ebbjs/storage@1.0.0

## 0.3.0

### Minor Changes

- fa0b984: Add `QueryRowOf<Schema, EntityName, JoinKeys>` to name the projected row a
  query returns after `with(...)` joins, without restating the query builder's
  type arguments.

### Patch Changes

- @ebbjs/core@0.3.0
  - @ebbjs/storage@0.3.0

## 0.2.0

### Minor Changes

- a46e201: `receiveRemoteHLC` now refuses only a remote HLC more than 120s ahead of the wall clock, mirroring the server's `ActionValidator`, and validates the remote value before mutating the clock so a refused merge is a no-op. Any past HLC is accepted because it only loses the merge. This narrows the public `MAX_FUTURE_DRIFT_MS` to a bound on the remote value rather than the merged local clock, and removes `MAX_PAST_DRIFT_MS` from `@ebbjs/core`'s exports.

### Patch Changes

- Updated dependencies [a46e201]
  - @ebbjs/core@0.2.0
  - @ebbjs/storage@0.2.0

## 0.1.1

### Patch Changes

- d19bff2: Republish through npm trusted publishing to validate the OIDC release path.
  No functional change. `0.1.0` was bootstrapped with a granular token and is the
  only version of these packages published without provenance.
- Updated dependencies [d19bff2]
  - @ebbjs/core@0.1.1
  - @ebbjs/storage@0.1.1

## 0.1.0

### Minor Changes

- 2004274: First public release. All `@ebbjs/*` packages share one version and ship together; `@ebbjs/server` and `@ebbjs/www` stay private.

### Patch Changes

- Updated dependencies [2004274]
  - @ebbjs/core@0.1.0
  - @ebbjs/storage@0.1.0
