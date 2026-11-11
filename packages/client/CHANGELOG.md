# @ebbjs/client

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
