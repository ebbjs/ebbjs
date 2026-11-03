---
"@ebbjs/client": patch
---

Deterministic ids for the rows a derived field implies.

A derived body (`e.collaborativeText()`) is not stored on its parent: it is a
document entity, a relationship, and `entityGroup` rows. Those ids used to be
minted, so two clients that independently decide to create the same missing
body would each address it under their own id — two documents, two
relationships, text split between them.

Both ids are now derived from facts every client already agrees on, the parent
id and the field accessor, so every client derives the same rows for the same
body. The document id also names the document's entity type, because the server
binds an id to the type it was first committed under, so a rename has to yield a
new document; the relationship id does not, so a rename re-points the same row.

A single writer's behaviour is unchanged, but the rows it creates now carry these
ids instead of minted ones. They are opaque strings to the server, so nothing
else on the wire moves; live rows keep the ids they were created under, so there
is no migration. This lands the identity half of the derived-row backfill; the
write-side trigger and enumeration follow separately.
