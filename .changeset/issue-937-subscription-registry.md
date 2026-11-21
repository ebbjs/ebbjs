---
"@ebbjs/client": minor
"@ebbjs/storage": minor
---

Add the subscription registry and the replica claim a subscription holds.

Every live query and row subscription now lives in one registry
(`createSubscriptionRegistry`), exposed as `client.subscriptions`. An entry owns
its read set, its own revision cursor, the result its consumer published, the
claims its dependencies need, and whether it is still live. Dispatch reads the
replica's journal once per batch and hands each entry only the changes that
touch it; the query cache and the row watcher both mount on the registry instead
of running their own loops.

Residency follows the subscription: a live entry holds the components its result
reads, and unsubscribing releases them, which starts the residency grace period.
Two subscriptions reading one `(row, component)` share one resident value and
one claim. The query cache keeps its inactive-result TTL for now; that lifetime
merges with `residencyTtlMs` in #941, and indexed dispatch replaces the scan in
#938.

`Replica.acquire(id, components)` is the long-lived counterpart of
`Replica.read`: it claims the values a subscription depends on, installing any
the replica does not hold, and returns one idempotent release. A held component
needs no claim, a component the row does not carry is not claimed, and a claim
that resolves after its subscription ended releases what it took.

BREAKING CHANGE: `ReplicaAccess.signal` is replaced by
`ReplicaAccess.subscriptions`, and `createQueryCache` takes the subscription
registry where it took the replica signal.
