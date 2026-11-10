# @ebbjs/react

## 1.0.0

### Minor Changes

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

- 40ebabb: Sync-state hooks: `useOutbox`, `useConflicts`, and `useEbbStatus`.

  `@ebbjs/client` already publishes `client.sync.outbox`, `client.sync.conflicts`,
  and the aggregate `client.status` as read-only observables — a synchronous
  `get()` plus a `subscribe(cb)` — built so a UI can render pending depth,
  conflict depth, and the last sync time without polling. `@ebbjs/react` bound
  only `useConnection`, so every app wrote its own `useSyncExternalStore`
  wrapper. The binding is the missing half:

  ```tsx
  const { connection, lastSyncedAt, outbox, conflicts } = useEbbStatus();
  if (outbox.pending > 0) return <span>Saving…</span>;
  if (conflicts.count > 0) return <span>{conflicts.count} edits need review</span>;
  return <span>Synced</span>;
  ```

  - `useOutbox()` returns the `OutboxSnapshot`: `pending`, `acknowledged`,
    `error`, `conflicted`, `flushLatency`, and `storeFaults`.
  - `useConflicts()` returns the `ConflictSnapshot` (`count` and `conflicts`),
    republished whenever the outbox's counts change — a detection, a resolution,
    and the initial durable load all arrive that way, never through
    `client.conflicts.list()`.
  - `useEbbStatus()` returns the aggregate `ClientStatus`: `connection`,
    `lastSyncedAt`, `outbox`, and `conflicts`.
  - `useSyncObservable<T>(observable)` is the generic wrapper the three build
    on, exported for `client.sync.backfill` and app-owned observables. It keeps
    one subscription per observable across re-renders.

  The hooks are read-only, matching the client's split: resolution stays on
  `client.conflicts` (`list()` then `resolve(id, "retry" | "discard")`), so the
  decision and its durable write stay outside React's render pass.

  `createEbbHooks<C>()` now binds the three alongside `useClient` and
  `useQuery`; the generic `useSyncObservable` stays unbound. `OutboxSnapshot`,
  `ConflictSnapshot`, `ClientStatus`, and `ReadonlyObservable` are re-exported
  from `@ebbjs/client` so an app never imports the client just for a snapshot
  type.

### Patch Changes

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
- Updated dependencies [da55d18]
- Updated dependencies [da11172]
- Updated dependencies [ec52770]
- Updated dependencies [e999004]
- Updated dependencies [ce74122]
- Updated dependencies [085fab5]
- Updated dependencies [6e2df83]
- Updated dependencies [6e2df83]
- Updated dependencies [6e2df83]
- Updated dependencies [6e2df83]
- Updated dependencies [6e2df83]
- Updated dependencies [6e2df83]
- Updated dependencies [6e2df83]
- Updated dependencies [6e2df83]
- Updated dependencies [b809169]
- Updated dependencies [7108176]
- Updated dependencies [48e9b64]
- Updated dependencies [b113df5]
- Updated dependencies [b8fe081]
- Updated dependencies [e543a97]
- Updated dependencies [ad79662]
  - @ebbjs/client@1.0.0

## 0.3.0

### Patch Changes

- Updated dependencies [fa0b984]
  - @ebbjs/client@0.3.0

## 0.2.0

### Minor Changes

- a46e201: `receiveRemoteHLC` now refuses only a remote HLC more than 120s ahead of the wall clock, mirroring the server's `ActionValidator`, and validates the remote value before mutating the clock so a refused merge is a no-op. Any past HLC is accepted because it only loses the merge. This narrows the public `MAX_FUTURE_DRIFT_MS` to a bound on the remote value rather than the merged local clock, and removes `MAX_PAST_DRIFT_MS` from `@ebbjs/core`'s exports.

### Patch Changes

- Updated dependencies [a46e201]
  - @ebbjs/client@0.2.0

## 0.1.1

### Patch Changes

- d19bff2: Republish through npm trusted publishing to validate the OIDC release path.
  No functional change. `0.1.0` was bootstrapped with a granular token and is the
  only version of these packages published without provenance.
- Updated dependencies [d19bff2]
  - @ebbjs/client@0.1.1

## 0.1.0

### Minor Changes

- 2004274: First public release. All `@ebbjs/*` packages share one version and ship together; `@ebbjs/server` and `@ebbjs/www` stay private.

### Patch Changes

- Updated dependencies [2004274]
  - @ebbjs/client@0.1.0
