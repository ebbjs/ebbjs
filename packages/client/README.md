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
engine (typed `query()` reads with one-level `with` joins and retained reactive
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

The server is authoritative, so the helper sends no `x-ebb-actor-id`. That
matters for tailscale deployments: the browser cannot know its tailnet login in
advance, but the server derives it per request. `identity.provider` (`"bypass"`,
`"external"`, `"tailscale"`) says which mode answered; `displayName` and
`providerId` carry what that mode knows. Keep the actor picker for `bypass`;
use the resolved id as-is otherwise. The long-lived client still stamps
`x-ebb-actor-id` on its own requests for bypass compatibility; in tailscale
mode the server ignores it and authenticates from the gateway's headers.

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
like the rest. Reads go through `query()`, which takes a `select`; a single row
is opened with `get(id, { select })`, taking the same selection. Every write
is an Action mounted as `client.actions.<name>`. The async row accessors and the
collection `subscribe(filter, cb)` are internal, not public read paths.

### Reads — `client.<entity>.query()`

`query()` returns a typed, immutable chain. Each mutator returns a new chain;
awaiting it resolves to the projected rows (the schema's fields plus the
entity `id`; a replica-backed query row also carries its live `groupIds`).

`groupIds` is read from the replica's membership index — one lookup per row,
no `membership` scan. Use it when a row only needs the ids it belongs to;
`.with({ groups: true })` projects the group rows themselves, which matters
because a group id can name a row that is not materialized. Joined target
rows are plain projections (fields plus `id`), and a chain over
already-materialized candidates (`buildQueryBuilder` / row accessors) has no
membership index, so neither carries `groupIds`.

```typescript
const issues = await client.issue
  .query()
  .select({ title: true, status: true })
  .where("status", "open")
  .or("priority", "urgent")
  .orderBy("updated_at", "desc")
  .limit(50)
  .with({ assignee: true });
```

Grammar:

- `where(key, value)` — equality conjunct. A key may be a shape field, a
  registered relationship `as` (filters that edge), or the reserved `groups`
  key (filters built-in membership). An object or array value compares
  structurally, so key order does not matter and a compound leaf is matched
  by value rather than by reference.
- `or(key, value)` — starts a new AND-group. Predicates are a disjunction of
  AND-groups, so `.where(a).where(b).or(c).where(d)` means
  `(a AND b) OR (c AND d)`.
- `where(key, null)` — matches rows with no live value for the field (absent
  or cleared). A schema default never widens the filter; `.where("status",
"open").or("status", null)` is the explicit "open or unset".
- `orderBy(field, "asc" | "desc")` and `limit(n)`. `orderBy` accepts scalar
  fields only: object and array values are not orderable (there is no total
  order to compare them by), so such a field is refused rather than tied.
- `with({ key: true, ... })` — one-level joins over the schema's relationships
  plus `groups`. Each selected key is merged onto the row; a nested selector
  is rejected.
- `select({ field: true, ... })` — projects only the fields named. The same
  declaration is the read's lease set and its invalidation key: a selected
  field is returned, claimed, and watched, and a write to an unselected
  component leaves the result alone. `.select({})` returns only the structural keys
  (`id`, and `groupIds` on a query row). System components are never
  selectable: `groupIds`, a predicate's or join's edge/membership reads, and a
  joined target are supplied by the planner.

Terminals: `await` / `.then()` for rows, `.first()`, `.count()`, `.exists()`,
the async iterator, and `.toRaw()` for the untyped wire entities.

A chain's result is retained and reactive: `.result()` returns the engine store
(`getSnapshot()` reads `{ data, status, loading, error }`; `subscribe(listener)`
fires on change) and the chain's own `.subscribe(listener)` is the shorthand.
`status` is one of:

| Status     | Meaning                                                           |
| ---------- | ----------------------------------------------------------------- |
| `unloaded` | Never run; `data` is `undefined` (never an empty list).           |
| `stale`    | A usable result exists at an older revision; a re-run is pending. |
| `current`  | The result was produced at the replica's current revision.        |
| `failed`   | The last run threw; sticky until a successful run.                |

Two chains that lower to the same query share one retained result, so a remount
reads it back instead of re-running. In React, `useQuery` wraps this surface.
A chain over already-materialized rows — a row accessor, or a builder from
`buildQueryBuilder` — has no engine entry, so `.result()` and `.subscribe()`
refuse rather than keep a second copy beside the results view: await the chain to read it.

Name the row a query returns with `QueryRowOf`, passing the schema and the
`with(...)` join keys you selected. It derives the same projection the query
returns, so a view type cannot drift from the schema:

```typescript
type IssueRow = QueryRowOf<typeof schema, "issue", "assignee">;
const issues: readonly IssueRow[] = await client.issue.query().with({ assignee: true });
```

### Residency

Nothing declares what stays in memory. A row the replica holds carries a value
for every component it knows: a synced Action folds its components, and a
`load` adopts the record whole. A row the replica does not hold — a group
outside the client's subscribed scope, a view the record did not carry — is the
entity store's to serve, and a read installs it:

```typescript
// The store serves the row; the read projects it and releases it again.
const page = await client.page.get(pageId, { select: { title: true } });
```

A read claims what it installs. Releasing the last claim starts one residency
grace period (`residencyTtlMs`, default 60 s), so a remount inside it reads
nothing; when it elapses the row a read installed leaves the replica whole and
the next read goes back to the store. A value the Action log folded is not the
claim's to release: nothing reclaims it today, so no lease keeps it and no
expiry takes it — it stays for the session (#957). There is no cap, so reading a
second row never takes the first away from a screen still reading it.

A live subscription owns what it read: `row.subscribe` claims the components its
read selected until it unsubscribes, and a query subscription claims the
components its result read, so a component cannot expire under a mounted screen.
Two subscriptions reading one component share one copy and one claim, and
unsubscribing starts the same grace period. A query result does not go away with
its last subscriber: it becomes an inactive subscription that keeps its result
and claims for the same `residencyTtlMs`, so a remount inside it reads nothing
and re-runs only when a relevant change landed. `client.subscriptions` is the
registry those live subscriptions live in. Two readers of one row that selected
different components hold separate claims, so one cannot observe a partial row
behind the other's lease. `client.replica.stats().leases` reports what is
leased, what is only waiting out its grace period, and for how long, per
component.

A `row.subscribe` event is either a `snapshot` — the row's current projection,
a tombstone included — or an `unloaded` that names the component the replica
lost (`component` set) or the row leaving the replica (`component` absent).
`unloaded` is not routine memory pressure: an active lease is never expired or
truncated, so it takes a scope eviction, a component `drop` write, or a `load`
that replaces the row. A read that selected nothing observes the whole row;
re-read with `get(id, { select })` to re-acquire after an unload.

A read that projects a component the replica does not hold is not refused. It
narrows the ids first — scan, predicates, order, `limit` — and then acquires only
the page it projects:

```typescript
// The ids narrow first; only the twenty documents `limit` names are acquired.
const docs = await client.page_content.query().select({ content: true }).limit(20);
```

A single row is read the same way, with `get(id, { select: { content: true } })`,
and its `subscribe` keeps claiming the selected components. A join leases its
target after the page is chosen: `with({ content: true })` acquires the joined
rows before projecting them.

A cold projection on a page that needs acquisition runs the narrowing plan
once: the page it narrowed is handed to acquisition, which installs only the
components the projection reads. The results view reconciles a change that
lands while acquisition is in flight, so the page cannot be left stale (#962).

A relevant change patches the retained result only when it cannot move the row.
An unselected `client.<model>.query()` reads `<model>/*`, so the patch rate
depends on every projected component being resident: measured through the
shipped path at 200 pages, 40/40 projected writes patch when every projected
component is resident, 4/40 at 10% optional-component presence, and 0/40 when
the component is absent (#942). A change to matching, ordering, limits, joins,
or row existence re-runs.

The persisted replica record is a snapshot of what memory held, not a durability
claim: the entity store already has every synced row, so the record only makes a
cold start cheaper.

### Writes — actions

`defineAction(schema, callback)` is the only way to write. A definition pairs
the schema with a callback over that schema's draft namespaces; a client
created with `actions` mounts it as `client.actions.<name>(params)`.

```typescript
import {
  createClient,
  defineAction,
  defineModel,
  defineSchema,
  e,
  type EntityValues,
} from "@ebbjs/client";

const issue = defineModel("issue", { title: e.string(), status: e.string() });
const schema = defineSchema({ models: { issue }, version: 1 });

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
  many-cardinality one. `{ replace }` refuses when the source row is not locally
  readable rather than writing a partial set — use `link` / `unlink` or
  `{ add, remove }` to write keys individually.
- `addToGroup(id, groupId)`, `removeFromGroup(id, groupId)`, and
  `setGroups(id, groupIds)` for membership. A membership row's id is derived
  from the `(entity, group)` pair, so a share is idempotent across devices and
  an unshare removes the row every device is looking at.

The system entities get their own draft namespaces. `group.create` bootstraps a
group — the group row plus the acting actor's membership, one Action.
`membership.create` adds one `grant` row, and `membership.update` /
`membership.delete` patch or remove one behind the local `last_grant`
guard, so leaving a workspace is one Action. Both namespaces also carry the
plain entity verbs — `update`, `delete`, `duplicate`, `link`, `unlink`,
`setLinks` — and omit only the membership verbs, since an `membership` row for
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

The grammar has no `id` predicate: query the collection and select the row, or
read one with `get(id, { select })`. `limit(n)` is the only paging control;
cursor pagination is deferred.

A relationship or existence predicate invalidates on the derived index key it
reads: dispatch touches a subscription whose relation target changed, or whose
component was written, instead of every subscription that reads the component.
A link write touches the targets the journal's edge delta names under the
index's relation plus the changed row, and a membership scope resolves to both
groups a move names — the read set still keeps `ebb/membership` broad, so scope
dispatch narrowing still waits on #962. Only a change whose shape cannot say
what moved — a link write or a membership change with no delta — falls back to
every reader of the index. A read that also projects the relation keeps
`ebb/link` in its dispatch set, because a join projects the source row's edges,
so that read still sees every link write.

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
  grants: [
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

   The identity suite needs a server in tailscale mode. Boot one with
   `EBB_AUTH_MODE=tailscale` (it binds loopback), then run the same command;
   `EBB_TAILSCALE_TEST_URL` overrides its address. A bypass or external server
   makes those tests skip.

### Integration test layout

`src/__tests__/integration/` holds the suites below plus `server.ts`, the
scaffold they share: `SERVER_URL`, `runId()`, `serverReachable` (probed once,
when the file loads), and `itIfServer`. A test registered through
`itIfServer` reports as **skipped** when no server answers, so a suite can
never pass by returning early. `itIf(ready)` builds the same wrapper for a
suite whose fixtures are a second gate.

- `ebb-server.test.ts` — self-seeding. Creates a unique group + members
  per run and exercises the full client ↔ server round-trip (handshake,
  catchUp, write, presence, permission rejection).
- `row-create.test.ts` — the row-scoped create (#817) end to end: a
  zero-component row is a legal row on every delivery path.
- `app-scope.test.ts` — two apps, one actor, one store (#732): scope is a
  residency filter on the handshake, not authority.
- `identity.test.ts` — requires `EBB_AUTH_MODE=tailscale`. Wraps `fetch` to
  inject the gateway's identity headers, then resolves the actor, handshakes,
  writes, and observes the write over the live stream. It also pins the stale
  actor's `actor_mismatch`. Skips cleanly on a bypass or external server.
- `presence.test.ts` — requires a pre-seeded `grp_demo` group with a
  `demo-seeder` member and the demo's document (`doc_grp_demo`), none of
  which this package bootstraps. The test probes for the group at load
  time and skips cleanly with a warning when it's missing. Seed the demo
  fixtures locally (run `examples/collaborative-text-demo` once) if you
  want to run it end-to-end.

The CI integration job (`elixir-integration-tests` in
`.github/workflows/ci.yml`) boots the cached release and runs
`test:integration`, then boots a second release in `tailscale` mode on port
4001 for `identity.test.ts`. `presence.test.ts` skips there because the demo
fixture is not seeded.
