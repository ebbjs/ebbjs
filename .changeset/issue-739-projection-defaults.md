---
"@ebbjs/client": minor
---

Projection resolves a field's declared default: `stored ?? default` for both an
absent leaf and a tombstoned one. A tombstone with no default now projects as
`undefined` rather than `null`, so "cleared" and "never set" read the same, and
ordering compares fields through the same resolution so a sort never disagrees
with the value a row renders as. Query filtering is unchanged and never sees a
default.
