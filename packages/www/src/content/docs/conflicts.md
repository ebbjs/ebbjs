---
title: "Conflict Resolution"
description: "Why CRDTs aren't enough and how Ebb handles conflicts."
---

Inevitably when discussing offline-first architectures, CRDTs come up.

CRDT stands for Conflict-Free-Replicated-Datatypes. They are a way of using mathematics to embed the history of a data structure in the data structure itself and use that history to automatically merge and converge branching edits of that data structure.

They are quite rad and great for enabling real-time collaboration on a shared document, whiteboard, canvas, etc. with a large volume of concurrent editors.

So, you might think that (as many do) that they are a silver bullet for enabling collaborative, offline-capable applications. What could be better than a data structure that literally can always converge it's state - even from long ago offline edits?

Unfortunately, in practice CRDTs are quite horrible for building offline-first applications. Mainly because a CRDT is not actually conflict free. A better name for them would be Conflict-Avoidant-Replicated-Datatypes.

This is because conflicts are not actually simply a theoretical, mathematical problem. They are, in practice, a social problem.

When a CRDT like Yjs merges these two edits, what do you think should happen:
User A changes the title of a document from "The Color of Magic" to "The Colour of Magic".
User B deletes the heading.

If you answer the letter u stays in the document, you're right. This is the mathematically correct way to handle this conflicting concurrent edit to the same part of the document, but it is in no way the socially correct way to handle it.

CRDTs _avoid_ conflicts, they don't make them magically dissapear.

This is why surfacing and resolving conflicts are a feature every offline and collaborative application needs to be able to deal with in the way that's best for their users.

Ebb provides conflict management primitives similar to CouchDB's approach, using deterministic resolution to ensure all servers converge to the same state.

## Server-side: automatic convergence

The server doesn't track conflicts—it simply applies all updates using per-field merge functions based on each field's [type](/docs/data-model#typed-fields). Every server applies the same deterministic algorithm:

**LWW fields** (`e.string()`, `e.number()`, `e.boolean()`):
1. **Higher HLC wins** - Updates with more recent causal timestamps take precedence
2. **Tiebreaker** - If [HLC](/docs/clock) timestamps are equal, lexicographic comparison of update IDs (`update_id`) determines the winner. The higher update ID wins. This is deterministic regardless of the order nodes process updates, guaranteeing convergence

**Counter fields** (`e.counter()`): Per-actor counts are summed. Concurrent increments from different actors are additive—there is no "winner" because both increments are preserved.

**Collaborative text fields** (`e.collaborativeText()`): Yjs's built-in CRDT merge algorithm handles concurrent character-level edits deterministically.

This ensures all servers converge to identical state without coordination. From the server's perspective, there are no "conflicts"—just updates that get merged according to each field's type.

## Client-side: preserving user intent

The interesting conflict handling happens on the client during the "rebase" phase of [sync](/docs/sync) (i.e., pulling changes after being offline).

When a client comes back online and syncs, it may discover that [Actions](/docs/data-model) still in its Outbox (not yet sent to the server) contain Updates that would "lose" to Updates that have already been persisted. How this works depends on the field type:

**LWW fields:** The client detects a conflict when an incoming Action contains an Update that touches the same LWW field as a pending Outbox Update for the same entity, and the incoming Update has a higher HLC. In this case, the server's state has moved on, and the client's pending edit would be silently overwritten by LWW if sent.

**Counter fields:** No client-side conflict detection is needed. Counter increments are additive—a pending increment in the Outbox will be correctly merged with any increments that arrived while the client was offline. Both increments are preserved.

**Collaborative text fields:** Yjs handles the merge automatically. The client applies incoming Yjs updates to the local document, and any pending local edits are merged by Yjs's CRDT algorithm.

For LWW conflicts, rather than discard user intent, Ebb moves the "losing" Actions from the Outbox to the client's `Conflicts` table. If only some Updates within an Action conflict, the entire Action is moved to Conflicts—maintaining atomicity even for conflict handling. Developers can then watch this table and choose—based on entity type, fields changed, user role, time elapsed, etc.—whether to surface the conflict to the user, automatically retry the edit, or discard it.

For collaborative text fields, Ebb still detects when the field changed while the client was offline and snapshots the pre-merge state to the Conflicts table. This allows developers to surface "here's what the document looked like before the merge" if needed—even though the merge has already happened.

This approach provides automatic convergence at the server level while preserving user intent at the client level. Ebb doesn't "solve" conflicts—it gives you the primitives to handle them as the human problems they are.
