---
"@ebbjs/client": minor
---

Patch safe result changes into a cached result instead of re-running the query.

A change that can only rewrite a projected value of a resident row is now patched:
the rows it names are re-projected against the replica and spliced into the cached
result, so a one-row edit reads one row instead of the whole type. Measured on the
10,000-document fixture: a re-run examines 10,010 rows in ~16–18 ms of plan work; a
one-row patch examines 1 row in ~16 µs plus ~171 µs to splice it into the result.

The shapes that will not patch — and re-run exactly as before — are a predicate
field, an order key, a limited result, a join (its membership or a joined target's
rows), a row entering or leaving the set (a tombstone, a create, a delete, a scope
eviction, a membership write that moves `groupIds`), a value the result was holding
that the replica released, and a journal gap. `QuerySource.patch` is the optional
seam a source implements to take part — it must answer exactly the ids it was
handed, one row per id — and a source without it keeps re-running.

The fast path is not free for every model. An unselected `query()` read projects
every registered component of its source, so a row that does not carry an optional
lazy component (or does not have one resident) declines the patch and re-runs. A
result that has to acquire a projected value still re-runs, which is what makes the
patch the synchronous run it replaces.

Also exports `traversalCounter.resultRowsRead`, the rows a propagating result
materialized: a re-run's scan rows, a patch's by-id reads, or a row subscription's
one row per change. It is what makes the "10,000 rows to 1" claim observable from
application code and benchmarks. `SubscriptionWriter` now exposes the claims an
entry holds (`dependencies`), which the patch path uses to heal them for the rows
it rewrote.
