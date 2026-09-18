---
title: "Conflict Resolution"
description: "Why CRDTs aren't enough and how Ebb handles conflicts."
---

> **Note — Forward-looking API outline.** This document describes the planned v1 approach to conflict handling. The **server-side LWW merge** (per-field HLC + lexicographic `update_id` tiebreak) is **implemented** in `ebb_server/`. The **client-side conflict surfacing** described here is **planned, not built** — it depends on the Outbox and Conflicts table in `@ebbjs/client`, which does not exist yet.

Inevitably when discussing offline-first architectures, CRDTs come up.

CRDT stands for Conflict-Free-Replicated-Datatypes. They are a way of using mathematics to embed the history of a data structure in the data structure itself and use that history to automatically merge and converge branching edits of that data structure.

They are quite rad and great for enabling real-time collaboration on a shared document, whiteboard, canvas, etc. with a large volume of concurrent editors.

So, you might think that (as many do) that they are a silver bullet for enabling collaborative, offline-capable applications. What could be better than a data structure that literally can always converge it's state - even from long ago offline edits?

Unfortunately, in practice CRDTs are quite horrible for building offline-first applications. Mainly because a CRDT is not actually conflict free. A better name for them would be Conflict-Avoidant-Replicated-Datatypes.

This is because conflicts are not actually simply a theoretical, mathematical problem. They are, in practice, a social problem.

When a CRDT (such as Yjs) merges these two edits, what do you think should happen:
User A changes the title of a document from "The Color of Magic" to "The Colour of Magic".
User B deletes the heading.

If you answer the letter u stays in the document, you're right. This is the mathematically correct way to handle this conflicting concurrent edit to the same part of the document, but it is in no way the socially correct way to handle it.

CRDTs _avoid_ conflicts, they don't make them magically dissapear.

This is why surfacing and resolving conflicts are a feature every offline and collaborative application needs to be able to deal with in the way that's best for their users.

Ebb provides conflict management primitives similar to CouchDB's approach, using deterministic resolution to ensure all servers converge to the same state.

## Server-side: automatic convergence

The server doesn't track conflicts—it simply applies all updates using per-field merge functions based on each field's [type](/docs/v1-target/data-model#typed-fields). Every server applies the same deterministic algorithm:

**LWW fields** (`e.string()`, `e.number()`, `e.boolean()`):

1. **Higher HLC wins** - Updates with more recent causal timestamps take precedence
2. **Tiebreaker** - If [HLC](/docs/v1-target/clock) timestamps are equal, lexicographic comparison of update IDs (`update_id`) determines the winner. The higher update ID wins. This is deterministic regardless of the order nodes process updates, guaranteeing convergence

**Counter fields** (`e.counter()`): Per-actor counts are summed. Concurrent increments from different actors are additive—there is no "winner" because both increments are preserved.

**Collaborative text fields** (`e.collaborativeText()`, planned): The intended causal-tree implementation gives the same deterministic convergence as a CRDT for the same logical edits. See [the devlog post](/devlog/how-collaborative-editing-works) for why Ebb doesn't ship Yjs and what conflict surfacing looks like instead.

This ensures all servers converge to identical state without coordination. From the server's perspective, there are no "conflicts"—just updates that get merged according to each field's type.

## Client-side: preserving user intent

The interesting conflict handling happens on the client during the "rebase" phase of [sync](/docs/v1-target/sync) (i.e., pulling changes after being offline).

When a client comes back online and syncs, it may discover that [Actions](/docs/v1-target/data-model) still in its Outbox (not yet sent to the server) contain Updates that would "lose" to Updates that have already been persisted. How this works depends on the field type:

**LWW fields:** The client detects a conflict when an incoming Action contains an Update that touches the same LWW field as a pending Outbox Update for the same entity, and the incoming Update has a higher HLC. In this case, the server's state has moved on, and the client's pending edit would be silently overwritten by LWW if sent.

**Counter fields:** No client-side conflict detection is needed. Counter increments are additive—a pending increment in the Outbox will be correctly merged with any increments that arrived while the client was offline. Both increments are preserved.

**Collaborative text fields** (planned): The client materializes incoming actions into the local causal-tree document, applying each one in HLC order. The merge is deterministic — same merge result regardless of arrival order — but unlike Yjs, Ebb also captures the pre-merge state into the Conflicts table so the application can surface "Alice deleted this heading while you were fixing a typo" rather than silently producing the result.

For LWW conflicts, rather than discard user intent, Ebb moves the "losing" Actions from the Outbox to the client's `Conflicts` table. If only some Updates within an Action conflict, the entire Action is moved to Conflicts—maintaining atomicity even for conflict handling. Developers can then watch this table and choose—based on entity type, fields changed, user role, time elapsed, etc.—whether to surface the conflict to the user, automatically retry the edit, or discard it.

For collaborative text fields (planned), the same approach applies: Ebb detects that the field changed while the client was offline and snapshots the pre-merge state to the Conflicts table, giving the application the option to surface "here's what the document looked like before the merge".

This approach provides automatic convergence at the server level while preserving user intent at the client level. Ebb doesn't "solve" conflicts—it gives you the primitives to handle them as the human problems they are.
