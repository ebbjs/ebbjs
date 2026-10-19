# Replica read model at 10k documents (#503)

Measurement note for [issue #503](https://github.com/ebbjs/ebbjs/issues/503), a slice of the
[local query engine epic #495](https://github.com/ebbjs/ebbjs/issues/495). It replaces the epic's
throwaway spike with a repeatable bench against the **shipped** replica
(`@ebbjs/storage/replica`) and the real client read seams at **10,000 documents** (10,000 `page`,
29,999 `relationship`, 10,001 `entityGroup`/`group` rows, 10,000 heavy `page_content` bodies).
Branch `feat/issue-503-replica-10k-bench`, base `f2eb1fa` ("Merge pull request #548 from
ebbjs/feat/issue-532-gsn-free-payload"). Harness:
`packages/client/src/benchmark/replica-read-model.ts` ([Reproduction](#reproduction)). Labels:
**[measured]**, **[derived]**, **[from source]**; extrapolations are marked. References below are
the pre-replica spike at `N=10000`, `SAMPLE=25`, unless noted.

**Sources read.** #503; #495 (body + the "Input for the 10k bench + gate" comment and its
server-side-JSON follow-up); the spike on `spike/495-read-model-10k`
(`packages/client/spike/read-model-spike.{ts,report.md}` via `git show`); the shipped seams
`packages/storage/src/{replica,internal,types,memory}` and
`packages/client/src/sync/{namespace,relationship,traversal-counter,query-plan,query-execute}.ts`
(+ `__tests__/traversal-cost.test.ts` and the collaborative-text schema); house style
`docs/research/{515,485}-*.md`; `ebb_server/bench/RESULTS.md`; `README.md` "## Performance", where
the headline goes (currently "**Reads:** not benchmarked yet.").

## TL;DR

- **[measured] Resident metadata at 10k documents is 41.0 MB of V8 heap** — 29.4 MB of rows plus
  **11.7 MB of adjacency indices**, which had never been measured. The rows are 17.3 MB of JSON.
  That is 12.7% of the 323.4 MB hypothetical workspace; the other 306.0 MB of document bodies stay
  windowed (0 resident).
- **[measured] The 41.0 MB exceeds the epic's 32 MB back-of-envelope allowance**, which was
  "15.1 MB × ~2 V8 overhead" and never included the indices. Recorded here; #503 sets no threshold.
- **[measured] Traversal is index-bounded: 0 store rows scanned, 0.5–0.9 µs at the index.** The
  public row accessor that wraps the same read costs 7–11 µs at degree 0–2; the wrapper (async
  adjacency + `executePlan` + TypeBox projection + id sort) is now the cost, not the scan.
- **[measured] A search-shaped full scan of the 10,000 held pages is 1.2–1.9 ms per keystroke**,
  down from 42.5 ms on the old async scan; no search surface ships yet (see open questions).
- **[measured] The one-pass projection build (`replica.load`) is ~150 ms**, ~4× the spike's 37.0 ms
  — it derives both adjacency directions plus the type index, where the spike built one direction.
- **[measured] A windowed body opens in ~3.6 µs with exactly one store read**, and a pinned re-open
  reads nothing.

## Reference points

| reference                         | value at 10k documents                                                                                                                                                                                               | label                      | where it came from                                                                    |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------- |
| resident metadata / bodies        | 50,000 metadata rows / **15.1 MB** (page 3.1 + relationship 9.9 + entityGroup 2.2), 4.8% of the workspace; bodies **297.9 MB**, 95.2% of 313.1 MB. Prototype: 15.5 MB in-process, **excludes the adjacency indices** | [measured]                 | #495 comment, spike report, epic body                                                 |
| children / parent, old async scan | `reverse` 39,999 rows cloned / **198.5 ms**; `forwardOne` 29,999 rows / **157.7 ms**                                                                                                                                 | [measured]                 | #495 comment                                                                          |
| search, old async scan            | 10,000 rows / **42.5 ms per keystroke**                                                                                                                                                                              | [measured]                 | #495 comment                                                                          |
| full page tree                    | async scan ~400 M clones → **~1,985 s** (extrapolated from 25 sampled reads, **never run**); storage index 87.4 ms; resident 40.3 ms = **37.0 ms** build + 3.3 ms walk                                               | [measured, extrapolated]   | #495 comment, spike report                                                            |
| async tax                         | `await Promise.resolve()` 322 ns/op; hot `adapter.entities.get` 9.1 µs/op; resident `Map.get` 31 ns/op                                                                                                               | [measured]                 | #495 comment                                                                          |
| memory-adapter seed cost          | 39,999 `set` insertions ≈ **507.7 s**, i.e. **O(n²)**                                                                                                                                                                | [measured] / [from source] | spike report; `entity-store.memory.ts` copies the entity map and index on every `set` |

Seed directly with `replica.load(record)`; the adapter's O(n²) `set` is not a read path.
**Rows scanned per accessor is the shape-independent gate metric**; the budgets below are recorded,
not enforced:

| budget                                       |                                          value at 10k docs |
| -------------------------------------------- | ---------------------------------------------------------: |
| resident metadata (JSON)                     |        15.1 MB measured (≤ 32 MB allowing ~2× V8 overhead) |
| resident bodies                              |                                        0 (bodies windowed) |
| children / parent / backlinks / forward-many |                           O(1), ≤ 5 µs, **0 rows scanned** |
| search over resident pages                   |                                                     ≤ 5 ms |
| one-time projection build                    |                                                    37.0 ms |
| forbidden                                    | per-accessor `query("relationship")` / `query(type)` scans |

## Method

**Seed, projection build, footprint.** `replica.load` (`packages/storage/src/replica/replica.ts`)
clears state and makes **one linear pass** over `record.entities`, keeping a row only when the
residency policy `holds` its type (bodies are `materialization: "on-demand"`). Each kept row
contributes a reverse `indexEntryFor` and a forward `forwardIndexEntryFor` entry
(`packages/storage/src/internal/reverse-index.ts`); indices are never persisted (`ReplicaRecord`),
so this pass _is_ the projection build.

Footprint is measured two ways. JSON bytes per bucket, for comparison with the epic's 15.1 MB.
Then, under `--expose-gc`, the heap the replica actually retains, in one measurement window per
rep: the held rows are allocated **fresh** (their own row objects), a replica is loaded over
exactly those rows, and `heapUsed` is sampled after two forced GCs at each step. That separates
the rows' heap from the replica's structures (base map, type index, both adjacency indices) and
gives their sum as the resident metadata total. Every rep stays pinned, so a later GC cannot
reclaim an earlier rep's account. The JSON total and the heap total are different units.

**Traversal.** `relationships`/`memberships` (ids) and `relationshipLinks`/`membershipLinks` (link
objects) read one index key: O(1) lookup plus O(degree) projection. The accessor layer wraps the same
four in `replicaAdjacency` (`client/src/sync/namespace.ts`) for `forwardOne`/`forwardMany`/`reverse`/
`membershipGroups` (`client/src/sync/relationship.ts`). It is timed three ways: with resident rows
(`replica.get`), with direct replica index reads, and with store-backed by-id rows (how
`namespace.ts` wires `readLocalEntity` today).

**Query path.** `client/src/sync/query-plan.ts` plans scan/select/order/limit, adjacency and membership
predicates ahead of field filters; `createReplicaExecutor` (`client/src/sync/query-execute.ts`) runs it synchronously.

**Search.** No search surface ships, so the measured shape is a search-shaped full scan of resident
`page` rows with a substring test on `title` — 10,000 rows by construction (spike: 1.0 ms, 42.5 ms async).

**Rows scanned, and what this is not.** Rows reached by id plus index rows returned by an adjacency
key. The shipped witness is `traversalCounter` (`client/src/sync/traversal-counter.ts`): one per
loaded row plus the links each index read returns; the executor's whole-type `iterate` is
deliberately not counted, so `open` and search are counted separately. **This is a measurement
ticket** — no thresholds, no CI assertion on wall-clock or memory; the enforced gate is #497's
rows-examined test.

## Results

One harness run at `N=10000`: `pnpm --silent client:benchmark`, Node v24.21.0, AMD EPYC 7763
(shared host), harness runtime 9.8 s. Timing numbers are medians and drift 10–20% between runs
on this shared host, so compare magnitudes, not decimals; counters, row counts and heap medians are
stable across runs (the 41.0 MB total moved 0.1 MB over four invocations).

### Footprint

JSON bytes, uncompressed — the figure comparable to the epic's 15.1 MB:

| bucket                                                      |   rows |  JSON bytes |     size | % of workspace |
| ----------------------------------------------------------- | -----: | ----------: | -------: | -------------: |
| `page` (title, icon, updated_at)                            | 10,000 |   3,524,451 |   3.4 MB |           1.0% |
| `relationship` (parent + references)                        | 29,999 |  12,156,313 |  11.6 MB |           3.6% |
| `entityGroup` + `group`                                     | 10,001 |   2,505,738 |   2.4 MB |           0.7% |
| **held metadata subtotal**                                  | 50,000 |  18,186,502 |  17.3 MB |           5.4% |
| `page_content` bodies (representative 31.3 KB row × 10,000) | 10,000 | 320,880,000 | 306.0 MB |          94.6% |
| **full workspace (hypothetical)**                           | 60,000 | 339,066,502 | 323.4 MB |         100.0% |

The totals run ~14% above the spike's 15.1 MB for the same 50,000 rows because every field here
carries a per-field `update_id` of realistic length (`u_page_1234_title`, ~20–22 chars, close to a
21-char nanoid) where the spike used short `u_${n}` placeholders. Compare shapes, not row bytes.

Heap the replica retains (V8, `--expose-gc`, median of 5 reps):

| account                                                             |      median |          min–max | % of workspace |
| ------------------------------------------------------------------- | ----------: | ---------------: | -------------: |
| held rows (fresh row objects + the record's reference array)        |     29.4 MB |     29.2–29.4 MB |              — |
| replica structures (base map + type index + both adjacency indices) |     11.7 MB |          11.7 MB |              — |
| **resident metadata total (rows + structures)**                     | **41.0 MB** | **40.9–41.1 MB** |      **12.7%** |

**[derived]** The adjacency indices are 0.68× the held rows' JSON bytes and 28.5% of the resident
total; the rows themselves retain ~1.7× their JSON. The 41.0 MB is above the epic's 32 MB allowance,
which was sized before the indices were measured — a number to decide on, not a failure.

### Traversal

Median per call over 5 batches of 2,000 calls, ids spread over `page_0`…`page_9,999`. "Store reads"
is `get` calls; "rows examined" is the shipped `traversalCounter`.

| read                                             | µs/call | degree (min–max) | index rows | store reads | rows examined |
| ------------------------------------------------ | ------: | ---------------: | ---------: | ----------: | ------------: |
| `reverse` — children, shipped accessor           |    9.42 |       0.0 (0–10) |       0.80 |         0.0 |          1.60 |
| `forwardOne` — parent, shipped accessor          |    1.57 |        1.0 (1–1) |       1.00 |         0.0 |          3.00 |
| `reverse` — backlinks, shipped accessor          |   10.34 |        2.0 (2–2) |       2.00 |         0.0 |          4.00 |
| `forwardMany` — references, shipped accessor     |   11.14 |        2.0 (2–2) |       2.00 |         0.0 |          5.00 |
| `membershipGroups` — groups, shipped accessor    |    7.34 |        1.0 (1–1) |       1.00 |         0.0 |          2.00 |
| `relationships` — children (`targetId`)          |    0.50 |       0.0 (0–10) |       0.80 |         0.0 |          0.00 |
| `relationships` — backlinks (`targetId`)         |    0.76 |        2.0 (2–2) |       2.00 |         0.0 |          0.00 |
| `relationshipLinks` — parent (`sourceId`)        |    0.59 |        1.0 (1–1) |       1.00 |         0.0 |          0.00 |
| `relationshipLinks` — references (`sourceId`)    |    0.89 |        2.0 (2–2) |       2.00 |         0.0 |          0.00 |
| `memberships` — groups (`entityId`)              |    0.60 |        1.0 (1–1) |       1.00 |         0.0 |          0.00 |
| `membershipLinks` — membership rows (`entityId`) |    0.64 |        1.0 (1–1) |       1.00 |         0.0 |          0.00 |

**The index meets the budget; the wrapper does not.** Direct index reads are 0.5–0.9 µs with zero
rows scanned and rows examined equal to the row's degree. The shipped accessors over the same index
cost 7–11 µs at degree 0–2 because each call runs the async adjacency seam, `executePlan`, the
TypeBox projection, and an id-ordered sort. Rows examined stay degree-bounded either way, so the
scan gate holds; the remaining cost is fixed per-call work in the accessor layer.

The shipped namespace still resolves the source/target **rows** through `storage.entities.get`
(1–3 by-id reads per call, not a scan): 7.28 µs (children), 1.32 µs (parent), 10.48 µs
(forward-many), 7.39 µs (groups). Reading those rows from the resident replica instead removes the
store round trips and moves the same reads to the accessor numbers above.

### Search over held pages

No search surface ships. The substring scan is the shape a search would ride on today
(`replica.iterate("page")` plus a title filter); the `executePlan` rows are the shipped query path.
Each visits all 10,000 held pages.

| path                                            | µs/call | rows visited | rows matched | store reads |
| ----------------------------------------------- | ------: | -----------: | -----------: | ----------: |
| title substring scan (`includes("Document 4")`) |    1460 |       10,000 |        1,111 |         0.0 |
| `executePlan` — field equality (`updated_at`)   |    1198 |       10,000 |            1 |         0.0 |
| `executePlan` — whole-type scan (ordered by id) |    1671 |       10,000 |       10,000 |         0.0 |

**[derived]** 1.2–1.9 ms is under the epic's ≤5 ms search budget and 23–36× faster than the old
async scan's 42.5 ms/keystroke, with zero store reads. The whole-type scan's extra cost over the
plain substring scan is its O(n log n) `localeCompare` sort.

### One-pass projection build

| step                                                             |       median |        min–max | reps |
| ---------------------------------------------------------------- | -----------: | -------------: | ---: |
| fixture row generation (one-time, excluded from the build)       |     121.1 ms |              — |    1 |
| record assembly (copy of 50,003 row references)                  |     264.8 µs | 232.7–322.7 µs |    5 |
| `replica.load(record)` — first load in this process              | **164.7 ms** |              — |    1 |
| `replica.load(record)` — repeat loads (each also drops the base) |     153.1 ms | 121.5–175.2 ms |    5 |

Rows resident after load: 50,000. Indices built: 11,001 reverse keys and 29,999 forward keys over
39,999 + 39,999 index entries. **[derived]** ~3.1 µs per held row and ~1.9 µs per index entry
(repeat-load median ÷ those counts); at `N=1000` the same shape builds in 10.6 ms (2.1 µs/row), so
the build is linear in rows with a mild map-growth factor.

`load` is ~4× the spike's 37.0 ms build, which is a different measurement: the spike built one
adjacency direction in one pass, while `load` derives both directions for every `relationship` and
`entityGroup` row into plain objects and rebuilds the type index. It is the cost of hydrating the
shipped replica, not a like-for-like regression.

### Windowed bodies

`page_content` is the schema's on-demand type, so `load` drops it and `replica.open(id)` reads it
through the store into a pinned window. Each timed open follows a `close` with `pinnedTtlMs: 0`, so
every call is a cold read.

| measure                                      |                value |
| -------------------------------------------- | -------------------: |
| distinct documents opened                    |                  100 |
| cold open, median (min–max)                  | 3.59 µs (2.97–20.90) |
| body row size (JSON)                         |              31.3 KB |
| store rows read per cold open                |                    1 |
| store reads added by re-opening while pinned |                    0 |
| resident bodies after close                  |                    0 |
| held bodies (`heldByType`)                   |                    0 |

## Caveats

- **One developer machine, one Node/V8.** Wall-clock moves with JIT, GC and layout; the spike ran on an earlier machine, so compare magnitudes, not decimals.
- **Heap delta and JSON bytes are different units.** JSON bytes are uncompressed text; heap adds object headers and strings, and the rows' own heap retains ~1.7× their JSON. The 41.0 MB heap total is the number to compare against a memory allowance; the 17.3 MB JSON total is the number comparable with the epic's 15.1 MB.
- **Extrapolation is labelled where used.** The ~1,985 s / ~400 M-clone tree figure came from 25 sampled reads and was never run.
- **The bench is not a gate.** Nothing asserts wall-clock or memory; #497's rows-examined test is
  the enforced check. The store-backed traversal rows show the async row reads that remain.
- **Open questions, deliberately unresolved.** **The representative search shape** is open: the
  substring scan stands in for a search surface that does not exist yet. **One workspace shape** was
  measured (branch 10, 2 references/page, 120×200-char bodies); rows scanned is shape-independent,
  wall-clock is not. **The 41.0 MB vs 32 MB allowance** is for the epic to revisit, not this note.

## Reproduction

```sh
# from the repo root: builds @ebbjs/core + @ebbjs/storage, then runs the bench
pnpm --silent client:benchmark
```

One command, no manual prerequisite. The client `benchmark` script sets `NODE_OPTIONS=--expose-gc`
for the heap account; without it the run reports the JSON footprint only and says so on stderr. Env
knobs and defaults are the spike's shape: `N=10000`, `SAMPLE=25`, `BRANCH=10`, `REFS_PER_PAGE=2`,
`BODY_BLOCKS=120`, `BODY_CHARS=200`. Seeding is direct, avoiding the memory adapter's O(n²)
population (507.7 s for 39,999 `set`s [measured]). The harness writes Markdown to stdout and
progress to stderr, and prints its own total runtime with the tables; a default run is ~10 s. The
~1,985 s full-tree path never runs.
