---
title: "Offline conflicts"
description: "How ebb detects, records, and resolves writes that race while a client is offline — and the boundary between convergence and detection."
---

> **Shipped.** This page is the one-page reference for the offline-conflict model implemented in `@ebbjs/client`: detection and the durable record ([#390](https://github.com/ebbjs/ebbjs/issues/390)), the entity-level surface and resolution verbs ([#392](https://github.com/ebbjs/ebbjs/issues/392)), the before/after rows and diff on the conflict payload ([#408](https://github.com/ebbjs/ebbjs/issues/408), [#409](https://github.com/ebbjs/ebbjs/issues/409)), and the retirement of `client.snapshots` ([#410](https://github.com/ebbjs/ebbjs/issues/410)).

Live sync is **pure convergence**. While a client is connected, every inbound Action is appended and materialized under the shared merge rule; nothing is held and no conflict is recorded. Conflicts are a **catch-up** concern: when a client reconnects, the writes it made offline are checked against the window it missed.

## The convergence boundary

|          | Live                                        | Catch-up                                                     |
| -------- | ------------------------------------------- | ------------------------------------------------------------ |
| Behavior | append and materialize every inbound Action | fold the missed window against buffered local writes         |
| Rows     | none                                        | one `conflicted` row per losing local Action                 |
| Holds    | none                                        | the losing Action is held and never submitted until resolved |

The boundary is the **catch-up call site**, not `connectionState`. The subscription's catch-up runs the detection pass once, after the whole missed window has drained and before the flush gate reopens. `connectionState` flips to `live` only after the gate releases.

`client.catchUp()` called directly does **not** run detection — only the subscription's catch-up does. An application that drains the window itself before subscribing therefore starts detection from an already-caught-up cursor.

## Declared scope

Granularity is declared on the entity, not guessed:

```ts
const post = defineEntity(
  "blog_post",
  {
    title: e.string(),
    body: e.collaborativeText({ conflictScope: "entity" }),
  },
  { conflictScope: "field" }, // the default
);
```

- `"field"` surfaces a same-position race, and a concurrent `put` / `delete` that omitted a field the local write holds (the field is reverted on the server).
- `"entity"` surfaces any concurrent touch of an entity that has buffered local writes.
- Unknown entity types default to `"field"`.
- Structural edge subject types (`relationship`, `entityGroup`, `groupMember`) are never surfaced: concurrent writes to edges are not field conflicts.

`e.collaborativeText({ conflictScope })` stamps the generated document entity, so each derived body declares its own scope. Every derived body is its own document entity ([#398](https://github.com/ebbjs/ebbjs/issues/398)), so the old blanket `text_document.*` grant becomes one grant per body.

## Positions

The unit of a conflict is a **position**, produced by the generic map-key recursion shared with the merge rule:

- a map field merges key by key, so two writes to different keys are different positions and do not conflict;
- a shared leaf, or the path where the two sides' kinds diverge, is one position.

For a collaborative-text document, runs live in `content`, a map field. One `content[runId]` is one position:

- concurrent inserts at different runs → different positions → no conflict;
- an extend and a tombstone on the same run → one position → conflict.

There is no per-field "address a value" hook. A field type with non-map positions would extend the field marker.

A nested map key that a missed `put` replaced away — the `put` supplied a `content` map omitting that key — is **not** surfaced as a slot: the pending write re-adds it on flush. A field the peer's `put` reverted entirely _is_ surfaced, with a remote side of `{ value: undefined }`.

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
  readonly subjects: readonly string[];
  readonly subjectStates: readonly ConflictSubjectStateView[];
  readonly entries: readonly ConflictEntry[];
  remoteWins(): boolean;
}

interface ConflictEntry {
  readonly action: Action; // the losing local Action
  readonly subjects: readonly string[]; // subjects that actually lost
  readonly slots: readonly ConflictSlotView[];
  readonly basedOnGsn: number;
  readonly catchUpId: string; // the catch-up pass
  readonly conflictId: string; // the durable group key
  readonly detectedAtHlc: string;
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

- `subjects` scopes the entity-level group. A create-plus-update write names only the entity that lost, so a freshly created entity is not dragged in.
- `subjectStates` is one state per losing subject, in `subjects` order: the client's row before the sync, the server's row after it, and the positions that differ.
- `slots` is the overlapping positions, in detection order. It is **empty** at entity scope when nothing position-wise overlapped — the application reads that as "nothing of mine would be lost".
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

`subjectStates` lives on `Conflict` only; `ConflictEntry` is unchanged. It dedupes by `subjectId` alone, taking the earliest `before` and the latest `after` — a no-op today, since every entry in a conflict comes from one catch-up pass.

An entity-scoped application reads `subjectStates` / the diff, not `remoteWins()`.

## `remoteWins()`

`remoteWins()` answers "would my value lose the merge here?" without re-deriving the merge:

- either side is not a merge leaf — the remote is absent, or the two sides' kinds diverge — the remote wins;
- both sides are leaves → the higher HLC wins, then the lexicographically greater `update_id` (ties go to the remote).

`Conflict.remoteWins()` is `entries.some((e) => e.slots.some((s) => s.remoteWins()))`, and `false` when the conflict has no slots.

This is a **position-level** question. With no overlapping position it is `false` by construction; entity-scoped apps read [`subjectStates`](#before--after-and-the-diff) instead.

The system surfaces on **concurrency alone**, even when the local value would win. An application opts into "only when something would be lost" in its own handler:

```ts
client.conflicts.onChange((conflicts) => {
  for (const conflict of conflicts) {
    if (conflict.remoteWins()) showInUi(conflict);
    else void client.conflicts.resolve(conflict.id, "retry");
  }
});
```

## Resolution

Two verbs: one for the whole conflict, one per entry.

- `resolve(conflictId, "retry" | "discard")` resolves every entry in the conflict, in authoring order.
- `resolveEntries(entryIds, "retry" | "discard")` is the per-entry primitive; `entryIds` are local Action ids.

Both return per-entry results and do **not** roll back:

```ts
interface ResolveResult {
  readonly resolved: readonly string[];
  readonly failed: readonly { entryId: string; error: unknown }[];
}
```

A failed entry stays `conflicted` under the same `conflictId` and can be resolved again.

- **`retry`** re-asserts the **whole** losing Action, freshly stamped: every Update and every leaf gets a new `update_id` and HLC. Re-asserting only the colliding slots would silently drop the write's other fields.
- **`discard`** drops the whole Action and re-materializes the affected entities from the action log, converging on the server's view.

There are no `accept` / `backup` / `merge` verbs.

## Backup

The pre-sync row is reachable as `Conflict.subjectStates[].before` ([#408](https://github.com/ebbjs/ebbjs/issues/408), [#409](https://github.com/ebbjs/ebbjs/issues/409)): the state the client had before the catch-up window, durable on the conflict payload. There is no standalone `client.snapshots` surface — a pre-merge row only has value when the sync clobbered something the user wrote, so backup is conflict-scoped, and nothing captures pre-sync rows outside detection.

Duplicate an entity at that point in time with `client.<entity>.duplicate(id, { at: "preSync" })` ([#397](https://github.com/ebbjs/ebbjs/issues/397)). The copy resolves the entity's earliest unresolved conflict and copies its `before` row. With no unresolved conflict referencing the entity it throws `duplicate: no unresolved conflict for "<id>"`.

## Server merge rule

The server and every client materializer apply one deterministic rule:

- a `put` replaces the subject's whole field set — a top-level field the `put` omits is reverted;
- a later `patch` merges its fields back over whatever stands;
- a map field merges key by key, so a patch to one key leaves its siblings.

A pending local write is always submitted after catch-up, so it lands after the missed window in server order.

## What must not change

The convergence/detection boundary is deliberate:

- **No client merge override.** A different convergent type is a protocol extension, not a callback.
- **No live detection.** Inbound Actions while connected never create a conflict.
- **No gate holds.** The flush gate is global and catch-up-scoped. A conflict keeps its own row out of `pending`, but holding _other_ writes for a human decision is an application concern, built on `client.conflicts`.
- **Detection is not exact concurrency between two already-committed writes.** It is "a write this client had not seen when it authored its own".
- **The conflict's entity rows are copies, not references into the action log.** Compaction of the log cannot erase the comparison a conflict exposes.

## References

- Epic [#389](https://github.com/ebbjs/ebbjs/issues/389) — offline conflict surfacing
- [#390](https://github.com/ebbjs/ebbjs/issues/390) detection with declared scope · [#392](https://github.com/ebbjs/ebbjs/issues/392) entity-level surface and resolution · [#395](https://github.com/ebbjs/ebbjs/issues/395) pre-sync capture · [#397](https://github.com/ebbjs/ebbjs/issues/397) duplicate at a point · [#398](https://github.com/ebbjs/ebbjs/issues/398) one document entity per derived field · [#408](https://github.com/ebbjs/ebbjs/issues/408) before/after rows on the payload · [#409](https://github.com/ebbjs/ebbjs/issues/409) entity-level before/after and diff · [#410](https://github.com/ebbjs/ebbjs/issues/410) retirement of `client.snapshots`
- `packages/client/src/sync/conflicts.ts`, `packages/client/src/sync/conflict-slots.ts`, `packages/client/src/sync/outbox.ts`
