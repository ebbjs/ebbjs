---
"@ebbjs/storage": minor
---

One list of storage types, re-exported from both entries.

The root entry and `@ebbjs/storage/types` were two hand-maintained copies of the same
export list, and they had drifted: `ConflictHold`, `ConflictRemoteAction`, and
`ReplicaStats` were in `types/index.ts` but missing from the root entry's own module. The
list now lives in `src/types/index.ts` and the root entry re-exports it whole, so both
paths always publish the same types — the three names included — and can no longer
disagree about what `@ebbjs/storage` exports.

```diff
-import type { StorageAdapter } from "@ebbjs/storage";
+import type { StorageAdapter, ConflictHold } from "@ebbjs/storage";
```

The redundant re-export block in `types/storage-adapter.ts` is gone; that module now
exports only `StorageAdapter`.
