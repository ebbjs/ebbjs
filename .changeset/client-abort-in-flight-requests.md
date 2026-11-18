---
"@ebbjs/client": minor
---

`close()` aborts the client's in-flight requests instead of letting them finish.

Every plain HTTP path — catch-up, writes, entity reads, function calls, the group listing —
kept running after teardown and then applied rows, persisted replica state, or wrote
`acknowledged` outbox rows through a storage adapter that may already be closed. One
`AbortController` per client, aborted only from `close()`, now rides on the single wrapped
fetch the constructor builds, so every call site inherits it. A caller-supplied
`init.signal` is merged by hand, because `AbortSignal.any` is Node 20.3+ and the SSE
transport documents Node 18 for consumers.

This is observable, so it ships as a minor: an in-flight `write()` that used to resolve now
rejects with the `AbortError`, and its outbox entry stays `pending` (the submit threw, so
it is `unreachable`, not `error`) rather than being marked acknowledged after teardown. No
request that had not yet responded applies rows or marks an outbox entry acknowledged. Abort
cannot retract work already past the fetch: a response body read before `close()` finishes
applying, and the final replica save still runs so a clean teardown does not lose local
writes. A request aborted after its headers but mid-body surfaces as that endpoint's own
error, because the HTTP layer reads an unreadable body as empty.

Presence is the one exemption, and only for `keepalive`: `presence.leave({ keepalive: true })`
is sent from an unload handler where nobody can await it, so it has to outlive the `close()`
that follows. Replacing a session via `subscribe()` or calling a plain `unsubscribe()` does
not abort anything; only `close()` does.
