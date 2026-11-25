---
"@ebbjs/client": minor
---

Register the relation, existence and scope index resolvers (#961).

A query read now declares the derived indices its predicates and joins read —
`relation:<as>/<type>` for each target a relationship predicate or forward join
names, `exists:<component>` for an existence predicate, and `scope` for each
group a membership predicate names. The subscription registry serves them from
resolvers over the row index from #971, so a change is matched by the index key
it moved rather than by the component it is filed under. On the benchmark's
relationship-heavy fixture — 1,000 subscriptions, one per relation target, and a
100-change batch of writes to those targets — subscriptions touched per batch
fall from 1,000 to 100.

The fallback is conservative by construction. A resolver that cannot prove the
keys a change moved answers `null` — a link write never names the target it
dropped, and an evicted row leaves no membership to read — and dispatch then
touches every entry that declared that index, which is the breadth the component
read set gave before. The component dependency stays in the read set for claims
and re-checks, but leaves the dispatch set where an index covers it, so a
resolver fallback, never a narrower guess, is what remains.

The coverage holds once a result claims values: a covered join target model also
covers the exact components the result claims from it, and a self-relation keeps
its source model dependency because source and target share one. A differential
test compares every retained result with a fresh plan run after each write and
pins both rules (#1002).
