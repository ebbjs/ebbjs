---
"@ebbjs/client": minor
"@ebbjs/storage": minor
---

Remove the replica's pin cap: a read keeps every component it selects.

`ReplicaOptions.pinnedCapacity` and `SyncClientOptions.pinnedCapacity` are gone, along
with the LRU trim that released the least recently opened component once the window
filled. Opening a component no longer releases another one, so a row with more on-demand
components than the old default of 16 no longer comes back partial: the components
requested first were dropped silently, with no error and no event. Memory is bounded by
`close` and `pinnedTtlMs` alone — a component stays resident until it is closed and its
TTL elapses — and `DEFAULT_PINNED_CAPACITY` is no longer exported.
