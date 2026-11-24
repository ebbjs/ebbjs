---
"@ebbjs/storage": minor
"@ebbjs/client": minor
---

Group-scope eviction reads membership from the row index.

`Replica.membershipRows()` answers every live membership row — membership row
id, group id and member entity id — from the index entries, and the row index
exposes the same read with an optional entity id. Scope eviction derives each
row's groups from that read and the group and grant rows from the component
map, so removing a value from the cache cannot change which groups a row is in.
A membership add, remove or tombstone is observed immediately, and the model
sweep and value reads the old calculation needed are gone.
