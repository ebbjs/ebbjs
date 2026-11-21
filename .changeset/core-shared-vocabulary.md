---
"@ebbjs/client": minor
"@ebbjs/core": minor
"@ebbjs/schema": minor
"@ebbjs/storage": minor
---

One owner per duplicated concept, in `@ebbjs/core`.

`@ebbjs/storage` deliberately does not depend on `@ebbjs/schema`, and both already depend on
`@ebbjs/core`, so the vocabulary they must agree on now lives there once.

```diff
-# schema/src/platform-model.ts   export const GROUPS_ACCESSOR = "groups"
-# schema/src/reserved.ts        export const RESERVED_MEMBERSHIP_NAMES = ["groups"] as const
-# storage/src/internal/reverse-index.ts  const MEMBERSHIP_ACCESSOR = "groups"
+# core/src/system.ts            export const GROUPS_ACCESSOR = "groups"
```

- `GROUPS_ACCESSOR` is declared in `@ebbjs/core` and re-exported by `@ebbjs/schema`. The storage
  adjacency index's membership accessor and `RESERVED_MEMBERSHIP_NAMES` both derive from it, so the
  reserved name and the index key cannot drift apart.
- `ConflictScope` (`"field" | "component" | "entity"`) is declared in `@ebbjs/core` and aliased by
  `@ebbjs/schema`, by `OutboxConflict.scope`, and by the client's catch-up pass. A fourth scope is
  now a compile error at the declaration, the persisted payload, and the comparison, rather than a
  silently-rejected persisted shape.

`@ebbjs/storage` grows two names and one default:

- `DEFAULT_DB_NAME` is the database an IndexedDB adapter opens when the caller passes none.
- `RESET_VERSIONS` replaces the seven `*_RESET_VERSION` constants and the hand-re-listed array built
  from them: one list of `{ version, reason }`, which `createEbbStores` and the doc block both read.
  A gate added to the list is a gate the reset runs; versions and behaviour are unchanged.
- `DEFAULT_JOURNAL_CAPACITY` and `DEFAULT_PINNED_TTL_MS` are exported, and the `ReplicaOptions`
  docs reference them instead of restating their numbers.
