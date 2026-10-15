# Server authorization and coherence: what one Action may contain

> Research note, sourced from `ebb_server/`. It establishes what a single
> Action may legally contain, and — more importantly — which coherence
> invariants the server does **not** enforce, so a client-side planner knows
> what it must guarantee itself. Grounds the server-side coherence bug and the
> client write-path unification issue.

## Summary — the decisive question

**Yes, one Action may legally contain a user-entity create filed in group A
and an `entityGroup` membership put into group B — but only if the actor holds
`<type>.create` in group B** (for the membership put), independent of whatever
permission authorizes the create in A. Authorization is strictly per-Update
(`ebb_server/lib/ebb_server/storage/authorizer.ex:5-6`), and there is **no
server-side same-group-set rule**. The client enforces one
(`packages/client/src/sync/atomic.ts:379-408`, `group_mismatch`) but the server
does not: it authorizes each Update on its own and fans the whole Action out to
the union of every Update's groups.

If the create is filed into A _and_ the same Action adds the same entity to B
via two `entityGroup` puts, the actor needs `<type>.create` in **both** A and B
(`ebb_server/test/ebb_server/storage/authorizer_test.exs:717-751`). A
create-only permission in A does not cover the B membership put.

## What one Action may legally contain

| Composition                                                              | Authorized?     | Reason / source                                                                                                                                   |
| ------------------------------------------------------------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Same-group create + `entityGroup` put (A only)                           | yes             | entity create passes via union A; membership put needs `<type>.create` in A (`authorizer.ex:312-327`; `authorizer_test.exs:656-670`)              |
| Create in A + `entityGroup` put into B (actor has create in A only)      | **no**          | membership put is checked against target B (`authorizer.ex:312-327`, `717-751`) → `not_authorized`                                                |
| Create in A + `entityGroup` put into B (actor has create in A **and** B) | yes             | both per-Update checks pass; no cross-Update rule runs                                                                                            |
| Two creates in A and B                                                   | yes server-side | each create checks its own set; server has no equality check. **Client refuses** `group_mismatch` (`atomic.ts:395-408`, `atomic.test.ts:412-427`) |
| New group `put` + own `groupMember` `put` (bootstrap) alone              | yes             | both Updates exempt (`permission_helper.ex:169-190`; `authorizer_test.exs:128-141`)                                                               |
| Bootstrap + `entityGroup` put for an entity the same Action creates      | yes             | `entity_group_bootstrap_update?` requires group in bootstrap **and** entity in `created_ids` (`permission_helper.ex:185-190`)                     |
| Bootstrap + `entityGroup` put for an **existing** entity                 | no              | exemption is anchored to created ids (`permission_helper.ex:126-138, 185-190`; `authorizer_test.exs:566-581, 862-880`)                            |
| Bootstrap + third-party `groupMember` or unrelated patch                 | no              | per-Update exemption only (`authorizer.ex:13-19`; `authorizer_test.exs:530-605`)                                                                  |
| `entityGroup` delete of the entity's last membership                     | no              | `last_membership` (`authorizer.ex:250-263`)                                                                                                       |
| Unowned user-entity write (empty group set)                              | no              | `missing_ownership` (`authorizer.ex:424-434`)                                                                                                     |

## 1. Action validation

`ActionValidator.validate/3` checks shape, actor, HLC; it explicitly does **not**
authorize (`action_validator.ex:5-8, 56-74`). Structure requires a non-empty
`id`, `actor_id`, positive `hlc`, and a **non-empty `updates` list**
(`action_validator.ex:91-106`). Each Update is validated independently
(`action_validator.ex:110-124`): non-empty `id`/`subject_id`/`subject_type`,
`method ∈ {put,patch,delete}` (`action_validator.ex:146-150`), and data shape —
system entities (`group`, `groupMember`, `relationship`, `entityGroup`) accept
any shape including `nil`; user `put`/`patch` need `data.fields`
(`action_validator.ex:36, 152-174`). **There is no constraint on mixing methods
or subject types in one Action**, and no cap on Update count.

## 2. Per-Update authorization

Dispatch is by `subject_type` (`authorizer.ex:209-215`). Permission names come
from `method_to_permission/1` (put→create, patch→update, delete→delete;
`permission_helper.ex:53-55`), matched exactly or by `<type>.*`
(`permission_helper.ex:63-71`). Union/any-match over a group set
(`authorizer.ex:440-465`).

- **user entity**: `<type>.<verb>` in **any** group of the entity's set, where
  the set is the cached `entityGroup` membership unioned with the Action's own
  `entityGroup` puts (`authorizer.ex:424-434`; `entity_index.ex:136-158`). Empty
  set → `missing_ownership`, not a permission failure.
- **`group`**: `<group verb>` against the group's own id
  (`authorizer.ex:218-226`).
- **`groupMember`**: `<groupMember verb>` in the target group from
  `data.group_id`, else the by-id cache (`authorizer.ex:228-243, 497-503`).
- **`entityGroup`**: see §4.
- **`relationship`**: a put checks the **source's true type** (from the
  entity-type index, never the wire `data.type`, `authorizer.ex:517-522`) and
  requires `<source_type>.update` in the source's group set; patch/delete
  require `relationship.update` / `relationship.delete` in the edge's source
  group set (`authorizer.ex:388-417`). Resolution always follows the source,
  never `target_id` (`entity_index.ex:101-113, 212-213`).

Group scope for user entities is resolved via `EntityIndex.resolve_groups/3`
then `apply_intra_action/3` unioning same-Action `entityGroup` puts
(`entity_index.ex:66-75, 136-146`; intra context built at
`permission_helper.ex:199-212`).

## 3. Bootstrap exemption (`permission_helper.ex`)

`bootstrap_group_permissions/3` collects group `put` ids that do **not** exist
(`exists?`) and pairs each with the acting actor's own `groupMember` put's
declared permissions (`permission_helper.ex:88-121`). `created_subject_ids/2`
is the set of user-entity puts whose id does not exist
(`permission_helper.ex:126-138`); `created_entity_types/1` maps created ids to
types (`permission_helper.ex:142-157`). `bootstrap_update?/4` exempts exactly:
the `group` put, the actor's own `groupMember` put in that group, and an
`entityGroup` put whose target group is in the bootstrap **and** whose
`entity_id` is in `created_ids` (`permission_helper.ex:167-190`). All three must
co-occur in the **same Action**. `exists?` reads the entity-type index
(`entity_index.ex:173-186`), which retains tombstones, so a deleted id still
reads as existing and cannot be re-bootstrapped (`authorizer.ex:88-103`;
`bootstrap_existence_integration_test.exs:16-30`). `entityGroup` rows are
anchored to created entity ids precisely so the self-grant cannot graft an
existing entity (`permission_helper.ex:126-138`).

## 4. `entityGroup` put/delete authorization

- **put**: the added entity's `<type>.create` in the **target group(s) on the
  wire** (`wire_group_ids`; `authorizer.ex:312-327, 505`). The type is the
  committed index's, else a type created by this or an earlier Action of the
  request; unresolvable → `not_authorized` (`authorizer.ex:377-383, 517-522`).
  It is checked with `cached_permissions/3`, so the bootstrap's declared
  permissions never stand in (`authorizer.ex:468-480`).
- **delete**: the entity's `<type>.update` in **any** group of its current set
  (union); the row is resolved from the membership index because the wire form
  drops the entity (`authorizer.ex:335-342, 356-372, 497-503`).
- **patch**: `entityGroup.update` in the membership's group
  (`authorizer.ex:345-353`).
- **Last membership** is enforced in `check_last_membership/2`: a per-entity
  net delta of cached membership + the request's puts − deletes, carried across
  Actions of a request; any entity left with `[]` is rejected with reason
  `last_membership` (`authorizer.ex:248-290`; tests `authorizer_test.exs:882-995`).

## 5. `groupMember` put/delete authorization

Permission `groupMember.create/update/delete` in the target group; group scope
comes from `data.group_id` or the by-id cache for data-less deletes
(`authorizer.ex:228-243, 497-503`). Third-party membership needs that real
permission (`authorizer_test.exs:606-619`); bootstrap only exempts the actor's
own row. **No "online-only" constraint exists server-side** (see §9). The
server's `@system_entity_types` list is the only structural special-casing.

## 6. Coherence rule (#127)

**Not enforced server-side.** There is no comparison of group sets across
Updates anywhere in `Authorizer`/`Writer`; a grep for `group_mismatch`/coherence
in `ebb_server` finds nothing. The Writer computes an Action's group set as the
**union** of every Update's resolved groups and indexes it once per Action
(`writer.ex:1044-1059`); the Router fans the _whole_ Action to every group in
that set (`fan_out_router.ex:474-500, 527-535`). `Authorizer`'s only cross-Update
check is `last_membership`. The coherent-same-set rule lives only in the client
planner (`atomic.ts:22-37, 379-408`), where creates that differ from the union
are rejected with `group_mismatch` before submission
(`atomic.ts:395-408`; `atomic.test.ts:367-540`). Membership/system writes are
"exempt" on the client only because they do not route through
`client.atomic` (`atomic.ts:31-37`; `namespace.ts:926-929`) — there is no server
exemption to speak of.

## 7. Decisive question and variants

See the table. Sources per variant:

- **(a) create in A + `entityGroup` put into B**: authorized iff the actor also
  holds `<type>.create` in B, because the membership put is checked against the
  target group only (`authorizer.ex:312-327`; pinning test
  `authorizer_test.exs:717-751`). The create's independent union check can pass
  on A while the membership fails on B → whole Action `not_authorized`
  (`authorizer.ex:5-6`).
- **(b) create in A + `entityGroup` put into A**: authorized with
  `<type>.create` in A (`authorizer_test.exs:656-670`).
- **(c) create in A + `groupMember` put**: authorized iff the actor holds
  `groupMember.create` in the put's group, unless it is the actor's own
  bootstrap row in a same-Action new group (`authorizer.ex:228-243`;
  `authorizer_test.exs:606-619`).
- **(d) two creates in A and B**: server-authorizes if each create's group
  grants `<type>.create`; the client refuses `group_mismatch`
  (`atomic.ts:395-408`, `atomic.test.ts:412-427`).
- **(e) bootstrap alone / with same-Action entity**: both authorized
  (`authorizer_test.exs:128-141, 499-511`); adding an entity the Action does not
  create is `not_authorized` (`authorizer_test.exs:566-581, 862-880`).

## 8. Fan-out / visibility

An Action's fan-out scope is the **union** of its Updates' groups
(`writer.ex:1044-1059`; fallback `fan_out_router.ex:474-500`). `group_memberships`
maps each group to the **entire Action** and `GroupServer.push_actions` pushes
all of it to every subscriber (`fan_out_router.ex:527-535`;
`group_server.ex:81-100`). Catch-up reads the same union-indexed
`cf_group_actions` (`writer.ex:1054-1059`). So a mixed Action leaks group-B
Updates to group-A subscribers (and vice versa) — the visibility hazard #127
targets. This is exactly why the client planner refuses cross-group creates
(`atomic.ts:22-37`).

## 9. Where online-only lives

Nowhere. Membership mutation is **offline-legal (#126)** on the client and goes
through the normal outbox (`namespace.ts:926-929`), and the server has no
connection-state check on `group`/`groupMember` writes
(`authorizer.ex:218-243`). If a "group/groupMember is online-only" rule is
assumed, it is not in this source tree.

## Implications for a unified client planner/committer

1. Enforce the same-group-set rule client-side; the server will _accept_ a mixed
   Action and then leak it across groups.
2. A membership put into group B needs `<type>.create` **in B**, regardless of
   the entity's other groups. "Create in A" is not transitive.
3. Every created entity must carry a non-empty group set, else
   `missing_ownership`.
4. Membership deletes need `<type>.update` in some current group, and must not
   empty the entity's set (`last_membership`).
5. A bootstrap Action must co-occur: new `group` put + own `groupMember` put +
   (optionally) `entityGroup` for entities created in that same Action. Any
   other update falls through to the permission table.
6. `relationship` puts authorize from the source's _true_ type and group set;
   the wire `data.type` is ignored.

## Open questions / contradictions

- #127/#233 coherence is a **client-only** rule; the server does not enforce it.
  Is that intentional, or is a server-side `group_mismatch` planned?
- The client check only inspects creates' `groups` options (`atomic.ts:395-408`);
  a relationship-only batch with no groups is "coherent by this rule"
  (`atomic.ts:391-393`), leaving a possible visibility blind spot for a unified
  planner.
- The task's premise of an "online-only" `group`/`groupMember` rule contradicts
  #126 ("offline-legal"); the source does not settle whether such a rule was
  ever intended.
- `entityGroup` put uses `<type>.create` while patch uses `entityGroup.update`
  (`authorizer.ex:312-353`) — an asymmetry a planner must model per method.
