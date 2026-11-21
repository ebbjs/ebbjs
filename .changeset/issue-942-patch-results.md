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
seam a source implements to take part; a source without it keeps re-running.
