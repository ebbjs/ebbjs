---
"@ebbjs/client": minor
---

`close()` aborts the client's in-flight requests instead of letting them finish.

Every plain HTTP path — catch-up, writes, entity reads, function calls, the group listing —
kept running after teardown and then applied rows, persisted replica state, or wrote
`acknowledged` outbox rows through a storage adapter that may already be closed. One
`AbortController` per client, aborted only from `close()`, now rides on the single wrapped
fetch the constructor builds, so every call site inherits it. A caller-supplied
`init.signal` is merged by hand rather than with `AbortSignal.any`, which would impose a
browser floor the package does not declare.

This is observable, so it ships as a minor: an in-flight `write()` that used to resolve now
rejects with the `AbortError`, and its outbox entry stays `pending` (the submit threw, so
it is `unreachable`, not `error`) rather than being marked acknowledged after teardown. No
request that had not yet responded applies rows or marks an outbox entry acknowledged. Abort
cannot retract work already past the fetch: a response body read before `close()` finishes
applying, and the final replica save still runs so a clean teardown does not lose local
writes. A body read that the abort interrupts now rethrows instead of degrading to an empty
one, which is what stopped an interrupted `invokeFunction` from reporting a void success.

Three follow-ons keep the guarantee honest: a `keepalive` post is the one request teardown
leaves on the wire (`presence.leave({ keepalive: true })` comes from an unload handler, so
it is exempt by the flag rather than by call site); backfill and the group listing stop
reporting cancelled reads as failures, and `client.backfill()` resolves as a no-op once
closed rather than saving the replica through a closed adapter; and replacing a session via
`subscribe()` or calling a plain `unsubscribe()` aborts nothing — only `close()` does.
