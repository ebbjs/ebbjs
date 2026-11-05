---
"@ebbjs/client": minor
"@ebbjs/codemirror": minor
---

Presence is a typed, ephemeral, per-entity **channel** API instead of a
hard-coded text-cursor shape.

Declare the channels an app broadcasts with `definePresence(...)` and pass the
registry to `createClient({ presence })`:

```ts
const presence = definePresence({
  cursor: Type.Object({
    anchorId: Type.String(),
    anchorOffset: Type.Number(),
    headId: Type.String(),
    headOffset: Type.Number(),
  }),
  camera: { schema: Type.Object({ x: Type.Number(), y: Type.Number() }), ttlMs: 5_000 },
});
const client = createClient({ serverUrl, actorId, presence });
```

`client.presence.set(entityId, channel, value)` checks the channel name and the
`Static<>` value type at the call site and validates with `Value.Check`; an
undeclared channel is also an `UndeclaredPresenceChannelError` at runtime, and a
value that fails its schema is a `PresenceValidationError`. A client built
without a registry still has `client.presence`, with dynamic string channels and
unvalidated `unknown` values.

Sends coalesce per `(entityId, channel)` (a send on one entity or channel never
drops another's pending send), POST `{entity_id, data: {channel, value}}`, and
are never queued, retried, or written to the Outbox — a failed send is dropped
because the next write of that channel carries newer state. An oversized body
(over 8 KiB serialized) throws `PresencePayloadTooLargeError` synchronously at
the call site.

Reads go through `client.presence.forEntity(entityId, channel)`, a
`ReadonlyMap<actorId, PeerPresence<T>>`, and `client.presence.onUpdate(cb)`
reports the changed `(entityId, channel)` so a listener can ignore unrelated
high-frequency channels. Each channel has a receiver-side TTL (default 30 s;
`ttlMs: Infinity` opts out) and a per-`(entity, channel)` entry cap (default
100). `client.presence.clear(entityId, channel)` sends `{channel, value: null}`
so peers drop just that channel.

Presence still rides the live stream `subscribe()` opens, so its scope is the
groups you subscribe to and the peer set is dropped when that stream closes.

**Breaking:** `PresenceManager`, `presence.start()`, `presence.dispose()`,
`presence.setLocalCursor()`, and `PresenceEntry` are removed; `PeerPresence<T>`
replaces `PresenceEntry` and entries carry `data` instead of `cursor`.
`@ebbjs/codemirror`'s `createPresenceExtension` reads `entry.data`, and
`getPresence` is typed as `ReadonlyMap<string, PeerPresence<CursorPresence>>`.
