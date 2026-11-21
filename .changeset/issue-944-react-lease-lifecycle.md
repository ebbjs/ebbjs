---
"@ebbjs/client": minor
"@ebbjs/react": minor
---

A dev-only lease watchdog, and the React read hooks' lease ownership made explicit.

The React hooks have owned their subscription since the registry landed — `useSyncExternalStore`
subscribes once per committed mount and unmounting calls the one release it was handed — but
nothing said so, and nothing could say when a release never came. Residency has no cap and no
eviction by size, so a mounted reader whose cleanup never runs holds its values for the life of
the client; that is the one leak the model cannot heal by itself.

`createSubscriptionRegistry(replica, { watchdog })` reports two shapes of it: a live entry whose
claim set has sat unchanged past `staleAfterMs` (default 5 minutes), and a `close()` that leaves
live readers behind. One warning per quiet period: the period runs from the last claim-set change,
an entry already reported for its current claim set is not reported again for it, and a reader
holding no claims is not reported at all. The watchdog is on in development and inert in a
production build — `process.env.NODE_ENV === "production"`, or a bundle with no `process` at all,
arms no timer and prints nothing; `watchdog: false` turns it off outright, and `warn` / `now` /
`intervalMs` exist so a host can route or test the reports.

The query hook's contract is unchanged and now documented and covered by tests: a mounted result
leases the components it reads, unmounting releases every one and starts the one `residencyTtlMs`,
a remount inside that TTL performs no store read and no re-run unless the read set went stale (then
one re-run), and a render that throws still releases through React's own cleanup. `loading` stays
a derived first-mount flag (`status === "unloaded"`), not a residency declaration.
