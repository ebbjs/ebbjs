# App scope

Ebb is one data store across many apps. App scope answers one question:
**which groups does this client app pull into its replica?** It is a property
of the group, not an authority over it.

A group declares the apps it belongs to in `ebb/group`'s `apps` list — the app
ids it is in scope for. A client presents a local app id, keeps the groups in
scope, and subscribes to whichever of those it needs. Cross-app integration is
a shared group whose scope names both apps, with individual entities filed into
it through the existing `ebb/membership` row.

App scope is deliberately **not an authorization boundary**. The actor's group
grants remain the only boundary. A client that ignores its app scope, claims
another app id, or over-subscribes gets exactly what it got before: everything
the actor can reach. App scope is the default view, not a fence.

## Group metadata, not a grant

```ts
ebbSystemEntity.components.group = defineComponent(
  "ebb/group",
  e.object({
    name: e.string(),
    apps: Type.Optional(e.array(e.string())),
  }),
  { optional: true, permission: "own" },
);
```

- **In scope iff `apps` contains the app id.** Removing an app drops its id.
  A present-but-empty list scopes the group to nobody.
- **Absent scope means every app.** An existing group without the field, and a
  client without an `appId`, behave exactly as they did before. No data
  migration, no server flag.
- **The app id is a client-declared label.** `createClient({ appId })`; no
  request header, token, or auth exchange. Nothing is trusted because nothing
  is granted.

The list is not a map because `ebb/group` is an **atomic** component (#805): an
atomic value may not contain a map, since a nested map would lose its per-key
merge. The server reads the value whole, so "in scope" is membership in the
list.

## Wire and storage

`POST /sync/handshake` returns each group's `apps` as the sorted list of app
ids, or `null` for an unscoped group:

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
read `data.fields.group.value.apps` per group from SQLite without a scan. A
`GroupAppsCache` alongside `GroupCache` fills `group_id → apps` on the boot
walk over the `ebb/group` component entries — which makes a group row one of
the eagerly materialized system rows, paying full materialization once at boot.

Writes are `ebb/group.update` in the group. A new group's scope rides the
bootstrap-exempt `ebb/group` put (creation via `client.seed()` or
`group.create()` writes the creating app's scope automatically). A later edit
writes the **whole** `ebb/group` value, because it is one atomic component:

```ts
group.update(id, { name: group.name, apps: [...group.apps, "docs"] });
```

That is the cost of the atomic form: two admins editing scope concurrently
converge on one whole value rather than merging per app id, so a write made
from a stale replica can drop an app it never saw. Read the group, edit the
list, write it back.

The Action log is unchanged: `actor_id` remains the user and no `app_id` is
recorded. A client-declared label is not trustworthy attribution; if trusted
attribution is ever wanted it needs a real app credential, which is a separate
decision.

## Worked example

Alice uses `notes` (https://notes.example.com) and `issues`
(https://issues.example.com).

| group      | `apps`               | alice's `ebb/grant` permissions         |
| ---------- | -------------------- | --------------------------------------- |
| `g_notes`  | `["notes"]`          | `note.*`, `ebb/group.*`, `ebb/grant.*`  |
| `g_issues` | `["issues"]`         | `issue.*`, `ebb/group.*`, `ebb/grant.*` |
| `g_bridge` | `["notes","issues"]` | `note.*`, `issue.*`                     |

1. **Isolation.** The notes app handshakes → `[g_notes]`; the issues app →
   `[g_issues]`. Each replica holds only its own group.
2. **Integration.** From the notes app, Alice creates `g_bridge` in one
   Action: the `ebb/group` put carries `apps: ["notes", "issues"]`, and her
   `ebb/grant` row carries `note.*` and `issue.*` — the write contract for
   bidirectional editing. The group put needs no extra permission.
3. **Share.** Alice files note `N` into `g_bridge` (an `ebb/membership` put).
   The share is gated by `note.create` in `g_bridge` and `note.update` where
   `N` already lives (`g_notes`).
4. **Pickup.** The issues app learns of `g_bridge` on its next handshake,
   subscribes, and the group listing seeds `N` plus its membership row.
5. **Bidirectional.** The issues app edits `N`: `note.update` in `g_bridge`
   (her membership covers it). The entity's group set is `{g_notes, g_bridge}`,
   so the write fans out to both and the notes app receives it through
   `g_notes`.
6. **Unshare.** Deleting the `ebb/membership` row stops future updates. The
   issues replica keeps `N` until it re-subscribes and evicts. Revocation is
   forward-only.
7. **Not scoped.** If `g_bridge.apps` omitted `issues`, the issues app never
   sees the group. Nothing is denied; the group was simply never in that app's
   view.

## What does not change

- **Authorization.** `Authorizer`, `PermissionChecker` and the query SQL keep
  their rules. `packages/client/src/sync/permission.ts` needs no new rule: a
  scope write is an `ebb/group` write, resolved as `ebb/group.update` in the
  group because the component declares `permission: "own"`.
- **Presence and functions.** Presence scope is already the subscribed group
  set, which is now the app's subset. Functions run as the subject actor with
  its own grants; there is no app dimension.
- **Scope is group-global.** One member adding an app changes the group's
  default view for every member. Per-user consent would reintroduce the
  authorization model this design avoids.
- **Revocation is forward-only.** Bytes already synced stay on a device until
  its subscription changes and eviction runs.

A live membership change now reaches a connected client: an `ebb/grant`
put, patch, or delete pushes a `groups_changed` control event, and the
client re-handshakes and reconciles its subscription. A group the actor
gained joins the subscription and is seeded from its listing; a group the
actor lost leaves it and its rows are evicted. Only the membership
difference is applied, so a group whose membership did not change keeps
the subscription the app chose.

An `ebb/group` edit on its own is not a trigger: it wakes nobody. The scope
is re-read on the next handshake, which a membership change or a reconnect
now causes, and that handshake applies both directions — a group leaving
the app's scope is dropped and evicted, and a group the actor already
belonged to that enters scope joins the subscription and is seeded. Making
a scope edit wake the group's members is the remaining step.
