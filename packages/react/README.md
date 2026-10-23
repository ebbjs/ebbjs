# `@ebbjs/react`

React bindings for [`@ebbjs/client`](https://github.com/ebbjs/ebbjs/tree/main/packages/client). A thin adapter over the client's namespace and reactivity primitives — no state-management library, no `define*` symbols.

This package ships the client plumbing plus the data hooks:

- `EbbProvider` — context carrying a `NamespacedClient<S, TActions>`.
- `useClient<S>()` — read the client, typed by the caller's schema, for writes
  and imperative actions (`client.actions`, `client.atomic`, the namespace
  verbs). Reads go through `useQuery`.
- `useConnection()` — `useSyncExternalStore` over `client.onStateChange`, returning the `ConnectionState`.
- `useQuery()` — the reactive read root: build a query through the typed namespaces and subscribe to its cached result.
- `useEntityMutations()` — stable `create` / `update` / `delete` pass-throughs for one namespace.

SSR / Suspense are out of scope for now.

## Install

```bash
npm install @ebbjs/react react   # react ^18 || ^19 is a peer
```

Node `>=22.8.0`. `@ebbjs/client` is a normal dependency and installs with it.

```tsx
import { EbbProvider, useClient, useConnection, useQuery } from "@ebbjs/react";
```

## Usage

```tsx
import { createClient, defineEntity, defineSchema, e } from "@ebbjs/client";
import { EbbProvider, useClient, useConnection, useQuery, type QueryRoot } from "@ebbjs/react";

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
  const { actorId } = useClient<Schema>();
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

## `useClient` and writes

`useClient<Schema, TActions>()` returns the provider's client typed by the
caller's schema and action map. It is the write surface, not a read surface:
reads go through `useQuery`. Single-entity verbs live on the typed namespace
(`client.issue.update`, `client.issue.link`), and multi-entity writes go
through `client.atomic` or a `defineAction` bound to `client.actions`.

```tsx
function NewIssue({ groupId }: { groupId: string }) {
  const client = useClient<Schema>();
  const create = () =>
    client.issue.create({ title: "Buy milk", status: "todo" }, { groups: [groupId] });
  return <button onClick={() => void create()}>new issue</button>;
}
```

A `defineAction` is declared once and called through the action map:

```tsx
const client = useClient<Schema, typeof workspaceActions>();
await client.actions.addToWorkspace({ actorId, profileId, groupId, permissions });
```

`useEntityMutations(client.todo)` returns referentially stable
`create` / `update` / `delete` functions that forward to the namespace
unchanged — a convenience when a component only needs those three.

## API

| Export                          | What                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------ |
| `EbbProvider`                   | Makes a `NamespacedClient<S, TActions>` available to hooks below it.           |
| `useClient<S, TActions>()`      | Returns the nearest provider's client typed by `S`; throws outside a provider. |
| `useConnection()`               | Subscribes to connection state and re-renders on transitions.                  |
| `useQuery(build, deps?)`        | Subscribes to a cached query result; `{ data, status, loading, error }`.       |
| `useEntityMutations(namespace)` | Stable `{ create, update, delete }` pass-throughs.                             |
| `EbbProviderProps`              | The provider's prop type.                                                      |
| `UseQueryResult`                | The `useQuery` result type.                                                    |
| `UseEntityMutationsResult`      | The `useEntityMutations` result type.                                          |
| `QueryRows`                     | The projected row-list type a `QueryBuilder` resolves to.                      |
| `ConnectionState`               | Re-exported `"connecting" \| "live" \| "reconnecting" \| "offline"` union.     |

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
