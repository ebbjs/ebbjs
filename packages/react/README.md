# `@ebbjs/react`

React bindings for [`@ebbjs/client`](https://github.com/ebbjs/ebbjs/tree/main/packages/client). A thin adapter over the client's namespace and reactivity primitives — no state-management library, no `define*` symbols.

This package ships the client plumbing plus the data hooks:

- `EbbProvider` — context carrying a `NamespacedClient<S, TActions>`.
- `useClient<S>()` — read the client, typed by the caller's schema.
- `useConnection()` — `useSyncExternalStore` over `client.onStateChange`, returning the `ConnectionState`.
- `useQuery()` — subscribe a component to a materialized collection query.
- `useEntity()` — subscribe a component to a single entity row.
- `useEntityMutations()` — stable `create` / `update` / `delete` pass-throughs for one namespace.

SSR / Suspense are out of scope for now.

## Usage

```tsx
import { createClient, defineEntity, defineSchema, e } from "@ebbjs/client";
import {
  EbbProvider,
  useClient,
  useConnection,
  useEntity,
  useEntityMutations,
  useQuery,
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
  // No cast: `useClient<Schema>()` restores the typed namespaces.
  const client = useClient<Schema>();
  const { data, loading, error } = useQuery(() =>
    client.todo.query().where("completed", false).limit(50),
  );

  if (loading) return <span>loading…</span>;
  if (error) return <span>{error.message}</span>;
  return (
    <ul>
      {data.map((row, i) => (
        <li key={i}>{row.title}</li>
      ))}
    </ul>
  );
}

function ConnectionBadge() {
  const state = useConnection();
  const { actorId } = useClient<Schema>();
  return <span>{`${actorId}: ${state}`}</span>;
}

function TodoRow({ id }: { id: string }) {
  const client = useClient<Schema>();
  const todo = useEntity(() => client.todo.get(id), [id]);
  const { update, delete: remove } = useEntityMutations(client.todo);

  if (todo === null) return <span>missing</span>;
  return (
    <div>
      <button onClick={() => void update(id, { completed: !todo.completed })}>{todo.title}</button>
      <button onClick={() => void remove(id)}>delete</button>
    </div>
  );
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

`useQuery(build, deps?)` builds the query once per `deps` change (`deps`
must keep a stable length) and re-renders the component when the query's
source entity changes. The trigger is the builder's source-entity change
stream, so a matching row whose non-filtered field changed still
re-renders; a change that leaves the materialized rows identical is
suppressed by a structural snapshot compare.

`useEntity(load, deps?)` takes the same shape — `load` is
`() => client.<entity>.get(id)`. It runs on mount, on each `deps` change,
and again on every live change. It returns the row's projected fields
plus relationship accessors, or `null` when `get` finds no row — and
`null` after a soft delete observed while mounted. On a live change it
re-runs `get` rather than merging the snapshot, so an accessor that
shares a name with a field keeps the accessor-wins precedence.

Two limits come from the client's row surface: a row deleted **before**
mount reads as its tombstone (`get` returns tombstones for inspection),
and a row created after an absent read is not observed, because
`EntityRow.subscribe` only exists once a row does.

`useEntityMutations(client.todo)` returns referentially stable
`create` / `update` / `delete` functions that forward to the namespace
unchanged.

## API

| Export                          | What                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------ |
| `EbbProvider`                   | Makes a `NamespacedClient<S, TActions>` available to hooks below it.           |
| `useClient<S>()`                | Returns the nearest provider's client typed by `S`; throws outside a provider. |
| `useConnection()`               | Subscribes to connection state and re-renders on transitions.                  |
| `useQuery(build)`               | Subscribes to a materialized collection query; `{ data, loading, error }`.     |
| `useEntity(load, deps?)`        | Subscribes to a single row; the projected fields + accessors, or `null`.       |
| `useEntityMutations(namespace)` | Stable `{ create, update, delete }` pass-throughs.                             |
| `EbbProviderProps`              | The provider's prop type.                                                      |
| `UseQueryResult`                | The `useQuery` result type.                                                    |
| `UseEntityResult`               | The `useEntity` row type.                                                      |
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

## Testing

```bash
pnpm --filter @ebbjs/react test
```

Vitest with `happy-dom`, using `@testing-library/react`. Tests resolve `@ebbjs/client` to source (see `vitest.config.ts`) so they exercise the workspace's client rather than a stale `dist/` bundle.
