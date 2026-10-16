# Issue Tracker Demo

A Vite + React 19 + Tailwind v4 app that renders a Linear-style issue tracker against a running ebb sync server. It is the v1 finish-line demo (epic [#348](https://github.com/ebbjs/ebbjs/issues/348)) and this slice ([#438](https://github.com/ebbjs/ebbjs/issues/438)) stands up the shell: the typed data model, a deterministic seed, and a signed-in actor seeing their (empty) issue list.

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
4. The ready tree is wrapped in `<EbbProvider>`. `useConnection()` drives the badge; `useQuery` drives the workspace switcher, profile card, and issue list.

Every seed id is derived from the actor id (or a fixed literal for the shared fixtures), so reloading re-`put`s the same rows: the seed is idempotent and its permissions cover the re-`put` path (a committed group is authorized by `group.create` in that group, not by the bootstrap exemption).

## The pinned data model

Declared in `src/schema.ts` with `defineEntity` / `defineSchema`:

| Entity      | Fields                                                  |
| ----------- | ------------------------------------------------------- |
| `workspace` | `name`, `slug`, `description`                           |
| `profile`   | `actor_id`, `display_name`, `avatar_url`                |
| `issue`     | `title`, `status`, `priority`, `assignee_id` (nullable) |

Membership is ebb's built-in system, **not** a user-defined entity:

- a workspace **is** a Group; actors join through `GroupMember`;
- issues and profiles are scoped to the workspace group through the `entityGroup` write path;
- a row's group is read from the built-in `groups` accessor (`await row.groups`), which is why **`workspace` has no `group_id` field**. The workspace switcher demonstrates this by resolving the selected row's group with `client.workspace.get(id)` then `row.groups.toRaw()`;
- `group`, `groupMember`, and `entityGroup` are reserved system entities. Do not declare a `member` / `membership` entity.

`profile` is one row per actor, scoped to the workspaces they have joined, so it is visible only inside those workspaces. The profile card finds the row whose `actor_id` matches the signed-in actor.

## Shared-workspace membership is deferred

The seed creates the shared workspace but deliberately does **not** add the signed-in actor to `grp_shared`. Joining and leaving a workspace — putting the actor's `groupMember` row and linking their profile to the group in one atomic Action — is [#441](https://github.com/ebbjs/ebbjs/issues/441). Until then the issue list for the default workspace is empty (the sample issue lives in the shared workspace), which is exactly what this slice proves.

## Files

```
src/
├── main.tsx             # React entry
├── App.tsx              # Top-level layout + actor lifecycle
├── schema.ts            # Pinned data model
├── seed.ts              # Deterministic bootstrap seed (SeedData builders)
├── bootstrap.ts         # createClient + seed + handshake + subscribe
├── ActorPicker.tsx      # Actor identity selector
├── ConnectionBadge.tsx  # useConnection() indicator
├── WorkspaceSwitcher.tsx# useQuery list + row.groups group id
├── ProfileCard.tsx      # Group-scoped profile row
├── IssueList.tsx        # Empty for the default workspace
└── index.css            # Tailwind v4 + dark theme
```
