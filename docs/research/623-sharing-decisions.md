# Sharing an entity with a group (#623)

The decisions behind the `entityGroup` share primitive: who may add an entity to
a group, what the client calls it, how a share is revoked, and what the words
mean. This note answers D1–D8 from [#623](https://github.com/ebbjs/ebbjs/issues/623)
and records the rejected options. Nothing here is implemented on top of this
branch — Phase 1 is "decide", and the slices below are what follows.

## The hole, restated

`entityGroup` put is authorized by the **target** group alone: the added
entity's `<type>.create`. Nothing consults the entity's own groups.

That is not a visibility grant. Every user-entity write — update, delete, and
the membership delete that unshares — is authorized by `<type>.<verb>` over the
**union of the entity's current groups**. So filing E into G does two things in
one unauthenticated-on-the-source write:

- it exposes E to G's members (`202`-visible through any group-scoped query);
- it adds G to the set of groups that authorize writes to E, so the same caller
  can now overwrite or delete E with `<type>.update` in G.

The primitive is therefore a **write to E authorized by a group E is not in**.
The missing check is on the source side, which is why "the target group's
policy is the whole gate" cannot be fixed by tightening the target side.

The demo makes it concrete: `SEED_PERMISSIONS` grants every invited member
`profile.*`, `entityGroup.*` and `relationship.*` in the shared workspace, so
any signed-in member can today file any known actor's profile — `prof_<actorId>`,
a _derived_ id — into the workspace and read it, without ever holding
`profile.update` in that actor's personal group.

The same write is the documented invite flow (the inviter files the invitee's
profile into the workspace), which is why the owner-side rule in `2391039` was
reverted in `94c6b33`: it broke an integration test that the product wants to
keep passing. The product answer is not "drop the check" but "the owner's
client performs the share" — see D2 and the two-write invite below.

## Decisions

### D1. Cross-owner sharing by id without owner consent — never

**Decision.** No. A caller may not change an entity's group set unless it can
already write that entity. There is no telemetry-and-accept variant.

**Why.** The operation is a write to E (above), so accepting it means accepting
that `<type>.create` in any group is a write capability over every entity of
that type. Ids are not secrets in this framework: apps derive them
(`prof_<actorId>`, `grp_<actorId>`), and an id becomes visible to everyone an
entity is shared with, so a share leaks ids sideways and one leak compounds.
`<type>.create` is also the most widely granted permission there is — it is what
every member of every group holds.

**Rejected.** _E (id as capability)_ — needs a product sign-off that trades the
invariant above for an unrevocable, un-auditable read path; the demo's derived
ids make it worse than the abstract case. _D (invite-shape exemption)_ — sniffs
`actor_id` and makes an app field security-relevant. _D′ (same-Action
exemption)_ — allow the share only while the caller also files a `groupMember`
row for `entity.actor_id` in the same Action; it keeps one-Action invites but
adds a second authorization path whose safety depends on two Updates riding
together, and it still only helps entities that carry `actor_id`.

If a product ever wants "claim a known id", it is an explicit claim operation
with its own consent rule and its own `ebb.*` event, not a default.

### D2. A now, B later — and B lands as a disjunct, not a rewrite

**Decision.** Adopt **A (owner-side consent)** as the model. Write the put rule
so B (share grants) is additive, and do not build B until a product need names
it.

**Why.** A is the smallest rule that restores the invariant, and it is the only
option that needs no new wire primitive, no new system entity, and no new
client capability surface. Its cost is coordination, not code — see below.

B's only buyer today is atomic/offline admin-initiated invites and third-party
delegation. Both are real, neither is in scope: the demo's self-service join is
one click in the invitee's own browser, where the owner's client is present.

**Not now.** _C (accept-before-join)_ — needs a pending membership state, an
accept operation and a discovery channel; none exist and none is required for
the security baseline (see D3). _B_ — a system entity, cache, auth rules,
revocation, client API and tests, i.e. a slice of its own.

**The seam.** The rule is written as one conjunction with a disjunction inside
it (§ The invariant), so B adds `OR a live grant naming the caller` to the
source-side term and touches nothing else.

### D3. Access is membership; the invitee keeps consent without an accept step

**Decision.** No accept-before-join. Sharing covers an entity's profile
visibility, not access.

**Why.** Access is granted by a member of the group (`groupMember.create` in
that group), so it is already a member-consented act on the group's side. Under
A the invitee's content only appears in the group when the invitee's own device
writes the share, so the invitee controls their content without a pending
membership state. That combination — "you can be added to a group, but nothing
of yours becomes visible until your device says so" — is the product answer C
would otherwise be built to obtain.

**Revisit if** access itself must be consented to before the invitee can read
group state. That is a bigger slice: pending membership, accept operation,
discovery, and a UI state machine.

### D4. Keep `addToGroup` / `removeFromGroup` / `setGroups`; no `share` verb

**Decision.** The client keeps its existing membership verbs. No `share` /
`unshare` alias, no `<type>.share` permission, no new server endpoint. The word
"share" is documentation, not API.

**Why.** On the wire and in the permission table, sharing _is_ a group-set
change; a second name for the same operation is exactly the "one concept, not
three" trap the issue warns about. A `<type>.share` verb would fork the
permission table for an operation whose authority is already expressible as
`<type>.update` (source) + `<type>.create` (target), and every app would have to
grant it alongside the two it already has.

The owner's one documented call is
`profile.addToGroup(profileId, workspaceGroupId)` on the owner's own client
(or `setGroups` for several groups at once). The docs sentence that goes with
it: _to share an entity with a group, add it to that group; your write
permission in the entity's current groups is the consent._

**Contingent on B.** If B lands, grants are a different object from membership
and `share`/`unshare` becomes the honest name for the delegate's call —
`addToGroup` then stays the direct owner path. Adding the alias at that point is
cheap; deleting one now would not be.

### D5. Discovery stays on the handshake

**Decision.** Handshake and catch-up. No per-actor notification channel.

**Why.** The Action stream is group-scoped by construction — a non-member cannot
receive anything, so an invite cannot be delivered as an event to the invitee
before the membership exists. A per-actor inbox is a product slice (delivery,
read state, fanout) that the security baseline does not need.

**Consequence.** Admin-initiated invites have a discovery window bounded by the
invitee's next `refresh()`/catch-up. Self-service join has no window in
practice: the invitee's own click triggers the refresh, and the share follows
immediately (D2, two-write invite).

### D6. One row per `(entity, group)`: derive the row id, and refuse a duplicate

**Decision.** The client mints an `entityGroup` row id deterministically from
`(entityId, groupId)`, and the server refuses a put that would mint a second
row for a pair the index already holds. No server-side uniqueness index.

**Why.** This is a revocation bug, not tidiness. Rows are minted as
`generateId("eg")` (`packages/client/src/sync/relationship.ts`), so two devices
that share the same entity into the same group before syncing create two live
rows. Unsharing deletes the row the unsharing device can see; the other row
survives, the entity stays visible, and the owner's successful unshare silently
fails. The same is reachable by a hostile client putting a fresh `eg_*` id for a
pair that already exists — today `authorize_entity_group_put/4` reads only the
target group, so nothing notices.

Deriving the id collapses both cases onto one row, which makes the share
idempotent across devices (D6's idempotency requirement) and unshare total.
Re-sharing after an unshare reuses the same row id, so revocation cannot be
defeated by an id shuffle either.

The derivation must be unambiguous, not merely readable: `eg_<entityId>_<groupId>`
lets `(a_b, c)` and `(a, b_c)` collide. A length-prefixed encoding
(`eg_<len(entityId)>_<entityId><groupId>`) or a hash of the two parts is
required; exact form is the implementation's choice. Row ids were never
capabilities — deletes are authorized over the entity's groups and row identity
is pinned — so a predictable row id changes no authorization.

The server-side half is a positive check, not an absence: `(entity, group)` live
in the index and the put naming a different row id → refuse. Both lookups exist
(`EntityGroupCache.entity_group_entries/2`).

**Rejected.** _Server uniqueness for `(entity, group)`_ — an index the write
path does not have, a new rejection code competing with the per-row
`last_membership` bookkeeping, and no fix for rows created before it. The
derived id makes the invariant true at the source for every writer, including
third-party clients.

**Note.** This narrows today's deliberate tolerance ("membership is per row, so
a second row for a group the entity already belongs to keeps that group").
`last_membership` still counts rows per group, and the put-then-delete
cancellation it documents still holds under one row per pair.

### D7. Revocation is the existing delete, and the UI shows no new state

**Decision.** Unshare is `entityGroup` delete, authorized by `<type>.update`
over the entity's current groups, delivered through the normal Action stream.
No tombstones, no separate revocation path.

**Why.** It already works and it is already per-row correct (`75da13c`). Under A
the caller must be able to write the entity, so unsharing is the owner's action —
which also means a group member can no longer unshare somebody else's entity,
and "leave" for the invitee's profile is owner-initiated.

**Propagation.** Live clients see the entity leave the group on the next Action
(per-Update delivery scopes, #473); an offline client sees it at catch-up.
A stale offline put can still win the merge against a delete under the existing
LWW rule — that is the merge model, not a share special case — but with D6's
derived row id the two contend on the same row, so the race resolves visibly on
one row instead of leaving a silent duplicate behind.

**UI.** Nothing new for the framework. The one state worth naming is on the
group's side: a member whose profile has not been shared _yet_ is
`profile-pending` — an app-level rendering of "no profile row for this member
in this group", not a stored status. The demo owns it (Phase 4).

### D8. Document the vocabulary we actually ship

**Decision.** `CONTEXT.md` gains a `### Sharing` section with **Share**,
**Invite** and **Profile-pending**. **Grant** and **Accept** are not defined —
they name options this note rejects for now, and vocabulary for absent concepts
rots. Whichever of B/C lands introduces its own term.

**Why.** The invariant is a permission rule that app authors cannot derive from
the entity schema, so it has to be stated where they read. Criterion 7 also
wants the client mirror documented, and the mirror currently describes a rule
the server does not implement (below).

Files that change with the implementation: `CONTEXT.md`, the
`EbbServer.Storage.Authorizer` moduledoc (`entityGroup` put rule),
`packages/client/src/sync/permission.ts` (rule table and header),
`packages/client/README.md`, and the demo's `workspace.ts` moduledoc.

## The invariant

```text
entityGroup put(entity E, group G):
  E is new to the index            → <type>.create in G
  the row is E's live row for G    → allow (idempotent re-put)
  G is already in E's groups       → refuse (a second row for a live pair)
  otherwise                        → <type>.create in G
                                     AND <type>.update in one of E's current groups
                                         [B: OR a live grant naming the caller for E]
patch                                 → refused, structurally, on both sides
delete                                → unchanged: <type>.update over E's current groups
```

"New to the index" keeps its #635 meaning: the entity-type index does not know
the id, so the same Action is creating it. Every #635 fail-closed rule stays —
row identity pinned, ownerless refused, per-row deletes keyed by the stored row,
string ids, no bootstrap grant for entities that already exist.

The two refusals in the middle are what D6 adds: an idempotent re-put of the
entity's own live row is a no-op, and minting a second row for a live pair is
never allowed, whatever permission the caller holds.

## Consequence: the invite becomes two writes by two actors

One Action carries one actor's authority. Under A the inviter cannot file the
invitee's profile into the workspace, because the inviter has no write access to
the invitee's profile — that is the whole point. So the demo's `addToWorkspace`,
which today writes the `groupMember` row and the profile membership in one
Action through the seeder client, splits:

1. **Invite** — a member of the workspace (the demo's `demo-seeder`) puts the
   invitee's `groupMember` row: `groupMember.create` in the target group. No
   entity share.
2. **Share** — the invitee's own client puts the `entityGroup` row for its
   profile once it observes the membership: `profile.update` in its personal
   group plus `profile.create` in the workspace.

`workspace.ts`'s doc comment ("a partially-joined actor is impossible") stops
being true and must say what replaces it: the window where the member exists
and the profile is pending, who closes it, and that closing it is the invitee's
own write. `MembershipPanel.join` becomes invite → refresh → share.

Leaving already has the right shape — `leaveWorkspace` removes the profile
membership with the _member's_ client, which is exactly the owner-side
authorization A requires — so leave is unchanged.

The demo's `SEED_PERMISSIONS` should also shrink to what a member needs
(`issue.*`, `workspace.*`, `groupMember.*`, `relationship.*`): `profile.*`,
`entityGroup.*` and `group.*` in the shared group are what make the graft
reachable today. The owner-side rule is the framework fix; least privilege is
the app-level one, and both belong in the slice.

## What this does not decide

- Notifications, invite expiry, rate limiting, abuse detection, per-field ACLs,
  server-function runtime changes, peer replication: out of scope per the issue.
- **Trigger for B**: a product need for atomic or offline admin-initiated
  invites, third-party sharing with an actor who is not the owner, or delegation
  with revocation by a third party. When it appears, B adds a disjunct to the
  invariant and a grant object with its own lifecycle — it does not reopen D1.
- **Trigger for C**: access itself must be consented to before the invitee reads
  group state.
- Row-id derivation format (D6) and the exact refusal code for the duplicate-pair
  and patch cases.

## Follow-up slices

1. **Server** — re-apply the owner-side rule from `2391039` (adapted to the
   invariant above), add the duplicate-pair refusal, keep every #635 check, and
   make the #635 probe suite and the new outsider/share end-to-end tests
   red-on-parent. Patch refusal stays; the mirror learns to agree with it.
2. **Client** — derive `entityGroup` row ids, stop modelling `entityGroup` patch
   as a permission rule (structural refusal, so `can()` reports `denied` with no
   permission consulted), document the mirror rule.
3. **Demo/UI** — invite/share split in `workspace.ts` and `MembershipPanel`,
   trimmed `SEED_PERMISSIONS`, `profile-pending` rendering, integration tests for
   self-service and admin-initiated paths.
4. **Docs** — `CONTEXT.md` Sharing section, authorizer moduledoc, client docs.
