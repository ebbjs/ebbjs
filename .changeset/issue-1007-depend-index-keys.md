---
"@ebbjs/client": minor
---

Let a subscription consumer supply derived-index keys (#1007).

`SubscriptionWriter.depend` and `Subscription.depend` now take an optional list
of `IndexDependency` keys beside the claims: `depend(dependencies, indices?)`.
A result whose keys come from the rows it holds rather than from its query — the
membership row each projected row is filed by — can declare them there, and the
registry merges them with the entry's declared keys, dedupes by `(index, key)`,
and re-indexes that one entry. Adding or removing a key costs the entry's own
re-index; it re-acquires nothing, does not move the entry's claim generation,
and does not restart the lease watchdog's quiet period, because no claim moved.

`indices` absent means "no opinion": the keys the consumer supplied stay in
force, so the patch path's `depend(dependencies)` is unchanged. That default is
safe because a patch rewrites a row in place and cannot change the set of rows a
result holds; a caller that changes its rows must state the new keys, and
`indices: []` withdraws them. Row subscriptions are unaffected, and
`depend(dependencies)` keeps its exact behaviour for every existing caller.

The seam narrows **dispatch** only. A consumer that registers keys has to match
its own re-checks against the same keys in the same change, which is #1011's
work for the read path: keys registered here while `isRelevant` still tests the
old read set would let dispatch deliver a change the consumer then seeks past.
`IndexDependency` is now exported from the package entry point, so a consumer
can name the shape of the keys it supplies.
