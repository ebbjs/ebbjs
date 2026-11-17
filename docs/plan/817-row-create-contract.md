# #817 — the row create: implementation contract

Epic: [#793](https://github.com/ebbjs/ebbjs/issues/793) · Slice: [#817](https://github.com/ebbjs/ebbjs/issues/817)
Supersedes, for row existence only: [`797-component-envelope-contract.md`](./797-component-envelope-contract.md)
ADR: [`docs/adr/0001-component-model.md`](../adr/0001-component-model.md) · Vocabulary: [`CONTEXT.md`](../../CONTEXT.md)

This note is the authoritative shape for slice 10. The client and the server are changed
against it independently; where it is silent, #797's contract still decides.

## 0. The decisions this slice makes

The issue carries four open questions. Each is answered here, and the answer is the
implementation requirement — not a suggestion.

1. **The create's model is authoritative.** A row has no prior record, so the create cannot
   contradict one: `create.model` is the row's committed model. Every component Update for
   the same subject in the same Action must name the same model (its `<model>/<field>`
   prefix); a disagreement is a structure violation, refused by `ActionValidator` and by
   `ModelRegistry.validateAction`. A component Update delivered **before** the create (the
   client's out-of-order delivery) never decides the model: the create does when it arrives.
   A create naming a model the row is already committed under is a relabel and is refused
   (the authorizer's existing model-identity rule, now also applied to `create.model`).
2. **A component write whose create was not seen: held by the client, refused by the
   server.** The client keeps today's placeholder (`exists: false`, `created_hlc: null`) and
   content backfill fetches the base; dropping the write would lose data that per-subject,
   group-scoped delivery legitimately hands to a group that never saw the create. Nothing
   is ever _inferred_: the base, and with it the create, comes from the server. The server
   refuses instead, because a commit is the one place ordering cannot be out of order: a
   component write with no create in its Action cannot fold to `:put`, so it is authorized
   as an update of a row that has no ownership and fails closed (`missing_ownership` /
   `not_authorized`). The materializer never invents a row from a component write.
3. **The create carries its own `hlc`, and that is the only creation time.** `created_hlc` is
   the create Update's `hlc`, never the Action's. The Action HLC cannot serve: a replica
   whose base arrives through backfill replays a synthetic Action stamped at the row's
   _latest_ position (`updated_hlc` / `last_gsn`), so restating creation from the Action
   would report the last write as the creation time. Carrying the fact makes the base
   self-describing on every delivery path. A real write stamps both from the same clock, so
   in the common case `create.hlc == action.hlc`; the protocol does not require it.
4. **`create` is idempotent on replay.** A `create` for a subject this replica (or the
   server) has already materialized is a no-op: it does not restate `model` or
   `created_hlc`, does not clear a tombstone and does not resurrect the row — symmetric with
   `delete` for an unknown id. A create that arrives twice (catch-up plus listing seed, two
   backfill passes, a retried Action) is therefore harmless, and dedup/retry cannot fail.

## 1. The wire

`Update` becomes:

```ts
type Update =
  | { id; subject_id; model: string; method: "create"; hlc: HLCTimestamp; data: null }
  | { id; subject_id; component: ComponentName; method: "merge" | "replace"; data: FieldValue }
  | { id; subject_id; component: ComponentName; method: "drop"; data: null }
  | { id; subject_id; method: "delete"; data: null };
```

`UpdateInput` is the same union with `id` optional. New `UpdateMethod` member: `"create"`.

- `model` matches `^[^/]+$` (a model name, no `/`). It is the only place a create spells
  identity.
- `hlc` is an `HLCTimestamp` on the client and the same integer representation the server
  already uses for `Action.hlc`; it is the row's creation time.
- `data` is `null`; a create carries no component.
- One create per subject per Action (structure violation otherwise), and one model per
  subject per Action (§ decision 1).
- A create for the platform model `ebb` must carry exactly one `ebb/*` component in the same
  Action (a platform row is one kind); a zero-component `ebb` create is a structure
  violation.

Ordering:

- Real create: `create` first, then one component Update per field (today's order). The
  create need not be first in principle; every writer here emits it first so the wire reads
  as one story.
- A zero-component create is `create` alone and is a complete, legal Action body for the row.

Both schemas (`UpdateSchema`, `UpdateInputSchema`) are otherwise unchanged, and
`additionalProperties: false` keeps the old shape unreadable.

## 2. Naming in `@ebbjs/core`

New helpers, so no caller has to test the method string ad hoc:

```ts
/** Whether the Update names a component. False for `create` and `delete`. */
export const isComponentUpdate = (update: Update): update is ComponentUpdateUpdate;
/** The row-scoped create, narrowed. */
export const isRowCreate = (update: Update): update is RowCreateUpdate;
```

`updateComponentValue` returns `undefined` for `create` as well as `drop`/`delete`.
`mergeFieldValue`, `componentModel`, `componentField`, `componentName` are unchanged.

## 3. The client

### 3.1 Materializer (`packages/storage/src/internal/materialize.ts`)

`applyUpdate` folds the create as a row fact:

- `create`, no row record: a live row — `model: update.model`, `data: { fields: {} }`,
  `exists: true`, `created_hlc: update.hlc`, `updated_hlc: <Action hlc>`, `deleted_hlc: null`.
- `create`, row record that is a placeholder (`exists: false`, not tombstoned): fills in
  `exists: true`, `created_hlc: update.hlc`, `model: update.model`; fields untouched.
- `create`, row record that already exists (`exists: true`) **or is tombstoned**: no-op
  (decision 4). `updated_hlc`/`last_gsn` still advance monotonically as for any delivered
  Update.
- `merge`/`replace`, no row record: the placeholder it is today — `exists: false`,
  `created_hlc: null`, `model` from the component prefix. The `replace`-implies-create
  inference is **deleted**; `exists` is only ever set by a create.
- `drop`: unchanged (no row ⇒ no-op; a drop never changes `exists`).
- `delete`: unchanged (no row ⇒ no-op; a tombstone stays a tombstone and keeps `exists`).

`updateModel(update, entity)` answers `update.model` for a create.

A create also makes its row **present** in the replica, independent of component residency:
a row whose components are declared lazy (an on-demand document body) is a live row with
no fields held, and the replica's stats read that as presence (`byModel`) with residency
reported separately (`heldByModel`, `nonResidentComponents`). The alternative — letting the
create drag unheld components in, or hiding the row until a component is held — would make
`get(id)` answer `null` for a row the server says exists, which §6 forbids.

### 3.2 Replica record

`REPLICA_RECORD_FORMAT` bumps `5 → 6`; a record of another format reads as absent and the
replica resets (no migration, #793 house rule).

### 3.3 Backfill and listing seeds (`packages/client/src/sync/backfill.ts`, `group-listing.ts`)

`snapshotActionWithIds` emits the row fact first:

- one create Update with `model: entity.model`, `hlc: entity.created_hlc ?? entity.updated_hlc`
  (a live server row always has a `created_hlc`; the fallback exists so a row from an older
  server cannot synthesize a null creation time), and the Update id `${ids.updateId}$create`;
- then the existing one Update per field (`replace` for a leaf, `merge` for a keyed value).

`fetchedEmpty` is deleted: a fetched base with zero components now materializes a live row,
so the id is not a candidate again. `collectBackfillCandidates` keeps treating
`exists: false` as missing; that is now exactly "the create has not been seen".

`group-listing.ts` inherits the create through `snapshotActionWithIds`; a zero-component row
in a listing page now seeds as a live row.

### 3.4 Write planner (`packages/write`)

Every path that brings a row into existence emits a create **first**, then its component
Update(s):

| Path                                                                                                    | Create's model     |
| ------------------------------------------------------------------------------------------------------- | ------------------ |
| `createEntity` (incl. `client.create({})` — zero field writes)                                          | the entity's model |
| `createPlatformRow` (`ebb/group`, `ebb/grant`) and every other `systemRowUpdate` path                   | `ebb`              |
| membership rows (`buildMembershipUpdates`), in `createEntity`, `changeGroups`, `duplicateEntity`, seeds | `ebb`              |
| link rows (`buildRelationshipUpdate` / `buildRelationshipWrite`)                                        | `ebb`              |
| `duplicateEntity`                                                                                       | the entity's model |

The create's `hlc` comes from `ctx.ids.hlc()`. A `create` with no fields is emitted like any
other, so `client.create({})` is one Update on the wire and a legal Action body.

`patchEntity`, `dropEntity`, `deleteEntity`, `writeRelationship`'s entity update: no create
(the row already exists). `client.create`/`createEntity` validation no longer requires at
least one field; an empty payload is a zero-component create.

### 3.5 Schema validation (`packages/schema`)

`ModelRegistry.validateAction`:

- a create names a declared model (the same `Unknown model` violation as a component) and no
  component;
- a component Update's model must equal the create's model for the same subject
  (decision 1);
- everything else unchanged.

## 4. The server

### 4.1 `ActionValidator`

- Accepts `method: "create"`: `model` a non-empty binary without `/`, `data: nil`, no
  `component`, `hlc` a valid timestamp inside the future-drift window, and — decision 1 —
  every component Update of that subject in the same Action names the same model.
- One create per subject per Action; a duplicate is a structure violation.
- A create naming `ebb` must carry exactly one `ebb/*` component in the same Action.
- Rejections keep the existing shape (`reason`/`details`); no new reason strings are
  invented for the old frame — it already fails as a structure violation.
- The internal Update becomes
  `%{id, subject_id, component: nil, model: "note", field: nil, method: :create, data: nil, hlc: <created_hlc>}`.

### 4.2 `ActionFormat`

Stores a create as `id`, `subject_id`, `model`, `method`, `hlc`, `data` and no `component`;
the reader accepts exactly that and raises otherwise (no read-through, #552/#797 precedent).
The frame (payload + `subject_scopes`) is unchanged.

### 4.3 `RowMutations`

`method` keeps its `:put | :patch | :delete` spelling — the `created?`/`deleted?` rename is
slice #863's and is not done here — but its **derivation** changes: a subject folds to
`:put` iff its Action carries a `create`, and to `:patch` otherwise. The existence index and
the flush's `:created` set stop deciding the verb: `<model>.create` means the explicit
create by construction, and a drop-only Action is an update.

- `:model_resolver` and the delete's committed-model resolution stay.
- The create's model is the row's model (a component prefix that disagrees was refused at
  structure validation); `kind` still comes from the component, so a zero-component create
  is a user row.
- `data` still folds the component values; a create contributes no field.
- The `:exists?` and `:created` options go with the inference they served.

### 4.4 `EntityStore`

- `apply_create`: with no materialized row, writes the row — `model` from the create,
  `created_hlc` from the create's `hlc`, empty fields, `updated_hlc`/`last_gsn` from the
  Action. With a materialized row (live or tombstoned) it is a no-op (decision 4).
- `apply_component` no longer stamps `created_hlc` (the "first write of any method stamps
  it" rule is deleted) and, with no materialized row, is a no-op: a component write never
  invents a row (decision 2). Replay still starts from the SQLite row, so a delta that
  carries only components has its create in an earlier Action.
- `drop`/`delete` unchanged.
- The row's model is fixed by the create; a later component prefix cannot relabel it.

### 4.5 Delivery

Catch-up, fan-out, and the listing need no new shape: the create is an Update in the Action,
so it travels in the frame and through `subject_scopes`. What must be verified:

- a create-only row fans out to the groups of the membership rows the same Action writes
  (`subject_scopes` for the subject, resolved through the fold's `model` — no component and
  no kind, so the case is the user-model one);
- a group member receives a zero-component row through catch-up;
- the group listing returns a zero-component row (`GET /sync/groups/:group/entities`) and
  `/entities/:id` reports it with `created_hlc`;
- the listing seed and content backfill materialize it (§3.3).

`PermissionHelper`/`Authorizer`: the verb now follows the create, so no rule needs new
plumbing; `created_models`/`created_subject_ids` keep their meaning (`:put` = created by
this Action). The `sim.models`/flush `:created` bookkeeping exists to compensate for the old
inference and is removed where the fold no longer reads it.

## 5. Deleted compensations (acceptance)

- `fetchedEmpty` (client backfill).
- `replace`-implies-create (`exists`, `created_hlc` in `materialize.ts`).
- first-write `created_hlc` and the row-inventing component write (`entity_store.ex`).
- `snapshotAction`/`snapshotActionWithIds` synthesizing a base from component Updates only.
- the `version`-component seed workaround in
  `packages/testing/src/test/e2e/seeds/single-entity.ts` (`patches: []` comes back).

`rg "fetchedEmpty|write.method === \"replace\"|created_hlc.*===" packages/client packages/storage`
finds nothing.

## 6. Acceptance (tests to add)

- `client.create({})` on a model whose components are all optional round-trips against the
  real server; `get(id)` is a live row with no fields and `has(...)` is false for every
  component.
- A zero-component row reaches a cold replica through catch-up, and through the backfill /
  listing seed when delivery missed it.
- Drop the last component, read from a fresh replica: the row is returned (not `null`), with
  no fields.
- `created_hlc` equals the create's HLC on every replica, including one whose first
  delivered write was a component write and whose base arrived through backfill.
- A duplicate create (replay, catch-up plus seed, retried Action) changes nothing.
- The server refuses a component write for a row it has no create for.

The acceptance items live at: `packages/client/src/__tests__/integration/row-create.test.ts`
(the real-server round trips, catch-up, listing seed, drop-last-component, `created_hlc`
through backfill, duplicate create, server refusal), `packages/storage/src/internal/materialize.test.ts`
and `packages/storage/src/testing/entity-store.test-suite.ts` (the fold, both adapters),
`packages/client/src/sync/__tests__/{backfill,group-listing}.test.ts` (the synthetic bases),
and `ebb_server/test/integration/row_create_integration_test.exs` (the server half).

## 7. Verification

`pnpm tsc --noEmit`, `pnpm lint`, `pnpm fmt:check`, `pnpm --recursive exec vitest --run`,
`mix format --check-formatted`, `mix credo --strict`, `mix test`, and the client↔server
integration run.
