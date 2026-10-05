# `@ebbjs/react`

React bindings for [`@ebbjs/client`](https://github.com/ebbjs/ebbjs/tree/main/packages/client). A thin adapter over the client's namespace and reactivity primitives — no state-management library, no `define*` symbols.

This slice ships the client plumbing plus the first data hook:

- `EbbProvider` — context carrying a `NamespacedClient<S, TActions>`.
- `useClient<S>()` — read the client, typed by the caller's schema.
- `useConnection()` — `useSyncExternalStore` over `client.onStateChange`, returning the `ConnectionState`.
- `useQuery()` — subscribe a component to a materialized collection query.

`useEntity` and `useEntityMutations` land in follow-up slices. SSR / Suspense are out of scope for now.

## Usage

```tsx
import { createClient, defineEntity, defineSchema, e } from "@ebbjs/client";
import { EbbProvider, useClient, useConnection, useQuery } from "@ebbjs/react";

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

## API

| Export             | What                                                                           |
| ------------------ | ------------------------------------------------------------------------------ |
| `EbbProvider`      | Makes a `NamespacedClient<S, TActions>` available to hooks below it.           |
| `useClient<S>()`   | Returns the nearest provider's client typed by `S`; throws outside a provider. |
| `useConnection()`  | Subscribes to connection state and re-renders on transitions.                  |
| `useQuery(build)`  | Subscribes to a materialized collection query; `{ data, loading, error }`.     |
| `EbbProviderProps` | The provider's prop type.                                                      |
| `UseQueryResult`   | The `useQuery` result type.                                                    |
| `QueryRows`        | The projected row-list type a `QueryBuilder` resolves to.                      |
| `ConnectionState`  | Re-exported `"connecting" \| "live" \| "reconnecting" \| "offline"` union.     |

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
