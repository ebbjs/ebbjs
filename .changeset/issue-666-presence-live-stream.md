---
"@ebbjs/client": patch
---

Presence rides the client's live stream instead of a connection of its own.

`client.presence` used to open a second `/sync/live` stream and POST a
`/sync/handshake` on every `start()`, retrying until the actor belonged to a
group. The server keys subscribers by connection, so every presence packet was
fanned out twice and every action batch was encoded into a stream that discarded
it. `SyncClient` now folds each `presence` event from the stream `subscribe()`
already holds into the presence map before the subscriber's `onEvent` sees it.

Presence scope is therefore the groups you `subscribe()` to, not every group the
handshake returned; presence for a group you are not streaming is noise. The map
clears when that stream closes, because a disconnected client cannot know its
peers. `presence.start()` and `presence.dispose()` remain as deprecated no-ops
so existing callers keep compiling; the generic channel API that replaces them
lands separately.
