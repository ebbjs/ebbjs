# Read-model / durability seam — TS-local spec (ebbjs#496)

**Status:** throwaway spike. Branch `spike/496-read-model-seam`; main keeps only the
decision recorded on [ebbjs/ebbjs#496](https://github.com/ebbjs/ebbjs/issues/496).

**Assumption stated up front:** this is a **logic/architecture prototype**, not a UI one.
It is throwaway code on a throwaway branch, under-polished, with no persistence, one
command, that exists to settle the seam before #497–#501 build on it.

**Artifacts on this branch:**

- `packages/client/spike/read-model.ts` — the concrete read-model core + the durable port
  - the one apply pipeline.
- `packages/client/spike/read-model-seam.ts` — the dual-run harness (fires the required
  cases, a seeded fuzz pass, hydrate checks, a divergence probe, and the #495 budget check).
- One-command run:
  ```
  pnpm storage:build
  pnpm --filter @ebbjs/client spike:read-model-seam
  ```
- `packages/client/src/sync/client.ts` gains `export` on `applyLocalUpdate` so the harness
  can dual-run the **real** optimistic merge. Production deletes the helper (see §7).

---

## 1. Decision summary

| Question                   | Decision                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where the read model lives | **`@ebbjs/storage`**, new `src/read-model/`. It reuses `internal/materialize.ts`, the durability ports already live in `@ebbjs/storage/types`, and both `@ebbjs/client` and `@ebbjs/react` consume it. The **query engine** (planner #498, result cache #512) lives in `@ebbjs/client` on top of its synchronous reads.                                     |
| Read-model shape           | **(B) mutable in-place core + monotonic version + change journal**, exposing **(A)'s versioned handle** as the public read token, with **(C)'s derived-index registry** as the internal extension point.                                                                                                                                                    |
| The pluggable seam         | Behind the read model, at durability: `ActionLog` / `SnapshotStore` / `CursorStore` / `OutboxStore`. The read model itself is a concrete core, **not** a port.                                                                                                                                                                                              |
| Replace or parallel        | The read model **replaces** `EntityStore` + `DirtyTracker` as the engine's materialized read path. `ActionLog` survives narrowed; `CursorStore` / `OutboxStore` survive unchanged; `SnapshotStore` is new. The old `StorageAdapter.entities` / `.dirtyTracker` may linger as a compatibility shim for non-engine callers, but they leave the engine's port. |
| The central hypothesis     | **Confirmed with one honest reframe:** the read model subsumes `EntityStore`. It subsumes `DirtyTracker` **only** under the redefinition "changed since version V" (which is exactly what #512 needs), _not_ "awaiting lazy rematerialization". If an expensive lazy projection ever returns, a real dirty set returns with it.                             |
| Hydrate                    | latest snapshot (`position` watermark) ⊕ `ActionLog.readTail(position)` ⊕ the durable outbox overlay.                                                                                                                                                                                                                                                       |
| Merge authority            | `applyUpdate` / `mergeFields` from `storage/src/internal/materialize.ts`, used **verbatim by the base, the inbound-window fold, and the optimistic overlay**. The server runs the same rule, so the pre-ack view converges with the post-merge state; a pending write that loses is never shown winning.                                                    |

---

## 2. Design twice — the three shapes weighed

### (A) Immutable snapshot + structural sharing — **rejected as the core**

Every apply returns a new snapshot; unchanged entities, type sets, and index keys reused by
reference; snapshot identity _is_ version identity. The read contract is excellent and is
**retained** (see the versioned handle in §3). It is rejected as the core because real
structural sharing at the _collection_ level needs a persistent map/HAMT the repo does not
have: with a plain `Map`, each apply shallow-copies the top-level entity record and the
touched type set, i.e. **O(n) per write**. The memory adapter's own O(n²) population
(40k inserts in ~508 s) is the measurement of that cost. The write path is the one that
must keep up with a live ingest stream; taxing it to buy read safety inverts the priority.
Its author's own fallback — "a mutable resident map with versioned copy-on-write per
entity" — is exactly the shape adopted below.

### (C) Table/column-oriented per type + field/adjacency indices — **rejected as the core**

Per-type row tables plus per-field column indices plus relationship adjacency is the right
**destination** for the planner (#498): `refs` / `index` / `adjacency` / `get` give a
plan/execute split and eliminate whole-row scans. It is rejected as the #496 core on two
grounds. First, it is premature: #496 only needs the per-type index; per-field indices are
explicitly the planner's slice, and building the columnar core now pays write amplification
for queries that do not exist yet. Second, IndexedDB cannot persist it usefully — IDB
indexes only top-level properties, cannot index nested `FieldValue` paths, cannot express
`relationshipEntryFor`'s live-row filter or the adjacency `rowId → sourceId` dedup, and has
no query primitive over a stored `Map`. The snapshot is therefore **row-shaped** regardless,
and columns must be rebuilt in one pass at hydrate. Its direction is **retained** as the
read model's index-registry extension point: derived indices consume the change journal and
live behind the core seam.

### (B) Mutable store + monotonic version + change journal — **chosen**

A single mutable core mutates in place (O(1) apply), a monotonic version bumps exactly when
observable content changes, and a change journal (`{version, id, type, deleted}`) carries
the per-entity change signal. It is wrapped in **(A)'s versioned handle** so callers get the
structural-sharing contract — "a new reference appears only when an entity changed" — without
the persistent-map tax. **(C)'s** per-type table idea is the core's entity partition; its
field/adjacency indices become journal consumers. This is the only shape that keeps the write
path cheap at the 10k+ scale the query engine targets while still giving #512 a clean
invalidation token. The honest caveat is recorded in the decision table: subsuming
`DirtyTracker` requires redefining "dirty" as "changed since V".

The full dual-run prototype is this shape; §5–§9 are its spec.

---

## 3. The read model interface

```ts
type EntityId = string;
type EntityType = string;
type Version = number;

interface EntityChange {
  readonly version: Version;
  readonly id: EntityId;
  readonly type: EntityType;
  readonly deleted: boolean;
}

/** The public read token. Reference identity IS the invalidation signal. */
interface ReadModelHandle {
  readonly version: Version;
  get(id: EntityId): Entity | null; // base ⊕ overlay; tombstones returned
  iterate(type: EntityType): readonly Entity[]; // base ⊕ overlay; tombstones included
  changesSince(version: Version): readonly EntityChange[];
}

interface ReadModel extends ReadModelHandle {
  handle(): ReadModelHandle; // current token
  ingest(action: Action, position: number): ReadModelHandle; // durable fold
  optimistic(action: Action): ReadModelHandle; // overlay only
  discard(actionId: string): ReadModelHandle; // drop an overlay action
  loadSnapshot(snapshot: ReadModelSnapshot): ReadModelHandle;
  toSnapshot(): ReadModelSnapshot;
}

interface ReadModelSnapshot {
  readonly formatVersion: 1;
  readonly position: number; // log append-order cursor, NOT gsn (see §5)
  readonly version: Version;
  readonly entities: readonly Entity[];
}
```

**Interface invariants**

1. **One merge authority: the durable LWW.** Every fold routes through
   `applyUpdate(entity, update, gsn, hlc)`; `mergeFieldValue` owns LWW, the equal-HLC
   `update_id` tiebreak, and map union. That includes the **optimistic overlay**: the
   server will run the same rule when it accepts the Action, so composing the overlay with
   anything else (e.g. pending-local-wins) can show a write that will lose and then flip on
   ack. A pending write that actually wins LWW is visible immediately; one that loses is
   not. Conflict _detection_ is independent — it reads the raw buffered action and
   `foldInboundWindow`, both with the durable rule.
2. **Version tracks observable content, not bookkeeping.** `contentChanged` compares `type`,
   `updated_hlc`, `deleted_hlc`, and the field map structurally (reference fast path). A
   lower-HLC patch that only bumps `last_gsn` changes the stored row but **not the version**,
   so `ingest` returns the **same handle reference**. This is #496's structural-sharing
   acceptance test; the harness asserts it.
3. **Ordering.** Durable Updates fold in ascending log position; within an Action the
   `updates` array order is authoritative. Single-writer: the caller serializes `ingest`.
   (A `put` is not commutative with a later `patch`, so order is correctness, not nicety.)
4. **Tombstones.** `delete` sets `deleted_hlc` and retains the row. `get` returns
   tombstones; `iterate` includes them (matching `EntityStore.query`). Hiding tombstones is
   the query engine's projection job. A patch on a tombstone is ignored
   (`applyUpdate` returns the row unchanged).
5. **Reads are shared.** `get` / `iterate` return the model's own rows; nothing is copied
   (contrast the adapter's `JSON.parse(JSON.stringify(...))` per read). Callers must treat
   rows as immutable. This is the #495 read-cost win.
6. **Overlay.** `optimistic` never touches the base and never appends to the log. Reads
   compose `base ⊕ overlay` in authoring order. `ingest` folds the echo into the base and
   then `discard`s the matching overlay action atomically from the caller's perspective;
   because the echo carries the same `update_id`, the composed value is already equal, so
   convergence is a **no-op for the version**.
7. **No-base optimistic write is a no-op.** A patch/delete whose base row is absent folds to
   `null` and stays absent (matches `applyLocalUpdate` and the "the echo supplies the base"
   contract).

**Error modes.** `get`/`iterate`/`changesSince` are total after construction. A corrupt or
absent snapshot is treated as "no snapshot" → full log replay, never a partial base.
`toSnapshot` before any ingest yields an empty snapshot at position 0. Reads are synchronous
and never return a promise; the only awaits are on the four ports.

---

## 4. The durable port

```ts
interface LoggedAction {
  readonly action: Action;
  readonly position: number;
}

interface ActionLogPort {
  append(action: Action): Promise<LoggedAction>; // append-only; repeated id merges Updates (#473)
  readTail(afterPosition: number): Promise<readonly LoggedAction[]>;
  lastPosition(): Promise<number>;
  clear(): Promise<void>;
}

interface SnapshotStorePort {
  load(): Promise<ReadModelSnapshot | null>; // single-slot latest
  save(snapshot: ReadModelSnapshot): Promise<void>; // atomic overwrite
  clear(): Promise<void>;
}

interface CursorStorePort {
  // unchanged
  get(groupId: string): Promise<number | null>;
  set(groupId: string, gsn: number): Promise<void>;
}

// OutboxStore is the existing `storage/src/types/outbox-store.ts` surface; the
// read model consumes only `list()` for its optimistic projection.
```

**Semantics**

- `ActionLog.append` returns the new Action's **log position** — a log-local monotonic
  append cursor. `readTail` returns every Action with `position > afterPosition`, in append
  order. Repeated Action ids merge their Updates (the existing `#473` rule).
- `SnapshotStore` stores the latest row-shaped snapshot and its `position` watermark.
  `hydrate` = `load()` ⊕ `readTail(snapshot.position)`. A snapshot is only ever a **fast
  path**; correctness never depends on it existing. Log truncation/compaction is a
  follow-up and must be atomic with the snapshot write.
- `CursorStore` remains the per-group server-resume point. It is no longer read during
  materialization.
- `OutboxStore` remains the durable pending-local-action buffer. It is the source of
  optimistic state across a reload: `hydrate` replays its `pending` / `acknowledged` rows
  into the overlay.

**Finding — `lastGsn()` cannot be the hydrate cursor.** The starting candidate port was
`append / getForEntity / getAll / lastGsn`. gsn is not a unique, monotonic log cursor: an
Action can be delivered once per group (#473), and `gsn: 0` is legal (#475 backfill, legacy
entries). A `gsn > watermark` replay both drops zero-gsn entries and cannot distinguish
"folded into the snapshot" from "appended after it". The port therefore needs an
**append-order position**, independent of the server gsn. This holds whether or not the
backfill snapshot keeps `gsn: 0` (see the correction in §8.3). The harness proves the cursor
with the zero-gsn backfill put surviving `snapshot + tail`.

**Finding — a late base must reconcile earlier Updates (`#475` is not only a cursor).**
Second-guessing the first draft found a real hole: the store materializes by replaying an
entity's **whole log in gsn order** on every read, so a `patch` that arrives before its base
is a no-op at first but _re-applies on top of the base_ once the base lands. An incremental
model that simply drops the no-op loses it. The read model therefore retains every Update
that arrives with no base (an **orphan**) and, when a `put` seeds the base, replays the
orphans **whose gsn is greater than the put's**, in gsn order — exactly the store's sort.
Orphans with a lower gsn are superseded by the full-replacement put. The snapshot watermark
must not advance past an orphan (`toSnapshot` caps `position` at the oldest orphan), or a
hydrate would drop the Update before its base arrives. The harness pins both the
patch-before-backfill case and an orphan spanning a snapshot. This is why `getForEntity`
can still leave the port: the model buffers what it needs instead of re-reading the log.

**IDB satisfiability (argued, not built).** The snapshot persists as one object store keyed
by `[type, id]` holding the `Entity` row, plus a cursor record for `position` / `version`.
Column and adjacency indices are **not** persisted: IDB cannot index nested `FieldValue`
paths, cannot express live-row filtering or adjacency dedup, and would clone the derived
structure wholesale anyway. They are rebuilt in one linear pass at hydrate — ~34 ms at 10k
docs, noise next to hydrate itself.

**What leaves the engine's port**

| Component                                                                          | Fate                                                                                                                                                       |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EntityStore.get`                                                                  | → `readModel.get` (sync)                                                                                                                                   |
| `EntityStore.query(type)`                                                          | → `readModel.iterate(type)` (sync)                                                                                                                         |
| `EntityStore.set`                                                                  | → `optimistic` (local) / `ingest` (durable); provenance replaces a raw set                                                                                 |
| `EntityStore.queryByRelationship` / `queryByMembership`                            | → derived index over the change journal (lands with #497/#498); `internal/reverse-index.ts` is reused                                                      |
| `EntityStore.reset`                                                                | → rebuilt from ports                                                                                                                                       |
| `DirtyTracker.mark` / `isDirty` / `getDirtyForType` / `clear`                      | → the change journal (`id → version/type/deleted`); no "awaiting rematerialization" state                                                                  |
| `EntityChangeEmitter`                                                              | → `version` + `changesSince` (+ a subscribe surface for #501); the journal can reproduce `onEntityChange` / `onTypeChange`                                 |
| `ActionLog.getForEntity` / `getAll`                                                | → **gone**; the read model buffers an Update that arrives before its base (an orphan) and reconciles it when the base lands, so nothing replays per entity |
| `ActionLog.append`                                                                 | survives                                                                                                                                                   |
| `StorageAdapter.entities` / `.dirtyTracker` / `.isDirty` / `.materializeKeepDirty` | leave the engine's port (may linger as a shim)                                                                                                             |
| `CursorStore`, `OutboxStore`                                                       | survive unchanged                                                                                                                                          |

**Does the existing `StorageAdapter` satisfy the port?** No — it is too broad and its
`ActionLog` is too thin. `DurableStore` is exactly
`{ actions: ActionLogPort, snapshots: SnapshotStorePort, cursors: CursorStorePort,
outbox: OutboxStore }`. The memory adapter's `actions.append` returns `void` and it has no
`readTail` / `lastPosition`, so it needs an adapter shim (or the port replaces it).

---

## 5. The apply pipeline — one pipeline, two provenances, one merge rule

```
                     ┌──────────────────────────────┐
durable  ingest ───► │  applyUpdate(prev, update,    │ ──► base
(gsn, log position)  │    { gsn, hlc })   [LWW]      │
                     └──────────────────────────────┘
                     ┌──────────────────────────────┐
optimistic optimistic│  applyUpdate(prev, update,    │ ──► overlay (actionId, update, hlc)
(gsn = 0)            │    { 0, hlc })     [LWW]      │
                     └──────────────────────────────┘
```

- **One merge rule for both provenances.** The overlay composes with the same
  `applyUpdate` / `mergeFieldValue` LWW the base and the server use. The client's
  `applyLocalUpdate` differs here on ties and older HLCs (pending-local-wins); that is the
  behavior to delete, not to port. Rationale: the server's merge is authoritative, so a
  pre-ack view that keeps a losing local write will differ from the post-merge state and
  flip on ack/conflict. Conflict _detection_ is independent either way: it reads the raw
  buffered action and `foldInboundWindow` with the durable rule.

- **Durable** (`SyncClient._applyAction`): append to the `ActionLog` first, then fold each
  Update into the base. `ingest` then `discard`s any overlay entries carrying the same
  `action.id` — the server echo. Version bumps only when `contentChanged`.
- **Optimistic** (`SyncClient.applyLocalAction`): no log append (an unacknowledged Action
  has no gsn). Each Update is appended to the per-entity overlay and the composed row is
  recomputed. `get` / `iterate` return the composed view; the base is untouched.
- **Convergence:** optimistic overlays sit over durable state; the echo removes the overlay
  and lands the same `update_id` in the base. Reads converge; the version does not move if
  the values already agreed.
- **Discard:** `discard(actionId)` drops a rejected / conflicted Action's overlay writes,
  reverting the view to the durable base. This replaces the current
  `reMaterializeFromLog` hack, which "has no way to represent absence".
- **The engine's port obligation:** the caller appends before folding (durability first) and
  folds in ascending position. `ingestDurable(model, store, action, groupId?)` also advances
  the `CursorStore` cursor from `action.gsn`.

**Version / dirty surface #512 consumes:** `handle().version` (reference-identity change
token) plus `changesSince(v)` → `{version, id, type, deleted}[]`. `changesSince` is served
from the journal; a consumer whose watermark predates the journal floor must rebuild from a
snapshot (the journal is bounded in production).

---

## 6. Invariants (the test surface)

1. `ingest` / `optimistic` / `discard` route every Update through `applyUpdate`.
2. Version is monotonic; the handle reference changes **iff** observable content changed.
3. The base is always a pure fold of the log; the overlay never mutates the base.
4. Ordering: ascending log position, then `updates` order.
5. `get` returns tombstones; `iterate` includes tombstones.
6. `last_gsn`-only delivery changes never bump the version.
7. A patch/delete with no base is a no-op for the current read, but is **retained as an
   orphan** and reconciled when a `put` seeds the base — only orphans whose `gsn` exceeds
   the put's, in gsn order (the store's replay rule).
8. `hydrate` is `snapshot(position) ⊕ readTail(position) ⊕ outbox overlay`; idempotent;
   gsn-0 Actions survive; the snapshot watermark never advances past an orphan.
9. Reads return shared rows; callers must not mutate.
10. The optimistic overlay ≡ durable LWW (`applyUpdate(prev, update, 0, hlc)`) on every
    fixture. The production `applyLocalUpdate` **diverges** exactly when a pending write
    ties (and loses the `update_id` tiebreak) or is older — the cases where the server
    would keep the other value. The divergence is pinned, not papered over.

---

## 7. Dual-run evidence

Every case updates both the read model and `createMemoryAdapter()`; after each operation the
harness asserts `get(id)` and `iterate(type)` equivalence (deep, id-sorted). **77/77 checks
pass** on the representative run.

| Case                                                                                  | Result |
| ------------------------------------------------------------------------------------- | ------ |
| put                                                                                   | ✅     |
| patch (higher HLC wins)                                                               | ✅     |
| patch (lower HLC ignored) — version handle and version **unchanged**                  | ✅     |
| equal-HLC tiebreak by lexicographically greater `update_id` (win and lose)            | ✅     |
| map-union field (sibling key retained)                                                | ✅     |
| delete → tombstone; patch-on-deleted ignored; read of deleted                         | ✅     |
| optimistic put, visible pre-echo, then server echo converges                          | ✅     |
| optimistic patch whose base is missing (stays absent)                                 | ✅     |
| #475 backfill (synthetic gsn-0 snapshot put)                                          | ✅     |
| type-index membership across a type change                                            | ✅     |
| cursor advances to the max gsn                                                        | ✅     |
| patch delivered before its backfilled base (#475) — the orphan fix                    | ✅     |
| backfill snapshot with the entity's **true gsn + updated_hlc** (row keeps `last_gsn`) | ✅     |
| an orphan Update spanning a snapshot rehydrates and still reconciles                  | ✅     |
| divergence probe: read model keeps a newer optimistic write the adapter drops         | ✅     |
| merge policy: overlay == durable LWW on every fixture                                 | ✅     |
| documented divergence: `applyLocalUpdate` pending-wins on tie/older (pinned)          | ✅     |
| hydrate: snapshot + tail == incremental; full replay == incremental; gsn-0 survives   | ✅     |
| hydrate: durable outbox replays into the optimistic overlay                           | ✅     |
| seeded fuzz: 300 random durable + optimistic-then-echo ops                            | ✅     |

**#495 budget check (10k metadata docs, in-process):**

| metric                                | measured    | #495 reference            |
| ------------------------------------- | ----------- | ------------------------- |
| resident metadata footprint           | **15.5 MB** | 15.1 MB                   |
| full tree build (adjacency + N reads) | **33.0 ms** | 40.3 ms                   |
| adjacency build                       | 31.4 ms     | 37.0 ms                   |
| build 50k metadata rows               | 172 ms      | (excluded from read cost) |

The footprint matches the reference once the generator matches the reference's row shape
(no optional per-leaf `hlc`; placeholder envelope HLCs). **Caveat:** real writes stamp
per-leaf HLCs, which inflates the resident bytes — the ≤ 32 MB budget on #503 should be
re-measured with production-shaped rows.

---

## 8. Findings / known divergences

1. **A newer optimistic write is lost by the adapter on an unrelated durable touch.** If a
   local Action is optimistically applied (with a newer HLC than an incoming unrelated
   durable Action), the current adapter replays the log from scratch and silently drops the
   local write; the overlay read model keeps it until echo/conflict (probe:
   `read-model title = Local`, `adapter title = Other`). When the incoming durable Action is
   the newer one, both converge on it (LWW) — the older overlay entry loses. The dual-run
   cases assert equivalence on the specified cases and treat the newer-local interleaving as
   a discovery the read model fixes.
2. **`gsn` is the wrong hydrate cursor** (§4). A log-local append position is the robust
   cursor: gsn is neither unique (an Action can be delivered once per group, #473) nor
   guaranteed non-zero. This is independent of what gsn the backfill snapshot carries.
   Append order alone is not enough for _folding_ either: a `put` must reconcile the
   orphans that precede it, gated by gsn (a newer `put` supersedes older orphans).
3. **`gsn: 0` on the backfill snapshot is a conservative shortcut, not a correctness
   requirement — the entity's true `last_gsn` is better.** The server already returns the
   entity's real `last_gsn` (`EntityResponse.last_gsn`); the client copies it in
   `toRuntimeEntity` and then discards it, because `snapshotAction` emits `gsn: 0` and the
   materializer derives the row's `last_gsn` from the _action's_ gsn. A first draft of this
   spec argued zero was load-bearing (the base must sort under every delivered Action).
   That was **wrong**, and second-guessing it against the code disproved it: stamping the
   true `last_gsn` (with `updated_hlc` as the action HLC) is correct, because gsn ordering
   places the full-replacement snapshot at its true causal position — an earlier patch
   (`gsn <= last_gsn`) is subsumed by the snapshot that already contains it, and a later
   patch (`gsn > last_gsn`) merges on top by HLC, exactly like any other action. Verified
   two ways: a dual-run case (`backfill with the entity's true gsn`), and running the repo's
   own backfill suite with `snapshotAction` switched to `entity.last_gsn` — only the two
   assertions that hardcode `gsn === 0` fail; all 14 behavioral tests pass. The switch
   needs no merge-logic change; just those two assertions and the comment.
   The one thing the true gsn does **not** fix is `created_hlc`: the action shape carries a
   single HLC and `applyUpdate`'s `put` sets `created_hlc = updated_hlc`, so a fetched row
   that was patched after creation still loses its `created_hlc`. Preserve that with a
   first-class baseline/seed operation (or an explicit `created_hlc` on the put data) if it
   matters.
4. **`applyLocalUpdate` is redundant, and its pending-wins rule is the bug.** The right
   optimistic merge is `applyUpdate(gsn 0)` — the same LWW the server runs — because the
   server's merge is authoritative: a pre-ack view that keeps a losing local write will
   flip when the Action is accepted. `mergeLocalField`'s "pending local leaf wins outright"
   differs exactly when a pending write **ties and loses the `update_id` tiebreak**, or is
   **older** than the cached field. My first merge-parity check only used strictly newer
   HLCs and missed it. Evidence: switching `mergeLocalField` to `mergeFieldValue` and
   running the client suite fails exactly one test — `conflicts-integration >
re-materializes a losing Action's non-conflicting entity` — which pins `"mine"` for a
   local write that ties and loses the tiebreak. That test, and commit `#326`'s "leaf
   writes keep winning outright ... what the optimistic view has always promised", encode
   the behavior that should change. **Conflict detection is unaffected**: `detectConflicts`
   uses `actionWrites(entry.action)` and `foldInboundWindow` (`mergeFieldValue`), never the
   merged overlay. What changes is the optimistic read and the conflict `before` row (both
   become server-consistent). `discard` / `retry` are unaffected: discard re-materializes
   from the log, and retry stamps a strictly newer action. The read model's overlay uses
   `applyUpdate`; production deletes `applyLocalUpdate` / `mergeLocalField`.
5. **Reads stop cloning.** The adapter deep-clones each read (`copyEntity`); the read model
   returns internal rows. This is the 495 win and the reason a resident model is affordable.
6. **Ordering is an interface obligation.** Out-of-order durable ingest would diverge from
   the adapter's gsn sort; single-writer, ascending-position is a documented invariant, and
   orphan reconciliation must be gated by gsn (not arrival order).
7. **`changesSince` needs a bounded journal in production.** The spike's journal is
   unbounded; a real implementation compacts and forces a snapshot rebuild for a stale
   watermark.

---

## 9. TS-isms to remove when the language-neutral spec is extracted

- `Promise`-returning port methods vs synchronous core reads: the neutral spec should name
  blocking/mutability, not language async types.
- `Map` / `Set` as the concrete store; the neutral phrasing is an ordered key-value map plus
  a hash set with a total order on ids.
- `number` for `gsn` (server-global) and `position` (local append index): name them as
  unbounded integers, not IEEE doubles.
- `FieldValue`'s structural union and the `isFieldMap` runtime discriminant; HLC as a decimal
  string vs a 64-bit bigint.
- `readonly` / optional fields / structural typing.
- The `contentChanged` identity fast path: state it as an equality predicate with an
  identity optimization, not a semantic requirement.
- The outbox `action`/`status` structural subset; the neutral spec references the durable
  action-buffer record.

---

## 10. Non-goals (unchanged)

Query grammar/planner (#498), reactive result cache (#512), residency/TTL (#499/#500), hooks
(#501), wire-protocol or server changes, a second-language implementation, and an actual
IndexedDB snapshot adapter (argued on paper in §4, not built).
