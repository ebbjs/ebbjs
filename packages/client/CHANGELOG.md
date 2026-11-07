# @ebbjs/client

## 0.4.0

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

- 22b7acf: Deterministic ids for the rows a derived field implies.

  A derived body (`e.collaborativeText()`) is not stored on its parent: it is a
  document entity, a relationship, and `entityGroup` rows. Those ids used to be
  minted, so two clients that independently decide to create the same missing
  body would each address it under their own id — two documents, two
  relationships, text split between them.

  Both ids are now derived from facts every client already agrees on, the parent
  id and the field accessor, so every client derives the same rows for the same
  body. The document id also names the document's entity type, because the server
  binds an id to the type it was first committed under, so a rename has to yield a
  new document; the relationship id does not, so a rename re-points the same row.

  A single writer's behaviour is unchanged, but the rows it creates now carry these
  ids instead of minted ones. They are opaque strings to the server, so nothing
  else on the wire moves; live rows keep the ids they were created under, so there
  is no migration. This lands the identity half of the derived-row backfill; the
  write-side trigger and enumeration follow separately.

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
  - @ebbjs/schema@0.4.0
  - @ebbjs/write@0.4.0
  - @ebbjs/core@0.4.0
  - @ebbjs/storage@0.4.0

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
