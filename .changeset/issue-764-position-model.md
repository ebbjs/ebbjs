---
"@ebbjs/schema": major
"@ebbjs/client": major
"@ebbjs/codemirror": major
"@ebbjs/storage": major
---

Collaborative text now stores immutable run cells and additive cut cells.

A text body is a `content` map of cells — a run is a fixed string anchored at
`(parentRunId, offset)`, and a delete is a cut `[from, to)` over the run it
belongs to. Runs are never split, rewritten, or extended: an insert at the end
of a run is a new run anchored at that run's length, and an insert mid-run is a
new run anchored at the offset, so editing one run cannot invalidate another
replica's writes. Cuts union per run, so concurrent deletes and delete-vs-insert
commute.

This changes what a persisted text body means:

- The internal encoding of a text body changed. The `content` map is
  **append-only** — a cell id, once written, is never rewritten — and the body
  now carries a `version` leaf declaring the cell format. Every write stamps
  it; a read of an unknown version fails with `DocumentVersionError`. A body
  without the leaf (an empty seeded document) is read as the current version.
- `deleted` and tombstone cell encodings are gone. Deletes are cut cells, and
  projection hides the covered characters of the owning run, leaving text
  inserted around them visible.
- Conflict slots collapse for text. Concurrent same-run edits are no longer
  conflicts, because runs and cuts merge without a losing action: the merged
  `content` map is the whole state. Text surfaces no conflict slots.
- An old IndexedDB database resets at open. `@ebbjs/storage` bumps
  `EBB_SCHEMA_VERSION` to 9; a database below 9 is discarded and rebuilt empty
  rather than migrated, so a tab carrying pre-release text rows does not
  half-read the new cell format. Server-side actions are untouched — this is a
  local-store reset.

`@ebbjs/client` and `@ebbjs/codemirror` follow the same cell format, and both
re-export the constants a caller needs (`DOC_CONTENT_FIELD`, `DOC_VERSION_FIELD`,
`CURRENT_TEXT_VERSION`, the cell schemas).
