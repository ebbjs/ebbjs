---
"@ebbjs/client": minor
"@ebbjs/storage": minor
"@ebbjs/react": patch
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
  question. Read `entry.slots[i].remoteWins()` for field scope; an
  entity-scope entry has no slots.
- The `retry` re-stamp path (`restampField`, `restampUpdate`, `restampAction`,
  and the `stampAction` / `hlc` / `generateUpdateId` collaborators). Re-stamping
  every leaf recursed into map entries and rewrote their `update_id` and HLC —
  the only code path that could silently fabricate ordering on an append-only
  log. "Make my value win" is a normal write through `defineAction` with a
  fresh clock.
- `Outbox.retryConflicted(originalId, action)`. It is replaced by
  `releaseConflict(actionId)`, which returns the row to `pending` with its
  Action untouched.

New verbs:

- `client.conflicts.sendLocalActions(conflictId)` clears the hold and submits
  the held Actions verbatim — same action id, Update ids, and field HLCs.
- `client.conflicts.clearLocalActions(conflictId)` drops the held Actions and
  the local writes the hold was keeping off the wire, converging those
  subjects on the server's view.

Subject hold:

- Every subject named by an open conflict is held. A later local write to it is
  durable and applied optimistically, but `pending()` and the flush exclude it
  until the conflict resolves.
- The hold is derived from the durable `conflicted` rows, so a reload preserves
  it with no second store.
- The hold applies to `pending` writes only; an `acknowledged` write is already
  on the server and is never re-held. Detection now considers `pending` writes
  only for the same reason.
- `Outbox.heldPending(subjects)` snapshots the writes a hold excludes and
  `Outbox.dropHeld(actionIds)` removes exactly those; a write made after the
  hold lifts is never dropped.

Report additions: `Conflict.scope` and `Conflict.remoteActions` (actor id,
action id, GSN of the concurrent missed Actions). The per-subject `before` /
`after` rows and their `EntityDiff` already existed. `ConflictEntry.slots` is
now absent for an entity-scope entry, and `ConflictEntry` carries its own
`scope` and `remoteActions`. `OutboxConflict` gains required `scope` and
`remoteActions` fields, persisted under IndexedDB schema version 10 (additive:
a pre-v10 row reads as field scope with no recorded remote context).
`ConflictRemoteAction` is exported from `@ebbjs/storage/types` and
`@ebbjs/client`; `ConflictScope` remains the single declaration exported from
`@ebbjs/schema`. The IndexedDB outbox store normalizes a pre-v10 payload on
read, so a row written before the bump cannot make the conflict view
unreachable.

`clearLocalActions` drops the pending writes to the conflict's subjects, so the
subjects really converge. An Action writing several subjects is held or
dropped whole; an Action cannot be sent in part. In a partial pass, only the subjects the resolved entries released are
converged; a subject a failed entry still names stays held and keeps its
writes. A durable-store fault in the final drop or flush rejects rather than
returning a partial result.
