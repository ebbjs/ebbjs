# (Superseded)

Presence cursors are not a separate slice in the optimization pass. The presence changes are minor (tracking `(runId, offset)` pairs instead of bare node IDs) and are folded into the component docs:

- [presence.md](../components/presence.md) — updated presence types and position resolution
- [relay.md](../components/relay.md) — updated presence message format

Presence changes can be implemented alongside any slice from Slice 3 onward.
