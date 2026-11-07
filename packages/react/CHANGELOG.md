# @ebbjs/react

## 0.4.0

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

### Patch Changes

- Updated dependencies [3df4a29]
- Updated dependencies [da55d18]
- Updated dependencies [da11172]
- Updated dependencies [ec52770]
- Updated dependencies [22b7acf]
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
  - @ebbjs/client@0.4.0

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
