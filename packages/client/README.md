# @ebbjs/client

Local-first sync client for the ebbjs stack. Performs handshake, catch-up,
and live SSE streaming against an `ebb_server`, with an outbox for offline
writes and a query layer over materialized entities.

## Install

```bash
npm install @ebbjs/client
```

Node `>=22.8.0`. The package ships one entry point:

```typescript
import { createClient } from "@ebbjs/client";
```

## Status

Working in development. The README will fill out as the SDK stabilizes.
Today: handshake, catch-up, live SSE, outbox, presence, and the local query
engine (typed `query()` reads with one-level `with` joins and cached reactive
results). The React bindings live in `@ebbjs/react`; server functions are
still being designed.

## Resolving the actor

`createClient` still takes the actor id up front. Ask the server which actor
it authenticated, then build the client:

```typescript
import { createClient, resolveIdentity } from "@ebbjs/client";

const identity = await resolveIdentity({ serverUrl });
const client = createClient({ serverUrl, actorId: identity.actorId });
```

The server is authoritative, so no `x-ebb-actor-id` is sent. That matters for
tailscale deployments: the browser cannot know its tailnet login in advance,
but the server derives it per request. `identity.provider` (`"bypass"`,
`"external"`, `"tailscale"`) says which mode answered; `displayName` and
`providerId` carry what that mode knows. Keep the actor picker for `bypass`;
use the resolved id as-is otherwise.

Resolution is the one online step. A first run on a new device must reach the
server to learn its actor — after that, cache `identity.actorId` under the
app's storage key and start offline with it.

A Tailscale login change is a new actor: a client still holding the old id
writes with it and gets `actor_mismatch` from the server. Re-resolve, build a
new client for the new `actorId`, and use that actor's storage — retrying with
the stale id cannot succeed. `resolveIdentity` throws
`IdentityResolutionError` with a `kind` (`network`, `unauthorized`,
`invalid-response`, `http`) that says which of these happened.

## Reads and writes

`client.<entity>` is the schema-bound read API; a schema-bound client also
carries the `client.group` / `client.membership` system namespaces, read-only
like the rest. Reads go through `query()`; every write is an Action mounted as
`client.actions.<name>`. The engine's single-row read (`get(id)`), its async row
accessors, and the collection `subscribe(filter, cb)` are internal — they are
not public read paths.

### Reads — `client.<entity>.query()`

`query()` returns a typed, immutable chain. Each mutator returns a new chain;
awaiting it resolves to the projected rows (the schema's fields plus the
entity `id`; a replica-backed query row also carries its live `groupIds`).

`groupIds` is read from the replica's membership index — one lookup per row,
no `entityGroup` scan. Use it when a row only needs the ids it belongs to;
`.with({ groups: true })` projects the group rows themselves, which matters
because a group id can name a row that is not materialized. Joined target
rows are plain projections (fields plus `id`), and a chain over
already-materialized candidates (`buildQueryBuilder` / row accessors) has no
membership index, so neither carries `groupIds`.

```typescript
const issues = await client.issue
  .query()
  .where("status", "open")
  .or("priority", "urgent")
  .orderBy("updated_at", "desc")
  .limit(50)
  .with({ assignee: true });
```

Grammar:

- `where(key, value)` — equality conjunct. A key may be a shape field, a
  registered relationship `as` (filters that edge), or the reserved `groups`
  key (filters built-in membership).
- `or(key, value)` — starts a new AND-group. Predicates are a disjunction of
  AND-groups, so `.where(a).where(b).or(c).where(d)` means
  `(a AND b) OR (c AND d)`.
- `where(key, null)` — matches rows with no live value for the field (absent
  or cleared). A schema default never widens the filter; `.where("status",
"open").or("status", null)` is the explicit "open or unset".
- `orderBy(field, "asc" | "desc")` and `limit(n)`.
- `with({ key: true, ... })` — one-level joins over the schema's relationships
  plus `groups`. Each selected key is merged onto the row; a nested selector
  is rejected.

Terminals: `await` / `.then()` for rows, `.first()`, `.count()`, `.exists()`,
the async iterator, and `.toRaw()` for the untyped wire entities.

A chain's result is cached and reactive: `.result()` returns the engine store
(`getSnapshot()` reads `{ data, status, loading, error }`; `subscribe(listener)`
fires on change) and the chain's own `.subscribe(listener)` is the shorthand.
`status` is one of:

| Status     | Meaning                                                           |
| ---------- | ----------------------------------------------------------------- |
| `unloaded` | Never run; `data` is `undefined` (never an empty list).           |
| `stale`    | A usable result exists at an older revision; a re-run is pending. |
| `current`  | The result was produced at the replica's current revision.        |
| `failed`   | The last run threw; sticky until a successful run.                |

Two chains that lower to the same query share one cached result, so a remount
reads it back instead of re-running. In React, `useQuery` wraps this surface.

Name the row a query returns with `QueryRowOf`, passing the schema and the
`with(...)` join keys you selected. It derives the same projection the query
returns, so a view type cannot drift from the schema:

```typescript
type IssueRow = QueryRowOf<typeof schema, "issue", "assignee">;
const issues: readonly IssueRow[] = await client.issue.query().with({ assignee: true });
```

### Materialization

An entity type is `held` (the replica materializes every row) or `on-demand`
(a row materializes only while it is open). Declare it on the definition:

```typescript
const pageContent = defineEntity(
  "page_content",
  { content: e.map(e.string()) },
  { materialization: "on-demand" },
);
```

A document entity generated by `e.collaborativeText()` is on-demand by
default, so the heavy body stays out of the replica while the page, its
relationships, and its memberships stay held. Open a body with `row.body` (or
`client.replica.open(id)`); it is pinned in an LRU window (`pinnedCapacity`,
default 16). `client.replica.close(id)` closes the pin; the row stays cached
for `pinnedTtlMs` (default 30 s) so a remount reads it back, then leaves. A
non-positive TTL releases it immediately on close, and an open row is never
released by the TTL. The persisted replica record holds held rows only — a
body is never part of it.

A query whose **source** type is on-demand is refused with
`OnDemandQueryError`, because a scan is held-only. A held source may join an
on-demand target: `with({ content: true })` opens the joined rows
asynchronously, and a cached result reads `stale` while the load is in flight
and `current` once it settles.

### Writes — actions

`defineAction(schema, callback)` is the only way to write. A definition pairs
the schema with a callback over that schema's draft namespaces; a client
created with `actions` mounts it as `client.actions.<name>(params)`.

```typescript
import {
  createClient,
  defineAction,
  defineEntity,
  defineSchema,
  e,
  type EntityValues,
} from "@ebbjs/client";

const issue = defineEntity("issue", { title: e.string(), status: e.string() });
const schema = defineSchema({ entities: { issue }, version: 1 });

// Module scope. A definition is pure — no ids, no writes, no I/O — so it
// builds at module load and mounts once when the client is created.
const createIssue = defineAction(schema, ({ issue }, params: { title: string; groupId: string }) =>
  issue.create({ title: params.title, status: "todo" }, { groups: [params.groupId] }),
);

const client = createClient({ serverUrl, actorId, schema, actions: { createIssue } });

// One call, one Action. The returned handle carries the minted id.
const { id } = await client.actions.createIssue({ title: "Buy milk", groupId });
```

A definition cannot be inlined in a component: the client is built against the
definitions it mounts, so declare them at module scope. An update is the same
shape — an action is a plain function of its params:

```typescript
// `EntityValues<typeof issue>` is the value shape of the entity's wire
// fields, so a patch type follows the schema instead of restating it.
const updateIssue = defineAction(
  schema,
  ({ issue: issues }, params: { id: string; patch: Partial<EntityValues<typeof issue>> }) =>
    issues.update(params.id, params.patch),
);
```

**One Action per call.** Every draft verb a callback calls — across any number
of entities and groups — commits as a single Action when the callback returns,
in call order, with field validation running during that commit. A rejection
throws `ActionRejectedError` (carrying the rejections); there is no
`rejected` result to inspect.

Every verb is synchronous inside the callback. `create` and `duplicate` return
a handle with `.id`, so a later verb in the same callback can point at a row the
batch has not materialized yet:

```typescript
const commentOnIssue = defineAction(
  schema,
  ({ issue, comment }, params: { issueId: string; body: string; groupId: string }) => {
    const created = comment.create(
      { body: params.body, issue: params.issueId },
      { groups: [params.groupId] },
    );
    issue.update(params.issueId, { status: "in_progress" });
    return created;
  },
);

const { id: commentId } = await client.actions.commentOnIssue({ issueId, body, groupId });
```

That is also how a relationship is set in the same Action: the draft `create`
takes the pointer (`issue: params.issueId` above, or a handle from an earlier
`create` in the same callback), and the planner resolves it during the commit.

Draft verbs, per entity:

- `create(input, { groups })` — `groups` is required and non-empty; the
  membership rows ship in the same Action as the entity. Returns the handle.
- `update(id, patch)` and `delete(id)`.
- `duplicate(id, { at?, groups? })` — copies the live row (`at: "current"`, the
  default) or the entity's earliest unresolved conflict's `before` row
  (`at: "preSync"`), landing in the source's live groups unless `groups` says
  otherwise. Returns the new handle.
- `link(id, as, target)` / `unlink(id, as)` for a one-cardinality relationship;
  `setLinks(id, as, { replace })` or `setLinks(id, as, { add, remove })` for a
  many-cardinality one.
- `addToGroup(id, groupId)`, `removeFromGroup(id, groupId)`, and
  `setGroups(id, groupIds)` for membership. A membership row's id is derived
  from the `(entity, group)` pair, so a share is idempotent across devices and
  an unshare removes the row every device is looking at.

The system entities get their own draft namespaces. `group.create` bootstraps a
group — the group row plus the acting actor's membership, one Action.
`membership.create` adds one `groupMember` row, and `membership.update` /
`membership.delete` patch or remove one behind the local `last_group_member`
guard, so leaving a workspace is one Action. Both namespaces also carry the
plain entity verbs — `update`, `delete`, `duplicate`, `link`, `unlink`,
`setLinks` — and omit only the membership verbs, since an `entityGroup` row for
a group or a member has no meaning:

```typescript
const inviteMember = defineAction(
  schema,
  ({ membership }, params: { actorId: string; groupId: string; permissions: string[] }) => {
    membership.create({
      group_id: params.groupId,
      actor_id: params.actorId,
      permissions: params.permissions,
    });
  },
);

const client = createClient({ serverUrl, actorId, schema, actions: { inviteMember } });
await client.actions.inviteMember({ actorId: personId, groupId, permissions: [] });
```

**Sharing an entity is a write to it.** Filing an entity the server already
places in a group needs `<type>.update` in one of the entity's current groups as
well as `<type>.create` in the target, so an invitation cannot file the invitee's
profile: the inviter has no permission where that profile lives. The invitee's own
client shares it, after observing the membership, through its own action:

```typescript
const shareProfile = defineAction(
  schema,
  ({ profile }, params: { profileId: string; groupId: string }) =>
    profile.addToGroup(params.profileId, params.groupId),
);

// run by a member of the group, through that member's client
await memberClient.actions.inviteMember({ actorId: personId, groupId, permissions });
await inviteeClient.handshake();
// run by the invitee's client; `profileIdFor(personId)` belongs to its actor
await inviteeClient.actions.shareProfile({ profileId: profileIdFor(personId), groupId });
```

One Action carries one actor's authority, so the two cannot be batched. Between
them the member exists and the profile does not — the `profile-pending` window.

`client.write(actions)` and `client.seed(data)` stay as the schema-less
transport and fixture path — pre-built wire Actions, not the application write
surface.

### Not yet

The grammar has no `id` predicate: query the collection and select the row.
`limit(n)` is the only windowing — cursor pagination is deferred.

## Seeding fixtures

`client.seed(data)` submits a `SeedData` fixture as one Action through the same
commit path an action takes, applying the shared rejection-tolerance policy. It
is schema-less: rows carry their own ids and plain field values, so a client
created without a `schema` can still seed fixture data.

```typescript
import { createClient } from "@ebbjs/client";

const client = createClient({ serverUrl, actorId: "demo-seeder" });
await client.seed({
  groups: [{ id: "grp_demo", name: "Demo Group" }],
  groupMembers: [
    {
      id: "gm_demo",
      actorId: "demo-seeder",
      groupId: "grp_demo",
      permissions: ["text_document.*", "group.*"],
    },
  ],
  entities: [],
});
client.close();
```

`@ebbjs/core/seed` is the browser-safe module behind it. It exports
`SeedData` (and the row types), `buildSeedAction`, which stamps plain values
into wire envelopes, and the rejection-tolerance policy (`assertSeedAccepted`
/ `SeedRejectedError`). `@ebbjs/testing.seed` re-exports the same builder and
adds the raw-POST `seed(serverUrl, actorId, data)` harness, so browser demos
and the server test harness share one builder and one tolerance policy,
defined in one place.

## Development

Three scripts:

- `pnpm --filter @ebbjs/client test` — unit tests only. Fast, no server
  needed. 1119 tests across `src/sync/`, `src/fields/`, `src/presence/`,
  and the storage layer. Runs in CI on every PR.
- `pnpm --filter @ebbjs/client test:watch` — same as `test`, in watch mode.
- `pnpm --filter @ebbjs/client test:integration` — round-trip integration
  tests under `src/__tests__/integration/` against a live `ebb_server`.
  Not run by default.

### Running integration tests locally

1. Build the release once:

   ```bash
   bash packages/testing/scripts/build-release.sh
   ```

2. Start `ebb_server` on the default port (4000):

   ```bash
   ./packages/testing/dist/ebb_server/bin/ebb_server start
   ```

   Or run from source: `cd ebb_server && MIX_ENV=dev mix run --no-halt`.

3. In another shell:

   ```bash
   pnpm --filter @ebbjs/client test:integration
   ```

   Override the server URL with `EBB_TEST_URL=http://localhost:4001` for
   a non-default port.

### Integration test layout

`src/__tests__/integration/` contains two files:

- `ebb-server.test.ts` — self-seeding. Creates a unique group + members
  per run and exercises the full client ↔ server round-trip (handshake,
  catchUp, write, presence, permission rejection).
- `presence.test.ts` — requires a pre-seeded `grp_demo` group with a
  `demo-seeder` member and the demo's document (`doc_grp_demo`), none of
  which this package bootstraps. The test probes for the group at load
  time and skips cleanly with a warning when it's missing. Seed the demo
  fixtures locally (run `examples/collaborative-text-demo` once) if you
  want to run it end-to-end.

The CI integration job (`elixir-integration-tests` in
`.github/workflows/ci.yml`) boots the cached release and runs
`test:integration`. `presence.test.ts` skips there because the demo
fixture is not seeded.
