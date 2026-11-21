---
"@ebbjs/storage": minor
"@ebbjs/client": minor
---

Replace the replica's pins with component leases.

`open` / `close` are gone: residency is a lease the replica takes for a read and releases
when the value is installed. A released value stays resident for `residencyTtlMs` (default
60s, was a 30s pin TTL), a leased value is never released, and there is still no cap. Reads
go through `replica.read(id, components)`, which installs the non-held components the caller
names and returns the composed row; `client.<entity>.get(id)` and a cold join use it. The
pin table, its LRU order, `isOpen`, and the pin stats are deleted. `ReplicaStats.pinned` and
`pinnedComponents` are replaced by `ReplicaStats.leases` (`leased`, `inactive`,
`oldestInactiveMs`, overall and per component), and `ReplicaOptions.pinnedTtlMs` by
`residencyTtlMs`. Acquiring or releasing a value no longer advances the content revision:
installing an on-demand component and expiring one are residency events, so neither journals
an entry and neither makes a cached query re-run.

BREAKING CHANGE: `Replica.open`, `Replica.close`, and `Replica.isOpen` are removed in favour
of `Replica.read`; `ReplicaOptions.pinnedTtlMs` is renamed `residencyTtlMs`;
`ReplicaStats.pinned` and `ReplicaStats.pinnedComponents` are removed in favour of
`ReplicaStats.leases`.
