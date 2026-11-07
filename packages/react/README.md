# `@ebbjs/react`

React bindings for [`@ebbjs/client`](https://github.com/ebbjs/ebbjs/tree/main/packages/client). A thin adapter over the client's read namespaces and reactivity primitives — no state-management library, no `define*` symbols.

This package ships the client plumbing plus the data hooks:

- `EbbProvider` — context carrying the app's client.
- `useClient<C>()` — read that client, typed by the _client type_ rather than
  a schema-plus-actions pair, so one generic covers reads and `client.actions`
  together. Reads go through `useQuery`.
- `useConnection()` — `useSyncExternalStore` over `client.onStateChange`, returning the `ConnectionState`.
- `useQuery()` — the reactive read root: build a query through the typed namespaces and subscribe to its cached result.
- `usePresence()` — the peers observed on one presence channel of one entity, typed from the channel's declared schema when bound with `createEbbHooks`.
- `usePresenceLeave()` — retract this session's presence when the page goes away. `EbbProvider` already installs it; call it yourself only under a custom provider.
- `useOutbox()` — the write buffer's depth and flush latency: pending, acknowledged, error, conflicted, `flushLatency`, `storeFaults`.
- `useConflicts()` — the conflicts awaiting an application decision.
- `useEbbStatus()` — connection + `lastSyncedAt` + outbox + conflicts in one subscription.
- `useSyncObservable<T>(observable)` — the generic `useSyncExternalStore` wrapper the hooks above build on, exported for `client.sync.backfill` and app-owned observables.
- `createEbbHooks<C>()` — bind `useClient`, `useQuery`, `usePresence`, and the
  sync-state hooks to your client type once, so components need neither a
  generic nor a callback annotation.

SSR / Suspense are out of scope for now; the hooks have no
`getServerSnapshot`.

## Install

```bash
npm install @ebbjs/react react   # react ^18 || ^19 is a peer
```

Node `>=22.8.0`. `@ebbjs/client` is a normal dependency and installs with it.

```tsx
import { EbbProvider, useClient, useConnection, usePresence, useQuery } from "@ebbjs/react";
```

## Usage

```tsx
import { createClient, defineAction, defineEntity, defineSchema, e } from "@ebbjs/client";
import {
  EbbProvider,
  useClient,
  useConnection,
  usePresence,
  useQuery,
  type QueryRoot,
} from "@ebbjs/react";

const todo = defineEntity("todo", { title: e.string(), completed: e.boolean() });
const schema = defineSchema({ entities: { todo }, version: 1 });

type Schema = typeof schema;

// Own the client outside React so remounts don't tear down the connection.
const client = createClient({
  serverUrl: "http://localhost:4000",
  actorId: "alice",
  schema,
});

function OpenTodos() {
  // `q` is the client's typed namespaces narrowed to `query()`; annotating it
  // with the schema is how the hook infers both `q` and the row types.
  const { data, status, loading, error } = useQuery((q: QueryRoot<Schema>) =>
    q.todo.query().where("completed", false).limit(50),
  );

  if (loading) return <span>loading…</span>;
  if (error) return <span>{error.message}</span>;
  return (
    <ul data-status={status}>
      {(data ?? []).map((row) => (
        <li key={row.id}>{row.title}</li>
      ))}
    </ul>
  );
}

function ConnectionBadge() {
  const state = useConnection();
  const { actorId } = useClient<typeof client>();
  return <span>{`${actorId}: ${state}`}</span>;
}

export function App() {
  return (
    <EbbProvider client={client}>
      <ConnectionBadge />
      <OpenTodos />
    </EbbProvider>
  );
}
```

## `useQuery(build, deps?)`

`build` receives `q` — the client's own entity namespaces, narrowed to
`query()` — so `q.todo.query` is the same method as
`client.todo.query`. Hook and imperative callers cannot drift.

Annotate `q` with your schema, `(q: QueryRoot<Schema>)`, and omit the
hook's type arguments. That is how TypeScript infers both the query
surface and the row type: supplying a type argument instead
(`useQuery<Schema>(...)`) would pin the row generics to their defaults,
because TypeScript does not partially infer type arguments. `where` keys,
`with` selections, and the joined `data` shape all follow the annotation.

The callback runs once per `deps` change (`deps` must keep a stable
length). Keep the query chain deterministic: it lowers to a serializable
`Query`, which is the cache key, so two components building the same
chain share one cached result.

```tsx
useQuery(
  (q: QueryRoot<Schema>) => q.issue.query().where("status", "open").with({ assignee: true }),
  [boardId],
);
```

`with(...)` widens each row with one-level joins. The result's `data`
type follows the selection, so `issue.assignee` is typed from the
schema's relationship and a nested selector is a compile error.

The rest of the grammar:

- `where(key, value)` — equality conjunct. A key may be a shape field, a
  registered relationship `as`, or the reserved `groups` key.
- `or(key, value)` — starts a new AND-group, so
  `.where(a).where(b).or(c).where(d)` means `(a AND b) OR (c AND d)`.
- `orderBy(field, "asc" | "desc")` and `limit(n)`.

The chain is immutable, so a helper can return a partially-built query and the
caller can keep narrowing it.

### Status

`status` is derived from the engine's cache, never stored ad hoc:

| Status     | Meaning                                                           |
| ---------- | ----------------------------------------------------------------- |
| `unloaded` | Never run; `data` is `undefined` (never an empty list).           |
| `stale`    | A usable result exists at an older revision; a re-run is pending. |
| `current`  | The result was produced at the replica's current revision.        |
| `failed`   | The last run threw; sticky until a successful run.                |

A held result renders synchronously on first mount with `status: "current"` or
`"stale"` (never `unloaded`), so there is no loading flash for cached data.
`loading` is true only while no result exists yet, and `error` mirrors
`failed`. A `stale` result is still usable, so it keeps `loading: false`
while the refresh runs.

A remount re-reads the cached result; it does not refetch. A live
change that leaves the projected rows equal does not re-render.

## Single rows

There is no single-row hook, and the query grammar has no `id` predicate
yet. Query the collection and select the row; the result is cached and
reactive, so the selected row follows live changes:

```tsx
const { data: issues, status } = useQuery((q: QueryRoot<Schema>) =>
  q.issue.query().with({ assignee: true }),
);
const issue = issues?.find((row) => row.id === issueId);

if (status === "unloaded") return <span>loading…</span>;
if (issue === undefined) return <span>missing</span>;
```

`client.<entity>.get()` and its async relationship accessors are
internal / undocumented; `useEntity` was removed in #501.

## Not a query (yet)

- **Windowing / cursor pagination is deferred.** `limit(n)` is the only
  windowing; there is no cursor, offset, or page-boundary API. Query the
  collection you can afford to hold and slice it in the component if you
  must.
- **On-demand document bodies are not yet a query (#500).** A
  collaborative-text body is a separate document entity that the replica
  will materialize when opened, not a row the query grammar returns. Open it
  through the low-level `client.textDocument(id)` for now.
- **There is no `id` predicate**, so a single row is a collection query plus
  `find`, as above.

## Presence

`usePresence(entityId, channel)` subscribes a component to the peers observed
on one presence channel of one entity. Presence is declared when the client is
built — `definePresence` fixes each channel's schema, send debounce, receive
TTL, and entry cap:

```tsx
import { Type } from "@sinclair/typebox";
import { createClient, definePresence } from "@ebbjs/client";

const presence = definePresence({
  camera: {
    schema: Type.Object({ x: Type.Number(), y: Type.Number(), zoom: Type.Number() }),
    ttlMs: 5_000,
  },
  cursor: Type.Object({ anchorId: Type.String(), anchorOffset: Type.Number() }),
});

const client = createClient({ serverUrl, actorId, schema, presence });
type AppClient = typeof client;

// Bind once, at module scope.
export const { useClient: useEbb, useQuery, usePresence } = createEbbHooks<AppClient>();
```

Bound from `createEbbHooks<C>()`, the channel name is checked against the
client's registry and the payload type follows the channel's schema, so a
misspelled channel and a cursor payload on the camera channel are both compile
errors:

```tsx
function Cameras({ planId }: { planId: string }) {
  const peers = usePresence(planId, "camera");
  // ReadonlyMap<string, PeerPresence<{ x: number; y: number; zoom: number }>>

  return (
    <ul>
      {[...peers].map(([actorId, peer]) => (
        <li key={actorId}>
          {`${actorId} at ${peer.data.x},${peer.data.y} (zoom ${peer.data.zoom})`}
        </li>
      ))}
    </ul>
  );
}
```

The snapshot is `client.presence.forEntity(entityId, channel)`; the
subscription is `client.presence.onUpdate`, filtered to the same target, so a
20 Hz camera channel does not re-render a cursor consumer. The store notifies
on a peer's packet, on the channel's TTL expiry, and when the live stream
resets, so a peer that leaves stops rendering instead of leaving a stale
cursor behind. Sending is unchanged: `client.presence.set(entityId, channel,
value)` coalesces per target, and `client.presence.clear` sends the channel's
`null`.

The provider also leaves: on `pagehide` it calls
`client.presence.leave({ keepalive: true })`, retracting every target this
session announced so peers drop the actor instead of waiting out the TTL. That
is page lifetime, not a React lifetime, so it is not tied to unmounting —
`client.close()` stays local teardown, because a remount or a client swap must
not broadcast an absence — and `visibilitychange` is not a leave either, since
a hidden tab still has a cursor and the TTL covers it. Under a custom provider
that does not wire this, call `usePresenceLeave()` in a component that stays
mounted for the page's lifetime.

The standalone `usePresence<T>()` cannot see the client type (React context
erases it), so it does not narrow the channel; pass the payload type there:

```tsx
const cursors = usePresence<CursorPresence>(docId, "cursor");
```

Presence is ephemeral: it never enters the Action log, is lossy on
disconnect, and the server holds no state for it. A peer that stops sending is
aged out by the channel's receive TTL, and the whole peer set is dropped when
the live stream closes — both surface as a re-render, not as a stale cursor.

## Sync state: outbox, conflicts, and status

The client publishes its sync state as read-only observables — a synchronous
`get()` plus a `subscribe(cb)` — and these hooks are the React half. Nothing
polls, and nothing reaches into the client's internals.

```tsx
import { useEbbStatus } from "@ebbjs/react";

function SyncBar() {
  const { connection, lastSyncedAt, outbox, conflicts } = useEbbStatus();

  if (connection === "offline" && outbox.pending > 0) {
    return <span>{outbox.pending} writes queued, offline</span>;
  }
  if (conflicts.count > 0) {
    return <span>{conflicts.count} edits need review</span>;
  }
  if (outbox.pending > 0 || outbox.acknowledged > 0) return <span>Saving…</span>;
  return <span>{lastSyncedAt === null ? "Not synced yet" : "Synced"}</span>;
}
```

`useOutbox()` returns the `OutboxSnapshot`: `pending`, `acknowledged`,
`error`, `conflicted`, `flushLatency` (wall time of the last resolved flush,
`null` before one), and `storeFaults` (cumulative durable store faults). A
flush reports its depth first and its latency second, so the same flush can
re-render twice; `get()` always holds the latest of both.

`useConflicts()` returns the `ConflictSnapshot`: `count` and `conflicts`,
oldest detection first. `client.sync.conflicts` republishes whenever the
outbox's counts change — a detection, a resolution, and the initial durable
load all arrive that way, with no async refetch. A write that does not touch
the conflict set can republish an equal snapshot, so the consumer may re-render
without its data changing. A conflict carries its losing entries, its subject
states with a before/after `diff`, and `remoteWins()`, which is enough to
render "2 edits need review" and to build a review UI.

`useEbbStatus()` returns the aggregate `ClientStatus`: `connection`,
`lastSyncedAt` (epoch ms of the last applied remote Action or completed
catch-up, `null` before the first), `outbox`, and `conflicts`. It is one
subscription over four sources, and any of them changing re-renders the
consumer — reach for `useOutbox` / `useConflicts` when a component needs only
one slice.

`useSyncObservable<T>(observable)` subscribes to any `ReadonlyObservable<T>`.
The client's sync state is published in exactly that shape, so it covers the
slots without a dedicated hook — `client.sync.backfill`, for instance — and an
app-owned observable:

```tsx
import { useSyncObservable } from "@ebbjs/react";

// Entity ids being backfilled because a membership row named an entity the
// local cache lacks — render a pending row rather than an empty one.
const backfilling = useSyncObservable(client.sync.backfill);
```

An observable must return the same value reference until its value changes; a
fresh object on every `get()` makes React warn and re-render in a loop, while
a new reference on a real change is what triggers the re-render.

### Resolving conflicts is not a hook

`useConflicts` is read-only, matching the client's split between reading the
set and resolving it. Resolution goes through `client.conflicts`, outside the
render pass:

```tsx
const [conflict] = await client.conflicts.list();
await client.conflicts.resolve(conflict.id, "retry"); // or "discard"
```

`retry` re-asserts the losing Actions; `discard` drops their optimistic writes
and replays the log. Either way the conflict set shrinks, `useConflicts`
re-renders, and no refetch is involved.

## `useClient` and writes

`useClient<C>()` returns the provider's client typed by the client type
itself. One generic covers the schema (reads) and the action map
(`client.actions`) together, so adding an action never changes a call site.
It is the write surface, not a read surface: reads go through `useQuery`.
Every write is an Action: declare it once at module scope with `defineAction`,
mount it on the client, and call it as `client.actions.<name>`.

```tsx
// Module scope, beside the client that mounts it.
const createIssue = defineAction(schema, ({ issue }, params: { title: string; groupId: string }) =>
  issue.create({ title: params.title, status: "todo" }, { groups: [params.groupId] }),
);

const client = createClient({ serverUrl, actorId, schema, actions: { createIssue } });

type AppClient = typeof client;

function NewIssue({ groupId }: { groupId: string }) {
  const client = useClient<AppClient>();
  const create = () => client.actions.createIssue({ title: "Buy milk", groupId });
  return <button onClick={() => void create()}>new issue</button>;
}
```

Nothing above imports a type from the library: the client type is simply what
`createClient` returned, so `defineAction`, `EntityValues` and `typeof client`
are the whole vocabulary.

Naming the client once also lets a component stop carrying a generic — and
gives `useQuery` a typed `q` without the `QueryRoot<Schema>` annotation
(TypeScript does not partially infer type arguments, so a schema type argument
would drop the row types; binding the client is the way out):

```tsx
// use-ebb.ts — bind the hooks to the client type once, at module scope.
export type AppClient = typeof client;
export const { useClient: useEbb, useQuery, usePresence } = createEbbHooks<AppClient>();

// anywhere below the provider: no generics, no annotations
const client = useEbb();
await client.actions.createIssue({ title: "Buy milk", groupId });

const { data } = useQuery((q) => q.issue.query().with({ assignee: true }));
const cameras = usePresence(boardId, "camera");
```

`q` is the client's **read root** — every namespace narrowed to `query()` — so
a write stays a compile error there. Call `createEbbHooks` at module scope:
each call makes new hook functions, and a per-render call would hand React a new
hook identity on every render.

One call is one Action, and a rejection throws `ActionRejectedError`. The
action callback is synchronous and cannot live inside a component, so a
component only calls the mounted action.

A multi-entity action reads the same way — everything its callback drafts is
one Action, or none of it commits. The issue-tracker demo's `leaveWorkspace`
drafts two writes (a profile leaving a group, its `groupMember` row going with
it) and still costs one call:

```tsx
await client.actions.leaveWorkspace({ profileId, groupId, memberId });
```

## API

| Export                           | What                                                                                     |
| -------------------------------- | ---------------------------------------------------------------------------------------- |
| `EbbProvider`                    | Makes the app's client available to hooks below it.                                      |
| `useClient<C>()`                 | Returns the nearest provider's client typed as `C`; throws outside a provider.           |
| `useConnection()`                | Subscribes to connection state and re-renders on transitions.                            |
| `useQuery(build, deps?)`         | Subscribes to a cached query result; `{ data, status, loading, error }`.                 |
| `usePresence(entityId, channel)` | Subscribes to the peers on one presence channel; `ReadonlyMap<actorId, PeerPresence>`.   |
| `usePresenceLeave()`             | Leaves (`keepalive`) every claimed presence target on `pagehide`; the provider wires it. |
| `useOutbox()`                    | Subscribes to the write buffer; `OutboxSnapshot` (depth, latency, faults).               |
| `useConflicts()`                 | Subscribes to the conflict set; `ConflictSnapshot` (`count`, `conflicts`).               |
| `useEbbStatus()`                 | Subscribes to the aggregate `ClientStatus`; one hook for a status bar.                   |
| `useSyncObservable(o)`           | Subscribes to any `ReadonlyObservable<T>`; the generic wrapper above.                    |
| `createEbbHooks<C>()`            | Binds `useClient`, `useQuery`, `usePresence`, and the sync-state hooks to one type.      |
| `QueryRootOf<C>`                 | The read root of a client type — what a bound `useQuery`'s `q` is.                       |
| `PresenceChannelOf<C>`           | The presence channel names a client type declares.                                       |
| `PresencePeerMapOf<C, K>`        | The peer map a bound `usePresence` returns for one declared channel.                     |
| `EbbProviderProps`               | The provider's prop type.                                                                |
| `UseQueryResult`                 | The `useQuery` result type.                                                              |
| `QueryRows`                      | The projected row-list type a `QueryBuilder` resolves to.                                |
| `ConnectionState`                | Re-exported `"connecting" \| "live" \| "reconnecting" \| "offline"` union.               |
| `OutboxSnapshot`                 | Re-exported outbox snapshot type (`pending`, `flushLatency`, …).                         |
| `ConflictSnapshot`               | Re-exported conflict snapshot type (`count`, `conflicts`).                               |
| `ClientStatus`                   | Re-exported aggregate status type (`connection`, `outbox`, …).                           |
| `ReadonlyObservable<T>`          | Re-exported observable interface `useSyncObservable` accepts.                            |

## Peer dependencies

```json
{
  "react": "^18.0.0 || ^19.0.0"
}
```

`@ebbjs/client` is a regular dependency.

## Development

```bash
pnpm --filter @ebbjs/react test
```

Vitest with `happy-dom`, using `@testing-library/react`. Tests resolve `@ebbjs/client` to source (see `vitest.config.ts`) so they exercise the workspace's client rather than a stale `dist/` bundle.
