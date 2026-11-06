---
"@ebbjs/client": minor
---

A `null` filter value now means "no live value".

A field predicate whose value is `null` matches a leaf the row never set and a
tombstoned (cleared) leaf alike. A non-null value still matches only an equal
stored value, so a declared schema default never widens a filter: the query
path stays schema-blind.

On the server, a `null` value now emits `json_extract(...) IS NULL` instead of
binding NULL into `= ?`, which SQL evaluates as never true. `json_extract`
returns SQL NULL for a missing path and for a JSON null alike, so one clause
covers both absent and tombstoned leaves.
