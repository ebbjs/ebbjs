---
"@ebbjs/client": minor
"@ebbjs/schema": minor
"@ebbjs/storage": minor
---

Remove the declared read-residency policy: `loading` and `materialization` are gone.

`ComponentOptions.loading` (`"eager"` / `"lazy"`), `ModelOptions.materialization`
(`"held"` / `"on-demand"`), the `ComponentDef.loading` and `ModelDef.materialization`
fields, and `ModelRegistry.loadingOf` are deleted. A declaration that still names one
fails at `defineComponent` / `defineModel` rather than being ignored. Residency is now
decided by what the replica folded and by the leases a read holds: a synced row carries a
value for every component it knows, and a row the replica does not hold — one outside the
client's subscribed scope, or one the persisted view did not carry — is served by the
entity store on read and released again after `residencyTtlMs`. There is still no cap, and
a component selection is the only thing that narrows what a read projects. A value the log
folded has no lease, so nothing reclaims it today: it stays resident for the session, and
reclaiming it needs a memory budget tracked in #957.

`MaterializationPolicy`, `holdAll`, `Replica.isHeld`, and `Replica.isRowHeld` are removed;
`Replica.fullyResident(row)` replaces the last of them as the store-mirror rule. `readComponent`
may return the whole row: the replica adopts it, keeping any value it already holds for
itself. `ReplicaStats` loses `held`, `heldByModel`, `heldComponents`, `residentComponents`,
`nonResident`, and `nonResidentComponents`; `entities`, `byModel`, `components`, and
`leases` remain. `ReplicaRecord.notResident` is gone, so a persisted record carries only
rows the replica held at the time.

Durability is unchanged: the entity store still receives every synced row whether or not
its components are resident, and a record written by this build carries the same rows it
did before the removal. `REPLICA_RECORD_FORMAT` bumps 6 → 7, because a pre-#943 record
names a row's unpersisted components only in `notResident`; reading one would adopt a
partial row as whole, so it is discarded and the client replays the Action log instead.

BREAKING CHANGE: component `loading` and model `materialization` are removed with no alias;
`MaterializationPolicy`, `holdAll`, `Replica.isHeld`, `Replica.isRowHeld`, the `held` /
`nonResident` replica stats, and `ReplicaRecord.notResident` are removed. `Replica.fullyResident(row)`
replaces `isRowHeld`.
