# Map-field write path (#496): representation and merge research

Research note for [issue #496](https://github.com/ebbjs/ebbjs/issues/496) — the
read-model / durability seam. The #496 spike settled the seam but its budget was
read-focused. The finding under test here is the spike's own biggest open risk
(`packages/client/spike/read-model-seam.spec.md:452-464`): **a single keystroke in
a collaborative-text body patches one run key of the doc's `content` map, and the
normative merge copies the entire map on every patch.**

This note measures the write path across representations and proposes a ranked
fix. It does **not** change the wire protocol or the shared merge rule; every
option keeps the existing flat `{ map: { key: leaf } }` encoding.

**Apparatus.** Throwaway prototype on branch `research/496-map-field-write-path`
(based on `spike/496-read-model-seam`). Run:

```sh
pnpm --filter @ebbjs/client spike:map-write-path   # 3-5 min, writes the tables below
pnpm --filter @ebbjs/client spike:read-model-seam  # the baseline probe
```

Source: `packages/client/spike/map-reps.ts` (containers + the merge over a
container), `packages/client/spike/map-write-path.ts` (driver, parity, tables).

**Machine.** AMD EPYC 7763, 4 vCPU, 16 GB, Node v24.21.0 (V8), gc on.
Measurements are glue-code microbenchmarks on one process; treat magnitudes as
indicative and re-run on the target. Cells are µs/op, median-of-loop.

**Sources read.** `packages/core/src/types/action.ts`; the shared vectors
(`fixtures/merge_vectors.json`); `packages/storage/src/internal/materialize.ts`,
`memory/entity-store.memory.ts`, `indexeddb/entity-store.indexeddb.ts`; the #496
spike (`packages/client/spike/read-model.ts`, `read-model-seam.ts`,
`read-model-seam.spec.md`); `packages/client/src/fields/collaborative-text/{text-document,wire,tree}.ts`;
`packages/client/src/sync/{conflict-slots,conflicts,committer,namespace}.ts`;
`packages/react/src/use-entity.ts`; the Elixir server
`ebb_server/lib/ebb_server/storage/{field_merge,entity_store,sqlite,writer,rocks_db}.ex`
and `ebb_server/lib/ebb_server/storage/action_validator.ex`.

---

## TL;DR — ranked recommendation

1. **P0 · No-op-aware merge + `changed` signal (client `@ebbjs/core` + `storage`).**
   [measured] Today a _losing_ patch still rebuilds the whole map (`{ ...existing.map }`)
   and the read model then rescans it structurally: N=1000 ≈ **278 µs copy + 335 µs
   scan ≈ 610 µs** (the probe measured the combined ingest at 483 µs). Returning the
   existing reference when no key changed and adding a reference fast path to
   `contentChanged` takes it to **~0.2 µs** at every N. ~30 lines, no wire change, no
   memory change, no protocol change. **Do this regardless of everything below.**
   It does **not** fix the winning keystroke — see P1.
   **Shipped in [#514](https://github.com/ebbjs/ebbjs/pull/514)** together with the
   server decode win: the merge-only losing patch at N=5000 fell from **1892 µs to
   1.5 µs**, and a dirty server materialize at N=5000 from **41.5 ms to 27.4 ms**
   (client `applyUpdate` winning, and the merge vectors, unchanged).
2. **P1 · A representation for the winning path, only when N justifies it.**
   [measured] The winning one-key patch is O(N) on a plain object (N=1000 **229 µs**,
   N=10000 **3.9 ms**), O(N) on a native `Map` (still **1.3 ms** at N=10000), but flat
   on a **sharded container** (shard(64): **5–14 µs** to N=10000) and flat on a
   **HAMT** (**~0.2 µs**, but **1.8× resident memory**). Ranked by
   effort/benefit:
   - **P1a · in-place resident merge** — cheapest integration, zero memory; requires
     the read model to own its rows (the #496 contract already says "must not be
     mutated"). Fragile w.r.t. retained rows; see §6.4.
   - **P1b · shard(64) resident container** — recommended structural shape:
     near-object memory, ~30 lines, no dependency, but needs P0's `changed` flag
     (without it the O(N) scan would dominate and sharding would be pointless)
     and a container type at the resident boundary.
   - **P1c · HAMT resident container** — best constant, 1.8× memory and an O(N)
     snapshot encode/hydrate; adopt only past ~10–50k runs.
     The measured flip point is **N ≈ 300–500 runs**, where the plain-object copy
     crosses ~25–60 µs/keystroke.
3. **P1-server · cut the JSON round trips in `EntityStore.materialize`.** [measured]
   The Elixir server does **not** copy the map — `Map.merge/3` is O(log₃₂ N) with
   structural sharing (~0.5 µs for a one-key patch at any N). Its real per-dirty-patch
   cost is JSON: **2 × `Jason.decode!` + 1 × `Jason.encode!` of the whole entity blob
   ≈ 70 ms at N=5000**, ~30× the client's map copy. This is the single largest number
   in this note; it is a server slice, not a client representation problem.
   **The redundant decode shipped in [#514](https://github.com/ebbjs/ebbjs/pull/514)**;
   ETF storage / a per-key side table remain open.
4. **Do not**: one entity per run (breaks group-scoped permission; §6.1), a compact
   envelope / run registry on the wire (protocol change, no write benefit; §6.2),
   a native `Map` container (still O(N); §3.1), or a lazy/windowed content that
   breaks the synchronous-read goal (§6.3).

---

## 1. The problem, stated precisely

A collaborative-text document is one entity whose `content` field is a
[map field](https://github.com/ebbjs/ebbjs/issues/326). Each run is a key:
`data.fields.content.map[<runId>] = { value: <RunNode | null>, update_id, hlc }`
(`packages/client/src/fields/collaborative-text/wire.ts:5-40`). Runs are **not**
separate entities on purpose: the server's `<type>.<verb>` permission model
applies to the document as a whole, and the run node keeps its own `actorId`.

A keystroke at the end of a run is an `EXTEND_RUN` → a `patch` Update touching
**one** key (`text-document.ts:437-520`). A new run touches one key plus, on a
split, the parent key. So the common write is a one- or two-key patch of an
N-key map.

The normative merge is `mergeFieldValue` (`packages/core/src/types/action.ts:84-100`):

```ts
const merged: Record<string, FieldValue> = { ...existing.map }; // ← copies all N keys
for (const [key, value] of Object.entries(incoming.map)) {
  merged[key] = mergeFieldValue(merged[key], value);
}
return { map: merged };
```

`mergeFields` likewise spreads the fields record
(`packages/storage/src/internal/materialize.ts:32-38`), though that record holds
only the declared fields and is O(#fields).

`structuralClone`/`{ ...obj }` on a large object is not smoothly linear in V8:
the object transitions out of fast properties into dictionary mode around a few
hundred keys and the constant rises steeply. That is the "property cliff" in the
spike spec. The measurements below reproduce it.

### 1.1 The cheap no-op case is the one the read model pays most for

The read model computes `contentChanged` by comparing `updated_hlc` first — a
winning patch changes it, so the comparison short-circuits. A **losing** patch
(duplicate / out-of-order / re-delivered Action) leaves `updated_hlc` unchanged
and falls through to a full structural scan of the map
(`read-model.ts:120-160`). So today a losing patch pays the O(N) copy _and_ the
O(N) scan.

---

## 2. Method, and a V8 trap worth recording

`map-reps.ts` defines a `MapContainer<V>` interface (empty / size / get /
setMany / copy / entries / toWire / fromWire) and expresses the normative
map-over-map rule once, over that interface: union the incoming keys, merge each
by the unchanged `mergeFieldValue`. `mergeTopMap(..., reuseOnNoop)` models both
today's unconditional rebuild (`false`) and the no-op fix (`true`).

> **Elision trap.** A pure map-copy microbenchmark can be _optimised away_.
> Timing `mergeTopMap` on a 1000-key object with no observation of the result
> original measured **7 µs**; the same loop reading one untouched sibling key
> measured **169–228 µs**, matching the real `applyUpdate` (225 µs). V8 elides the
> clone's dead stores when the untouched entries are never loaded, and the
> optimisation state is sticky. Every timing below reads the patched key and a
> sibling, which is also what the real read model does (`contentChanged`,
> projection, snapshot). Any future microbenchmark of this path must do the same.
> [measured]

Parity: all 15 shared merge vectors reproduce for every container, and
`overlappingPaths` (`conflict-slots.ts`) sees disjoint-key writes as no slot and a
same-key race as one slot, for every container — the representation is invisible
to the conflict recursion. See §4.

---

## 3. Measurements

### 3.1 Winning one-key patch vs N (µs/op) — the keystroke path

`reuseOnNoop=false` (today's unconditional rebuild), key 0.

| rep            | N=100 | N=200 | N=300 | N=500 | N=750 |    N=1000 | N=2000 |   N=5000 |  N=10000 |
| -------------- | ----: | ----: | ----: | ----: | ----: | --------: | -----: | -------: | -------: |
| object (today) |   5.2 |  15.3 |  26.2 |  59.3 | 125.7 | **228.7** |  561.0 | **1960** | **3930** |
| `Map`          |   6.1 |  12.0 |  17.7 |  25.5 |  43.1 |      66.6 |  125.3 |    519.6 |     1297 |
| `Map` in-place |   0.4 |   0.3 |   0.3 |   0.3 |   0.3 |       0.4 |    0.3 |      0.3 |      0.3 |
| shard(16)      |   2.5 |   2.7 |   2.8 |   2.8 |   3.4 |       4.2 |    8.1 |     49.1 |     99.1 |
| shard(64)      |   6.6 |   6.3 |   6.2 |   5.3 |   6.6 |       7.8 |    6.1 |      9.3 |     13.5 |
| shard(256)     |  20.7 |  20.1 |  20.7 |  22.1 |  21.1 |      19.4 |   21.5 |     18.9 |     18.8 |
| HAMT           |   0.5 |   0.3 |   0.2 |   0.3 |   0.2 |       0.2 |    0.2 |      0.2 |      0.2 |

- The plain object is **~4 ms/keystroke at N=10000**, with a steep rise between
  N=200 and N=1000 (3×→15×→229 µs). That is the cliff, and it is the shape the
  spike warned about.
- A native `Map` is ~3× better in constant but **still O(N)** (1.3 ms at
  N=10000). It is not a fix. (Its only edge: `new Map(existing)` is a tight
  linear copy without the dictionary transition.)
- shard(64) is flat to N=10000 at **~5–14 µs**; the cost is `N/K + K` property
  writes. shard(16) degrades once `N/K` grows; shard(256) pays the 256-slot array
  copy even for small N. **K=64 is the sweet spot for the N range measured.**
- HAMT is **flat ~0.2 µs** at every N; a one-key write copies ~4 nodes.
- Position (first / middle / last key) changes nothing material for any rep —
  see §3.3.

### 3.2 Losing patch and change detection (µs/op)

| rep            | forced rebuild N=1000 | no-op reuse N=1000 | forced N=10000 | reuse N=10000 | scan N=1000 | scan N=5000 | scan N=10000 |
| -------------- | --------------------: | -----------------: | -------------: | ------------: | ----------: | ----------: | -----------: |
| object         |                 278.3 |                0.2 |           3870 |           0.2 |     **335** |    **3790** |     **8440** |
| `Map`          |                  70.3 |                0.2 |           1210 |           0.2 |          98 |         704 |         1667 |
| `Map` in-place |                   0.3 |                0.2 |            0.2 |           0.2 |         0.0 |         0.0 |          0.0 |
| shard(16)      |                   7.8 |                0.3 |          107.9 |           0.3 |         509 |        3320 |         6850 |
| shard(64)      |                   6.2 |                0.3 |           14.5 |           0.3 |         295 |        3160 |         6640 |
| shard(256)     |                  18.1 |                0.3 |           19.2 |           0.3 |         352 |        2530 |         6400 |
| HAMT           |                   0.6 |                0.3 |            0.2 |           0.2 |         345 |        2110 |         4690 |

- **The no-op fix alone takes the losing patch from ~610 µs (copy+scan) at
  N=1000 to ~0.2 µs**, at every N — for the current representation, with no memory
  change. The probe's combined losing-ingest number (483 µs at N=1000) is this
  cost.
- **The scan is the half that no container removes.** `scanChangedRep` is O(N)
  for every rep that keeps it: hundreds of µs to milliseconds (object 335 µs /
  HAMT 345 µs at N=1000; 8.4 ms / 4.7 ms at N=10000). The shard/HAMT scans are
  comparable to or somewhat better than the object's property walk at large N,
  and shard(16) is worse at small N — i.e. the container does not help here. The
  `changed` flag from the merge is what makes P1b/P1c a win: without it a shard
  buys a cheap write and then pays an unchanged O(N) scan, so the scan would
  dominate and the container would be pointless.
- HAMT's forced "rebuild" is already a no-op: `hamSet` reuses the node chain when
  the value is unchanged, so it is intrinsically no-op-aware.

### 3.3 Position sensitivity

For every rep, the first-key, middle-key and last-key tables are within noise of
each other (HAMT/shard are content-addressed; the object copies all properties
regardless of position). Position is not a design factor; the full tables are in
the benchmark output.

### 3.4 Size, snapshot and structured-clone cost at N=5000

| rep        | wire JSON bytes | resident `v8.serialize` bytes | snapshot clone bytes | `toWire` µs | snapshot encode µs | hydrate decode µs | resident heap bytes/doc |
| ---------- | --------------: | ----------------------------: | -------------------: | ----------: | -----------------: | ----------------: | ----------------------: |
| object     |         281,671 |                       251,676 |              251,676 |         0.1 |               1570 |               0.1 |                 559,019 |
| `Map`      |         281,671 |                       251,676 |              251,676 |        1003 |               2752 |              1851 |                 592,147 |
| shard(64)  |         281,671 |                       251,869 |              251,676 |        1758 |               3695 |              1947 |                 565,774 |
| shard(256) |         281,671 |                       252,447 |              251,676 |        1283 |               3278 |              2206 |                 567,942 |
| HAMT       |         281,671 |                   **471,775** |              251,676 |        1463 |               3336 |              2824 |           **1,017,987** |

- **Wire bytes are identical for every rep** (the wire is flat; the container is
  in-memory only). IndexedDB structured-clone of the snapshot is likewise
  identical (251,676 B) because the snapshot is encoded flat before it is stored.
- The marginal costs of a non-object resident rep are `toWire` on snapshot
  (~1–1.8 ms at N=5000) and `fromWire` on hydrate (~1.9–2.8 ms). Both are
  **per-snapshot / per-hydrate, not per-write**, so they amortise.
- **The only real memory cost is HAMT's ~1.8×** resident bytes (472 KB vs 252 KB
  clone; 1.02 MB vs 0.56 MB heap). Sharding is memory-neutral.
- Caveat: `v8.serialize` is a structured-clone proxy, not IndexedDB itself; the
  snapshot stays row-shaped per #473 either way.

### 3.5 HAMT shape

|     N | depth | branch nodes | leaves | collisions | nodes copied per write |
| ----: | ----: | -----------: | -----: | ---------: | ---------------------: |
|    10 |     1 |            1 |     10 |          0 |                      2 |
|   100 |     2 |           33 |    100 |          0 |                      3 |
|  1000 |     5 |          305 |   1000 |          0 |                      4 |
|  5000 |     5 |         1246 |   5000 |          0 |                      4 |
| 10000 |     5 |         2226 |  10000 |          0 |                      4 |

5-bit branching, depth 5 at N≥1000, ~4 nodes copied per key. That is the flat
0.2 µs, and it is why the write cost stops growing.

### 3.6 Server side (Elixir)

Measured on this machine with the repo's `mix`/`elixir` toolchain, `FieldMerge`
is dependency-free:

```sh
cd ebb_server
elixir -pa _build/dev/lib/jason/ebin /tmp/verify_merge.exs   # field merge
```

|    N | `FieldMerge.merge/2`, 1-key | equivalent flat map copy (`:maps.from_list(:maps.to_list/1)`) |
| ---: | --------------------------: | ------------------------------------------------------------: |
| 1000 |                 **0.48 µs** |                                                      153.9 µs |
| 5000 |                 **0.51 µs** |                                                      955.7 µs |

**The server does not copy the map.** `Map.merge/3` → `:maps.merge_with/3`
iterates the _smaller_ map (`elixir/lib/map.ex:651-653`; OTP `maps.erl:379-390`)
and shares structure, so a one-key patch is one O(log₃₂ N) update. `stamp/2`
(`field_merge.ex:101-105`) runs only over the incoming patch field, O(1) for a
one-key patch. The spike spec's parenthetical "the server pays it too"
(`read-model-seam.spec.md:459`) is **inaccurate as stated about the map copy**.

What the server does pay is **JSON**, on the materialize/read path:

| server operation                                       | site                                       | verdict                                  |
| ------------------------------------------------------ | ------------------------------------------ | ---------------------------------------- |
| Writer append (`term_to_binary` of the Action)         | `writer.ex:1107,1169`                      | O(patch); **not O(N)** for a 1-key patch |
| `FieldMerge.merge` → `Map.merge/3`                     | `field_merge.ex:72`, `entity_store.ex:397` | **O(log N)**                             |
| `FieldMerge.stamp` on the incoming field               | `entity_store.ex:395`                      | O(payload); O(1) for a 1-key patch       |
| `Jason.decode!(row.data)` (existing blob)              | `entity_store.ex:183`                      | **O(N)**                                 |
| `Jason.encode!(merged_data)`                           | `entity_store.ex:287`                      | **O(N)**                                 |
| SQLite 8× STORED `json_extract` on upsert              | `sqlite.ex:78-85,245`                      | **O(N)** per parse                       |
| `format_entity/1` decode (2nd decode; also clean hits) | `entity_store.ex:298,430`                  | **O(N)**                                 |

JSON throughput (realistic doc, ~130 B/run, Jason):

|    N |   bytes | `Jason.decode!` | `Jason.encode!` |
| ---: | ------: | --------------: | --------------: |
| 1000 | 129,658 |          2.4 ms |          2.6 ms |
| 5000 | 665,658 |         29.6 ms |         12.4 ms |

A dirty one-key patch materializes with **2 decodes + 1 encode** → **≈ 70 ms at
N=5000**, five orders of magnitude above the 0.5 µs merge. The benchmarked
commit path (`bench/runner.ex:146`, `sync/router.ex:63`) never materializes, so
the server is **not** on the critical write path for the map copy today; but
every read after a write pays the JSON. Candidate #1 in the #485 spike
("materialize on write") would import that cost into the commit path.

---

## 4. Correctness parity

Every container reproduces the protocol exactly; the prototype's `mergeTopMap`
_is_ the normative rule specialized to the container, delegating each leaf to the
unchanged `mergeFieldValue`.

| check                                                                                                                                 | result |
| ------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 15/15 shared merge vectors, every container (object, `Map`, `Map` in-place, shard 16/64/256, HAMT) [measured]                         | ✅     |
| disjoint run keys → `overlappingPaths` returns no slot; same key → exactly `[["k_a"]]`, every container [measured]                    | ✅     |
| `IsDeepStrictEqual` against `fixtures/merge_vectors.json` (LWW, tiebreak, map union, nested map, kind mismatch, tombstone) [measured] | ✅     |
| baseline suites green: `@ebbjs/core` 135 tests, `@ebbjs/storage` 295, `client conflicts.test.ts` 34 [measured]                        | ✅     |

Because the wire and snapshot stay flat, **no protocol, wire-size or IndexedDB
change is required by any option**; the container is an in-memory detail. The
one cross-cutting constraint is the resident type boundary (§5).

---

## 5. The real integration cost: `FieldValue` is both the wire type and the resident type

This is the finding that decides the shape of P1. `FieldValue`'s map variant is
literally `{ readonly map: Record<string, FieldValue> }`
(`packages/core/src/types/action.ts:33-55`). The read model stores `Entity`
rows whose fields are `FieldValue`, and consumers of those rows
(`parseContentField` in `wire.ts`, `projectFieldValue` in `query-builder.ts`,
`conflictSide`, the derived-body accessor at `namespace.ts:565`, React
`useEntity`) read `.map`. So a container that is not a plain record either:

1. **converts to the wire shape at the read-model boundary** — O(N) per read,
   which defeats the synchronous-read goal the whole seam exists for; or
2. **becomes part of `Entity`/`FieldValue`** — a type-level change rippling
   through `isFieldMap`, the merge, conflict slots, the wire adapters, the React
   projection and IndexedDB; or
3. **is introduced as a read-model-internal container with a documented
   `toWire`/`fromWire` seam**, and the row's `content` field is materialized flat
   only at the boundaries (snapshot, projection, TextDocument hydrate) — paying
   O(N) there, which is the same order those paths already pay, but keeping the
   public `FieldValue` type.

Option 3 is what the prototype models and what P1b/P1c assume. It is not a local
change; it deserves its own slice and issue. **P1a (in-place) sidesteps the type
boundary entirely** because it keeps the resident `content` as the plain wire
record and mutates only the changed key — which is why it is listed first on
effort, despite its contract risk.

---

## 6. Alternatives analysed but not (fully) benchmarked

### 6.1 One entity per run — NO-GO

Runs as separate entities would make a one-key write a one-row write (no map at
all), but it overturns the load-bearing reason runs are map keys. Evidence:

- **Permission.** `wire.ts:14-22` rejects `subject_type: "run"` explicitly:
  `run.update` is too broad — any actor with it could rewrite any run. The doc's
  own type scopes the grant. The server agrees: the required permission is
  `<subject_type>.<verb>` in an owning group (`authorizer.ex:614-627`), and there
  is no per-entity/per-field permission (`permission_checker.ex:61`).
- **Membership / index.** Every user entity must resolve ≥1 owning group
  (`authorizer.ex:614-620`); membership is per entity (`entity_index.ex:167`).
  Per-run rows → N membership rows per doc and N `cf_type_entities` keys.
- **Query.** `EntityStore.query` joins `entityGroup`+`groupMember` per row
  (`sqlite.ex:334-347`); `can_read?` resolves per entity id
  (`permission_checker.ex:171`).
- **`last_gsn` / `updated_hlc` / dirty.** The monotonic upsert guard
  (`sqlite.ex:107`, rationale `entity_store.ex:38-41`) and the one-mark-per-entity
  DirtyTracker (`dirty_tracker.ex:88`) assume one row per doc. Per-run rows move
  the frontier to the run and lose the doc-level `updated_hlc` the client's
  `contentChanged` short-circuit reads.
- The RocksDB log format (`cf_actions`, `cf_entity_actions`, `cf_group_actions`)
  would survive; entity identity/keying changes.

Verdict: a larger change than the map cost it removes. Revisit only if the
product needs per-run permissions or per-run conflict rows — a product decision.

### 6.2 Compact envelope / run registry — not worth it here

Per-leaf `update_id` + `hlc` (and `hlc` duplicated inside the `RunNode`) is real
byte overhead (~56 B/run in the synthetic bench; production run nodes are
larger). A shared run registry could shrink the wire, but:
it changes the wire and snapshot shape; the LWW triple must stay per-key for
convergence; and it does **not** affect write scaling (the copy is over keys,
not bytes). Separate issue if snapshot size becomes a problem. [reasoned]

### 6.3 Lazy / windowed content — conflicts with the synchronous-read goal

Keeping a compact run index resident and materializing the projected map on read
would move the O(N) cost off the write path but onto every read, and the read
model's contract is synchronous `get`/`iterate` returning rows. The derived-body
accessor already re-parses the whole map on every read
(`namespace.ts:565` → `parseContentField` → `applyRunFieldUpdates`), so reads are
O(N) today; adding a lazy layer does not remove that, it adds a cache to
invalidate. [reasoned; read cost out of scope here]

### 6.4 In-place mutation + version handle (P1a), and the shared-row audit

The prompt's warning is apt: the #496 read model says "rows are not copied and
must not be mutated" (`read-model.ts:47-56`), but the legacy adapters deep-clone
every read (`memory/entity-store.memory.ts:49,164`; `indexeddb/...:69`) and the
storage test suite _pins_ that isolation ("returns copy to prevent mutation",
`entity-store.test-suite.ts:171-178`).

Audit of production call sites that touch `entity.data.fields`:

- **No production code assigns into a field map or run map.** The only such
  mutation is the isolation test itself.
- Callers _retain_ rows: React `useEntity` is `useSyncExternalStore` over the
  row snapshot; the derived-body accessor holds the entity long enough to
  hydrate.

So in-place mutation of the resident `content` map is viable **only** under
these conditions: (a) the read model is the sole owner of the row (the legacy
adapters are not the same store); (b) `get(id)` returns a **fresh entity wrapper**
when content changed, so `useSyncExternalStore`'s `Object.is` snapshot check
fires — mutating only the inner map while returning the same entity object would
silently suppress re-renders; (c) the merge reports `changed` accurately so a
losing patch never mutates; (d) no consumer keeps a row across a write and
expects it to be frozen (an old entity wrapper shares the mutated map).

Because (d) is an invisible contract that will be broken by a future `useMemo` /
cache, in-place is ranked below the copy-on-write containers despite being the
cheapest. It is the right call only if the read model can enforce ownership
(e.g. `Object.freeze` is _not_ used and no retained-row consumers exist).

### 6.5 Coalescing / batching (#332)

#332 is server-side Writer batch coalescing (`writer.ex`), not client keystroke
coalescing. The client's committer already wraps a batch of operations in one
Action (`committer.ts:1-11`), and the flush scheduler coalesces triggers, but
`TextDocument.localInsert`/`localExtend` each build their own Action and
self-flush (`text-document.ts:344-360,495-510`), so keystrokes are _not_
coalesced into one map patch today. Coalescing B keystrokes into one patch would
amortise the O(N) copy over B (one copy per batch instead of per keystroke) and
cut server-bound Action count, but it does not remove the O(N) term, does not
help other clients' ingest, and does not help the server's per-read JSON. It is
complementary, not a substitute. [reasoned]

---

## 7. Recommendation

### P0 — no-op-aware merge and a `changed` signal (do now) — **shipped in #514**

Concrete shape (reference-identity convention; no return-type change, so the
server mirror and all callers are untouched):

```ts
// packages/core/src/types/action.ts
export const mergeFieldValue = (existing, incoming) => {
  if (existing === undefined) return incoming;
  if (!isFieldMap(existing) || !isFieldMap(incoming)) {
    /* unchanged */
  }
  let changed = false;
  let merged = existing.map;
  for (const [key, value] of Object.entries(incoming.map)) {
    const prev = merged[key];
    const next = mergeFieldValue(prev, value);
    if (next !== prev) {
      if (!changed) {
        merged = { ...existing.map };
        changed = true;
      }
      merged[key] = next;
    }
  }
  return changed ? { map: merged } : existing; // ← reuse on no-op
};
```

```ts
// packages/storage/src/internal/materialize.ts
export const mergeFields = (existing, update) => {
  const patch = readFields(update);
  let merged = existing.fields,
    changed = false;
  for (const [field, patchValue] of Object.entries(patch)) {
    const prev = merged[field];
    const next = mergeFieldValue(prev, patchValue);
    if (next !== prev) {
      if (!changed) {
        merged = { ...existing.fields };
        changed = true;
      }
      merged[field] = next;
    }
  }
  return changed ? { fields: merged } : existing; // reuse the whole data object
};
```

Then `applyUpdate`'s patch branch builds the entity wrapper (O(1)) with the
shared `data`, and the read model's `fieldsEqual` gets a `if (a === b) return false`
top-level fast path. A losing patch → same `data` reference → `contentChanged` is
O(1); the `updated_hlc` short-circuit still handles the winning patch.

Why this is safe: the merge already returns the existing leaf by reference on a
loss, so reference identity already means "no observable change" for leaves; this
extends the same convention to the map. The 15 vectors are deep-equality checks
and pass unchanged. Only three production call sites exist
(`materialize.ts`, `conflict-slots.ts`, the internal recursion), and none mutates
a merged result. The server needs no change: `FieldMerge.merge` already returns
`existing` for a losing leaf, and its cost is O(log N).

Server-side, the `changed` flag additionally lets `apply_patch` answer "did this
patch change the row?" — but the server must still advance `last_gsn` and
`updated_hlc`, and it re-encodes JSON unconditionally today
(`entity_store.ex:287`); skipping the encode when nothing changed is a ~12 ms
win at N=5000 per no-op materialize. Worth including if a server slice touches
this.

### P1 — the winning path, when N justifies it

Measured flip point: **plain object is fine below ~300 runs** (≤26 µs/keystroke);
past ~500–1000 it is 60–230 µs and rising steeply. Choose by product reality:

- **Docs bounded ≤ ~300 runs, or one/few hot docs:** P0 only. No representation
  change. This is the common case and the recommendation's default.
- **Docs can reach thousands of runs, and the read model is the only row owner:**
  **P1a (in-place)** — 0.2 µs, no memory, no type ripple; accept the retained-row
  contract.
- **Docs can reach thousands of runs and rows are shared/frozen/cached:**
  **P1b (shard(64))** — 5–14 µs flat, memory-neutral, ~30 lines, no dependency;
  requires P0 and a resident `content` container with a `toWire`/`fromWire`
  boundary (§5). Snapshot/hydrate gain ~1.8–1.9 ms at N=5000 (amortised).
- **Docs can exceed ~10k runs, or writes are the hottest loop:** **P1c (HAMT)**
  — 0.2 µs flat, ~4 nodes copied, but 1.8× resident memory and ~1.5–2.8 ms
  snapshot/hydrate at N=5000. No off-the-shelf dependency is in the workspace;
  the prototype's ~150-line HAMT is the shape to reuse (or add `immer`/`immutable`
  as a dependency — an explicit decision).

### P1-server — the largest number in this note

Cut the JSON round trips in `EntityStore.materialize` before touching the client
representation if the server is hot: format the live entity from the in-memory
`merged_data` instead of re-decoding `row.data` (removes one whole-blob decode,
`entity_store.ex:287`→`:298`/`:430`), and consider ETF storage with a side index
replacing the `json_extract` generated columns. This is a server issue, not part
of #496's client seam, and it is independent of whatever P1 the client picks.

**Shipped in [#514](https://github.com/ebbjs/ebbjs/pull/514)** (the redundant-decode
half): dirty materialize of a 100-char-run doc fell from a **5.57 ms to 4.52 ms
median at N=1000** and **41.53 ms to 27.42 ms at N=5000**. ETF storage / side
index remain open.

---

## 8. Migration sketch (P0)

1. `packages/core/src/types/action.ts`: no-op-aware `mergeFieldValue`. Keep the
   doc comment; note the new reference-reuse guarantee.
2. `packages/storage/src/internal/materialize.ts`: no-op-aware `mergeFields`;
   `applyUpdate` reuses `data` and only allocates the entity wrapper.
3. Read model (`read-model.ts` / its production successor): add
   `if (a === b) return false` to `fieldsEqual`, and switch `contentChanged` off
   the full scan. The spike's `contentChanged` is spike-only; the production
   equivalent is whichever change signal the adopted seam exposes.
4. Tests: the 15 vectors already pin equality; add a reference-identity test
   ("a losing patch returns the same `FieldValue`/`data` reference") and a
   read-model test that a losing patch does not bump the version.
5. Server: no change required. Optional follow-up to skip the re-encode on a
   no-change `apply_patch`.
6. `packages/core/src/types/field-merge.vectors.test.ts` and the Elixir
   `field_merge_vectors_test.exs` stay the cross-language contract.

Estimated P0 diff: ~40 lines across 3 files, no API change, no wire/snapshot
change.

---

## 9. Risks and flip conditions

| risk / decision                                                | flip condition                                                                                                                                                                                                                         |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0 reference-reuse breaks a caller that mutates a merged value | None known; only 3 call sites, none mutate. Add the reference-identity test.                                                                                                                                                           |
| P1 skipped but a doc grows past ~1000 runs                     | Object copy crosses ~230 µs/keystroke; adopt P1a/b/c. Monitor max run-map size per doc.                                                                                                                                                |
| sharding reorders keys                                         | Deterministic per stable hash, but changes snapshot byte order vs today. Semantically irrelevant (map merge is order-independent; conflict recursion is order-independent); could churn snapshot diffs. Verify no test pins key order. |
| HAMT memory (1.8×) vs the #503 ≤32 MB resident budget          | Re-measure with production-shaped rows; if content docs share that budget, HAMT may blow it → prefer P1b or P1a.                                                                                                                       |
| In-place mutation + `useSyncExternalStore`                     | Only safe if `get(id)` returns a fresh entity wrapper per version and no consumer freezes/retains rows. If `Object.freeze` or retained-row caching is introduced, drop P1a.                                                            |
| Server JSON dominates                                          | If profiling shows the server is the bottleneck (70 ms vs 2 ms at N=5000), do P1-server first; the client representation is secondary.                                                                                                 |
| Per-run permissions become a product requirement               | Re-open §6.1; it is a permission-model change, not a storage tweak.                                                                                                                                                                    |

---

## 10. Proposed slices

1. **#496-A (P0, small, no protocol change):** no-op-aware `mergeFieldValue` /
   `mergeFields` / `applyUpdate` + read-model `changed` fast path + reference
   tests. Ships the largest measured win for the read model and the legacy
   adapters. **Shipped in [#514](https://github.com/ebbjs/ebbjs/pull/514)**
   (the read-model `changed` fast path is spike-scoped and lands with the seam;
   the production merge reuse is in the PR).
2. **#496-B (server, small):** remove the redundant `Jason.decode!` on
   materialize and (optionally) skip the `Jason.encode!` when the patch changed
   nothing. Measure with a dirty-materialize microbench at N=1000/5000.
3. **#496-C (P1, larger, needs a design decision):** a resident `content`
   container behind a `toWire`/`fromWire` seam — start with shard(64), keep HAMT
   as the fallback above ~10k runs; or P1a if ownership can be enforced. This is
   the slice that needs the explicit "the representation is in-memory only; the
   wire stays flat" decision recorded on #496.
4. **Do not** open a wire-format slice for a compact envelope unless snapshot
   bytes become a measured problem (separate issue).

---

## Appendix — exact commands and raw output

```sh
# client benchmark (tables in this note), ~3-5 min, gc on
pnpm --filter @ebbjs/client spike:map-write-path

# baseline probe that this must reproduce
pnpm --filter @ebbjs/client spike:read-model-seam

# server merge microbench (verified independently)
cd ebb_server && elixir -pa _build/dev/lib/jason/ebin /tmp/verify_merge.exs

# parity suites
pnpm --filter @ebbjs/core test          # 135 passed
pnpm --filter @ebbjs/storage test       # 295 passed, 1 skipped
pnpm --filter @ebbjs/client exec vitest --run src/sync/conflicts.test.ts   # 34 passed
```

Baseline anchor (both harnesses, one-key winning patch, N=1000): normative
`applyUpdate` **218.7 µs**, this harness' object container **228.7 µs**, the #496
probe's own report **~225 µs** — agreement within noise.
