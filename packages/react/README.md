# `@ebbjs/react`

React bindings for [`@ebbjs/client`](https://github.com/ebbjs/ebbjs/tree/main/packages/client). A thin adapter over the client's namespace and reactivity primitives — no state-management library, no `define*` symbols.

This first slice ships the plumbing every later hook builds on:

- `EbbProvider` — context carrying the `SyncClient`.
- `useClient()` — read the client, throwing outside a provider.
- `useConnection()` — `useSyncExternalStore` over `client.onStateChange`, returning the `ConnectionState`.

Data hooks (`useQuery`, `useEntity`, `useEntityMutations`) land in follow-up slices. SSR / Suspense are out of scope for now.

## Usage

```tsx
import { createClient } from "@ebbjs/client";
import { EbbProvider, useClient, useConnection } from "@ebbjs/react";

// Own the client outside React so remounts don't tear down the connection.
const client = createClient({ serverUrl: "http://localhost:4000", actorId: "alice" });

function ConnectionBadge() {
  const state = useConnection();
  const { actorId } = useClient();
  return <span>{`${actorId}: ${state}`}</span>;
}

export function App() {
  return (
    <EbbProvider client={client}>
      <ConnectionBadge />
    </EbbProvider>
  );
}
```

## API

| Export             | What                                                                             |
| ------------------ | -------------------------------------------------------------------------------- |
| `EbbProvider`      | Makes a `SyncClient` available to hooks below it. Props: `{ client, children }`. |
| `useClient()`      | Returns the nearest provider's client; throws a clear error when there is none.  |
| `useConnection()`  | Subscribes to connection state and re-renders on transitions.                    |
| `EbbProviderProps` | The provider's prop type.                                                        |
| `ConnectionState`  | Re-exported `"connecting" \| "live" \| "reconnecting" \| "offline"` union.       |

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
