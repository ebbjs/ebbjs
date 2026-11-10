---
title: "Offline conflicts"
description: "How ebb detects, records, and resolves writes that race while a client is offline — and the boundary between convergence and detection."
---

> **Shipped.** This page is the one-page reference for the offline-conflict model implemented in `@ebbjs/client`: detection and the durable record ([#390](https://github.com/ebbjs/ebbjs/issues/390)), the entity-level surface and resolution verbs ([#392](https://github.com/ebbjs/ebbjs/issues/392)), the before/after rows and diff on the conflict payload ([#408](https://github.com/ebbjs/ebbjs/issues/408), [#409](https://github.com/ebbjs/ebbjs/issues/409)), and the retirement of `client.snapshots` ([#410](https://github.com/ebbjs/ebbjs/issues/410)).

Live sync is **pure convergence**. While a client is connected, every inbound Action is appended and materialized under the shared merge rule; nothing is held and no conflict is recorded. Conflicts are a **catch-up** concern: when a client reconnects, the writes it made offline are checked against the window it missed.

## The convergence boundary

|          | Live                                        | Catch-up                                                                      |
| -------- | ------------------------------------------- | ----------------------------------------------------------------------------- |
| Behavior | append and materialize every inbound Action | fold the missed window against buffered local writes                          |
| Rows     | none                                        | one `conflicted` row per losing local Action                                  |
| Holds    | none                                        | the losing Actions and later writes to their subjects are held until resolved |

The boundary is the **catch-up call site**, not `connectionState`. The subscription's catch-up runs the detection pass once, after the whole missed window has drained and before the flush gate reopens. `connectionState` flips to `live` only after the gate releases.

`client.catchUp()` called directly does **not** run detection — only the subscription's catch-up does. An application that drains the window itself before subscribing therefore starts detection from an already-caught-up cursor.

## Declared scope

Granularity is declared on the entity, not guessed:

```ts
const post = defineModel(
  "blog_post",
  { title: e.string() },
  { conflictScope: "field" }, // the default
);
const body = defineModel(
  "text_document",
  { content: e.map(TextCellSchema), version: e.number() },
  { conflictScope: "entity", materialization: "on-demand" },
);
const schema = defineSchema({
  models: { blog_post: post, text_document: body },
  relationships: {
    body: defineRelationship({ source: post, target: body, as: "body", sourceCardinality: "one" }),
  },
});
```

- `"field"` surfaces a same-position race, and a concurrent `delete` or `drop` of a component the local write holds (the component is reverted on the server).
- `"entity"` surfaces any concurrent touch of an entity that has buffered local writes.
- Unknown entity types default to `"field"`.
- Structural edge subject types (`relationship`, `entityGroup`, `groupMember`) are never surfaced: concurrent writes to edges are not field conflicts.

`conflictScope` is declared on the document entity, so each document declares its own scope. Every document is its own entity ([#398](https://github.com/ebbjs/ebbjs/issues/398)), so a blanket `text_document.*` grant becomes one grant per document entity.

## Positions

The unit of a conflict is a **position**, produced by the generic map-key recursion shared with the merge rule:

- a map field merges key by key, so two writes to different keys are different positions and do not conflict;
- a shared leaf, or the path where the two sides' kinds diverge, is one position.

For a collaborative-text document, cells live in `content`, a map field keyed by cell
id. Every write only adds keys — a run is immutable and a delete is an additive cut —
so two concurrent edits never share a position:

- concurrent inserts are different run keys → no conflict;
- a delete is its own cut key and an extend is a new run key → no conflict;
- text therefore surfaces no slots at all. Same-run delete-vs-insert and
  delete-vs-delete commute, so the rule #392 recorded for same-run text edits no
  longer applies ([#764](https://github.com/ebbjs/ebbjs/issues/764)).

The body's `version` leaf is metadata declaring the cell format, never a position.

There is no per-field "address a value" hook. A field type with non-map positions would extend the field marker.

A nested map key a missed component write omits is **not** surfaced as a slot: a map merges key by key, so the key the pending write holds was never reverted, and it stands on flush. A component the peer's `delete` reverted entirely _is_ surfaced, with a remote side of `{ value: undefined }`.

## The write base and the HLC caveat

Every buffered local Action records `basedOnGsn`: the highest server sequence the client can claim to have applied when it authored the write.

- It is the **minimum non-zero applied cursor across the subscribed groups**. The client does not know which group carries a subject, and too low a base only surfaces extra conflicts.
- With no group subscribed (or a subscription with no groups), it falls back to the global maximum.
- Nothing applied yet — and legacy or absent bases — read as `0`, meaning "always concurrent".

**Concurrency is `inbound.gsn > basedOnGsn`.** GSN, not HLC. A missed Action the client may not have seen is concurrent regardless of how the HLCs compare; HLC is only the merge rule. This is why a conflict surfaces even when the local write has a _higher_ HLC than the peer's — the merge would keep the local value, but the GSN base still marks the two as concurrent.

A local write authored after the missed write had already been applied (`basedOnGsn` ≥ its GSN) is a deliberate override, not a conflict.

## The record

A detected loser is a `conflicted` status plus a payload on **its own outbox row** — one durable write, so the hold and the record cannot disagree. There is no separate conflict store.

```ts
interface Conflict {
  readonly id: string; // the persisted conflictId, shared by the group
  readonly scope: "field" | "entity"; // how detection classified it
  readonly subjects: readonly string[];
  readonly subjectStates: readonly ConflictSubjectStateView[];
  readonly entries: readonly ConflictEntry[];
  readonly remoteActions: readonly ConflictRemoteAction[];
}

interface ConflictEntry {
  readonly action: Action; // the losing local Action, verbatim
  readonly subjects: readonly string[]; // subjects that actually lost
  readonly slots?: readonly ConflictSlotView[]; // absent when this entry's scope is entity
  readonly scope: "field" | "entity";
  readonly remoteActions: readonly ConflictRemoteAction[];
  readonly basedOnGsn: number;
  readonly catchUpId: string; // the catch-up pass
  readonly conflictId: string; // the durable group key
  readonly detectedAtHlc: string;
}

interface ConflictRemoteAction {
  readonly actorId: string;
  readonly actionId: string;
  readonly gsn: number;
}

interface ConflictSlotView {
  readonly subjectId: string;
  readonly field: string;
  readonly path: readonly string[];
  readonly local: ConflictSide;
  readonly remote: ConflictSide;
  remoteWins(): boolean;
}

interface ConflictSubjectStateView {
  readonly subjectId: string;
  readonly subjectType: string;
  readonly before: Entity | null; // what the client had before the sync
  readonly after: Entity | null; // the server's row after it
  readonly diff: readonly EntityDiff[];
}

interface EntityDiff {
  readonly field: string;
  readonly path: readonly string[]; // map-key path from the field root; [] at the root
  readonly before: unknown; // projected via projectFieldValue
  readonly after: unknown;
  readonly kind: "changed" | "added" | "removed";
}
```

- `scope` is declared on the entity, not guessed per position. `"entity"` means any concurrent touch surfaced the subject; `"field"` means an overlapping position did.
- `subjects` scopes the entity-level group. A create-plus-update write names only the entity that lost, so a freshly created entity is not dragged in.
- `subjectStates` is one state per losing subject, in `subjects` order: the client's row before the sync, the server's row after it, and the positions that differ.
- `slots` is the overlapping positions, in detection order, and is **absent** for an entity-scope entry — there is no position-level verdict to misread. Read the diff instead. `Conflict.scope` is the coarsest of its entries, so a mixed group reports `"entity"` while its field-scope entries still carry slots.
- `remoteActions` is the concurrent missed Actions that made this a conflict: actor, action id, and server GSN. Deduped by action id, first-seen across the conflict's entries (each entry's own list is in window order).
- `conflictId` is stamped at detection, one per connected set of losing subjects in a catch-up pass, so grouping survives a reload and a partial resolution.
- The stored rows stay plain; the conflicts view rebuilds the method-carrying objects.

## `before` / `after` and the diff

Every losing subject carries the two entity rows the conflict compares, plus a projection of the positions that differ.

- **`before`** — the entity row as the client had it immediately before the catch-up window was applied: the client's last-synced server state with its own unflushed writes optimistically applied. "Your version". `null` when no row was materialized at capture time.
- **`after`** — the entity row once the missed window has landed: the server's advanced view. Measured at detection as the materialized row for the subject. `null` only when replay yields no row.

Captures are taken per catch-up pass, keyed by the pass's `catchUpId`, so a second reconnect pairs its conflict with the row that preceded _its_ window. Detection copies the pass's rows onto the durable conflict payload, so they survive a reload; they are copies, not references into the action log, and they live in memory only for the duration of the pass.

The `diff` is a **projection**, computed in the conflicts view, not stored. It uses the same recursion the merge does (top-level fields, then `FieldMap` keys), so the diff vocabulary matches the merge and slot vocabulary:

- entries sort deterministically: top-level fields by name, then path segments by name;
- each side is projected to plain JSON through `projectFieldValue`, the rule the slot sides already use;
- `kind` is a pure function of the two projected values: an absent `before` is `added`, an absent `after` is `removed`, both present is `changed`. A `before: null` therefore reads as `added` — nothing was materialized at capture;
- a nested map entry that projects to `null` is a tombstone, read as absent rather than as a changed position.

`subjectStates` lives on `Conflict` only; each `ConflictEntry` carries its own `slots`, `scope`, and `remoteActions`. `subjectStates` dedupes by `subjectId` alone, taking the earliest `before` and the latest `after` — a no-op today, since every entry in a conflict comes from one catch-up pass.

An entity-scoped application reads `subjectStates` / the diff, not the slots.

## `remoteWins()`

The slot's `remoteWins()` answers "would my value lose the merge here?" without re-deriving the merge:

- either side is not a merge leaf — the remote is absent, or the two sides' kinds diverge — the remote wins;
- both sides are leaves → the higher HLC wins, then the lexicographically greater `update_id` (ties go to the remote).

This is a **position-level** question, so it lives on a slot, not on the conflict: entity-scope conflicts have no `slots` list at all and read [`subjectStates`](#before--after-and-the-diff) instead. The system surfaces on **concurrency alone**, even when the local value would win. An application builds its own policy on the report:

```ts
client.conflicts.onChange((conflicts) => {
  for (const conflict of conflicts) {
    const losing = conflict.entries.some((entry) => entry.slots?.some((slot) => slot.remoteWins()));
    if (losing || conflict.scope === "entity") showInUi(conflict);
  }
});
```

## Resolution

The verbs name the mechanism, not a policy:

- `sendLocalActions(conflictId)` clears the hold and submits the held Actions **unchanged** — same action id, same Update ids, same field HLCs. Re-stamping would rewrite provenance on an append-only log and fabricate ordering. An application that wants its scalar value to win writes it again through `defineAction` with a fresh clock.
- `clearLocalActions(conflictId)` drops the held Actions, drops the local writes the hold was keeping off the wire, and converges those subjects on the server's view. A write made after the hold lifts is never dropped. In a partial pass only the subjects the resolved entries released are converged; a subject a failed entry still names stays held and keeps its writes, unless it shares an Action with a released subject — that Action is dropped whole.

Both return per-entry results and do **not** roll back:

```ts
interface ResolveResult {
  readonly resolved: readonly string[];
  readonly failed: readonly { entryId: string; error: unknown }[];
}
```

A failed entry stays `conflicted` under the same `conflictId` and can be resolved again. A durable-store fault in the pass's final drop or flush rejects instead: the rows already moved stay moved, and the outbox surfaces the fault.

There is no `retry`, `discard`, `accept`, `backup`, or `merge` verb. Policy — copy a backup, pick a winner, do nothing — is application code over the report.

## The subject hold

Entity scope holds more than the losing Action. Every subject named by an open conflict is **held**: a later local write to it is accepted into the outbox and applied optimistically, so local UX continues, but `pending()` and the flush exclude it until the conflict resolves. The hold is derived from the durable `conflicted` rows, so a reload preserves it without a second store.

- The hold applies to `pending` rows only. An `acknowledged` write is already on the server and is never re-held.
- Detection only considers `pending` rows for the same reason.
- `sendLocalActions` releases the whole held set and flushes it; `clearLocalActions` drops it, so the subjects really do converge.
- An Action writing several subjects is held or dropped whole; an Action cannot be sent in part.

## Backup

The pre-sync row is reachable as `Conflict.subjectStates[].before` ([#408](https://github.com/ebbjs/ebbjs/issues/408), [#409](https://github.com/ebbjs/ebbjs/issues/409)): the state the client had before the catch-up window, durable on the conflict payload. There is no standalone `client.snapshots` surface — a pre-merge row only has value when the sync clobbered something the user wrote, so backup is conflict-scoped, and nothing captures pre-sync rows outside detection.

Duplicate an entity at that point in time inside an action, with the draft `duplicate(id, { at: "preSync" })` verb ([#397](https://github.com/ebbjs/ebbjs/issues/397)). The copy resolves the entity's earliest unresolved conflict and copies its `before` row; it lands in the source's live groups unless the verb's `groups` option says otherwise. With no unresolved conflict referencing the entity it throws `duplicate: no unresolved conflict for "<id>"`.

```ts
const restoreIssue = defineAction(schema, ({ issue }, params: { id: string }) =>
  issue.duplicate(params.id, { at: "preSync" }),
);

const copy = await client.actions.restoreIssue({ id: issueId });
```

## Server merge rule

The server and every client materializer apply one deterministic rule:

- an Update writes one component, and that component's value is settled by one leaf-level compare: the higher HLC wins, then the lexicographically greater `update_id`;
- `replace` and `merge` go through that same compare; the only difference is that a `replace` stamps the row's creation time, so neither rewrites a component back to an older value;
- a `drop` detaches a component and a `delete` tombstones the row — nothing else reverts an omitted component;
- a map field merges key by key, so a write to one key leaves its siblings.

A pending local write is always submitted after catch-up, so it lands after the missed window in server order.

## What must not change

The convergence/detection boundary is deliberate:

- **No client merge override.** A different convergent type is a protocol extension, not a callback.
- **No live detection.** Inbound Actions while connected never create a conflict.
- **No gate holds.** The flush gate is global and catch-up-scoped. The subject hold keeps a conflict's subjects out of `pending`; sending or clearing them is the application's decision, made through `client.conflicts`.
- **Detection is not exact concurrency between two already-committed writes.** It is "a write this client had not seen when it authored its own".
- **The conflict's entity rows are copies, not references into the action log.** Compaction of the log cannot erase the comparison a conflict exposes.

## References

- Epic [#389](https://github.com/ebbjs/ebbjs/issues/389) — offline conflict surfacing
- [#390](https://github.com/ebbjs/ebbjs/issues/390) detection with declared scope · [#392](https://github.com/ebbjs/ebbjs/issues/392) entity-level surface and resolution · [#395](https://github.com/ebbjs/ebbjs/issues/395) pre-sync capture · [#397](https://github.com/ebbjs/ebbjs/issues/397) duplicate at a point · [#398](https://github.com/ebbjs/ebbjs/issues/398) one document entity per document · [#408](https://github.com/ebbjs/ebbjs/issues/408) before/after rows on the payload · [#409](https://github.com/ebbjs/ebbjs/issues/409) entity-level before/after and diff · [#410](https://github.com/ebbjs/ebbjs/issues/410) retirement of `client.snapshots`
- `packages/client/src/sync/conflicts.ts`, `packages/client/src/sync/conflict-slots.ts`, `packages/client/src/sync/outbox.ts`
