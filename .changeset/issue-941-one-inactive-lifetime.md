---
"@ebbjs/client": minor
---

Merge the query cache and the residency TTLs into one inactive lifetime.

A released query result is now an inactive subscription in the registry: it keeps
its result, its revision cursor, and the component leases its result read for one
`residencyTtlMs` (default 60s), then result and claims end together. A remount
inside that lifetime performs no store read and no re-run when nothing relevant
changed; a change that touched the read set marks the result stale and the remount
re-runs once. The query cache is a view over that registry — it holds no result,
no entry map, and no timer of its own — so there is one answer to how long an
unwatched read stays warm.

Breaking changes:

- `SyncClientOptions.queryTtlMs`, `DEFAULT_QUERY_TTL_MS`, and
  `QueryCacheOptions` are gone. `residencyTtlMs` is the one inactive lifetime for
  both a released component value and an inactive query result; a non-positive or
  non-finite value disables expiry for both.
- `createQueryCache(replica, subscriptions?)` no longer takes a lifetime option.
  `createSubscriptionRegistry(replica, { residencyTtlMs })` owns it.
- A query subscription's entry stays registered after its last subscriber leaves
  and reports `state: "inactive"`, with its claims still leased. `SubscriptionState`
  gains `inactive`, `SubscriptionStats` gains `inactive`, and a registry entry now
  carries the consumer state it was opened with.
- A change listener receives the entry's writer as its fourth argument, so an
  inactive result can publish `stale` without holding a subscriber.
