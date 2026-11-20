---
"@ebbjs/storage": minor
---

Add the component lease table: a refcounted claim on one `(entity, component)` value.

`createLeaseTable` is the residency primitive the replica's pins are being replaced by
(#935, part of #933). A caller acquires the components it reads and gets a single-shot
release back; two callers on the same key share one value and one read, and only the last
release starts the grace period. One `residencyTtlMs` (default 60s) decides how long an
inactive value stays warm, and expiry checks that nothing holds the key and that it is
still the generation the timer was armed for, so a remount inside the TTL cancels expiry
and a stale timer cannot free a re-acquired value. `stats()` reports `leased`,
`inactive`, `resident`, `timers`, and `oldestInactiveMs`. There is no cap and no
eviction by size. Nothing wires it into the replica yet.
