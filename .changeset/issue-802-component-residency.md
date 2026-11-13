---
"@ebbjs/client": minor
"@ebbjs/storage": minor
---

Hold, pin, and cold-read replica data per component instead of per row model.

`MaterializationPolicy.holds` now takes a component (`<model>/<leaf>`), and the client
derives it from the model registry, so a model's `materialization: "on-demand"` seeds
`lazy` on each of its components and a single lazy component on a held model works with no
extra declaration. A row is resident iff any of its components is held, or the row is
pinned; its base row can be partial, with the components it knows exist but does not hold
tracked as dormant. `Replica.open(id, component)` / `close(id, component)` address one
component, the new `readComponent` seam returns one component's value, and
`ReplicaStats` reports `components`, `residentComponents`, `heldComponents`,
`pinnedComponents`, `nonResidentComponents`, and `nonResident`. `ReplicaStats.pinned`
counts component pins, as do `pinnedCapacity` and the TTL.

The persisted replica record moves to format 3: rows carry their held components and a new
`notResident` map carries the components whose values are not persisted. An older record
reads as absent, which resets local records as decision 9 allows.
