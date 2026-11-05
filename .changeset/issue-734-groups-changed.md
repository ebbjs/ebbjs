---
"@ebbjs/client": minor
---

Live membership changes: a `groups_changed` control event, and a client that
acts on it.

The server now pushes `event: control` with
`{"groups_changed": true, "reason": "membership"}` to every live connection of
every actor whose group view a committed Action changed — a `groupMember` put,
patch, delete, or a row re-keyed to another actor. The event carries no delta:
it is a wake-up. It rides the post-apply fan-out path, so a client that reacts
immediately cannot handshake into the pre-apply state, and it is coalesced per
connection per commit. Actions that touch no membership emit nothing, and a
missed event is covered by the reconnect handshake.

`SyncClient` handles it by re-handshaking and reconciling the live subscription
against the previous handshake's membership: a gained group joins the
subscription, is seeded from its group listing, and streams without a reload; a
lost group leaves and its replica rows are evicted. Only the membership
difference is applied, so a group whose membership did not change keeps the
subscription the app chose. The same refresh runs on each reconnect once a
handshake has run, so a change whose event died with a dropped stream still
reconciles. The `behind_watermark` stream restart is unchanged.
