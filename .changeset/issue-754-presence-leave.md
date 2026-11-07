---
"@ebbjs/client": patch
"@ebbjs/react": patch
---

`client.presence.leave()` retracts every `(entityId, channel)` this session
announced, posting a `null` for each so peers drop this actor immediately
instead of waiting out the channel's TTL. It is best-effort and idempotent, and
flushes through the normal debounced transport rather than waiting a debounce
window.

Pass `leave({ keepalive: true })` from a `pagehide` handler: the option marks
those POSTs `keepalive` so the leave survives page teardown, where a normal
presence write would be dropped with the document. Ordinary sends stay
unmarked. `client.close()` remains local teardown — it cancels pending sends
and sends no leave, because a transient remount must not broadcast an absence.

`@ebbjs/react` wires the unload path for you: `<EbbProvider>` leaves with
`keepalive` on `pagehide`, so an app that never heard of `leave` stops ghosting
when its tab closes. A remount, a client swap, and a hidden tab all stay put —
only page teardown retracts presence, and a custom provider calls
`usePresenceLeave()` instead.
