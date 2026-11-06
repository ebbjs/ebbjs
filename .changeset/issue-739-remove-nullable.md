---
"@ebbjs/schema": major
"@ebbjs/client": major
---

Remove `.nullable()`.

No field schema may admit `Null` any more: `{ value: null }` is the wire
tombstone, not a stored null, so a field that admits one has no meaning.
`defineEntity` rejects a `Null`-admitting field at registration and points at
declarations (`default()` for a read value, `unset` to clear one).

The two production fields that used it are ordinary optional reads:
`relationship.target_id` is absent on a deleted edge (the edge is deleted, not
nulled) and `group.apps` is absent on an unscoped group (absent means every
app, while `{}` means none — neither takes a default). Their read types are
now `T | undefined`. The bundled runner is rebuilt.
