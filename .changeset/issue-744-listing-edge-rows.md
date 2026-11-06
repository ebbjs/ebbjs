---
"@ebbjs/storage": patch
"@ebbjs/client": patch
---

Seed relationship rows in the group listing, and reset a base seeded before
they were there (#744).

A relationship row is scoped by its **source** and owns no `entityGroup` row,
while the listing enumerates memberships — so a replica built from the listing
plus its tail held no edge created before its watermark, for good. Every
relationship read on such a device answered "nothing linked": an accessor
returned `null`, an adjacency join came back empty, and `readGeneratedParts`
could not see a document whose edge it discovers through. The listing now
ships the live relationship rows of each page's sources, in the same `entities`
array and under the same page token and watermark. Nothing on the wire or in a
seeded row changes shape; a seeded edge is an ordinary snapshot `put`.

The client's resume record gains an optional listing version (`@ebbjs/storage`
`CursorRecord.listingVersion`), written when a seed starts and kept when it
completes, so a base records what the listing it came from could carry.

A base seeded before this version is **reset, not re-listed**, and the reset
takes the existing invalid-cursor path: the action log, entity cache, replica,
and cursors go, the outbox stays, and every subscribed group re-seeds. A
put-only seed cannot remove a row the server deleted between the old base and
the new watermark, so re-listing would keep that row while the cursor moved
past its delete. The reset costs one re-list per device, once.

`listingVersion` is optional, so a stored resume record from an earlier release
reads back as version 0 and `EBB_SCHEMA_VERSION` does not move for it. A base
the log alone built has no listing to redo and is left alone.
