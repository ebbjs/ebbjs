---
"@ebbjs/react": minor
---

`usePresence` — a typed presence subscription hook.

Presence was a first-class client primitive with no React binding, so every app
re-implemented the same `useSyncExternalStore` over `client.presence.onUpdate`.
The package now ships the hook:

```tsx
const presence = definePresence({
  camera: { schema: Type.Object({ x: Type.Number(), y: Type.Number() }), ttlMs: 5_000 },
  cursor: Type.Object({ anchorId: Type.String(), anchorOffset: Type.Number() }),
});
const client = createClient({ serverUrl, actorId, schema, presence });

const { usePresence } = createEbbHooks<typeof client>();
const cameras = usePresence(planId, "camera");
// ReadonlyMap<string, PeerPresence<{ x: number; y: number }>>
```

The snapshot is `client.presence.forEntity(entityId, channel)` and the
subscription is `client.presence.onUpdate` filtered to that same target, so a
camera channel's traffic does not re-render a cursor consumer. The store already
notifies on a peer's packet, on TTL expiry, and on stream reset, so a peer that
leaves stops rendering instead of leaving a stale cursor.

Bound from `createEbbHooks<C>()`, the channel is checked against the client's
`definePresence` registry and the peer payload follows the channel's schema. The
standalone `usePresence<T>(entityId, channel)` cannot see the client type
through context, so it takes the payload type as its generic.

`EbbProvider` now accepts a client built with any presence registry: `EbbClient`
is `SyncClient<undefined> | SyncClient<AnyPresenceRegistry>`, so both real class
instantiations pass and the provider keeps its nominal client check. Inside the
provider the client is stored with its presence registry erased to a
non-generic read surface, and `useClient<C>()` restores the caller's type.
`SyncClient<undefined>` alone used to reject typed-presence clients because a
typed `forEntity` promises a narrower map than the untyped one.
