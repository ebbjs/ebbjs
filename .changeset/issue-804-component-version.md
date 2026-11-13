---
"@ebbjs/schema": minor
"@ebbjs/storage": minor
"@ebbjs/client": minor
---

Read migrations are declared per component, not per model.

`defineComponent` already carried `version`; it now validates it as an integer >= 1.
`defineMigration(component, from, to, fn)` declares one up-only step that transforms a
component's projected value, and `defineSchema({ migrations })` proves the steps form one
contiguous chain from version 1 to each declared version. A gap, step past the
declaration, duplicate `(component, from)` pair, or migration for an undeclared component
throws from `defineSchema` — boot, not the first read.

The replica persists a `componentVersions` map beside a record's rows and bumps the record to
format 4. A write stamps its component at the declared version; a loaded record keeps the
stamps it persisted. Projection compares that stamp with the declaration and runs the composed migration
chain, memoised per `(component, from, declared)`. A component stored at a version newer
than the client declares throws `ComponentVersionAheadError` instead of being read as the
older shape. The Action log and the materialized base are untouched; `replica.get`,
`toRaw()`, and history still read the stored shape.

The wire and the log carry no version, so a value materialized by the current session is
assumed current. Migrations therefore cover the client's own persisted upgrade path, not
data another client wrote against an older schema.
