# 779 — Subscription-owned residency

Status: design note, pre-implementation. Spikes live on
`spike/779-subscription-residency`. No production code in this note is merged.

This note starts from the forcing bug and ends with a slice plan. It treats the
current split — a refcounted query-result cache beside an LRU component window —
as an accident, and asks what the client looks like when **the subscription owns
the data it reads**.

Vocabulary follows `CONTEXT.md`: _replica_, _materialize_, _residency_,
_component_, _query_, _result status_, _cursor_, _catch-up_. "Lease" is new and
is defined in §6.

---

## 1. Current architecture

Two caches, two owners, three accidental couplings.

```text
                    ┌──────────────────────────────────────────────┐
                    │ Query cache  (packages/client/…/query-cache) │
                    │ unit: one (surface, lowered Query)            │
                    │ owner: the query cache                       │
                    │ lifetime: refs > 0; then queryTtlMs (5 min)   │
                    │ shedding: inactive-entry timer, no cap        │
                    │ reads: rowReadComponentsFor / readComponents  │
                    └───────────────┬──────────────────────────────┘
                                    │ (1) execution reads a row;
                                    │     a cold join calls open()
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ Replica (packages/storage/src/replica/replica.ts)                       │
│ unit: one (entity, component) value                                     │
│ owner: the replica                                                      │
│ lifetime: held forever, or pinned until close + pinnedTtlMs (30 s)      │
│ shedding: LRU trim to pinnedCapacity (16; #932 raises to 256)           │
│ journal: one ReplicaChange per observable change, capacity 1024         │
└───────────────┬─────────────────────────────────────────────────────────┘
                │ (2) open / releaseComponent / evict journal a data change
                ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ Derived readers: query cache, EntityWatcher, scope eviction, backfill   │
│ each keeps its own revision cursor; each scans all its entries          │
└─────────────────────────────────────────────────────────────────────────┘
```

| Cache            | Unit                  | Owner            | Lifetime                             | Shedding                                   |
| ---------------- | --------------------- | ---------------- | ------------------------------------ | ------------------------------------------ |
| Query results    | `(surface, Query)`    | `query-cache.ts` | refs + `queryTtlMs` (5 min)          | inactive TTL, no cap                       |
| Component values | `(entity, component)` | `replica.ts`     | held forever, or open → close + 30 s | LRU to `pinnedCapacity`, TTL on close only |

The **three coupling channels**:

1. **Execution pins with no subscriber.** `EntityNamespace.get` calls
   `replica.open` for every non-held component of the stored row
   (`namespace.ts`, `get`); `openJoinedRows` (`query-builder.ts`) opens every
   lazy component of every joined target. Neither holds a subscription and
   neither ever calls `close`. Open pins do not TTL, so "what has ever been
   read" drives memory until the LRU trims it.
2. **A mixed journal.** `releaseComponent` and `evict` call `bump`, so a
   residency release is indistinguishable from a write in `changesSince`. Every
   derived reader treats it as a data change, re-runs, re-opens, and trims
   someone else's pin. `installComponent` also bumps: materializing an already
   committed value invalidates every reader of that model.
3. **Unaligned lifetimes.** A cached query result outlives its components by up
   to five minutes; a component outlives its reader by 30 s after close; an open
   pin outlives everyone. Remount cost is decided by which timer happened to
   fire, not by what the reader needs.

**Where subscriptions already exist.** `FanOutRouter` keeps
`connection → group ids`; each `GroupServer` pushes one shared encoding to its
subscribers and self-stops when empty; `CatchUp` resumes from a per-group
cursor. The client has the delivery half of that shape (`createReplicaSignal`,
`createEntityWatcher`) but no equivalent registry for query/row dependencies.

---

## 2. Failure inventory

Every way residency is decoupled from the subscription that reads the data.

| #   | Failure                                                 | Mechanism today                                                                                                | Under the target                                                                                                 |
| --- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| F1  | A read silently returns a partial row                   | `open` trims the LRU after each install; a selection larger than the window loses its earliest components (S1) | Gone: no cap; a read either leases what it selected or fails loudly                                              |
| F2  | One row's read evicts another row's inputs              | LRU is global; `open(n_2, engine)` releases `n_1/content` (S1)                                                 | Gone: a held lease cannot be released by a peer's acquire                                                        |
| F3  | Memory follows "ever read", not "reading"               | Open pins never TTL; only `close` or trim releases                                                             | Gone: a lease is released when its subscription ends; only inactive values wait out the TTL                      |
| F4  | Cache pressure causes re-run storms                     | Release journals a change → query invalidates → re-runs → re-opens → trims a peer → repeat                     | Gone: residency changes stop advancing the content revision; a subscribed result's inputs cannot be released     |
| F5  | Materializing a committed value invalidates readers     | `installComponent` → `resync` → `bump`                                                                         | Gone: acquisition is not a write. A reader waiting on its own acquire is resolved by that acquire                |
| F6  | `get(id)` leaks every lazy component of the row         | opens all, holds no lease, never closes                                                                        | Gone: `get` leases its selection for the read and releases after projection                                      |
| F7  | A one-shot `await query.with(...)` leaks joined targets | `then` → `runProjectingPlan` → `openJoinedRows`, no release                                                    | Gone: the read's dependency set is leased for execution; a cached entry leases while cached                      |
| F8  | Two TTLs on related bytes                               | `queryTtlMs` and `pinnedTtlMs`/`cacheTtlMs` tick independently                                                 | One owner and one TTL (§5, §6)                                                                                   |
| F9  | A scope eviction can remove a row someone is watching   | `applyReplicaScope` → `replica.evict`; the row watcher drops `undefined` silently                              | `unloaded` with no component: a membership event, not pressure                                                   |
| F10 | Leaks are invisible                                     | `ReplicaStats.pinned` is a total; no subscription attribution                                                  | Per-subscription lease stats, oldest-inactive age, dev warning on a subscription that never releases             |
| F11 | A missed unsubscribe is permanent                       | An open pin leaks until trim; with a cap it silently truncates peers                                           | A missed unsubscribe leaks forever: no cap is also no pressure valve. Visibility is mandatory (risk R1)          |
| F12 | Journal gaps become full re-runs                        | `changeFloor` trimming; empty changes on an advanced revision means "everything"                               | Same policy, but decided per subscription cursor; a gap is an explicit full re-run, not an accidental empty scan |
| F13 | A cross-model write is reported twice                   | `touchedComponentSet` names fields under both prefixes                                                         | Keep: it is correct for invalidation; the index handles both names                                               |
| F14 | A `loading` declaration decides memory, not the reader  | `eager` holds forever; `lazy` needs `open`                                                                     | Replaced: selection decides read residency; a separate persist policy decides the offline base                   |

**What `unloaded` should still mean.** One event, one meaning: _a component the
subscription selected left the replica while the subscription was still alive,
without the subscription asking_. That is scope eviction, a replica `load`, a
conflict hold release, or a store miss on first acquire. It is **not** routine
memory pressure: no cap means no capacity eviction, and a leased component
cannot TTL out from under its reader. A soft delete is still a snapshot
(tombstone), as `CONTEXT.md` requires.

---

## 3. Hypothesis verdicts (G1–G6)

Spike sources:

- S1 `packages/storage/src/replica/__spike__/s1-truncation.test.ts`
- S2 `packages/client/src/sync/__spike__/s2-lease.test.ts` + `lease.ts`
- S3 `packages/client/src/sync/__spike__/s3-dispatch.test.ts` + `dispatch.ts`
- S4 `packages/client/src/sync/__spike__/s4-select.test.ts`, `s4-select.test-d.ts` + `select.ts`
- S5 `packages/client/src/sync/__spike__/s5-incremental.test.ts`
- S6 `packages/client/src/sync/__spike__/s6-lifecycle.test.ts`

All six run green on the spike branch; the baseline storage suite (497 passed,
1 skipped) and the client query-cache / on-demand / entity-subscribe suites
(43 passed) still pass.

### G1 — No-cap residency works: **confirmed, with a new leak risk**

S1 with the window removed (`pinnedCapacity: 0`) returns all three components;
with `pinnedCapacity: 2` it returns two and loses the first. The red repro on
current main, verbatim:

```text
S1 journal: [
 {"revision":2,"id":"n_1","deleted":false,"components":["note/title"]},
 {"revision":3,"id":"n_1","deleted":false,"components":["note/engine"]},
 {"revision":4,"id":"n_1","deleted":false,"components":["note/title"]},
 {"revision":5,"id":"n_1","deleted":false,"components":["note/title","note/content"]}
]
S1 row fields: ["engine","content"]      # `title` was requested; no error
S1 unrelated-row stats: {"note/content":1,"note/engine":1}
                                          # opening n_2/engine evicted n_1/content
```

The same three-component selection with #932's `cacheCapacity: 2` reproduces it
exactly (the default of 256 only raises the number of components needed to lose
one). S2 proves the primitive that replaces the window:

- two subscriptions on one `(row, component)` share one acquire and one value;
- the last release arms the TTL, an earlier release does not;
- a remount at 80 % of the TTL cancels expiry and performs **zero** store reads;
- 1,000 leases stay resident with no trim, then return to zero after release +
  TTL;
- a double release cannot free a peer's lease.

The risk is stated plainly: a cap is a pressure valve. With no cap, a
subscription that never releases holds its data forever. That is the intended
semantics, but it means F11 needs first-class visibility rather than "the LRU
will eventually drop it".

### G2 — Dependency-indexed fan-out works: **confirmed**

S3 builds inverted indices over the components, models, and row ids a
subscription declares, then compares indexed dispatch with today's
`entries × changes` scan on the same batches:

| Workload                         | Scan match evaluations | Indexed lookups | Subscriptions touched |
| -------------------------------- | ---------------------- | --------------- | --------------------- |
| 5,000 subscriptions, 100 changes | 500,000                | 280             | 2,621                 |
| 5,000 subscriptions, 1 change    | 5,000                  | 3               | 100                   |

The touched sets are identical on every fixture batch (the test asserts set
equality against the scan). The measured win is ~190× fewer decisions for a
burst; the lookups are proportional to changed components and row ids, not to
the registry size. Whole-model readers dominate the touched set, which is the
cost S4 removes.

### G3 — Selection replaces `loading`: **partially confirmed; do not remove `loading` yet**

Confirmed for **read residency and projection**:

- today a `rows` result reads `["note/*", "ebb/membership"]`
  (`rowReadComponentsFor`); a selected result reads
  `["note/title", "note/status", "ebb/membership"]`;
- a write to `note/content` invalidates today's rows entry and **not** the
  selected one; a write to a selected component still does;
- two selections of the same query get different cache keys;
- the type-level selection narrows the projected row to the selected fields plus
  `id`, rejects unknown fields, and narrows `get(id, { … })` the same way.

Refuted as "selection is the projection **and** the invalidation key **and** the
lease set, all at once" without qualification:

- A predicate and an `orderBy` read a field the result does not project.
  Selection is the **projection**; the lease set is
  `projection ∪ predicates ∪ order ∪ joins`.
- A row entering or leaving the source set names no component. S4 shows a
  bare create/delete (`components: []`) does **not** hit a component selection,
  so every query also needs a **membership** dependency on the source model and
  an **index** dependency for each predicate/join (`structuralReads`).
- Offline persistence cannot be inferred from a subscription that has not
  happened yet (G6).
- An entity-scope conflict holds the whole row regardless of selection
  (dynamic lease, §6).
- A cold start still needs a base to materialize; that is a persist policy, not
  a read policy.

Verdict: `loading`/`materialization` are removable **after** a persist policy
replaces the offline half; selection alone is not enough. Do not delete them in
the same slice that introduces selection.

### G4 — Incremental vs re-run: **confirmed for cost; patching is a narrow fast path, not the default**

Re-run counts under today's cache (S5, stub replica):

- a `rows` entry re-runs on `note/title` and `note/content` writes; a filtered
  `collection` entry reads only `note/status` + membership and does **not**
  re-run on either;
- a `note/status` write re-runs both;
- 100 changes delivered as one journal batch cause **one** re-run per affected
  entry; 100 separate notifications cause 100 (the replica notifies once per
  Action, so batches are the norm, but every `open`/`close`/`evict` is its own
  notification — that is how F4 becomes a storm).

Full execution vs patching on 10,000 rows:

| Path                  | Rows examined | Time      |
| --------------------- | ------------- | --------- |
| Re-execute the plan   | 10,000        | ~14.6 ms  |
| Patch one changed row | 1             | ~0.035 ms |

Patch-safe shapes:

- an unfiltered, unordered, unlimited `rows` query when a projected component of
  a resident row changes (replace that row's projection);
- a row subscription (always a patch test);
- a filtered query when the changed component is not a predicate, order key, or
  join key: re-test only that row's predicate and add/remove it.

Unsafe, must re-plan: any predicate field, any order field, a `limit`
boundary, a join target's membership/cardinality, a tombstone/create/delete,
scope eviction, and a journal gap. Re-run is the default in slice 1; each fast
path lands with its own test.

### G5 — One inactive lifetime: **confirmed; one owner, one TTL**

`queryTtlMs` and the component TTL guard different objects (a projected result
array vs component values), so they are not literally two timers on the same
bytes. They are still two answers to one question — _how long does an
unwatched read stay warm_ — and they disagree. Merge the owners: a cached query
result is an **inactive subscription** that owns leases on its read set. Ending
its subscription starts the same TTL as ending a row subscription; expiry
releases the leases and drops the result. One `residencyTtlMs`.

Races are linearized on the lease table:

- **release vs acquire at T**: the acquire either finds the entry (cancels the
  timer, no read) or finds it gone (one read). The timer callback checks
  `refs === 0` and its own generation before deleting, so a callback already
  queued cannot delete a re-acquired value.
- **remount within TTL**: acquire cancels the timer; the value was never
  released, so no store read and no re-run.
- **remount after TTL**: one store read; the query result is `stale` until it
  settles.
- **unmount while a read is in flight**: the acquire's generation is
  invalidated; the resolving read installs nothing (today's `openEpoch` rule,
  kept).

### G6 — Cold start/offline: **a separate persist policy is required**

S6 models the record as a set of `(row, component)` values and restores it as
inactive leases (same TTL):

| Record policy              | Values persisted (50 rows, 4 components, 5 notes open) | Store reads on a same-session remount | Reads on a different 5-note session |
| -------------------------- | ------------------------------------------------------ | ------------------------------------- | ----------------------------------- |
| A. held-only (today)       | 50                                                     | 5                                     | 5                                   |
| B. last active working set | 55                                                     | 0                                     | 5                                   |
| C. full resident row       | 200                                                    | 0                                     | 0                                   |

After the TTL, restored values leave and the next acquire reads the store. So
"persist the last working set, restore as leases" gives the same cold-start win
as full-row persistence at a quarter of the record, without pinning yesterday's
working set forever.

Decision: **`retain` is a persist policy, separate from residency.** It names
what the record keeps at rest; residency names what is in memory now. Group
scope remains the offline base (a row in scope keeps its base row and declared
persist components). Everything else is a lease acquired on read; a miss reads
the entity store, and an absent store row is a backfill, not a silent hole.

---

## 4. Removals

Evaluate, don't assume. Every row below was read in place.

| Symbol / file                                                                                                                             | Why it goes                                                                                                                            | Replacement                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pinnedCapacity` / `cacheCapacity`, `capacityOf`, `trimPins` (`replica.ts`)                                                               | A cap is the bug: it truncates a read and makes one read evict another's inputs (S1)                                                   | No cap. `leases.acquire/release` with refcounts                                                                                                  |
| LRU iteration order in `pins` (`Map` touch on open)                                                                                       | Ordering exists only to choose a victim                                                                                                | Delete; a lease has no victim                                                                                                                    |
| `pins`, `Pin`, `pinKey`, `pinComponent`, `openPin`, `closePin`, `releaseComponent`                                                        | The pin is a one-way latch: open never TTLs, close is the only release, release is journaled as a write                                | One lease table: `refs`, `inactiveSince`, `timer`, `generation`                                                                                  |
| `pinnedTtlMs` / `cacheTtlMs` as a window timer                                                                                            | Second TTL on the same question (G5)                                                                                                   | `residencyTtlMs`, owned by the lease manager                                                                                                     |
| `DEFAULT_PINNED_CAPACITY`, `DEFAULT_PINNED_TTL_MS`, `DEFAULT_CACHE_*`                                                                     | Same                                                                                                                                   | `DEFAULT_RESIDENCY_TTL_MS`                                                                                                                       |
| `ReplicaStats.pinned`, `pinnedComponents`                                                                                                 | A total with no attribution; cannot answer "who is holding this?" (F10)                                                                | `leased`, `inactive`, `leasedComponents`, `oldestInactiveMs`                                                                                     |
| `Replica.isOpen`                                                                                                                          | Openness is one bit of a lease, not a public state                                                                                     | `leaseRefs(id, component)` (engine-internal)                                                                                                     |
| `Replica.open` / `Replica.close` as public API                                                                                            | A reader-shaped verb that no reader calls symmetrically; `get`/joins open without closing (F6, F7)                                     | `acquire(id, component) → release` (internal); public reads go through `get`/`query`/`subscribe`                                                 |
| `MaterializationPolicy.holds`, `holdAll`, `resident()`'s `some(holds)`, `stripToResidency`, `dormant`                                     | A static declaration is a poor proxy for a dynamic reader                                                                              | Lease-driven residency + `retain` persist policy                                                                                                 |
| Component `loading` (`"eager"`/`"lazy"`), model `materialization` (`client.ts` `residencyFromRegistry`, `query-builder.ts` `modelIsHeld`) | Read policy moves to selection; offline policy moves to `retain` (G3/G6)                                                               | `select(...)` on reads; `retain` on the schema/record                                                                                            |
| `Replica.isRowHeld`                                                                                                                       | "All components held" is a static assumption; a row with leased bodies is resident but not held                                        | `fullyResident(row)` = every carried component resident (for the store-mirror rule); otherwise per-component                                     |
| `OnDemandQueryError` (`query-builder.ts`)                                                                                                 | A scan over a lazy model is legal once the read declares what it needs; the error encodes the old held-only scan                       | Two-phase read: narrow ids on index/held data, then acquire the selected components for the page (requires `limit`/keyset for a body projection) |
| `openJoinedRows`, `coldJoins`, `hasOnDemandJoin`, `modelIsHeld` special-casing                                                            | A join is a dependency: the query should lease the joined rows it projects, on every surface, and release them when the result settles | Join targets join the subscription's dependency set; the registry acquires/releases them                                                         |
| Coarse `rowReadComponentsFor` (`<model>/*`)                                                                                               | It exists because a projected row was assumed to carry the whole shape; selection removes that assumption                              | `selectionReadComponents`: projection ∪ predicate/order ∪ joins ∪ membership                                                                     |
| `queryTtlMs`, `DEFAULT_QUERY_TTL_MS`, `CacheEntry.evictTimer`                                                                             | Second inactive timer (G5)                                                                                                             | Subscription TTL in the registry                                                                                                                 |
| `entries` map + `for (const entry of entries.values()) reconcile(...)` (`query-cache.ts`)                                                 | All-entries scan on every change                                                                                                       | Dependency indices (§8)                                                                                                                          |
| `compilations` refcount table (`query-cache.ts`)                                                                                          | A second refcount table beside the new one                                                                                             | Compiled read set owned by the subscription                                                                                                      |
| `createEntityWatcher`'s `entityListeners`/`accessorListeners` maps                                                                        | A third registry with its own dispatch loop and no lease                                                                               | Row subscriptions in the subscription registry (accessor deps are index deps)                                                                    |
| `replica-signal.ts` per-reader cursor                                                                                                     | Each reader calls `changesSince`; the dispatcher should do it once                                                                     | One dispatcher cursor + per-subscription cursors                                                                                                 |
| `scope-eviction.ts` `evict` as a data operation                                                                                           | Scope eviction is the end of a membership lease, not a tombstone                                                                       | Scope subscription end → release leases by group; `unloaded` for live readers                                                                    |
| README over-capacity paragraph (#932)                                                                                                     | It documents F1 as guidance                                                                                                            | Delete with the cap                                                                                                                              |
| `isOpen` / `isComponentResident` in `subscribeToEntity`'s unloaded tracking (#932)                                                        | Correct for #932's pressure model, but TTL-under-reader must be impossible                                                             | Lease identity + `releaseReason`                                                                                                                 |

**Keep:** `ReplicaRecord`'s `notResident`/`componentVersions` (existence and
version survive a restart), `changeFloor` (a real catch-up gap), the
`revision`/journal protocol (it is the correct primitive; it just stops
carrying residency releases), and `scope-eviction`'s group rule.

---

## 5. Additions

| Module / API                                               | Responsibility                                                                                                                                                          |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `storage/src/replica/leases.ts`                            | One lease table over `(id, component)`: refcount, one inactive TTL, generation-guarded expiry, `{leased, inactive, oldestInactiveMs}` stats. No cap.                    |
| `client/src/sync/subscriptions.ts`                         | The registry: one entry per live query/row subscription; `revision` cursor; result snapshot; acquires/releases its dependency leases; terminal `unloaded`.              |
| `client/src/sync/dependency-index.ts`                      | Inverted indices (`component →`, `model →`, `row →`, `index:<name> →`), reverse map for removal, one dispatcher cursor, gap handling.                                   |
| `client/src/sync/selection.ts`                             | The `Selection` type, `selectionReadComponents` (projection ∪ predicates ∪ order ∪ joins), `structuralReads` (membership + indices), the cache key, and the projection. |
| `Query.selected` + `query().select(...)`                   | One declaration for projection and lease set; `get(id, { select })` for a single row.                                                                                   |
| `ReplicaChange` → `{ kind: "content"                       | "membership" }`(or`exists` bit)                                                                                                                                         | Make "a row entered/left the source set" explicit instead of overloading `components: []`. |
| `ReplicaStats` lease fields                                | Leak visibility: who holds what, how long it has been inactive (F10).                                                                                                   |
| `retain` persist policy                                    | What the replica record keeps at rest (G6), independent of residency.                                                                                                   |
| `useRow` / `useQuery` acquire-on-mount, release-on-unmount | The React lifecycle owns the subscription; `useSyncExternalStore` already gives the unsubscribe path. A row hook subscribes to a row + selection.                       |
| Dev-mode lease watchdog                                    | Warn on a subscription older than N minutes whose component set never changes, and on `close()` with live leases.                                                       |

---

## 6. Target lifecycle

A **lease** is one counted claim on a `(row, component)` value. A
**subscription** is a counted claim on a result plus the leases its
dependencies need. Subscriptions are the only public thing; leases are how the
replica knows what to keep.

### Query subscription

```text
                    run(selection)
 create ──► running ──────────────► current
   │           │  ▲                    │
   │           │  │ change (patch)     │ relevant change
   │           │  └────────────────────┤
   │           │                       ▼
   │           │                    stale ──run──► current
   │           │  change (re-plan)     │
   │           └───────────────────────┘
   │
   │ unsubscribe (last)
   ▼
 inactive ──remount < TTL──► current (no read, no re-run)
   │
   TTL
   ▼
 gone (release every lease, drop the result)
```

- Acquire: on first run, acquire every component in
  `projection ∪ predicates ∪ order ∪ joins`, plus a membership dependency on the
  source model; a join target's ids are acquired when the plan resolves them.
- Share: two chains lowering to the same query + selection share one
  subscription and one lease set.
- Release: last unsubscribe arms the TTL. The result stays usable and warm.
- Error: `failed` keeps the leases (a retry is coming); a terminal store miss
  reports `unloaded` for that component and releases it.
- Delete: a tombstone is a normal change (snapshot with `deleted_hlc`), not a
  release.
- Scope eviction / replica `load`: a membership event. Release leases that are
  no longer in scope and emit one `unloaded` per component (or one with no
  component when the row is gone).

### Row subscription

```text
 create(get) ──► resident ──content change──► resident (snapshot)
                     │
                     ├── delete ─────────────► resident (tombstone snapshot)
                     ├── scope eviction ─────► unloaded{component?}
                     │                         └─ re-get re-acquires
                     └── last unsubscribe ────► inactive ──TTL──► gone
```

- `get(id, { select })` acquires for the duration of the read, then releases.
  The returned projection owns its values (scalars are copies; maps are shared
  and stay alive through the returned object), so releasing after projection is
  safe. A mounted `row.subscribe` keeps the selection leased until it
  unsubscribes.
- The whole-row `unloaded` survives for the one case a component event cannot
  express: the row itself left the replica (scope eviction, same-id model
  change). It is not a capacity event any more.
- Conflict holds: an entity-scope conflict acquires leases on every component of
  the row for as long as the hold exists; releasing the hold releases them. A
  component/field-scope conflict leases only the contested component.

### Component lease

```text
 acquire ──refs=1──► leased ──acquire──► leased(refs=2) ──release──► leased(refs=1)
                      │                                                  │
                      │ release (refs=0)                                  │
                      ▼                                                  │
                   inactive(timer) ──acquire < TTL──► leased ◄────────────┘
                      │
                      TTL (refs still 0, generation matches)
                      ▼
                   released (value leaves the replica)
```

- A component value enters the replica only on acquire (a durable write may
  materialize it early if the persist policy says so) and leaves only at TTL
  expiry.
- An active lease is never TTL-released, never evicted, and never truncated. A
  read that selects N components gets all N or a loud error.
- Expiry is a residency event, not a content revision. It notifies the lease's
  own waiter/observer, not every query on the model.

---

## 7. API and breaking changes

Proposed surface (naming is the decision to settle in review; no aliases, per
pre-release rules):

```ts
// Collection read: one declaration is the projection and the lease set.
const open = client.issue
  .query()
  .select({ title: true, status: true, assignee: true }) // projection
  .where("status", "open")
  .with({ assignee: true }); // joins add their own targets to the lease set

const rows = await open; // readonly { title; status; assignee; id }[]
const live = open.subscribe((rows) => …);

// Single row: the same selection narrows the projection and the lease set.
const note = await client.note.get(noteId, { select: { title: true, content: true } });
const off = note?.subscribe((event) => {
  if (event.type === "snapshot") render(event.row); // { title, content, id }
  else if (event.component) reload(event.component); // only on a real eviction
  else recoverRow(); // the row left the replica
});
```

- `select` takes **field keys** of the row, and derives `<model>/<field>`.
  Full component names are accepted for platform/overlay components that are not
  model fields. Unknown keys are a compile error and a runtime validation error.
- `get(id)` with no selection keeps the historical "every component the stored
  row carries" behaviour for one release, then narrows to the model's
  `retain` set. (This is the one place a deprecation-free narrowing is a real
  breaking change; it is pre-release, so it can be one step.)
- `query().select(...)` is the only way to project a subset. `.select({})`
  returns `id` only. A query that projects a lazy component is legal: the plan
  narrows first, then acquires the page. Without a `limit` this is a full read
  of the type — expensive, not incorrect; the docs say to page.
- `EntityEvent` stays a discriminated union (`snapshot | unloaded`), but
  `unloaded` no longer fires for capacity (there is none) or for a TTL under a
  live subscription. Add `reason?: "scope" | "reset" | "conflict" | "miss"`? —
  keep it out of v1; the three cases all mean "re-read".
- `row.subscribe` becomes the documented public row read alongside `get`.
  Collection `subscribe(filter, cb)` keeps its snapshot contract.
- `Replica.open`/`close` stop being public. If a low-level escape hatch is
  wanted for tests, expose `acquire`/`release` (returning a release) and keep
  `open` as a one-shot `get`-like helper that releases after projection.
- `ReplicaOptions.pinnedCapacity`/`pinnedTtlMs` (or #932's
  `cacheCapacity`/`cacheTtlMs`) are removed with no alias. One
  `residencyTtlMs`.
- `Query.sourceComponents` folds into `selected`; the value-view namespace
  supplies its one platform component as the selection.
- `EntityRow.subscribe` is a breaking signature change (already breaking in
  #932) and stays breaking: consumers narrow on `event.type`.

**#932 verdict: amend, do not merge as-is.** It does the right surface work —
component-scoped `get`, `EntityEvent`, and `unloaded` per component — and that
surface is a prerequisite for this plan. But it renames the LRU to
`cacheCapacity`/`cacheTtlMs` and documents the forcing bug as guidance ("a
selection larger than `cacheCapacity` cannot all stay resident … the row omits
them"). That is F1 with a bigger default. Amend #932 to: keep selection and
`EntityEvent`; drop the capacity rename (the name belongs to the lease design);
make an over-window selection impossible by removing the trim, or — if it must
ship before slice 1 — fail loudly instead of omitting fields and never call the
knob a cache. Then slices 0–2 supersede its residency internals. Do not merge it
unchanged and do not build the redesign on its option names.

---

## 8. Dispatch design

One dispatcher owns one replica subscription and one journal cursor. It
maintains the indices the registry declares:

| Index key         | Value                                                                                                            | Who registers                                |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `component`       | subscriptions reading that exact component                                                                       | query projections/predicates, row selections |
| `model`           | subscriptions reading a model whole or its membership                                                            | unfiltered scans, existence/index readers    |
| `row`             | row subscriptions and joined-target leases                                                                       | `get`, `subscribe`, join targets             |
| `index:<name>`    | subscriptions whose predicate/join reads that index (`relation:<as>/<type>`, `membership`, `exists:<component>`) | filtered and joined queries                  |
| `scope:<groupId>` | subscriptions scoped to a group                                                                                  | scope lifecycle                              |

A batch:

1. Read `changesSince(cursor)` **once**. If the batch is empty on an advanced
   revision, or the cursor is below `changeFloor`, it is a gap: mark every
   subscription stale and re-run (§G5's remount rules still apply).
2. For each change, look up `row →`, `component →`, `model →`, and for a
   membership change `index:membership` / `scope:<id>`. Union, dedupe.
3. For each touched subscription, decide: patch (G4-safe shape and only
   projected components changed) or re-run. Advance its cursor to the batch
   revision either way.
4. Emit one notification per changed snapshot; never notify a re-run that
   produced a structurally equal result.

Complexity: `O(Σ_changes reads × lookups + touched × decision)` against today's
`O(subscriptions × changes)`. S3's numbers: 500,000 → 2,621 touched for a
100-change burst over 5,000 subscriptions.

**Initial result vs delta.** A new subscription runs once, records the
revision it executed at, and receives deltas from then on. A subscription whose
cursor lags by more than the journal window, or whose result shape a delta
cannot patch, re-runs. A white lie is the same as today's: `revision` read
before execute, compared after, and a change that landed in between triggers a
reconcile rather than being silently swallowed.

**Journal kinds.** `ReplicaChange` gains a kind so membership and content never
collide: `content` changes name the components they touched; `membership`
changes say the row entered, left, or changed model. `unloaded` is driven by the
subscription's own lease release, not by a journal entry, so losing a value does
not masquerade as a write.

---

## 9. Persistence / offline decision

The record is a **fast path, never correctness** (`ReplicaStore`'s contract).
Under subscription-owned residency it persists:

1. every row in the client's group scope, with base metadata and its
   `retain` components (`ebb/membership`, model metadata, whatever the app
   declares durable);
2. the component values **leased at save time** — the working set that was
   actually open — not every value that was ever materialized;
3. `notResident` existence and `componentVersions`, as today.

On hydrate: `replica.load(record)` installs the record's values as **inactive
leases** with `residencyTtlMs`; the action tail after `position` is folded; the
outbox overlay is applied. Then the first subscriptions acquire:

- a selected component already restored: **zero** store reads;
- a selected component absent from the record but present in the entity store:
  one store read;
- absent from both: a backfill (server), never a silent empty field.

This is S6 policy B. It gives the same cold-start win as persisting every
resident row (policy C) at ~¼ of the record in the measured workload, and it
does not pin yesterday's working set: unleased values expire on the same TTL.

What `retain` is not: it is not `loading`. `retain` answers "what must survive a
restart for offline"; residency answers "what is in memory now". A `retain`
component is materialized at hydrate and persisted; a non-`retain` component is
acquired by a subscription and may never be persisted at all. Offline apps
declare a group scope plus `retain` on the components they need with no network;
everything else is a lease.

Open question recorded for review: whether `retain` is declared per component,
per model, or as one record-level policy. The spike does not distinguish them;
the model-level declaration matching today's `materialization` is the smallest
migration, but it cannot express "persist a document body only after it has been
opened once". Recommend component-level `retain` seeded from the model default.

---

## 10. Slice plan

Each slice is independently verifiable, test-first, and leaves the tree green.
No slice may reintroduce a cap.

### Slice 0 — Delete the cap; prove the full selection returns

Files: `packages/storage/src/replica/replica.ts` (remove `trimPins`, capacity
option, LRU victim selection), `replica/types.ts`, `packages/client/src/sync/types.ts`,
`packages/client/README.md`, tests.

Failing test first: S1 promoted to `packages/storage/src/replica/replica.test.ts`
— a row with three non-held components, all requested, returns all three, at any
configured capacity (and the option no longer exists). A client-seam test asserts
`get(id, { components: [...three] })` returns all three.

Acceptance: S1 green with the cap deleted; no path calls `trimPins`; README
limitation paragraph gone; `ReplicaStats.pinned` no longer truncates anything.
Known gap (documented): open pins now leak until `close`, because slice 1 has
not landed. This slice is a stop-the-loss slice only.

### Slice 1 — Lease manager at the replica seam

Files: new `storage/src/replica/leases.ts`; `replica.ts` uses it for
acquire/release/inactive TTL; `ReplicaStats` lease fields; tests S2-shaped.

Failing test first: S2 ported to the replica API — two callers share one value;
last release TTLs; remount within TTL reads nothing; 1,000 components stay
resident; double release is safe.

Acceptance: no `pins`/`trimPins`; `open`/`close` are thin wrappers over
acquire/release (or removed); expiry no longer bumps the content revision;
`stats()` reports leased/inactive/oldest-inactive.

### Slice 2 — Subscription registry and dependency indices

Files: new `client/src/sync/subscriptions.ts`, `dependency-index.ts`;
`query-cache.ts` and `replica-signal.ts`/`createEntityWatcher` move onto it;
`ReplicaChange` gains a kind.

Failing test first: S3 ported — index dispatch touches exactly the scan's set,
and a 5,000 × 100 batch reports the touched count, not 500,000.

Acceptance: one dispatcher cursor; per-subscription cursors; journal gap re-runs;
row subscriptions in the registry; `unloaded` on scope eviction.

### Slice 3 — Selection

Files: `query.ts`, `query-builder.ts`, `query-plan.ts` (selection read
derivation), `namespace.ts` (`get(id, { select })`), `select.ts`-equivalent,
type tests.

Failing test first: S4 ported — today reads `<model>/*`, selected reads the exact
set; an unselected write does not invalidate; a create/delete is caught by the
membership dependency; the typed surface narrows and rejects unknown fields.

Acceptance: `.select(...)` on `query()` and `get`; cache key includes the
selection; joins lease their targets on both one-shot and cached paths;
`OnDemandQueryError` removed and a paged lazy projection test covers the
replacement.

### Slice 4 — Merge the caches and the TTLs

Files: `query-cache.ts` becomes a thin view over the registry;
`client.ts` drops `queryTtlMs`; one `residencyTtlMs`; README/options.

Failing test first: remount inside the TTL performs no store read and no re-run;
after TTL the result is gone and the leases are back to baseline; one timer
configures both.

Acceptance: S2/S6 invariants at the client seam; `stats()` returns to baseline
after unmount + TTL.

### Slice 5 — Delta vs re-run

Files: `subscriptions.ts` decision, `query-execute.ts` patch helpers, benchmark
harness.

Failing test first: S5 ported — a projected-component write patches one row; a
predicate/order/limit/join write re-runs; re-run counts per change are asserted.

Acceptance: patch paths for the G4-safe shapes only; every unsafe shape has a
test asserting re-run; benchmark reports rows examined and re-runs per change.

### Slice 6 — Remove `loading`/`materialization`, add `retain`

Files: `client.ts` `residencyFromRegistry`, `query-builder.ts` `modelIsHeld`,
schema/registry declarations, `replica.ts` load policy, docs.

Failing test first: S6 ported — a record persists the working set; hydrate
restores it as leases; a same-session remount reads nothing; a different session
reads only its missing bodies; TTL clears.

Acceptance: no `loading`/`materialization` in the read path; `retain` drives
hydrate; offline tests (group scope, no network) pass; cold start counters
match S6.

Ordering note: slices 0–2 fix the bug and the leak shape without changing the
query API. Slices 3–6 are breaking and may be one release. Do not interleave
slice 3 before slice 2: selection without indexed dispatch is a read-set
change on top of the all-entries scan.

---

## 11. Test / benchmark plan and risk register

### Tests

| Layer                                   | What it proves                                                                                                                                                        |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `storage/replica` lease tests           | share, release, TTL, remount, double release, 1k no-cap, expiry is not a content revision, unmount during in-flight read installs nothing                             |
| `storage/replica` truncation regression | three components on one row always return three; an unrelated row's component is never released by a peer's acquire                                                   |
| `client` dispatch tests                 | indexed set === scan set on fixtures; journal gap re-runs; batch touches each subscription once                                                                       |
| `client` selection tests                | exact read set = projection ∪ predicates ∪ order ∪ joins ∪ membership; cache key includes selection; unselected change is silent; `unloaded` only on real departure   |
| `client` type tests (`*.test-d.ts`)     | selection narrows the row, rejects unknown fields and non-`true` values, narrows `get`                                                                                |
| `client` one-shot tests                 | `await qb.with(...)` releases its joined targets; a one-shot `get` release leaves the returned projection intact                                                      |
| `react` tests                           | `useQuery`/`useRow` unsubscribe on unmount; remount inside TTL subscribes with no re-run; a thrown render still releases                                              |
| offline integration                     | record → hydrate with no network → a subscription over `retain` components settles; a non-retained selection reports `unloaded{component}` rather than an empty field |

### Benchmarks

Extend `packages/client/src/benchmark/replica-read-model.ts` and
`harness.ts` with: rows examined per change (already counted), re-runs per
change, subscriptions touched per batch, lease count / inactive count / oldest
inactive age, store reads per remount, and cold-start record size per policy.
Report S3/S5/S6-style tables so a regression is a number, not an anecdote.

### Risk register

| Risk                                   | Why it bites                                                                                                              | Mitigation                                                                                                                                                 |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1 A missed unsubscribe leaks forever  | No cap is no pressure valve; a React effect that forgets cleanup pins a body for the session                              | Dev-mode watchdog (age + never-changing refs), `useQuery`/`useRow` own cleanup, a test that throws during render, stats surfaced in the client             |
| R2 One-shot reads leak again           | Easy to add a `get`/join path that acquires and forgets                                                                   | Acquire returns a release; lint/test helper; a leak test per new read path                                                                                 |
| R3 Offline regression                  | `loading` removal changes what hydrate materializes                                                                       | `retain` policy + offline integration test before slice 6 merges; S6 counters                                                                              |
| R4 Type complexity                     | Selection generics can make `.select` unusable and `QueryRowOf` explode                                                   | Type tests first; field-key selection only; no nested selection; `QueryRowOf` derives from the same `SelectedRow`                                          |
| R5 Server scope mismatch               | App scope (`group.apps`) is a sync filter, not authorization; a client can select a component the server will not deliver | Residency is a local optimization; a missing component is `unloaded{component}`/backfill, never a partial row. Do not infer authorization from a selection |
| R6 Re-run storm returns via a new path | A patch path that bumps revision on acquire                                                                               | The "acquisition is not a write" invariant has its own test in slice 1                                                                                     |
| R7 Dispatch index drift                | An index that is not updated on dependency change silently misses a subscription                                          | Add/remove in one transaction with the subscription; S3's set-equality test against the scan in debug builds                                               |
| R8 Journal window 1024                 | A slow subscription falls off the window and re-runs everything                                                           | Cursor-gap behavior is explicit and counted; benchmark a 10k-row re-run (S5: ~15 ms)                                                                       |
| R9 Conflict holds vs selection         | An entity conflict must hold the whole row; a selection-based lease set would release it                                  | Hold is a lease owner; add its components to the lease set for the hold's lifetime; test a conflict + TTL                                                  |
| R10 #932 churn                         | Its option names disappear one release later                                                                              | Amend #932 per §7; land slices 0–2 before it                                                                                                               |

---

## What this sprint could not settle

- **`retain` granularity** (component vs model vs record). S6 measures the
  policy, not the declaration shape.
- **Patch fast paths beyond row replacement.** S5 proves the 10k → 1 win for
  a filtered row set; order/limit/join patching needs a sorted structure
  (e.g. an order index) that this sprint did not prototype.
- **Lazy projection without a limit.** Selection makes it legal; the cost is a
  per-row acquire. The right ergonomics (throw? implicit page? require
  `limit`?) is a follow-up.
- **React Suspense / transitions.** The plan keeps the current
  `useSyncExternalStore` contract; it does not add a Suspense read.
- **Server-side component selection.** The client can select; the server still
  delivers whole Actions. A read-filtered delta is out of scope (and
  `CONTEXT.md` says reads are not field-granular at the delivery boundary).
- **Persisting the working set at save time is a snapshot, not a log.** A
  component written while it was leased but saved after the lease ended is
  persisted under the policy; whether the record should include it is a policy
  question S6 does not answer.

## Appendix — spike commands and baseline

```bash
# from the spike worktree
pnpm install
pnpm build:packages
pnpm --filter @ebbjs/storage exec vitest --run src/replica/__spike__/s1-truncation.test.ts
pnpm --filter @ebbjs/client  exec vitest --run src/sync/__spike__
pnpm --filter @ebbjs/storage test                 # 497 passed, 1 skipped
pnpm --filter @ebbjs/client  exec vitest --run \
  src/sync/__tests__/query-cache.test.ts \
  src/sync/__tests__/on-demand-documents.test.ts \
  src/sync/__tests__/entity-subscribe.test.ts      # 43 passed
cd packages/client && npx tsc --noEmit              # includes the .test-d.ts spike
```

No `ebb_server/` change, no `mix`, no dependency-symlink write.
