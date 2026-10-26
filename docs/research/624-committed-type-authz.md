# Committed-type authorization for entity writes (#624)

Research note for [#624](https://github.com/ebbjs/ebbjs/issues/624): a
user-entity write is authorized against the client-supplied `subject_type`,
not the type the entity was committed under. No code changed here — this maps
the defect, the vectors a fix must close, where the check belongs, and
everything it touches. All evidence is `file:line` in `ebb_server/` unless
prefixed with `packages/`, on `fix/issue-624-committed-type-authz` at `c733c9f`.

## The defect in one sentence

`subject_type` is client input that only has to be a non-empty string
(`action_validator.ex:140-144`), and it is treated as the entity's _identity_
by every stage downstream of validation, while nothing compares it with the
type the id was committed under.

Where the wire type is authoritative today:

| Stage                                         | Site                                                        | Uses wire type |
| --------------------------------------------- | ----------------------------------------------------------- | -------------- |
| authz dispatch                                | `authorizer.ex:303-311`                                     | yes            |
| `<type>.<verb>` gate                          | `authorizer.ex:768-778`                                     | yes            |
| materialized row `type`                       | `entity_store.ex:493-511` (`type: subject_type`)            | yes            |
| entity-type cache + `cf_type_entities`        | `cache_mutation_planner.ex:131-134`, `committer.ex:228-238` | yes            |
| dirty mark + `cf_entity_actions`              | `writer.ex:1991-2001`, `committer.ex:218-226`               | yes            |
| SQLite `type` column (what `query/4` filters) | `sqlite.ex:603` via the materialized row                    | yes            |
| client replica row `type`                     | `packages/storage/src/internal/materialize.ts:110-125`      | yes            |

The committed type is only consulted for the membership gates:
`entity_type/2` (`authorizer.ex:717-723`) merges
`EntityIndex.subject_type/2` (the committed index) over
`authz.created_types`, and `authorize_entity_group_put/4`
(`authorizer.ex:642-660`) and `authorize_membership_delete/2`
(`authorizer.ex:700-715`) use it. `authorize_relationship_update/4`
(`authorizer.ex:726-757`) uses it for the _source_ id (#323). The user-entity
branch never does.

## 1. The authorization path

`check_update/3` (`authorizer.ex:283-287`) runs the row-identity check, then
`authorize_or_exempt/3` (`authorizer.ex:289-301`) skips bootstrap writes and
otherwise calls `authorize_update/3` (`authorizer.ex:303-311`), which dispatches
on `update.subject_type`:

- `"group"` / `"groupMember"` / `"entityGroup"` / `"relationship"` → the system
  branches (`authorizer.ex:313-661`);
- anything else → `authorize_user_entity_update/3` (`authorizer.ex:768-778`):
  `EntityIndex.resolve_groups(type, update.subject_id, authz.intra_opts)`, then
  `check_group_permission(group_ids, actor_id, type, permission_for(method))`.

`EntityIndex.resolve_groups/3` (`entity_index.ex:76-82`) splits into
`resolve_groups_cached/3` plus `apply_intra_action/3`. Only the system types
read the type argument:

| committed/wire type | `resolve_groups_cached/3`                                                             |
| ------------------- | ------------------------------------------------------------------------------------- |
| `"group"`           | `{[group_id], nil}` (`entity_index.ex:100`)                                           |
| `"entityGroup"`     | the row's `group_id`, from the by-id cache (`:102-111`)                               |
| `"relationship"`    | the **source's** group set (`:113-126`)                                               |
| `"groupMember"`     | the row's `group_id` (`:128-137`)                                                     |
| any user type       | `{source_groups_cached(source_id), source_id}` — **the type is ignored** (`:139-141`) |

So for a user-type write, group resolution is by entity id alone
(`entity_index.ex:177-190`: cached `entityGroup` targets ∪ the Action's
`entityGroup` puts), while the permission checked is `<wire type>.<verb>`. The
two halves of the check can name different types. `permission_for/1`
(`authorizer.ex:881`) maps put→`create`, patch→`update`, delete→`delete`.

Consequence per method, for a wire user type A on an existing user entity of
type B:

| method | groups consulted  | `<type>.<verb>` checked | stored type afterwards                      |
| ------ | ----------------- | ----------------------- | ------------------------------------------- |
| put    | the id's real set | `A.create`              | **A** (`entity_store.ex:505`, full replace) |
| patch  | the id's real set | `A.update`              | B (`entity_store.ex:539` `acc.type \|\| …`) |
| delete | the id's real set | `A.delete`              | B (untouched, `entity_store.ex:549-556`)    |

But all three poison the _indexes_: the entity-type ETS cache and
`cf_type_entities` are rewritten with the wire type for **every** Update,
including patch and delete (`cache_mutation_planner.ex:131-134` →
`writer.ex:1949-1950`), the dirty mark is `{subject_id, wire_type}`
(`writer.ex:1995-2001`), and `cf_entity_actions` is keyed by `subject_id` only
(`committer.ex:218-226`) — so any Update at all makes its Action replayable
under the target id, whatever its type.

`entity_type/2` (`authorizer.ex:721-723`) is the right primitive for the fix:
`EntityIndex.subject_type/2` first (committed, overlay-aware,
`entity_index.ex:190-200`), then `authz.created_types`. `nil` means "nothing
knows this id yet".

## 2. Attack vectors a fix must close, by severity

**V1 — user id, wire user type (the issue's repro).** Actor holds `todo.*` in
group G and an `invoice` also lives in G. A `put` for that invoice declaring
`subject_type: "todo"` is authorized as `todo.create`
(`authorizer.ex:768-777`), passes group resolution (type ignored), and
`apply_put/4` replaces the field map **and** the stored type
(`entity_store.ex:493-511`). Result: `todo.*` becomes `put`-rights over every
entity in the group, the private field is overwritten, and the SQLite/`type`
column flips so `query("invoice")` no longer matches it (`sqlite.ex:603`).
Bounded by group membership: the group set still comes from real membership
rows. **Wire type authoritative.**

**V2 — foreign id, wire _system_ type (worse: not bounded by group
membership).** The system branches authorize the **subject's own** row only
loosely, and materialization is keyed by `subject_id` alone:

- `relationship` put with `subject_id` = any entity id. Authorization looks
  only at the wire `source_id`'s set (`authorizer.ex:732-746`,
  `EntityIndex.relationship_groups/3`), so an actor who may update _their own_
  entity can name a victim's id as the edge id. It then writes
  `cf_entities[victim_id]` with the relationship's fields and
  `type: "relationship"` (`entity_store.ex:493-511`) plus a
  `relationships_by_id` row under that id (`cache_mutation_planner.ex:212-241`).
  `check_update_row_identity/2` only guards `entityGroup` puts
  (`authorizer.ex:662-666`) and reads `EntityIndex.membership/2`, which is the
  membership index, not the entity-type index.
- `entityGroup` put with `subject_id` = any entity id, `data.entity_id` = the
  attacker's own entity, `data.group_id` = a group where they hold
  `<their type>.create`: `authorize_entity_group_put/4` types the **wire
  `entity_id`**, never the subject (`authorizer.ex:642-660`), so the put is
  accepted and materializes over the victim id with an empty field map
  (`data` has no `fields` key) and `type: "entityGroup"`.

`group` and `groupMember` wire types over a foreign id are already refused
(`authorizer.ex:313-320` checks `group.create` in a group whose id is the
subject; `existing_group_member/2` returns `:unresolved` for a known id with no
cache row, `authorizer.ex:372-382`). So V2 is `entityGroup` + `relationship`
only. **Wire type authoritative; cross-group data destruction plus type
poisoning.**

**V3 — system id, wire user type.** Conditional but real. `resolve_groups/3` for
a user type falls into `source_groups_cached/2`, so the target only passes
ownership if the _system row itself_ has `entityGroup` rows — e.g. a `group`
filed into another group via an `entityGroup` put (allowed:
`authorizer.ex:642-660` + `check_not_ownerless/2` only refuses a known entity
with no group). When it does, a `put` relabels and wipes the system row, and on
the next boot `SystemCache.populate_type/6` rebuilds `GroupCache` /
`EntityGroupCache` from `cf_type_entities` prefixes (`system_cache.ex:525-548`,
`populate_group_members/5` at `:448-457`) while the entity data underneath has
been replaced — permission/membership data loss across a restart. Note
`cf_type_entities` is append-only: nothing deletes the old
`(committed_type, id)` key, so the row ends up indexed under both types.

**V4 — patch/delete with a mismatched type (index poisoning without a
relabel).** Stored type survives (`entity_store.ex:539, 549-556`) but the
entity-type ETS cache now answers the wire type for that id
(`cache_mutation_planner.ex:131-134` → `writer.ex:1949-1950`). Every later
`entity_type/2` caller — `entityGroup` put/delete gates and the relationship
source gate — then authorizes against the attacker's type for a victim id, and
the dirty mark sits under the wrong type so `query(victim type)` skips the
materialization. This is why re-deriving the type only inside
`authorize_user_entity_update/3` is not enough.

**V5 — new or unknown id (must keep working).** No committed type, so the wire
type is the only type; the permission gate must still be
`<wire type>.<verb>`. One asymmetric case to decide explicitly: a _tombstoned_
id keeps its `entity_type` entry (`entity_index.ex:202-212`, "a deleted id
still reads as existing and cannot be re-bootstrapped"), so a fail-closed
mismatch rule also forbids re-creating a deleted id under a new type. That
matches the existing "deleted ids stay known" rule, but it is a behaviour
choice, not an accident.

## 3. Where the committed type should be resolved

**Reject the mismatch at dispatch.** Add a `check_update_type_identity/2` beside
`check_update_row_identity/2` and call it from `check_update/3`
(`authorizer.ex:283-290`, i.e. before `authorize_or_exempt/3`, so no bootstrap
exemption can carry a mismatch):

```elixir
case entity_type(update.subject_id, authz) do
  nil -> :ok                                  # new id: the wire type is the type
  type when type == update.subject_type -> :ok
  _committed -> {:error, "not_authorized", "subject_type does not match the committed type"}
end
```

Why here and not in the user branch:

- `authorize_update/3` is the single dispatch point, and a misplaced write is
  the entry to **all five** vectors; V2 lives in the system branches, so a user
  branch-only fix leaves it open.
- Re-deriving the type _for the permission lookup_ does not stop the relabel:
  `apply_put/4`, `CacheMutationPlanner`, `cf_type_entities`, the dirty mark and
  `cf_entity_actions` all still key on the wire type. Rejecting means every
  Action that reaches the Writer has `wire type == committed type`, so **no
  downstream change is needed** — no `entity_store.ex`, planner, committer or
  writer edit.
- The alternative — rewriting `update.subject_type` to the committed type —
  also works downstream (the payload is encoded from the accepted updates after
  authorization: `writer.ex:952, 969` → `preparer.ex`), but then the durable
  Action no longer matches what the client authored, and patch/delete still
  need their own rule. Refusing is fail-closed and is one branch.

`EntityIndex.subject_type/2` and the planner/cache are consistent:
`plan_update/3` overwrites `{:entity_types, id}` with the wire type for every
Update (`cache_mutation_planner.ex:131-134`) and the overlay's last write wins,
so mid-flush `EntityIndex.subject_type/2` returns the type planned for that
flush. After this fix that equals the committed type, so the two agree by
construction. Authorization never sees an overlay at all:
`AuthorizationContext.to_opts/1` (`authorization_context.ex:84-95`) has no
`:overlay` key, so the Authorizer always reads committed state.

`Map.get(authz.created_types, entity_id)` **is** needed, for the two cases the
index cannot answer: an id created by an earlier Action of the same request
(`sim.types`, `authorizer.ex:226-233, 250-260, 271-274`) and an id created by
this same Action (the ETS index only advances on commit). `entity_type/2`
already orders those correctly. One caveat to respect:
`PermissionHelper.created_entity_types/1` (`permission_helper.ex:196-204`) maps
_every_ user-entity put, including puts on existing ids, so `created_types` is
not "created only" despite the name — the index-first order in `entity_type/2`
is what makes it safe. A poisoned entry cannot be observed either, because
`check_all_updates/3` halts the whole Action on the first failure
(`authorizer.ex:271-277`), so a mismatched put is never accepted into a later
update's view.

No helper or sim upstream of authorization knows a committed type:
`prepare_pool.ex` and `preparer.ex` are payload-only and cache-free by design
(`preparer.ex:1-18`), and `prepared_action.ex:24-33` derives
`affected_entities`/`type_entity_keys` from the same wire `subject_type`.

## 4. Tests

**Unit — `ebb_server/test/ebb_server/storage/authorizer_test.exs`.** The setup
helpers a new regression test should copy: `create_isolated_tables/0`
(`test/support/test_helpers.ex:469`), `auth_context/1` (`authorizer_test.exs:7`),
`put_entity_type/3` (`:19`), `put_membership/4` (`:23`), `put_group_member/3-4`
(`:33`), `entity_put/2` (`:101`), `build_action/1-2` (`:60`), and the two
assertions `assert_accepted/1` (`:64`) / `assert_rejected/2` (`:69-73`, which
asserts `rejection.reason == reason`).

Closest models to copy:

- **#323 (committed type beats a forged wire label)** — "relationship put
  ignores a forged wire type and checks the source's true type"
  (`authorizer_test.exs:498-509`), plus "authorizes a source type the same
  request created" (`:511-528`) for the `created_types` case. This is the exact
  shape: seed an entity via `put_entity_type`, give the actor only the other
  type's permission, assert `not_authorized`.
- **#635 (`entityGroup` rules)** — `describe "authorize/3 - entityGroup put
target group"` (`:756-793`), `describe "authorize/3 - entityGroup patch"`
  (`:1302-1476`), "a put cannot claim an entity the index knows but no group
  owns" (`:1417`). All of them put with the type they indexed
  (`put_entity_type(tables, "todo_1", "todo")` + `entity_put(..., "todo")`), so
  a mismatch rule should leave them green; they are the regression set for
  "system-entity behaviour must not move".
- `describe "authorize/3 - writes require ownership"` (`:656-755`) has the
  "cached membership satisfies ownership" case that must keep working when the
  index has no entry for the id (`:723-736`).

**End-to-end — `ebb_server/test/integration/permission_authorization_integration_test.exs`.**
`describe "cross-tenant entityGroup row identity (#623)"` (`:725-801`) is the
template: `bootstrap_group/3`, `todo_put/2` (`:816-826`), `entity_group_put/4`
(`:828-844`), the local `submit/2` (`:804-808`) which asserts HTTP 200 and
decodes `%{"rejected" => …}`, and `get_entity/2` for the post-condition. Add a
`describe "committed-type authorization (#624)"` with the issue's repro
(owner holds `invoice.*`/`todo.*`; `actor_2` holds only `todo.*`; `put` the
invoice as `todo`) asserting `%{"rejected" => [%{"reason" => "not_authorized"}]}`
and that `get_entity(invoice_id, …)["type"] == "invoice"`, then the `patch` and
`delete` variants and the "new id still uses the wire type" control.

Run (working dir `ebb_server`, `mix test` from `ebb_server/README.md:14`):

```sh
cd ebb_server
mix test test/ebb_server/storage/authorizer_test.exs
mix test test/integration/permission_authorization_integration_test.exs
mix test test/ebb_server/storage/authorizer_test.exs:498   # one test
```

## 5. Client mirror

`packages/client/src/sync/permission.ts:313-324` (the `default:` arm of
`resolveRule`) applies **`type: subjectType`** — the wire `subject_type` — as the
permission namespace, with `required: `${subjectType}.${verb}``and the group set
from`groupSetFor(subjectId)`(membership-by-id, same as the server). So the
local pre-check reproduces the server defect: it happily passes a`todo`-labelled put on a local `invoice`.

It already has what the fix needs. `RuleInputs.exists(subjectId)`
(`permission.ts:150-173`) is `storage.entities.get(id)`, a locally
materialized `Entity` carrying `.type`; the write path's `resolveType`
(`permission.ts:439-443`) is exactly the server's `entity_type/2` ordering —
`exists(id).type` first, then `createdTypes` built from this Action's user
puts (`:431-436`). The equivalent rule is therefore one line in the `default:`
arm: use `(await inputs.resolveType(subjectId)) ?? subjectType` as `type`.
`client.can()` needs nothing: `queryEntityPermission` already passes the
committed `row.type` (`permission.ts:597-653`), which is why `can.test.ts` is
not the file to extend. The replica materializer mirrors the server bug too
(`packages/storage/src/internal/materialize.ts:110-125` sets
`type: update.subject_type` on a put), so a server-accepted relabel would also
rewrite the local row's type.

Tests: `packages/client/src/sync/__tests__/permission.test.ts`,
`describe("collectPermissionViolations — user entities")` (`:102-191`). Closest
existing test to extend/copy: "ignores a forged wire type and checks the source's
true type" (`:241-255`) is the #323 analogue from the relationship block;
"throws locally and never enqueues or POSTs when the permission is missing"
(`:103-115`) is the user-entity shape to clone — materialize
`mkEntity("invoice_1", "invoice", …)` plus
`mkEntity("eg_1", "entityGroup", {entity_id: "invoice_1", group_id: "g_1"})`,
handshake `[["g_1", ["todo.*"]]]`, write `update("todo", "invoice_1", "put", …)`.
Note the existing user-entity tests deliberately never materialize the subject
row, so they keep exercising the wire-type path — they double as the "new id"
regression. Run with `pnpm --filter @ebbjs/client test`
(`packages/client/package.json:39`).

## 6. Docs the fix will contradict

| Claim today                                                                                                              | Site                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "User-entity writes require `<type>.<verb>` in at least one group of the entity's group set" — `<type>` is the wire type | `ebb_server/lib/ebb_server/storage/authorizer.ex:92-97`                                                                                                                                                                                                        |
| Facade description: "does the actor have the right `<type>.<verb>` (or `<type>.*`) on the entity's group?"               | `ebb_server/lib/ebb_server/storage/permission_checker.ex:13-14`                                                                                                                                                                                                |
| `subject_type/2` "used by the authorizer to gate membership mutations" — after the fix it gates entity writes too        | `ebb_server/lib/ebb_server/storage/entity_index.ex:36-42`                                                                                                                                                                                                      |
| Sequence-diagram step "ActionValidator + Authorizer group permissions"                                                   | `ebb_server/README.md:318`                                                                                                                                                                                                                                     |
| Wire schema: `subject_type` = "Type of the entity" (no committed-type precondition)                                      | `ebb_server/lib/ebb_server/sync/router.ex:793-800`; generated spec `ebb_server/openapi.yaml:46-49, 130-132` (and the duplicated copies at `:547-557`, `:755-762`); regenerate with `mix openapi.gen.spec` (`ebb_server/README.md:43-49`, spec location `:194`) |
| Client rule table: "user entity → `<type>.<verb>` over the entity's group set"                                           | `packages/client/src/sync/permission.ts:182-199`                                                                                                                                                                                                               |

Checked and **not** contradicted: the wire examples in
`packages/core/README.md:47`, `packages/www/src/content/docs/index.md:56` and
`ebb_server/README.md:807` are creates (no committed type to conflict
with). `CONTEXT.md` makes no `subject_type` claim — the new invariant ("an
entity's type is immutable; a write must declare it") belongs in its Schema
vocabulary next to **Entity** (`CONTEXT.md:86-91`).

## Open questions for the fix

_(Superseded by §7, which records what shipped and which way each question went.)_

- **Reason string.** `not_authorized` keeps one rejection surface and matches
  the issue's required tests; a dedicated reason (e.g. `subject_type_mismatch`)
  would be easier for clients to distinguish from a missing permission.
- **Tombstones.** Fail-closed means a deleted id cannot be re-created under a
  different type (see V5). Confirm that is intended before writing the test.
- **V2's blast radius.** `relationship`/`entityGroup` puts naming an existing
  entity id as their subject are not just a type mismatch — they are writes to
  another group's entity. Worth a second look at whether the _subject id_ of a
  system write should be required to be of the system type, independent of
  #624.

## 7. What shipped, and the decisions it made

Landed on `fix/issue-624-committed-type-authz`. The invariant is the issue's
own: a write's `subject_type` is identity, not a label, so it must equal the
type the id is committed under — checked per Update before the type dispatch
and before the bootstrap exemption (`authorizer.ex`, `check_update_type_identity/2`).

| Open question                   | Decision                                                                                                                                                                                                                                                                                           |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reason string                   | `not_authorized` with a specific `details` string. One rejection surface, and the required tests in #624 assert that reason. The client mirror reports the mismatch as its own violation kind instead of a missing permission, since no grant could make the write pass.                           |
| Tombstones (V5)                 | Fail closed: a deleted id keeps its type-index entry, so it may only be re-put under its own type. Re-putting it under its own type passes the type check and is then refused on ownership, so an app must file the new row itself. Test: "a tombstoned id may only be re-put under its own type". |
| Intra-request relabel           | Closed. The request simulation now wins over the current Action's own puts, so a later Action in the same request cannot type an id an earlier Action created. The id's first accepted type is binding for the request.                                                                            |
| Unresolvable type on a known id | Closed. The entity-type index lags the caches, so a `nil` entry is not proof of a new id: an id a membership row owns is refused rather than written under the wire type. A by-id system row types itself (its cache row is the record), so membership administration survives index lag.          |
| V2's blast radius               | The type identity check closes the relabel half: a `relationship`/`entityGroup` put naming a committed row of another type is now refused. Whether a system write's _subject id_ must additionally be of that system type is still open, and belongs in its own issue.                             |
| Client mirror scope             | The identity rule is mirrored for user-entity writes only. `relationship`/`entityGroup` wirings are left to the server, which is authoritative; the moduledoc states that boundary.                                                                                                                |
| Wire contract                   | `subject_type`'s OpenAPI description now states the rule for an existing id, and `openapi.yaml` was regenerated (`mix openapi.gen.spec` + `oxfmt`). `CONTEXT.md` records **Committed type** next to **Entity**.                                                                                    |
