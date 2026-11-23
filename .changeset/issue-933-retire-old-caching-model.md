---
"@ebbjs/client": minor
---

Remove the surfaces the retired caching model left behind.

`projectRows` is gone: `projectRow` projects one entity and a caller with a list maps it.
Repo-wide the only consumers were the barrel and one assertion beside an existing
`projectRow` check, so no behaviour went uncovered. `StructuralReads.indices` is gone as
well — nothing registered it in the change dispatcher, and a reader who trusted the field
learned nothing about how a read invalidates, so #961 adds it back with the resolvers that
use it. `createLocalQueryStore` is gone: a chain over already-materialized rows (a row
accessor, or a builder from `buildQueryBuilder`) has no engine cache entry, so `.result()`
and `.subscribe()` now refuse with a clear error instead of serving a second, uncached store
that silently ignored `QuerySubscribeOptions.initial`.

BREAKING CHANGE: `projectRows` and `StructuralReads.indices` are removed, and `.result()` /
`.subscribe()` throw on a chain over already-materialized rows.
