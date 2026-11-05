# App scope

Ebb is one data store across many apps. App scope answers one question:
**which groups does this client app pull into its replica?** It is a property
of the group, not an authority over it.

A group declares the apps it belongs to in `group.apps`, a map from app id to
boolean. A client presents a local app id, keeps the groups in scope, and
subscribes to whichever of those it needs. Cross-app integration is a shared
group whose scope names both apps, with individual entities filed into it
through the existing `entityGroup` membership.

App scope is deliberately **not an authorization boundary**. The actor's group
grants remain the only boundary. A client that ignores its app scope, claims
another app id, or over-subscribes gets exactly what it got before: everything
the actor can reach. App scope is the default view, not a fence.

## Group metadata, not a grant

```ts
groupSystemEntity = buildEntityDef("group", {
  name: e.string(),
  apps: e.map(e.boolean()).nullable(),
});
```

- **In scope iff `apps[id] === true`.** `false` removes an app; keys are not
  deleted. A present-but-empty map scopes the group to nobody.
- **Absent scope means every app.** An existing group without the field, and a
  client without an `appId`, behave exactly as they did before. No data
  migration, no server flag.
- **The app id is a client-declared label.** `createClient({ appId })`; no
  request header, token, or auth exchange. Nothing is trusted because nothing
  is granted.

The server reads the raw merged field. The projection rule is: a key is in
scope only when its leaf value is `true`. Removal is written as `false`, never
as a tombstone (`null`), because the server reads the raw merged field while
the client projects nulls away — `false` is the one value both sides agree on.

## Wire and storage

`POST /sync/handshake` returns each group's `apps` as the sorted truthy keys,
or `null` for an unscoped group:

```json
{
  "id": "grp_notes",
  "apps": ["notes"],
  "permissions": ["note.*"],
  "cursor_valid": true,
  "cursor": 412
}
```

Group rows are otherwise materialized on first read, so the handshake cannot
read `data.fields.apps` per group from SQLite without a scan. A
`GroupAppsCache` alongside `GroupCache` fills `group_id → apps` on the boot
walk over `group` entities — which makes `group` one of the eager system
types, paying full materialization once at boot — and `CacheMutationPlanner`
merges incoming `apps` envelopes with the wire's `FieldMerge` rule so per-key
and same-Action semantics match the client.

Writes are `group.update` in the group. A new group's scope rides the
bootstrap-exempt `group` put (creation via `client.seed()` or
`group.create()` writes the creating app's scope automatically). Later edits
are **single-key patches** — `apps.notes = true`, `apps.docs = false` — so the
per-key merge makes concurrent edits by two admins safe. A whole-map write
from a stale replica is the only hazard, and the convention avoids it.

The Action log is unchanged: `actor_id` remains the user and no `app_id` is
recorded. A client-declared label is not trustworthy attribution; if trusted
attribution is ever wanted it needs a real app credential, which is a separate
decision.

## Worked example

Alice uses `notes` (https://notes.example.com) and `issues`
(https://issues.example.com).

| group      | `apps`                          | alice's `groupMember.permissions`     |
| ---------- | ------------------------------- | ------------------------------------- |
| `g_notes`  | `{ notes: true }`               | `note.*`, `group.*`, `groupMember.*`  |
| `g_issues` | `{ issues: true }`              | `issue.*`, `group.*`, `groupMember.*` |
| `g_bridge` | `{ notes: true, issues: true }` | `note.*`, `issue.*`                   |

1. **Isolation.** The notes app handshakes → `[g_notes]`; the issues app →
   `[g_issues]`. Each replica holds only its own group.
2. **Integration.** From the notes app, Alice creates `g_bridge` in one
   Action: the `group` put carries `apps: { notes: true, issues: true }`, and
   her `groupMember` row carries `note.*` and `issue.*` — the write contract
   for bidirectional editing. The group put needs no extra permission.
3. **Share.** Alice files note `N` into `g_bridge` (an `entityGroup` put).
   The share is gated by `note.create` in `g_bridge` and `note.update` where
   `N` already lives (`g_notes`).
4. **Pickup.** The issues app learns of `g_bridge` on its next handshake,
   subscribes, and the group listing seeds `N` plus its membership row.
5. **Bidirectional.** The issues app edits `N`: `note.update` in `g_bridge`
   (her membership covers it). The entity's group set is `{g_notes, g_bridge}`,
   so the write fans out to both and the notes app receives it through
   `g_notes`.
6. **Unshare.** Deleting the `entityGroup` row stops future updates. The
   issues replica keeps `N` until it re-subscribes and evicts. Revocation is
   forward-only.
7. **Not scoped.** If `g_bridge.apps` omitted `issues`, the issues app never
   sees the group. Nothing is denied; the group was simply never in that app's
   view.

## What does not change

- **Authorization.** `Authorizer`, `PermissionChecker`, the query SQL, and the
  Action format are untouched. `packages/client/src/sync/permission.ts` needs
  no new rule: a scope write is a `group` patch, already resolved as
  `group.update` in the group.
- **Presence and functions.** Presence scope is already the subscribed group
  set, which is now the app's subset. Functions run as the subject actor with
  its own grants; there is no app dimension.
- **Scope is group-global.** One member adding an app changes the group's
  default view for every member. Per-user consent would reintroduce the
  authorization model this design avoids.
- **Revocation is forward-only.** Bytes already synced stay on a device until
  its subscription changes and eviction runs.

Live scope changes — re-handshake and subscription reconcile pushed to a
connected client — come from the `groups_changed` control event. Until that
lands, a scope removal takes effect on the app's next handshake.
