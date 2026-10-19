# Issue Tracker Demo

A Vite + React 19 + Tailwind v4 app that renders a Linear-style issue tracker against a running ebb sync server. It is the v1 finish-line demo (epic [#348](https://github.com/ebbjs/ebbjs/issues/348)). Slice [#438](https://github.com/ebbjs/ebbjs/issues/438) stood up the shell; slice [#439](https://github.com/ebbjs/ebbjs/issues/439) adds the core write loop — create, edit, and delete issues with optimistic writes and a durable Outbox; slice [#441](https://github.com/ebbjs/ebbjs/issues/441) adds workspace membership and per-issue access — joining a shared workspace reveals its issues, `client.can(...)` gates affordances, and the issue→profile `assignee` link proves membership-scoped reach.

Entity declarations and every app read/write go through the documented public API (`@ebbjs/client` / `@ebbjs/react`). Seeding goes through the public `client.seed(SeedData)` path shared with `@ebbjs/server.seed()` ([#466](https://github.com/ebbjs/ebbjs/issues/466), [#452](https://github.com/ebbjs/ebbjs/issues/452)); no demo code hand-rolls a wire Action.

## Run it

From the repo root, one command starts both processes:

```bash
pnpm dev
```

Or run them separately if you want isolated logs:

```bash
# Terminal 1: server (auto-reload on lib/ save)
cd ebb_server && mix dev

# Terminal 2: app
pnpm --filter issue-tracker dev
```

Then open:

- <http://localhost:5173/?actor=alice>
- <http://localhost:5173/?actor=bob> in a second tab

Switching the actor in the header re-bootstraps the client under the new identity.

The collaborative-text demo still runs with `pnpm dev:collab`.

## How it works

1. `?actor=` selects the bypass-auth actor id (default `alice`).
2. On load, `client.seed()` submits two bootstrap Actions through the public write path:
   - the actor's **personal workspace** (`grp_<actorId>`), their own `groupMember`, a `workspace`, a `profile`, and one `entityGroup` per row — attributed to the actor, so the server's group-bootstrap exemption authorizes it;
   - the **shared workspace** (`grp_shared`) with a sample issue, attributed to the dedicated service actor `demo-seeder` (the invite/service-account pattern from [#126](https://github.com/ebbjs/ebbjs/issues/126)).
3. A typed `SyncClient` runs `handshake()` and opens an SSE subscription for the actor's groups.
4. The client persists to IndexedDB (one database per actor), so the Outbox survives a page reload: an unacknowledged write is rehydrated and flushed once the subscription reconnects.
5. The ready tree is wrapped in `<EbbProvider>`. `useConnection()` drives the badge; `useQuery` drives the workspace switcher, profile card, membership panel, issue list, and issue detail. Joining or leaving the shared workspace re-runs `handshake()` and replaces the subscription, so the group set stays current without a reload.

Every seed id is derived from the actor id (or a fixed literal for the shared fixtures), so reloading re-`put`s the same rows: the seed is idempotent and its permissions cover the re-`put` path (a committed group is authorized by `group.create` in that group, not by the bootstrap exemption).

## Issue CRUD

The list has a **new issue** control and selectable rows. Selecting a row opens the detail view.

- **Create** — `IssueCreateForm` calls `client.atomic` so the row and its optional `assignee` link commit in one Action. The Outbox applies it optimistically, so the issue appears in the list immediately. The assignee options come from the workspace's profiles (`.where("groups", groupId)`).
- **Edit** — `IssueDetail` reads the issue and its `assignee` from one `useQuery` with an `assignee` join. `client.issue.update` handles title / status / priority and `client.issue.link` / `unlink` the assignee; the query re-runs from the replica signal, so the projection follows the write without a manual revision bump.
- **Delete** — a two-step confirmation, then `delete`; the row drops out of the list and the detail view reports the tombstone as gone.

Every write goes through the documented public API — the typed namespace, `client.atomic`, and `link` / `unlink` — and the Outbox, so there are no hand-authored Actions and no bespoke optimistic layer.

## The pinned data model

Declared in `src/schema.ts` with `defineEntity` / `defineSchema`:

| Entity      | Fields / links                                        |
| ----------- | ----------------------------------------------------- |
| `workspace` | `name`, `slug`, `description`                         |
| `profile`   | `actor_id`, `display_name`, `avatar_url`              |
| `issue`     | `title`, `status`, `priority`, `assignee` → `profile` |

The issue's assignee is an entity link declared with `defineRelationship`, not a scalar `assignee_id`:

```ts
defineRelationship({ source: issue, target: profile, as: "assignee", sourceCardinality: "one" });
```

Reads join the edge with `q.issue.query().with({ assignee: true })`, filter through `.where("assignee", profileId)`, and write through `client.issue.link` / `unlink` (or atomically with the create). A `profile` is group-scoped, so a profile is only visible (and therefore only assignable) inside the workspaces its actor has joined. There is deliberately no scalar `assignee_id` ([#454](https://github.com/ebbjs/ebbjs/issues/454)).

Membership is ebb's built-in system, **not** a user-defined entity:

- a workspace **is** a Group; actors join through `GroupMember`;
- issues and profiles are scoped to the workspace group through the `entityGroup` write path;
- a row's group comes from the built-in `groups` join (`q.workspace.query().with({ groups: true })`), which is why **`workspace` has no `group_id` field**. The workspace switcher demonstrates this by reading each workspace's group ids from that join. Single-row `client.<entity>.get()` and the row accessors are internal; the app reads only through `query()` / `useQuery`.
- `group`, `groupMember`, and `entityGroup` are reserved system entities. Do not declare a `member` / `membership` entity.

`profile` is one row per actor, scoped to the workspaces they have joined, so it is visible only inside those workspaces. The profile card finds the row whose `actor_id` matches the signed-in actor.

## Workspace membership and per-issue access

A workspace **is** a Group; actors join it through a `groupMember` row, and an actor's group-scoped `profile` is made visible to the workspace by an `entityGroup` row. The two stores are independent, so the demo's `addToWorkspace` Action ([`src/workspace.ts`](src/workspace.ts)) writes both in one Action — a partially-joined actor is impossible.

The membership panel joins and leaves the shared workspace:

- **Joining is an invite.** Groups are closed by default ([#126](https://github.com/ebbjs/ebbjs/issues/126)): only an existing member can put another actor's `groupMember` row. The shared workspace's service actor `demo-seeder` runs `addToWorkspace` for the signed-in actor (the invite/service-account pattern).
- **Leaving is self-service.** The invite grants the new member the permissions to drop its own `groupMember` and `entityGroup` rows again.
- Either way the actor's client re-handshakes and re-subscribes, so the new workspace's issues appear (and its former issues stop being delivered) without a reload.

Only the groups the actor is a member of are subscribed, so a non-member's client never materializes the shared workspace, its issues, or its members. The membership panel's leave control is gated on `client.can(...)`, which asks the same `<type>.<verb>` question the server enforces; the detail view's assignee picker instead offers only the profiles the membership makes visible.

The issue's assignee is the `issue → profile` link declared in `schema.ts`. A profile is reachable only through the membership that scopes it, so the picker offers exactly the workspace members' profiles. Note that this is a UI affordance, not a server invariant: a relationship write is authorized against the _source_'s (issue's) groups, not the target's, so a raw wire client could link an arbitrary profile id. The demo constrains assignment by what it can show.

### Profile content follows membership

The shared group receives the member's profile `entityGroup` row, and the client's membership backfill ([#475](https://github.com/ebbjs/ebbjs/issues/475)) reads the profile content — which was written in the member's personal group — into the shared group's subscribers. A fellow member can therefore read the joined actor's `display_name` / `avatar_url`, and a non-member still cannot. `client.sync.backfill` reports ids whose content is still being read, so a UI can render a pending row rather than an empty one.

## Files

```
src/
├── main.tsx             # React entry
├── App.tsx              # Top-level layout + actor lifecycle
├── schema.ts            # Pinned data model + issue→profile assignee link
├── seed.ts              # Deterministic bootstrap seed (SeedData builders)
├── workspace.ts         # addToWorkspace Action + invite/leave helpers
├── bootstrap.ts         # createClient + durable storage + seed + handshake + subscribe + refresh
├── issue-options.ts     # Status / priority / assignee option lists
├── SelectField.tsx      # Shared labelled <select>
├── ActorPicker.tsx      # Actor identity selector
├── ConnectionBadge.tsx  # useConnection() indicator
├── WorkspaceSwitcher.tsx# useQuery list + groups join
├── ProfileCard.tsx      # Group-scoped profile row
├── MembershipPanel.tsx  # Join / leave the shared workspace
├── IssueList.tsx        # Selectable list + new-issue control
├── IssueCreateForm.tsx  # Atomic create with optional assignee
├── IssueDetail.tsx      # Edit, link / unlink assignee, delete
└── index.css            # Tailwind v4 + dark theme
```
