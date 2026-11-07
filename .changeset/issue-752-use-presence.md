---
"@ebbjs/client": minor
"@ebbjs/react": minor
---

`usePresence` — a typed presence subscription hook — and the one presence
surface that makes it typeable.

**Breaking (`@ebbjs/client`):** `client.presence` is now a single interface
keyed by the channel map, instead of two interfaces switched on the registry:

```ts
const presence = definePresence({ camera: Type.Object({ x: Type.Number() }) });
const client = createClient({ serverUrl, actorId, presence });

client.presence.forEntity(planId, "camera");
// ReadonlyMap<string, PeerPresence<{ x: number }>>
```

Without a registry the channel map defaults to the dynamic one: `forEntity`
takes any string and returns `PeerPresence<unknown>`. The caller-named
`forEntity<T>()` generic is gone — it promised any payload type without
checking one, and it made a registered client unassignable to an unregistered
one. Declare the channels with `definePresence` when you want the payload
typed. `UntypedPresenceApi` and `TypedPresenceApi` are replaced by
`PresenceApi<Channels>`, `PresenceChannelsMap`, and `PresenceChannelsOf<R>`.

Because a registered client is now a plain `SyncClient`, `EbbProvider`,
`useClient<C>()`, and `createEbbHooks<C>()` keep their original `SyncClient`
constraint — no erased client surface and no registry union in the React
package.

`usePresence(entityId, channel)` snapshots `client.presence.forEntity` and
subscribes to `client.presence.onUpdate` filtered to the same target, so a 20 Hz
camera channel does not re-render a cursor consumer. The store already notifies
on a peer's packet, on TTL expiry, and on stream reset, so a peer that leaves
stops rendering instead of leaving a stale cursor.

Bound from `createEbbHooks<C>()`, the channel is checked against the client's
`definePresence` registry and the peer payload follows the channel's schema:

```tsx
const { usePresence } = createEbbHooks<typeof client>();
const cameras = usePresence(planId, "camera");
// ReadonlyMap<string, PeerPresence<{ x: number }>>
```

The standalone `usePresence<T>(entityId, channel)` cannot see the client type
through React context, so it takes the payload type as its generic.
