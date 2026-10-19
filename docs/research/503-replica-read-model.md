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
so this pass _is_ the projection build. Footprint: JSON bytes per bucket, then (under
`--expose-gc`) the heap the replica retains — a rows-only `Map` baseline, the replica after `load`,
and the index delta between them.

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

Filled from one harness run; the machine and Node version belong with the table. The headline goes to README "## Performance".

<!-- numbers: footprint -->

JSON bytes per bucket plus the retained heap — rows-only `Map`, replica after `load`, index delta — vs 15.1 MB and ≤ 32 MB.

| bucket | rows | JSON bytes | size | % of workspace |
| ------ | ---: | ---------: | ---: | -------------: |

| account | median | min | max | reps |
| ------- | -----: | --: | --: | ---: |

<!-- numbers: traversal -->

µs/call (median), rows examined, index rows and store rows per backend, vs 198.5 ms async and 0 rows / ≤ 5 µs.

| read | µs/call (median) | rows examined/call | index rows/call | store rows/call |
| ---- | ---------------: | -----------------: | --------------: | --------------: |

<!-- numbers: search -->

Rows visited (10,000 by construction), rows matched and µs/call (median), vs 42.5 ms/keystroke async and ≤ 5 ms.

| path | µs/call (median) | rows visited/call | rows matched (median) | store reads/call | index rows/call |
| ---- | ---------------: | ----------------: | --------------------: | ---------------: | --------------: |

<!-- numbers: projection-build -->

Fixture generation (excluded), record assembly and `replica.load`, vs the spike's 37.0 ms build.

| step | median | min | max | reps |
| ---- | -----: | --: | --: | ---: |

<!-- numbers: windowed-bodies -->

Cold open, re-open while pinned, residency after close: store reads, pinned rows, µs/call; 297.9 MB stays non-resident.

| measure | value |
| ------- | ----: |

## Caveats

- **One developer machine, one Node/V8.** Wall-clock moves with JIT, GC and layout; the spike ran on an earlier machine, so compare magnitudes, not decimals.
- **Heap delta and JSON bytes are different units.** JSON bytes are uncompressed text; heap adds headers and shared strings — ids sit in rows and in index keys, so summing bytes double counts.
- **Extrapolation is labelled where used.** The ~1,985 s / ~400 M-clone tree figure came from 25 sampled reads and was never run.
- **The bench is not a gate.** Nothing asserts wall-clock or memory; #497's rows-examined test is
  the enforced check. The store-backed traversal rows show the async row reads that remain.
- **Open questions, deliberately unresolved.** **Resident metadata** could mean rows only, rows plus the
  adjacency indices, or heap bytes: 15.1 MB is rows only, and the 15.5 MB prototype excludes indices.
  **The representative search shape** is open, and **one workspace shape** was measured.

## Reproduction

```sh
cd /home/drew/projects/ebbjs-issue-503
pnpm storage:build   # tsx resolves @ebbjs/storage/replica from dist, as the spike needed for /memory
NODE_OPTIONS=--expose-gc pnpm --filter @ebbjs/client exec tsx src/benchmark/replica-read-model.ts
```

The harness header also names a root script (`pnpm client:benchmark`); the line above runs today.
Env knobs and defaults are the spike's shape: `N=10000`, `SAMPLE=25`, `BRANCH=10`, `REFS_PER_PAGE=2`,
`BODY_BLOCKS=120`, `BODY_CHARS=200`. `--expose-gc` enables the paired heap account; without it the
run reports the JSON footprint only. Seeding is direct, avoiding the memory adapter's O(n²)
population (507.7 s for 39,999 `set`s [measured]). The harness writes Markdown to stdout and
progress to stderr, and prints its own total runtime — quote that with the tables. The ~1,985 s
full-tree path never runs.
