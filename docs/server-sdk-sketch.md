# Server-Side SDK (Sketch)

## What It Is

The server-side SDK is an HTTP/RPC client for the Ebb server. It gives application servers, SSR frameworks, and external processes the same data access API as the browser client — but over the network instead of against a local replica.

It is **not** collocated with the database. It talks to the Ebb server over HTTP, the same way the browser client does. This means it works from anywhere: a Next.js server, a TanStack Start loader, a standalone Node.js process, a CRON job on a different machine.

---

## Relationship to Other Ebb Primitives

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│   Browser Client          Server-Side SDK         defineFunction ctx        │
│   ─────────────────       ──────────────────       ────────────────────     │
│   Local SQLite replica    HTTP/RPC to Ebb          Direct SQLite            │
│   Outbox + sync           No Outbox                No Outbox                │
│   Conflict detection      No conflict detection    No conflict detection    │
│   Runs in browser         Runs anywhere            Runs inside Ebb process  │
│                                                                             │
│   All three talk to the same Ebb server.                                    │
│   All three run as an actor with group-scoped data visibility.              │
│   All three produce Actions and Updates that flow through the sync stream.  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Primary Use Cases

- **SSR hydration** — fetch initial data server-side for a Next.js or TanStack Start page, then hand off to the browser client for live sync
- **Server actions in SSR frameworks** — write to Ebb from a Next.js server action or TanStack server function
- **External processes** — CRON jobs, webhooks, background workers that need to read or write Ebb data
- **Service accounts** — automated actors that operate on behalf of the system rather than a user

---

## API Surface

The server-side SDK mirrors the browser client's data API. The same method names, same signatures — different transport underneath.

```ts
import { createServerClient } from '@ebbjs/client';

const client = createServerClient({
  url: "https://my-ebb-server.example.com",
  authenticate: () => ({ token: process.env.SERVICE_ACCOUNT_TOKEN }),
});

// Read
const doc = await client.get("doc-123");
const notes = await client.notes.query({ filter: { authorId: userId } });

// Write — produces Actions, flows through sync stream
await client.notes.create({ title: "Hello", body: "World" });
await client.notes.update("doc-123", { title: "Updated" });
await client.notes.delete("doc-123");
```

---

## Actor Identity

Every server-side SDK client is initialized with credentials that resolve to an actor on the Ebb server. Data visibility and write permissions are scoped to that actor's group memberships — identical to how the browser client works.

Common patterns:
- **Service account** — a dedicated actor with broad permissions, used for system-level automation
- **User-scoped** — the server acts on behalf of a specific user, passing their auth token through (e.g., in an SSR context where the user's session is available server-side)

```ts
// Service account — broad permissions, system actor
const systemClient = createServerClient({
  url: "...",
  authenticate: () => ({ token: process.env.SERVICE_ACCOUNT_TOKEN }),
});

// User-scoped — acts as the authenticated user
const userClient = createServerClient({
  url: "...",
  authenticate: () => ({ token: userSession.token }),
});
```

---

## SSR Pattern

The server-side SDK is designed to work alongside the browser client for SSR hydration. The key insight is that the server passes not just entity data but also the **GSN it fetched at** — so the browser client can seed its local replica and start catch-up from that cursor rather than from zero. No gap, no flicker, no redundant fetching.

```ts
// app/routes/notes.$id.tsx (TanStack Start)
import { createServerClient } from '@ebbjs/client';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/notes/$id')({
  loader: async ({ params, context }) => {
    const client = createServerClient({
      url: process.env.EBB_URL,
      authenticate: () => ({ token: context.session.token }),
    });

    // createServerClient returns data alongside the GSN it was fetched at
    const { data: note, cursor } = await client.get(params.id);

    // Pass both to the client — data for immediate render, cursor for sync handoff
    return { note, cursor };
  },

  component: function NoteRoute() {
    const { note: initialNote, cursor } = Route.useLoaderData();

    // Browser client seeds local replica with SSR data and starts catch-up from cursor
    // No cold start, no gap between server-rendered and live state
    const note = useEbb(initialNote.id, { initialData: initialNote, cursor });

    return <NoteEditor note={note} />;
  },
});
```

**How the handoff works:**
1. Server fetches entity data at a specific GSN via `createServerClient`
2. Server passes entity data + GSN cursor to the browser as part of the render payload
3. Browser client seeds its local replica with the entity data — no waiting for catch-up to render
4. Browser client starts catch-up from the provided GSN cursor, not from zero
5. Once caught up, browser client subscribes to the live sync stream as normal

This means the browser client never has to re-fetch what the server already fetched, and the user sees no flicker between the server-rendered state and the live state.

---

## Packaging

The server-side SDK and browser client ship from the **same package** (`@ebbjs/client`) as two named exports. The developer explicitly initializes the right client for their context — auto-detection is not possible because the two clients have fundamentally different initialization requirements (local storage adapter vs. server URL and auth credentials). But the method names and signatures are identical, so knowledge transfers between contexts.

```ts
// Browser
import { createClient } from '@ebbjs/client';

// Server
import { createServerClient } from '@ebbjs/client';
```

Package `exports` in `package.json` use separate `browser` and `node` conditions to ensure the right implementation is bundled for each environment — `createServerClient` is excluded from browser bundles, `createClient`'s storage layer is excluded from Node bundles.

---

## Open Questions

1. **Transport** — HTTP/RPC today. Could support WebSocket for lower-latency server-to-server use cases in the future.

2. **Caching** — Should the server-side SDK have any local caching layer, or always go to the network? For SSR, a per-request cache might be useful to avoid redundant fetches within a single render.

3. **SSR response shape** — `createServerClient` needs to return data alongside the GSN it was fetched at. What does that API look like? Does every method return `{ data, cursor }`, or is the cursor surfaced separately (e.g., `client.cursor` after a fetch)?

4. **Browser client cursor initialization** — `createClient` and `useEbb` need to accept a `cursor` parameter for SSR handoff. This touches the browser client's bootstrap flow — specifically the handshake and catch-up phases. Needs to be specified as part of the browser client spec.

5. **`defineFunction` from server-side SDK** — Can the server-side SDK invoke `defineFunction` handlers via `client.functions.x()`? Almost certainly yes — it's the same HTTP endpoint. Worth confirming explicitly.

6. **Relationship to `defineAction`** — Can the server-side SDK call `defineAction`s directly, or only through the normal write path? TBD pending the `defineAction` spec.
