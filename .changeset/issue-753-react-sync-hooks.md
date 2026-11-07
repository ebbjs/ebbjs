---
"@ebbjs/react": minor
---

Sync-state hooks: `useOutbox`, `useConflicts`, and `useEbbStatus`.

`@ebbjs/client` already publishes `client.sync.outbox`, `client.sync.conflicts`,
and the aggregate `client.status` as read-only observables — a synchronous
`get()` plus a `subscribe(cb)` — built so a UI can render pending depth,
conflict depth, and the last sync time without polling. `@ebbjs/react` bound
only `useConnection`, so every app wrote its own `useSyncExternalStore`
wrapper. The binding is the missing half:

```tsx
const { connection, lastSyncedAt, outbox, conflicts } = useEbbStatus();
if (outbox.pending > 0) return <span>Saving…</span>;
if (conflicts.count > 0) return <span>{conflicts.count} edits need review</span>;
return <span>Synced</span>;
```

- `useOutbox()` returns the `OutboxSnapshot`: `pending`, `acknowledged`,
  `error`, `conflicted`, `flushLatency`, and `storeFaults`.
- `useConflicts()` returns the `ConflictSnapshot` (`count` and `conflicts`),
  republished whenever the outbox's counts change — a detection, a resolution,
  and the initial durable load all arrive that way, never through
  `client.conflicts.list()`.
- `useEbbStatus()` returns the aggregate `ClientStatus`: `connection`,
  `lastSyncedAt`, `outbox`, and `conflicts`.
- `useSyncObservable<T>(observable)` is the generic wrapper the three build
  on, exported for `client.sync.backfill` and app-owned observables. It keeps
  one subscription per observable across re-renders.

The hooks are read-only, matching the client's split: resolution stays on
`client.conflicts` (`list()` then `resolve(id, "retry" | "discard")`), so the
decision and its durable write stay outside React's render pass.

`createEbbHooks<C>()` now binds the three alongside `useClient` and
`useQuery`; the generic `useSyncObservable` stays unbound. `OutboxSnapshot`,
`ConflictSnapshot`, `ClientStatus`, and `ReadonlyObservable` are re-exported
from `@ebbjs/client` so an app never imports the client just for a snapshot
type.
