---
"@ebbjs/storage": minor
---

The replica reports the serialized bytes it retains, by category.

`replica.bytes()` splits the base into **row envelopes** (id, model, existence,
timestamps, last gsn), **in-memory values** (every component with its
`update_id`/`hlc` envelope), and the **index** (model, component, and adjacency
indices plus version stamps). It also counts the retained **journal** and
**unconfirmed writes** (the optimistic overlay, the composed views it caches,
and updates waiting for a base row).

The figures are UTF-8 bytes of JSON, so they compare with each other and across
runs; they are not V8 heap. `jsonBytes` and `utf8Bytes` ship with the replica so a
harness can count the same unit without a `Buffer`/`TextEncoder` dependency. The method is separate from `stats()` because it
serializes every retained structure, and it is diagnostic rather than a read
path. Residency bookkeeping — the lease table, the store-row set, reads in
flight — is deliberately not a category: it holds no row or value.

The client benchmark reports all seven categories in `## 8. Memory by
category`, adding an inactive query result's projected rows and the full-row
`ReplicaRecord` snapshot it can write, both measured outside the replica. See
`docs/research/966-memory-by-category.md`.
