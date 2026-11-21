---
"@ebbjs/client": minor
---

Dispatch a change batch through dependency indices instead of every entry.

Every batch used to be checked against every live query and row subscription,
so a busy client paid `subscriptions × changes` comparisons for a handful of
real hits. The subscription registry now declares what each entry reads to one
change dispatcher: the components and models a query projected, or the row a
row subscription watches and the membership row that files it. A batch then
costs the subscriptions it touches plus one index lookup per dependency kind
per change — 5,000 subscriptions and 100 changes report 2,621 touched and 280
lookups rather than 500,000 decisions, and one change over the same 5,000
reports 100 touched and 3 lookups.

The dispatcher also owns the single journal cursor, so a batch reads the
replica's journal once rather than once per entry, and an entry a batch does
not touch is never visited: its cursor derives from the dispatcher's own. A
journal gap — a cursor below the retained window, or an empty batch on an
advanced revision after a `load` — still re-runs every subscription, and
patch-versus-re-run stays a per-subscription decision for #942.

The registry keeps one cursor model: an entry's cursor is the revision its
consumer has processed. A batch advances it only for a consumer that had caught
up with the previous one, and advances it before the listeners run, so a
listener that throws cannot lose its own batch. A consumer whose result still
reflects an older revision — an async re-run in flight — seeks back to it and
keeps that lag through later batches, touched or not, until the run settles and
seeks forward. An entry no batch touches reports the dispatcher's cursor, so an
idle result stays `current` without a write per entry, while a lagging one keeps
reporting where its consumer is. Dispatch bookkeeping that throws skips that
entry without moving its cursor, so a later gap dispatches it again, and a
change the indices cannot resolve hands the batch to every entry — the same
answer a gap gets — rather than losing it for all of them.
