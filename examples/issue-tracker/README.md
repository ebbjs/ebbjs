# Issue Tracker Demo

A Vite + React 19 + Tailwind v4 app that renders a Linear-style issue tracker against a running ebb sync server. It is the v1 finish-line demo (epic [#348](https://github.com/ebbjs/ebbjs/issues/348)). Slice [#438](https://github.com/ebbjs/ebbjs/issues/438) stood up the shell; slice [#439](https://github.com/ebbjs/ebbjs/issues/439) adds the core write loop — create, edit, and delete issues with optimistic writes and a durable Outbox; slice [#440](https://github.com/ebbjs/ebbjs/issues/440) adds the read surface — one filtered `useQuery` behind both the issue list and the status board, live updates from another actor, and a concurrent-field-edit check; slice [#441](https://github.com/ebbjs/ebbjs/issues/441) adds workspace membership and per-issue access — joining a shared workspace reveals its issues, `client.can(...)` gates affordances, and the issue→profile `assignee` link proves membership-scoped reach.

Entity declarations and every app read/write go through the documented public API (`@ebbjs/client` / `@ebbjs/react`). Every write is an Action: declared once at module scope in [`src/actions.ts`](src/actions.ts), mounted on each client the app builds, and called from a component as `client.actions.<name>(params)`; `client.<entity>` is read-only. Seeding goes through the public `client.seed(SeedData)` path shared with `@ebbjs/server.seed()` ([#466](https://github.com/ebbjs/ebbjs/issues/466), [#452](https://github.com/ebbjs/ebbjs/issues/452)); no demo code hand-rolls a wire Action.

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

- **Create** — `IssueCreateForm` calls the `createIssue` Action, so the row and its optional `assignee` link commit in one Action; the Action returns the created handle so the form can select the new row. The Outbox applies it optimistically, so the issue appears in the list immediately. The assignee options come from the profiles filed into the group the issue is created in (`.where("groups", groupId)`).
- **Edit** — `IssueDetail` reads the issue, its `assignee`, and its workspace group from one `useQuery` with `assignee` and `groups` joins. `updateIssue` patches title / status / priority and `setIssueAssignee` links or clears the assignee; the query re-runs from the replica signal, so the projection follows the write without a manual revision bump. The assignee picker offers the profiles of the _issue's own_ group, so a shared-workspace issue lists its fellow members, not just the actor's personal workspace.
- **Delete** — a two-step confirmation, then the `deleteIssue` Action; the row drops out of the list and the detail view reports the tombstone as gone.

Every write is one of the demo's declared Actions, and each goes through the Outbox: the Action applies optimistically and reconciles when the server acknowledges it, and a server refusal throws `ActionRejectedError`. There is no bespoke optimistic layer.

## Issue list, board, and live reads

The list and the board are two renderings of **one** `useQuery`. `IssuesPanel` owns the filter selection, the page window, and the list/board toggle; `useIssues` builds the chain and `buildIssueQuery` is the same chain the integration tests exercise.

- **Filters are predicates, not post-processing.** `status` and `priority` become field equality, and `assignee` filters through the `assignee` relationship (`.where("assignee", profileId)`). Changing a filter changes the query, so the replica returns only the matching rows.
- **The board groups the same rows by status.** `groupIssuesByStatus` keeps the picker's column order, renders empty columns, and gives an unexpected status a trailing column instead of dropping the row.
- **Live reads.** The chain is reactive: a live edit from another actor arrives through the subscription and re-runs the query store, so a card moves between board columns without a reload. The panel prints the query status (`live` / `syncing…`) from the cache rather than keeping a second loading flag.
- **Pagination is a growing window.** The grammar has no cursor yet, so "show more" grows `limit` (`.orderBy("title", "asc")` plus the engine's id tiebreaker). The earlier rows stay a prefix, which is what keeps rows from duplicating or disappearing at the page boundary; the integration test pins that across a live reorder.
- **Concurrent field edits.** `issue-crud.integration.test.ts` gates one actor's `fetchImpl` to simulate an offline edit: the write is applied optimistically and held in the Outbox, the other actor changes a different field, and reconnecting flushes the backlog. Both replicas converge on one row with both changes intact.

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

Reads join the edge with `q.issue.query().with({ assignee: true })`, filter through `.where("assignee", profileId)`, and write through the `setIssueAssignee` Action (or in the same Action as the create via `createIssue`). A `profile` is group-scoped, so a profile is only visible (and therefore only assignable) inside the workspaces its actor has joined. There is deliberately no scalar `assignee_id` ([#454](https://github.com/ebbjs/ebbjs/issues/454)).

Membership is ebb's built-in system, **not** a user-defined entity:

- a workspace **is** a Group; actors join through `GroupMember`;
- issues and profiles are scoped to the workspace group through the `entityGroup` write path;
- a row's group comes from the built-in `groups` join (`q.workspace.query().with({ groups: true })`), which is why **`workspace` has no `group_id` field**. The workspace switcher demonstrates this by reading each workspace's group ids from that join. Single-row `client.<entity>.get()` and the row accessors are internal; the app reads only through `query()` / `useQuery`.
- `group`, `groupMember`, and `entityGroup` are reserved system entities. Do not declare a `member` / `membership` entity.

`profile` is one row per actor, scoped to the workspaces they have joined, so it is visible only inside those workspaces. The profile card finds the row whose `actor_id` matches the signed-in actor.

## Workspace membership and per-issue access

A workspace **is** a Group; actors join it through a `groupMember` row, and an actor's group-scoped `profile` is made visible to the workspace by an `entityGroup` row. The two stores are independent, and they belong to different actors' authority: the workspace member invites (`inviteMember`), then the invitee's own client shares its profile (`shareProfile`). Between the two Actions the member exists and the profile does not — the `profile-pending` window. [`src/workspace.ts`](src/workspace.ts) sequences those reads and Actions; the Actions themselves are declared in [`src/actions.ts`](src/actions.ts).

The membership panel joins and leaves the shared workspace:

- **Joining is an invite.** Groups are closed by default ([#126](https://github.com/ebbjs/ebbjs/issues/126)): only an existing member can put another actor's `groupMember` row. The shared workspace's service actor `demo-seeder` runs `inviteMember` for the signed-in actor (the invite/service-account pattern), and the invitee then runs `shareProfile`.
- **Leaving is self-service, in one Action.** The invite grants the new member the permissions to drop its own rows again, and `leaveWorkspace` drafts the profile's membership removal and the `groupMember` delete together.
- Either way the actor's client re-handshakes and re-subscribes, so the new workspace's issues appear (and its former issues stop being delivered) without a reload.

Only the groups the actor is a member of are subscribed, so a non-member's client never materializes the shared workspace, its issues, or its members. The membership panel's leave control is gated on `client.can(...)`, which asks the same `<type>.<verb>` question the server enforces; the detail view's assignee picker instead offers only the profiles of the issue's own workspace group.

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
├── actions.ts           # Every declared Action (issues, invite/share/leave)
├── workspace.ts         # Invite / share / leave helpers over those Actions
├── bootstrap.ts         # createClient + durable storage + seed + handshake + subscribe + refresh
├── sync-groups.ts       # handshake / catch-up helpers shared with the tests
├── issue-options.ts     # Status / priority / assignee option lists
├── use-workspace-profiles.ts # useQuery: a workspace group's assignable profiles
├── use-write.ts         # pending / error state for one component's writes
├── SelectField.tsx      # Shared labelled <select>
├── ActorPicker.tsx      # Actor identity selector
├── ConnectionBadge.tsx  # useConnection() indicator
├── WorkspaceSwitcher.tsx# useQuery list + groups join
├── ProfileCard.tsx      # Group-scoped profile row
├── MembershipPanel.tsx  # Join / leave the shared workspace
├── IssueList.tsx        # List projection of the issue query
├── IssueBoard.tsx       # Status columns over the same rows
├── IssuesPanel.tsx      # Filters, list/board toggle, one paged useQuery
├── IssueFiltersBar.tsx  # Status / priority / assignee predicates
├── issue-view.ts        # Pure filters, grouping, and pagination model
├── use-issues.ts        # The shared issue query chain
├── use-visible-profiles.ts # Assignee filter options
├── IssueCreateForm.tsx  # createIssue Action with optional assignee
├── IssueDetail.tsx      # Edit, link / unlink assignee, delete
└── index.css            # Tailwind v4 + dark theme
```
