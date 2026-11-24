---
"@ebbjs/client": minor
---

Rename the query result surface after the model it implements, and stop keeping
a second copy of the subscription revision.

`QueryCache`, `createQueryCache`, and `client.queries` described a cache, while
the module holds no map, no timer, and no snapshot copy: it reads results out of
the subscription registry, which owns the snapshot, the revision, and the
claims. It is now `QueryResults`, `createQueryResults`, and `client.results`,
and the files are `query-results.ts` and `query-results.test.ts`. `QueryStore`
stays the per-result `getSnapshot` / `subscribe` handle that `.result()` returns;
`QueryResults` is the container `.watch()` lives on.

The consumer no longer keeps `QueryRun.at` beside `Subscription.revision`. A
result's status and its staleness now come from the one revision on its
registry entry: dispatch moves a caught-up entry's revision after its listeners
run, unless the consumer set it with `seek` or the new `hold`, so a result that
still reflects an older revision holds it back without a copy of its own.
Nothing about the lifecycle changed: an inactive result stays `stale` across
batches it does not read, a remount inside the residency TTL reads nothing and
re-runs nothing when nothing relevant landed, a stale result re-runs exactly
once on remount, a patch advances the entry's revision and reports `current`,
and a journal gap still re-runs.

Breaking changes:

- `QueryCache` is now `QueryResults`.
- `createQueryCache(replica, subscriptions?)` is now
  `createQueryResults(replica, subscriptions?)`.
- `client.queries` is now `client.results`; on the exported `ReplicaAccess` and
  `QueryContext` types the field is `results` too.
- `queryCacheKey(surface, query)` is now `queryResultKey(surface, query)`.
- `Subscription.cursor` (and every `SubscriptionSnapshot.cursor`) is now
  `Subscription.revision`; `SubscriptionWriter` gains `reflected` (the revision
  the published result reflects) and `hold()` (keep it where it is).
- The internal `ChangeDispatcher.cursor()` is now `revision()`.

There are no aliases, per the pre-release policy.
