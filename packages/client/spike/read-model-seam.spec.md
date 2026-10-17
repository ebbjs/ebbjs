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
| Merge authority            | `applyUpdate` / `mergeFields` from `storage/src/internal/materialize.ts`, used **verbatim by both provenances**. No LWW is re-implemented anywhere in the read model.                                                                                                                                                                                       |

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

1. **Merge authority is singular.** Every fold routes through `applyUpdate(entity, update,
gsn, hlc)`. `mergeFieldValue` owns LWW and the map-union rule. The read model never
   compares HLCs, never unwraps field envelopes, never re-implements a tiebreak.
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
`append / getForEntity / getAll / lastGsn`. The #475 backfill appends **synthetic gsn-0
snapshot puts**. A `gsn > watermark` replay drops them, and `lastGsn()` cannot distinguish
"folded into the snapshot" from "appended after it". The port therefore needs an
**append-order position**, independent of the server gsn. The harness proves the fix: a
gsn-0 put survives `snapshot + tail` hydrate only because the watermark is a position.

**IDB satisfiability (argued, not built).** The snapshot persists as one object store keyed
by `[type, id]` holding the `Entity` row, plus a cursor record for `position` / `version`.
Column and adjacency indices are **not** persisted: IDB cannot index nested `FieldValue`
paths, cannot express live-row filtering or adjacency dedup, and would clone the derived
structure wholesale anyway. They are rebuilt in one linear pass at hydrate — ~34 ms at 10k
docs, noise next to hydrate itself.

**What leaves the engine's port**

| Component                                                                          | Fate                                                                                                                       |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `EntityStore.get`                                                                  | → `readModel.get` (sync)                                                                                                   |
| `EntityStore.query(type)`                                                          | → `readModel.iterate(type)` (sync)                                                                                         |
| `EntityStore.set`                                                                  | → `optimistic` (local) / `ingest` (durable); provenance replaces a raw set                                                 |
| `EntityStore.queryByRelationship` / `queryByMembership`                            | → derived index over the change journal (lands with #497/#498); `internal/reverse-index.ts` is reused                      |
| `EntityStore.reset`                                                                | → rebuilt from ports                                                                                                       |
| `DirtyTracker.mark` / `isDirty` / `getDirtyForType` / `clear`                      | → the change journal (`id → version/type/deleted`); no "awaiting rematerialization" state                                  |
| `EntityChangeEmitter`                                                              | → `version` + `changesSince` (+ a subscribe surface for #501); the journal can reproduce `onEntityChange` / `onTypeChange` |
| `ActionLog.getForEntity` / `getAll`                                                | → **gone**; nothing replays per entity                                                                                     |
| `ActionLog.append`                                                                 | survives                                                                                                                   |
| `StorageAdapter.entities` / `.dirtyTracker` / `.isDirty` / `.materializeKeepDirty` | leave the engine's port (may linger as a shim)                                                                             |
| `CursorStore`, `OutboxStore`                                                       | survive unchanged                                                                                                          |

**Does the existing `StorageAdapter` satisfy the port?** No — it is too broad and its
`ActionLog` is too thin. `DurableStore` is exactly
`{ actions: ActionLogPort, snapshots: SnapshotStorePort, cursors: CursorStorePort,
outbox: OutboxStore }`. The memory adapter's `actions.append` returns `void` and it has no
`readTail` / `lastPosition`, so it needs an adapter shim (or the port replaces it).

---

## 5. The apply pipeline — one pipeline, two provenances

```
                     ┌──────────────────────────────┐
durable  ingest ───► │  foldUpdate(prev, update,     │ ──► base
(gsn, log position)  │    { gsn: action.gsn,         │
                     │      hlc: action.hlc })       │
optimistic optimistic│                               │ ──► overlay (actionId, update, hlc)
(gsn = 0)           └──────────────────────────────┘
```

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
7. A patch/delete with no base is a no-op.
8. `hydrate` is `snapshot(position) ⊕ readTail(position) ⊕ outbox overlay`; idempotent;
   gsn-0 Actions survive.
9. Reads return shared rows; callers must not mutate.
10. `applyUpdate(prev, update, 0, hlc)` ≡ the production `applyLocalUpdate(prev, update,
hlc)` on the optimistic fixtures.

---

## 7. Dual-run evidence

Every case updates both the read model and `createMemoryAdapter()`; after each operation the
harness asserts `get(id)` and `iterate(type)` equivalence (deep, id-sorted). **54/54 checks
pass** on the representative run.

| Case                                                                                | Result |
| ----------------------------------------------------------------------------------- | ------ |
| put                                                                                 | ✅     |
| patch (higher HLC wins)                                                             | ✅     |
| patch (lower HLC ignored) — version handle and version **unchanged**                | ✅     |
| equal-HLC tiebreak by lexicographically greater `update_id` (win and lose)          | ✅     |
| map-union field (sibling key retained)                                              | ✅     |
| delete → tombstone; patch-on-deleted ignored; read of deleted                       | ✅     |
| optimistic put, visible pre-echo, then server echo converges                        | ✅     |
| optimistic patch whose base is missing (stays absent)                               | ✅     |
| #475 backfill (synthetic gsn-0 snapshot put)                                        | ✅     |
| type-index membership across a type change                                          | ✅     |
| cursor advances to the max gsn                                                      | ✅     |
| merge parity: `applyUpdate(gsn 0)` ≡ `applyLocalUpdate` on six fixtures             | ✅     |
| hydrate: snapshot + tail == incremental; full replay == incremental; gsn-0 survives | ✅     |
| hydrate: durable outbox replays into the optimistic overlay                         | ✅     |
| seeded fuzz: 300 random durable + optimistic-then-echo ops                          | ✅     |

**#495 budget check (10k metadata docs, in-process):**

| metric                                | measured    | #495 reference            |
| ------------------------------------- | ----------- | ------------------------- |
| resident metadata footprint           | **15.5 MB** | 15.1 MB                   |
| full tree build (adjacency + N reads) | **40.4 ms** | 40.3 ms                   |
| adjacency build                       | 38.7 ms     | 37.0 ms                   |
| build 50k metadata rows               | 168 ms      | (excluded from read cost) |

The footprint matches the reference once the generator matches the reference's row shape
(no optional per-leaf `hlc`; placeholder envelope HLCs). **Caveat:** real writes stamp
per-leaf HLCs, which inflates the resident bytes — the ≤ 32 MB budget on #503 should be
re-measured with production-shaped rows.

---

## 8. Findings / known divergences

1. **The adapter loses an optimistic overlay on an unrelated durable touch.** If a local
   Action is optimistically applied and then an _unrelated_ durable Action re-materializes
   the same entity before the echo, the current adapter replays the log from scratch and
   silently drops the local write. The overlay read model keeps it (probe output:
   `read-model title = Local`, `adapter title = Other`). The overlay view is the correct
   one; the read model fixes a real defect. This is why the dual-run cases assert equivalence
   on the _specified_ cases and treat this interleaving as a discovery.
2. **`gsn` is the wrong hydrate cursor** (see §4). A log-local append position is required
   for #475.
3. **`applyLocalUpdate` is redundant.** The merge-parity check shows the normative
   `applyUpdate` with `gsn 0` equals it on every optimistic fixture. The only difference is
   `mergeLocalField`'s "local leaf wins outright" vs LWW; that is equivalent because local
   field HLCs are always freshest, an assumption the read model should state. Production can
   delete `applyLocalUpdate` and `mergeLocalField`.
4. **Reads stop cloning.** The adapter deep-clones each read (`copyEntity`); the read model
   returns internal rows. This is the 495 win and the reason a resident model is affordable.
5. **Ordering is an interface obligation.** Out-of-order durable ingest would diverge from
   the adapter's gsn sort; single-writer, ascending-position is a documented invariant, not
   an accident.
6. **`changesSince` needs a bounded journal in production.** The spike's journal is
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
