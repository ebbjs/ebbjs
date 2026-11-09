---
"@ebbjs/client": minor
"@ebbjs/storage": minor
---

One generic conflict: scope is declared, policy is application code.

Ebb holds and reports; the application copies a backup, resolves, does
nothing, or writes again. Ebb is pre-1.0, so the breaking surface ships as a
minor rather than a major, following the #692 precedent.

Removed:

- `client.conflicts.resolve(conflictId, "retry" | "discard")`,
  `client.conflicts.resolveEntries(entryIds, ...)`, and the
  `ConflictResolution` type.
- `Conflict.remoteWins()`. It was an entity-level aggregate of a position-level
  question. Read `entry.slots[i].remoteWins()` for field scope; entity scope has
  no slots.
- The `retry` re-stamp path (`restampField`, `restampUpdate`, `restampAction`,
  and the `stampAction` / `hlc` / `generateUpdateId` collaborators). Re-stamping
  every leaf recursed into map entries and rewrote their `update_id` and HLC —
  the only code path that could silently fabricate ordering on an append-only
  log. "Make my value win" is a normal write through `defineAction` with a
  fresh clock.

New verbs:

- `client.conflicts.sendLocalActions(conflictId)` clears the hold and submits
  the held Actions verbatim — same action id, Update ids, and field HLCs.
- `client.conflicts.clearLocalActions(conflictId)` drops the held Actions, and
  any later local writes to the same subjects, converging those subjects on
  the server's view.

Subject hold:

- Every subject named by an open conflict is held. A later local write to it is
  durable and applied optimistically, but `pending()` and the flush exclude it
  until the conflict resolves.
- The hold is derived from the durable `conflicted` rows, so a reload preserves
  it with no second store.
- The hold applies to `pending` writes only; an `acknowledged` write is already
  on the server and is never re-held. Detection now considers `pending` writes
  only for the same reason.

Report additions: `Conflict.scope`, `Conflict.remoteActions` (actor id, action
id, GSN of the concurrent missed Actions), and per-subject `before` / `after`
with an `EntityDiff`, which were already present. `ConflictEntry.slots` is now
absent at entity scope. `OutboxConflict` gains required `scope` and
`remoteActions` fields; `ConflictScope` and `ConflictRemoteAction` are exported
from `@ebbjs/storage/types` and `@ebbjs/client`.

`clearLocalActions` drops pending writes to the conflict's subjects, so the
subjects really converge. An Action writing several subjects is held or
dropped whole; an Action cannot be sent in part.
