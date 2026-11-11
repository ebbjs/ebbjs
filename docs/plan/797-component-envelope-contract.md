# #797 — the component envelope: implementation contract

Epic: [#793](https://github.com/ebbjs/ebbjs/issues/793) · Slice: [#797](https://github.com/ebbjs/ebbjs/issues/797)
ADR: [`docs/adr/0001-component-model.md`](../adr/0001-component-model.md) · Vocabulary: [`CONTEXT.md`](../../CONTEXT.md)

This note fixes the wire for slice 4 so the client and the server can be changed
independently. It is the authoritative shape; the ADR explains why. Where this note is
silent, the ADR decides.

## 1. The wire

One Update names one `(entity, component)`. `data` is the component's **value**, never a
row's field record, so `data.fields` no longer exists on the wire.

```ts
type UpdateMethod = "merge" | "replace" | "drop" | "delete";

type Update = {
  id: NanoId;
  subject_id: NanoId;
} & (
  | { component: ComponentName; method: "merge" | "replace"; data: FieldValue }
  | { component: ComponentName; method: "drop"; data: null }
  | { component?: never; method: "delete"; data: null }
);

type ComponentName = `${string}/${string}`; // exactly one "/", both segments non-empty
```

`UpdateInputSchema` is the same union with `id` optional (the server mints nothing; the
client stamps it).

`FieldValue` is unchanged: a leaf `{ value, update_id, hlc? }` or a keyed value
`{ map: Record<string, FieldValue> }`. `mergeFieldValue` stays the one merge definition.

### Naming rule

`ComponentName` is `<model>/<field>`. Two invariants make the server schema-free:

1. The segment before the first `/` is the **model** the entity is committed under. It is
   the permission subject, the query source, and the type-index key, exactly what the wire
   type string was.
2. The segment after the `/` is the row **field** the component's value is stored at. For an
   anonymous component the schema already names it that way (`defineModel("note", { title:
e.string() })` ⇒ component `note/title`). `defineModel` gains an assertion that a
   declared `ComponentDef`'s name leaf equals the key it is attached under, so the rule
   cannot be violated silently.

A multi-field atomic component (`e.object`, slice 3) stores its whole record as the leaf's
`value` at that one field; nothing about that is special on the wire.

### Method rules

| Method    | Rule                                                                                                                                                                                                        |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `merge`   | Merge the value under the wire's LWW rule at the component's field: a leaf merges leaf-over-leaf; a keyed value unions keys and merges each. A keyed component therefore writes **only the keys it sends**. |
| `replace` | The component's value replaces the stored value whole. **Refused for a keyed component** (any `data` carrying `map`), at validation, naming the component. A leaf replace is the leaf-level LWW compare.    |
| `drop`    | Detach the component: remove the field. The row survives; dropping the last component is not a row delete and the row is not tombstoned. Data is `null`.                                                    |
| `delete`  | Tombstone the row. Names no component; data is `null`.                                                                                                                                                      |

Ordering is unchanged: per leaf, HLC then `update_id`.

`replace` on a **new** row is the row's first write, and a create writes one `replace` per
component (a keyed component's create writes `merge`, because `replace` is refused for it).
So a `merge` that arrives before the row's create still materializes the row — it is the only
way to create a model whose components are all keyed. What it must not do is imply _and this
is the row's first write_: slice 5 (#798) replaced the `created_hlc`-unset signal with the
client row's explicit `exists` bit, false for a row materialized before its create was seen.
The client's content backfill fetches a row whose `exists` is false, so a replica that
received a later component write without the create still gets the base. `created_hlc` is the
row's creation time and nothing else: the server stamps it on the first write of any method.

### Refusals, and their messages

- Old shape (`subject_type`, `data.fields`, `put`/`patch`): rejected at structure
  validation. No read-through, no alias, no deprecation path (#552 precedent). The stored
  Action frame likewise accepts only the new shape and raises otherwise.
- `replace` with a `map` value: `"component \"<name>\" is a keyed component; replace is refused"`
  (wording may vary, the component name must be in it).
- `component` present with `method: "delete"`, or absent with any other method: invalid
  structure.
- `component` not `<model>/<field>`-shaped: invalid structure.

## 2. The server

The server has no schema. It derives what it needs from the two naming invariants:

- **model** = component prefix. For `delete`, the committed model resolved from the
  entity-type index (`EntityIndex.subject_type/2`; rename it, the phrase "subject type" is
  gone from `ebb_server/lib`). A delete for an id the index does not know keeps today's
  behaviour (reasonable fallbacks, no crash).
- **field** = component leaf.
- **row data stays field-keyed**: `data` is still `%{"fields" => %{field => FieldValue}}`
  inside the entity/materialization path, projected by `EntityView`. Only the _wire_ loses
  `data.fields`; the stored row, `/entities/:id`, query filters, and group listing keep the
  row shape they have today. This is deliberate: slice 4 is the wire, slice 6 replaces the
  existence index, slice 10 renames the system components.

Internal vocabulary:

- `update.component`, `update.model`, `update.field`, `update.method` (`:merge | :replace |
:drop | :delete`), `update.data` (a `FieldValue` or `nil`).
- No key, variable, type, comment, telemetry field, OpenAPI schema field, or test fixture in
  `ebb_server/lib` may mention the old wire name. `rg "subject_type" ebb_server/lib` must be
  empty.

### Fold for row-shaped consumers

Two server consumers need a whole row, not a field: the `Authorizer` and
`CacheMutationPlanner` (plus `PermissionHelper`'s bootstrap reads and
`EntityIndex.fan_out_preference`'s wire reads). Add one pure projection — call it
`RowMutations` — that folds one Action's per-component Updates into row-shaped mutations in
the existing internal vocabulary, one per subject, in first-appearance order:

```
%{id, subject_id, model, method: :put | :patch | :delete, data: %{"fields" => %{field => value}}}
```

- Any `delete` for the subject ⇒ a single `:delete` mutation (`data: nil`).
- Otherwise `:put` when the row is new (the existence index does not know it and no earlier
  Action of the same request created it), `:patch` when it exists. The fields are the
  Action's component values for that subject, folded in order; a `drop` removes the field.
- Update ids and leaf stamps pass through untouched.

This is **not** a compatibility layer: nothing stored, returned, or delivered carries the
folded shape. It is the internal input the rule engine was already written against, so the
authorizer's rules (bootstrap exemption, relationship row identity, last-membership,
last-group-member) keep their meaning. Deriving `:put` from "new row" is also what makes
`<model>.create` mean "first write to a row" and `<model>.update` mean "a write to an
existing row", which is the epic's verb rule.

### The rest of the write path

- **`ActionValidator`** validates the new structure (`component`, ids, methods, data shape,
  leaf HLC bounds, `replace`-on-keyed refusal) and produces the internal update. Caps stay.
- **`ActionFormat`** stores `component`, the method string, and `data`; `delete` stores no
  component. The frame format itself (payload/scopes) is unchanged.
- **Group resolution / `fan_out_preference`**: dispatch on `update.model`; the group (`group_id`)
  or source (`source_id`) a system row names on the wire is read from whichever component Update
  of the row carries it. A row's scope is therefore a **per-subject** decision: resolve it once
  per `(model, subject)` from the folded row mutation and give every component Update of that row
  the same group list. Resolving it per component Update would drop the delivery of the
  `entityGroup/entity_id` component (whose own Update names no group), so the row's
  `entityGroup/group_id` component decides for the whole row. The Writer memoizes per subject as
  it does today.
- **`update_scopes`**: still one group list per stored Update, index-aligned with
  `action.updates`. Scope cannot differ from the entity's in this slice (the ADR's boundary
  rule), so every component Update of a row gets the row's scope. The per-`(entity,
component)` keying is slice 8/9's.
- **`cf_entity_actions`** still coalesces per subject per flush; `cf_type_entities` keeps
  `(model, 0x00, id)`, written once per row from the derived model.
- **`DirtyTracker`** marks `{entity_id, model}`; all of one row's Updates carry one model,
  so a flush returns one mark per entity.
- **Materialization** (`EntityStore`) applies a stored per-component Update to the row:
  `merge` → `FieldMerge.merge(existing_field, data)`, `replace` → the same leaf compare, at
  the component's slot (its whole value, which is one leaf; stamping the update id), `drop` →
  remove the field, `delete` → tombstone. Both sides must apply the same rule — a `replace` that
  skipped the leaf compare would let an older write clobber a newer one on the server while every
  replica rejected it. A `merge` that arrives first for an unknown row creates the row too, and
  the server stamps `created_hlc` on that first write whatever its method; row existence is the
  stored row with a null `deleted_hlc`, never inferred from the method, the field count, or the
  creation stamp. A delta replay seeds `type`, `created_hlc`,
  and the tombstone columns from the materialized row, so a `drop` or `delete` that is the
  only Update in the delta rewrites the row with its own metadata. `last_gsn` and
  `update_id` stamping follow today's rules.
- **`CacheMutationPlanner`** consumes the folded row mutations.
- **Export, telemetry, OpenAPI, group listing, fan-out** replace the wire type with the
  derived model/component. `ActionExport`'s type exclusion becomes a model exclusion.

### Catch-up frames

Catch-up and fan-out deliver Actions, and an Action's Updates now carry components, so a
frame carries components-of-row. `GET /entities/:id` gains an optional `components`
query parameter: when present, the returned row's `data.fields` is filtered to those
components' fields and unknown names are ignored. Absent means the whole row (today's
behaviour). The client requests the whole row in this slice; the parameter exists so a
large component can be excluded without a second read path (ADR "component-scoped reads").

## 3. The client

- **Write planner** (`@ebbjs/write`): `createEntity`, `patchEntity`, `createSystemEntity`,
  `duplicateEntity`, `buildEntityGroupUpdates`/`...Delete`, `buildRelationshipWrite`,
  `buildManyEntityUpdate`, `writeRelationship` emit one Update per component.
  - `create`: `replace` per atomic/leaf component, `merge` per keyed component.
  - `patch`: one emit per component the payload touches; a component whose whole field is
    in the payload is `replace`-able but `merge` is preferred for a leaf too (identical
    result, and it keeps a keyed component's siblings). Emit `merge` for keyed components
    always.
  - `delete`: one `delete`, no component.
  - `duplicate`: `replace` per component, leaves copied verbatim.
  - `relationship` system rows: one Update per component of the row (`source_id`,
    `target_id`, `type`, `field`); a many-cardinality FK write is one `merge` of the declared
    map/array field.
- **Client materializer** (`@ebbjs/storage/internal/materialize.ts`): the row is still
  `{id, type, data: {fields}}`; `readFields` becomes `componentUpdate(update)` →
  `{ field, method, value }`, and `applyUpdate` applies it. A `replace` for a row that does
  not exist is a create (`exists: true`, `created_hlc` set); a `merge` for a row that does not
  exist also materializes the row, but as a placeholder with `exists: false` and
  `created_hlc: null` because that is a base the replica has not seen; a `replace`/`merge`
  for an existing row applies to that field; `drop` removes the field on an existing row and
  keeps the row and its existence bit even when the last component is detached; `delete`
  tombstones. `type` comes from the component prefix; a `delete` keeps the existing row's
  type. `collectBackfillCandidates` treats a row with `exists: false` as missing, so the base
  is fetched.
- **Outbox / conflict slots / history**: `InboundSubject` and `PendingWrite` carry
  **components**, not field maps: a component is the slot key, and a component value's map
  keys are the paths inside it. `STRUCTURAL_MODELS` becomes a check on the model
  prefix of the component (slice 8 replaces it with the declared conflict scope).
- **Schema registry**: `validateAction` resolves the model from the component prefix and
  refuses a component the model does not declare (the field key, today's rule).
- **`refuseContentRewrites`** keys on a position `(component, path)` instead of a bare
  field: the append-only guard asks "is this an append to a log position?" —
  `isLogPosition(component, ["updates"])` — rather than "is this the `content` field of a
  document". The collaborative-text document declares its cells under its own component
  (`<docType>/content`), whose entries are append-only.
- **Collaborative text** (`packages/schema/src/collaborative-text`): one Update per field
  becomes two Updates (`<docType>/content` and `<docType>/version`) in the same Action. Its
  functions-runtime/client/codemirror consumers follow.
- **Backfill snapshot** (`snapshotAction`) becomes one `replace` Update per component of
  the fetched row, plus the row's `delete` when the fetch returns a tombstone.

## 4. Handoff: what is pinned, and what later slices own

The envelope is the durable part of this slice; the machinery around it is not. Three decisions are
pinned here because reversing them later costs a wire or data-format change:

- **`replace` stays.** It is the only method a keyed component must refuse, and removing it is a wire
  change, so it is revisited only if slice 6 (#799) finds no consumer.
- **`<model>/<field>` is the addressing rule, not an implementation detail.** A component's name leaf
  is the row field it lives at; that is what lets the server stay schema-free. A later slice may
  rename the _names_ (`ebb/link` in slice 10) but not the shape — a component addressed
  independently of a row field is a wire change, not a schema relaxation.
- **One model per subject per Action** is an invariant of the identity story, enforced at structure
  validation. Declared-set authorization (slice 12) and the system-component rename (slice 10) both
  depend on it holding.

These were scaffolding that slice 5 (#798) deletes, listed there so they are not rediscovered:
a `merge` that arrives before a create no longer implies _and this is the row's first write_;
`created_hlc` unset no longer means "the base has not been seen" (the replica's `exists` bit
does, and the server always stamps the creation time); and nothing may infer existence from
`data.fields` being empty. One item on that list is **not** deliverable on this envelope: a row
with zero components cannot be _created_, because every non-`delete` Update names a component.
A zero-component row is reachable by dropping the last component and is a legal stored row, but
creating one from nothing needs a wire create (a row-scoped method or a separate endpoint),
which a later slice owns. The testing seed keeps its `version` write until then.

One delivery question this slice does not decide is tracked as #813: an Action whose resolved group
scope is `[]` is committed but delivered to nobody. Slice 6 (#799) owns it, because the scope index
is what loses it.

## 5. Out of scope (do not invent it here)

- `e.object` / multi-field atomic component values (#796), `optional`/`has`/`drop`
  authoring surface (#798), component existence index (#799), component-granular
  invalidation (#800), `conflictScope: "component"` (#801), per-component residency
  (#802), declared-set authorization (#803), per-component version (#804), renaming the
  system components to `ebb/*` (#805).
- Any migration, alias, or read-through of the old wire. Data is discarded.
- Field-level read permissions.

## 6. Migration note

Ebb is greenfield: there is no migration. The old wire is simply unreadable. This is the
one place the old names are recorded, so nothing in `packages/core/src` or `ebb_server/lib`
has to mention them.

| Old                                   | New                                                             |
| ------------------------------------- | --------------------------------------------------------------- |
| `subject_type: "note"`                | `component: "note/title"` — the model is the component's prefix |
| `data: { fields: { title: <leaf> } }` | `data: <leaf>` — the component's own value                      |
| `method: "put"`                       | `method: "replace"` (or `"merge"` for a keyed component)        |
| `method: "patch"`                     | `method: "merge"`                                               |
| `method: "delete"`                    | `method: "delete"` (still names no component)                   |
| —                                     | `method: "drop"` — detaches one component, row survives         |

A row that was one Update carrying five fields is now five Updates carrying one component
each. The client store is reset and server data is discarded; there is no alias, no
deprecation window, and no read-through of a stored old-shape Action.

## 7. Verification

- `rg "subject_type" packages/core/src ebb_server/lib` ⇒ nothing.
- `pnpm typecheck`, `pnpm lint`, `pnpm -r --filter "@ebbjs/*" exec vitest --run`, `mix test`.
- The client↔server integration run (`packages/client/src/__tests__/integration/ebb-server.test.ts`,
  `ebb_server/test/support/integration/*`) passes on the new envelope.
- A measurement is recorded in the epic: a 5-component `update()` is 5 Updates; payload
  delta and commit throughput through the real Writer pipeline
  (`ebb_server/bench/ebb_server/bench/write_batch.ex`), not a storage primitive.
