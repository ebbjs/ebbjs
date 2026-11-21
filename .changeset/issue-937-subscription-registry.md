---
"@ebbjs/client": minor
"@ebbjs/storage": minor
---

Add the subscription registry and the replica claim a subscription holds.

Every live query and row subscription now lives in one registry
(`createSubscriptionRegistry`), exposed as `client.subscriptions`. An entry owns
its read set, its own revision cursor, the result its consumer published, the
claims its dependencies need, and whether it is still live. The registry holds
the one replica subscription and dispatch cursor, reads the journal once per
batch, advances every live entry's cursor through it, and hands the changes only
to the entries they touch. One consumer's throwing listener is reported and
cannot skip a peer or lose its own batch: the cursor has already moved. The
query cache and the row subscriptions both mount on the registry instead of
running their own loops.

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

A live entry claims only the components its result already has resident: it does
not re-materialize a value that left the replica, even though `acquire` would
install it. A row that lost a component to an earlier expiry stays partial under
its subscription until the next read or re-run, which is #940's selection work.

BREAKING CHANGE: `ReplicaSignal` and `client.replicaSignal` are removed — the
registry owns dispatch and reads the journal itself, so the extra fan-out cursor
had no consumer. `ReplicaAccess.signal` is replaced by
`ReplicaAccess.subscriptions`, and `createQueryCache` takes the subscription
registry where it took the replica signal.
