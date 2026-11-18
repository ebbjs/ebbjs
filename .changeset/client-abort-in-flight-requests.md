---
"@ebbjs/client": minor
---

`close()` aborts the client's in-flight requests instead of letting them finish.

Every plain HTTP path — catch-up, writes, entity reads, function calls, the group listing —
kept running after teardown and then applied rows, persisted replica state, or wrote
`acknowledged` outbox rows through a storage adapter that may already be closed. One
`AbortController` per client, aborted only from `close()`, now rides on the single wrapped
fetch the constructor builds, so every call site inherits it. A caller-supplied
`init.signal` is merged by hand rather than with `AbortSignal.any`, which cannot detach at
settle and would leave a listener on the session-long signal per request.

This is observable, so it ships as a minor. New: `ClientClosedError`, the one shape a
closed client reports. A `write()` after `close()` throws it before touching the outbox,
and a `write()` in flight when `close()` lands rejects with it, leaving its outbox entry
`pending` (the submit threw, so it is `unreachable`, not `error`) rather than marking it
acknowledged. No request that had not yet responded applies rows or marks an entry
acknowledged. Abort cannot retract work already past the fetch: a body read before
`close()` finishes applying, and the final replica save still runs so a clean teardown does
not lose local writes. A body read the abort interrupts rethrows instead of degrading to an
empty one, which is what stopped an interrupted `invokeFunction` from reporting a void
success.

Three follow-ons keep the guarantee honest: a `keepalive` request is the one the teardown
leaves on the wire, keyed on the flag rather than on the presence call site, because
`presence.leave({ keepalive: true })` comes from an unload handler; a backfill or group
listing a teardown interrupted reports no failures and `client.backfill()` resolves without
saving once closed; and replacing a session via `subscribe()` or calling a plain
`unsubscribe()` aborts nothing — only `close()` does.
