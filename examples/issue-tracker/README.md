# Issue Tracker Demo

A Vite + React 19 + Tailwind v4 app that renders a Linear-style issue tracker against a running ebb sync server. It is the v1 finish-line demo (epic [#348](https://github.com/ebbjs/ebbjs/issues/348)). Slice [#438](https://github.com/ebbjs/ebbjs/issues/438) stood up the shell; slice [#439](https://github.com/ebbjs/ebbjs/issues/439) adds the core write loop — create, edit, and delete issues with optimistic writes and a durable Outbox.

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
5. The ready tree is wrapped in `<EbbProvider>`. `useConnection()` drives the badge; `useQuery` drives the workspace switcher, profile card, and issue list; `useEntity` + `useEntityMutations` drive the issue detail.

Every seed id is derived from the actor id (or a fixed literal for the shared fixtures), so reloading re-`put`s the same rows: the seed is idempotent and its permissions cover the re-`put` path (a committed group is authorized by `group.create` in that group, not by the bootstrap exemption).

## Issue CRUD

The list has a **new issue** control and selectable rows. Selecting a row opens the detail view.

- **Create** — `IssueCreateForm` calls `client.atomic` so the row and its optional `assignee` link commit in one Action. The Outbox applies it optimistically, so the issue appears in the list immediately.
- **Edit** — `IssueDetail` uses `useEntityMutations(client.issue)` for `update` (title, status, priority) and `client.issue.link` / `unlink` for the assignee. `useEntity` re-reads the row so the assignee resolves through the `issue.assignee` accessor.
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

Reads go through the `issue.assignee` accessor, filters through `.where("assignee", profileId)`, and writes through `client.issue.link` / `unlink` (or atomically with the create). Why the scalar reference field was shelved is on [#454](https://github.com/ebbjs/ebbjs/issues/454).

Membership is ebb's built-in system, **not** a user-defined entity:

- a workspace **is** a Group; actors join through `GroupMember`;
- issues and profiles are scoped to the workspace group through the `entityGroup` write path;
- a row's group is read from the built-in `groups` accessor (`await row.groups`), which is why **`workspace` has no `group_id` field**. The workspace switcher demonstrates this by resolving the selected row's group with `client.workspace.get(id)` then `row.groups.toRaw()`;
- `group`, `groupMember`, and `entityGroup` are reserved system entities. Do not declare a `member` / `membership` entity.

`profile` is one row per actor, scoped to the workspaces they have joined, so it is visible only inside those workspaces. The profile card finds the row whose `actor_id` matches the signed-in actor.

## Shared-workspace membership is deferred

The seed creates the shared workspace but deliberately does **not** add the signed-in actor to `grp_shared`. Joining and leaving a workspace — putting the actor's `groupMember` row and linking their profile to the group in one atomic Action — is [#441](https://github.com/ebbjs/ebbjs/issues/441). Until then the issue list for the default workspace shows only the issues the actor creates there, which is what this slice's demo walk proves. The write path itself converges across actors in one shared group, covered by `issue-crud.integration.test.ts` (which seeds a shared group for its two actors); the demo's own UI-level two-actor walk lands with #441.

## Files

```
src/
├── main.tsx             # React entry
├── App.tsx              # Top-level layout + actor lifecycle
├── schema.ts            # Pinned data model + assignee relationship
├── seed.ts              # Deterministic bootstrap seed (SeedData builders)
├── bootstrap.ts         # createClient + durable storage + seed + handshake + subscribe
├── issue-options.ts     # Status / priority vocabulary
├── ActorPicker.tsx      # Actor identity selector
├── ConnectionBadge.tsx  # useConnection() indicator
├── WorkspaceSwitcher.tsx# useQuery list + row.groups group id
├── ProfileCard.tsx      # Group-scoped profile row
├── IssueList.tsx        # Selectable list + new-issue control
├── IssueCreateForm.tsx  # Atomic create with optional assignee
├── IssueDetail.tsx      # Edit, link / unlink assignee, delete
└── index.css            # Tailwind v4 + dark theme
```
