# Spike report: resident read model vs async at 10k documents

**Status:** throwaway spike, decision captured. Script on branch `spike/495-read-model-10k`
(`packages/client/spike/read-model-spike.ts`). Main keeps only the decision on
[ebbjs/ebbjs#495](https://github.com/ebbjs/ebbjs/issues/495) and the gate slice
[ebbjs/ebbjs#503](https://github.com/ebbjs/ebbjs/issues/503).

**Question:** at a Notion-like 10k-document workspace, is a synchronous resident read model
(design **C**: normalized entity table + adjacency indices, sync reads) justified over the
current async, scan-per-accessor path — or should the client stay async with query-scoped
residency?

**Run:** `pnpm storage:build` once (tsx resolves `@ebbjs/storage/memory` from `dist`), then
`pnpm --filter @ebbjs/client exec tsx spike/read-model-spike.ts`
(`N`, `SAMPLE`, `BODY_BLOCKS`, `BODY_CHARS`, `BRANCH`, `REFS_PER_PAGE` are env-overridable).
Sanity-checked at `N=1000`, then run at `N=10000`.

Everything below is the script's own output at `N=10000`, `SAMPLE=25`.

---

# Read-model spike — 10,000 documents

_Throwaway perf spike (not a UI prototype). Real `createMemoryAdapter()` + real `forwardOne`/`reverse`/`forwardMany` from `packages/client/src/sync/relationship.ts`. SAMPLE=25, BRANCH=10, REFS_PER_PAGE=2, BODY_BLOCKS=120, BODY_CHARS=200._

## 1. Footprint

| bucket                                    |   rows |  JSON bytes |     size | % of workspace |
| ----------------------------------------- | -----: | ----------: | -------: | -------------: |
| `page` entities (title, icon, updated_at) | 10,000 |   3,198,164 |   3.1 MB |           1.0% |
| `relationship` rows (parent + references) | 29,999 |  10,341,265 |   9.9 MB |           3.2% |
| `entityGroup` rows + group                | 10,001 |   2,344,875 |   2.2 MB |           0.7% |
| **resident metadata subtotal**            | 50,000 |  15,884,304 |  15.1 MB |           4.8% |
| `page_content` bodies (heavy)             | 10,000 | 312,378,890 | 297.9 MB |          95.2% |
| **full workspace**                        | 60,000 | 328,263,194 | 313.1 MB |         100.0% |

Hypothesis (resident metadata ~10–30 MB vs full workspace hundreds of MB): **CONFIRMED** — metadata is 15.1 MB (4.8% of the workspace); heavy bodies are 297.9 MB.

## 2. Per-read cost

Rows scanned = entities returned by `queryEntitiesByType` (each is one deep clone in the memory adapter). Avg per call over SAMPLE reads; search is a single full scan.

| read                                               | rows scanned | query calls | get calls | ms/call |
| -------------------------------------------------- | -----------: | ----------: | --------: | ------: |
| children via `reverse` (current, async scan)       |       39,999 |         2.0 |       0.0 | 198.481 |
| parent via `forwardOne` (current, async scan)      |       29,999 |         1.0 |       2.0 | 157.668 |
| backlinks via `reverse` (current, async scan)      |       39,999 |         2.0 |       0.0 | 208.589 |
| references via `forwardMany` (current, async scan) |       39,999 |         2.0 |       1.0 | 201.504 |
| search all pages (current, async scan)             |       10,000 |         1.0 |       0.0 |  42.502 |
| children via resident `Map` (C, sync)              |            0 |         0.0 |       0.0 |   0.004 |
| parent via resident `Map` (C, sync)                |            0 |         0.0 |       0.0 |   0.002 |
| backlinks via resident `Map` (C, sync)             |            0 |         0.0 |       0.0 |   0.001 |
| references via resident `Map` (C, sync)            |            0 |         0.0 |       0.0 |   0.001 |
| search all pages (resident, sync)                  |       10,000 |         0.0 |       0.0 |   1.022 |

### Reverse reads via the async storage index that already ships (`queryByRelationship`)

| read                      |     rows cloned | ms/call |
| ------------------------- | --------------: | ------: |
| children (reverse index)  | 0 (returns ids) |  0.0131 |
| backlinks (reverse index) | 0 (returns ids) |  0.0078 |

## 3. Full page-tree build (all pages)

| path                         | work                                                                            |              wall-clock |
| ---------------------------- | ------------------------------------------------------------------------------- | ----------------------: |
| current async scan           | 399,990,000 rows cloned (extrapolated from 25 sampled `reverse` reads; NOT run) | 1984.8 s (extrapolated) |
| async storage index + N gets | N `queryByRelationship` reads + N `get`s                                        |      87.4 ms (measured) |
| resident projection (C)      | build adjacency (37.0 ms) + N `Map.get` (3.3 ms)                                |      40.3 ms (measured) |

## 4. Async microtask tax (isolated)

| loop                                       |   total |     per op |
| ------------------------------------------ | ------: | ---------: |
| `await adapter.entities.get(hot)` x 10,000 | 91.5 ms | 9148 ns/op |
| `projection.byId.get(hot)` x 10,000        |  0.3 ms |   31 ns/op |
| `await Promise.resolve()` x 10,000         |  3.2 ms |  322 ns/op |

## Deciding numbers

- Resident metadata: **15.1 MB**; full workspace: **313.1 MB** (bodies are 19.7x metadata).
- One children read: current **198.5 ms** / **39,999 rows cloned** vs resident **3.6 µs** / 0 rows.
- Full page tree for 10,000 pages: current **1984.8 s** (extrapolated, 399,990,000 clones) vs storage-index **87.4 ms** vs resident **40.3 ms**.
- Promise tax per await: **322 ns/op**; per hot `get`: **9148 ns/op**. The current tree cost is **616314x** the entire microtask tax of the same N awaits — the cost is algorithmic, not promises.
- Projection build (one pass over metadata): **37.0 ms**. Adapter population excluded (memory-adapter write path is O(n²)): **507.7 s** for 39,999 entities — not a read cost.
- `hotEntity` resolved synchronously for reference: page_5000.

---

## Verdict

**C is justified. The number that decides it is 15.1 MB — the entire resident metadata at
10,000 documents — not the 1,985 s scan figure.**

The 1,985 s is real but it is the _current_ path's pathology, not the cost of staying async.
Query-residency does not remove it; routing accessors through the index that already ships
(`reverseIndex` / `queryByRelationship`) does. Read honestly, the numbers say:

1. **The footprint argument for query-residency does not apply to metadata.**
   `page` + `relationship` + `entityGroup` = **15.1 MB**, 4.8% of the 313.1 MB workspace.
   Heavy bodies are **297.9 MB** (19.7× metadata) and are the only thing that must stay
   windowed. Holding 10k docs' metadata resident is ~1/20th of the workspace; "never hold the
   workspace" is about the bodies, and C already keeps bodies async.
2. **The current read path is quadratic and must be fixed either way.**
   One children read clones **39,999 rows in 198.5 ms**; a full 10k-page tree build clones
   ~**400 M rows** and extrapolates to **~1,985 s (~33 min)**. `forwardOne` (parent /
   breadcrumbs) clones **29,999 rows in 157.7 ms**. This is algorithmic, not promises:
   the whole N-await microtask tax is **3.2 ms** (322 ns/await); a hot `get` is 9.1 µs
   because it deep-clones.
3. **The tree build alone does _not_ justify C.** Using the reverse index that already exists,
   the same tree builds in **87.4 ms** vs C's **40.3 ms** — both fine. This is the honest
   caveat: the scary 1,985 s is a strawman for a well-built async design.
4. **What tips it to C** is the last mile the existing index does not cover:
   - **Forward reads.** `forwardOne` has no source-side key in storage, so breadcrumbs still
     scan all 29,999 relationship rows (157.7 ms). C is O(1).
   - **Search-as-you-type.** Current async = full page scan, **42.5 ms + 10,000 deep clones
     per keystroke**; C = **1.0 ms** over the resident set.
   - **Query-scoped residency collapses to metadata residency for this product.** A
     Notion-like sidebar renders the whole page tree, so the "active query result" for the
     primary screen _is_ all 10k page rows — the same 15.1 MB C would hold, just later and
     with loading states.
   - **The real goal is the view path.** Sync O(1) reads delete per-accessor
     loading/cancellation/race handling (`useEntity` re-loads on every materialization). That
     is the epic's stated point; no async design gets it for free.

### Budgets to record on #503

| budget                                            |                                          value at 10k docs |
| ------------------------------------------------- | ---------------------------------------------------------: |
| resident metadata (JSON)                          |  15.1 MB (≤ 32 MB budget, allowing ~2× V8 object overhead) |
| resident bodies                                   |      0 (bodies windowed) — 297.9 MB if ever fully resident |
| children / parent / backlinks / forward-many read |                           O(1), ≤ 5 µs, **0 rows scanned** |
| search over resident pages                        |                                                     ≤ 5 ms |
| one-time projection build (10k)                   |                                                    37.0 ms |
| forbidden                                         | per-accessor `query("relationship")` / `query(type)` scans |

### Recommendation for the slices

- **#497 (sync traversal):** first route accessors through the existing `reverseIndex`
  (`queryByRelationship`) and add the symmetric **source-side index** for `forwardOne` /
  `forwardMany`, whether or not C lands. That single change removes the 400 M-clone tree.
- **#495/#500 (residency tiers):** adopt C with **metadata-only residency** (page,
  relationship, entityGroup) and commit the 15 MB ceiling; keep `page_content` async. Add a
  regression gate that fails if any accessor calls `query("relationship")` / `query(type)`.
- **#499/#496:** the projection build is 37 ms one-pass, so eager hydrate of metadata is
  affordable; bodies stay lazy.

### Caveats

- Footprint is uncompressed JSON. V8 objects/IndexedDB structured clones are larger; the
  ≤ 32 MB budget above assumes ~2×.
- The memory adapter is a test double whose `set` is itself O(n²) (39,999 inserts took
  507.7 s). Population time is excluded from every read number.
- Wall-clock per-read uses one workspace shape (branching 10, 2 refs/page). Rows-scanned is
  the load-bearing metric and is shape-independent.
- C's win is a _product-shaped_ claim: it assumes the sidebar tree / backlinks / search are
  primary. A workspace that only ever opens one document by id would get little from C.
