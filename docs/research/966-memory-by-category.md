# Per-tab memory by category (#966)

Measurement note for [issue #966](https://github.com/ebbjs/ebbjs/issues/966), the first slice of
the [leaner client replica epic #965](https://github.com/ebbjs/ebbjs/issues/965). It adds a byte
account to the replica (`replica.bytes()`) and a `## 8. Memory by category` section to the client
benchmark, so the epic's later slices can claim a reduction against a number instead of a total
that moves with the fixture. Harness:
`packages/client/src/benchmark/replica-read-model.ts` ([Reproduction](#reproduction)). Labels:
**[measured]**, **[derived]**, **[from source]**.

**Sources read.** #966; #965 (the "In memory" list and the rules); the shipped seams
`packages/storage/src/replica/{replica,types,leases,size}.ts`,
`packages/storage/src/internal/{reverse-index,component-index,materialize}.ts`,
`packages/client/src/sync/{query-results,subscriptions}.ts`; the previous measurement note
[`503-replica-read-model.md`](503-replica-read-model.md); `docs/research/534-claim-order-release.md`
and `933-*`/`957` history for residency.

## TL;DR

- **[measured] The loaded 10k-document replica accounts for 11.7 MB of JSON.** Row envelopes are
  2.2 MB, component values 5.7 MB, and the model/component/adjacency indices plus version stamps
  3.8 MB. The values outweigh the row identities 2.7:1, which is the part #968/#980 move out of
  memory first.
- **[measured] With a 1,024-entry journal, 100 unconfirmed optimistic writes, and one released
  result holding 10,000 projected rows, the same tab's steady state is 12.6 MB of JSON.** The
  journal is 0.1 MB, the overlay with its composed views 0.1 MB, and the inactive result 0.7 MB —
  the last one is #991's target.
- **[measured] The full-row snapshot `toRecord()` writes is 9.1 MB**, 1.2 MB more than the rows
  and values it persists, because it also writes a version stamp per component. #977 replaces it
  with a row list.
- **[measured] The same run's heap account is 31.9 MB** (17.4 MB rows, 14.5 MB replica
  structures of which 13.6 MB is indices). JSON bytes are not heap bytes: the retained heap is
  ~2.7× the JSON account, and the account is a comparator, not an allowance.
- **[derived] The category account closes the 31.9 MB into identity, values, index, and the
  state around them, with no single dominant bucket.** The largest single lever is the index
  (#989) and the largest value lever is residency (#972/#975/#980), not the row envelope.

## What was added

`Replica.bytes()` returns `ReplicaBytes`:

| category            | what it counts                                                                                                              |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `rows`              | The row envelope: `id`, `model`, `exists`, `created_hlc`, `updated_hlc`, `deleted_hlc`, `last_gsn`                          |
| `values`            | Every component value in `data.fields` with its `update_id`/`hlc` envelope, plus the `data` wrapper                         |
| `index`             | Model index, component-existence index, reverse and forward adjacency indices, and the declared-version stamp per component |
| `journal`           | The retained change-journal array, including a discarded prefix a trim has not compacted yet                                |
| `unconfirmedWrites` | The optimistic overlay writes, the composed `effective` views they cache, and orphan updates waiting for a base row         |
| `total`             | The categories above, summed                                                                                                |

The `unconfirmedWrites` figure counts the overlay, the composed views it caches, and orphan
updates waiting for a base row. A server-confirmed Update buffered behind a cold read is not
counted: it belongs to the base's next settle, not to the overlay.

The unit is UTF-8 bytes of JSON, counted without `Buffer` or `TextEncoder` so Node, a browser,
and React Native agree; `jsonBytes` is exported beside the replica so a harness does not carry a
second implementation. `rows + values` is each row's JSON less the 8-byte `,"data":` separator
the two share; the benchmark asserts that identity. The account is a separate method rather than
a `stats()` field because it serializes every retained structure; it is diagnostic, not a read
path. Residency bookkeeping — the lease table, the `storeRows` set, reads in flight — is not a
category: it holds no row or value.

Two categories live outside the replica, so the benchmark measures them on the same throwaway
replica:

- **inactive results** — a released rows result's published `QueryResult`, still inactive because
  its residency TTL is disabled for the measurement (`registry.entries()`, state `inactive`);
- **snapshot** — the `ReplicaRecord` that `toRecord()` serializes for persistence.

## Numbers

One harness run at `N=10000` (`pnpm --silent client:benchmark`, Node v24.21.0, AMD EPYC 7763,
Linux 6.8.0). The workspace carries 10,000 `page` rows, 10,000 `ebb/membership` rows, and one
`ebb/group` — 20,001 resident metadata rows. Edges are link keys on their source page, so there
are no separate relationship rows: this is the post-#820 shape, not #503's 50,000-row shape.

| category                                       | JSON bytes |   size | measured on                           |
| ---------------------------------------------- | ---------: | -----: | ------------------------------------- |
| rows — row envelopes                           |  2,267,891 | 2.2 MB | 20,001 loaded rows                    |
| in-memory values — component values            |  6,026,682 | 5.7 MB | the same rows                         |
| index — model/component/adjacency + versions   |  3,932,875 | 3.8 MB | built by `load`                       |
| journal — retained change entries              |    105,481 | 0.1 MB | 1,024 retained after 1,124 changes    |
| unconfirmed writes — overlay + views + orphans |     80,498 | 0.1 MB | 100 optimistic Actions not yet echoed |
| inactive results — projected rows              |    758,015 | 0.7 MB | 1 inactive entry holding 10,000 rows  |
| snapshot — full-row `ReplicaRecord`            |  9,542,460 | 9.1 MB | the loaded base, versions included    |

| total                                                                  | JSON bytes |    size |
| ---------------------------------------------------------------------- | ---------: | ------: |
| loaded replica (rows + values + index)                                 | 12,227,448 | 11.7 MB |
| steady state (loaded + journal + unconfirmed writes + inactive result) | 13,171,442 | 12.6 MB |
| snapshot written on top (not resident unless persisting)               |  9,542,460 |  9.1 MB |

`values` is larger than section 1a's per-component subtotal (6.0 MB against 5.0 MB) because
it also counts each field's key and the row's `{"fields":{…}}` wrapper; section 1a attributes
only the value bytes.

The heap account from the same run, for the unit gap:

| heap account                                                             |      median |
| ------------------------------------------------------------------------ | ----------: |
| resident rows (fresh row objects + the record's reference array)         |     17.4 MB |
| replica structures (own base map + model index + both adjacency indices) |     14.5 MB |
| of which adjacency indices + model index                                 |     13.6 MB |
| **resident metadata total**                                              | **31.9 MB** |

**[derived] Per-unit figures.** A loaded row averages ~113 B of envelope and ~301 B of values in
JSON (the fixture's titles and edge keys are deliberately realistic). An index entry accounts for
~79 B of index JSON across the 29,999 edge entries and 20,000 membership entries (reverse plus
forward). One journal change is ~103 B.
One optimistic write with its composed view is ~805 B. One projected result row is ~76 B. The
snapshot adds ~63 B per row over `rows + values` (the version stamps and record envelope).

The figures are one instance's. Until #970/#986 land, every tab or app instance keeps its own
replica and its own released results, so a second tab adds another copy rather than sharing
this one (ADR [`0003`](../adr/0003-one-writer-per-local-store.md)).

## Findings

- **Values are the base's dominant category, not the rows.** Component values are 5.7 MB against
  the envelope's 2.2 MB, and `ebb/link` alone is 2.3 MB of the section 1a component table. A row
  index that keeps ids/models/existence without every value (#971, #973) is therefore the
  worthwhile split; the envelope is not the problem.
- **The index is the largest derived category and the least tied to data size.** 3.8 MB of index
  JSON against 7.9 MB of row JSON. It bundles the adjacency maps, the component-existence sets,
  and a version stamp per component. It also repeats id and component strings that `rows` and
  `values` already hold, so #980's per-component storage does not shrink it by itself; #989
  (intern ids and component names, numeric edge keys) and #849/#799 (the durable component
  index) own that. The number is the baseline those slices report against.
- **An inactive result keeps the whole projection.** Releasing a 10,000-row result leaves a
  0.7 MB array of projected rows, plus the claims it still holds for one residency TTL. #991
  drops the rows and re-projects on remount; this is the measured "before".
- **The snapshot is a second copy of the base.** 9.1 MB for a base that is 7.9 MB of rows and
  values, because `toRecord()` writes a version stamp for every component of every row. #977
  replaces the full-row snapshot with a row list.
- **The journal and overlay are small at their working sizes.** A 1,024-entry journal is 0.1 MB
  and 100 unconfirmed writes are 0.1 MB, so neither is a reason to change the default journal
  capacity or to trim optimistic writes early. A larger optimistic burst scales linearly at
  ~0.8 KB per Action.
- **Categories do not add up to the heap.** JSON bytes are text; V8 adds object headers, string
  overhead, and the base map. 12.6 MB of JSON is 31.9 MB of heap (~2.5×). Use the category
  account to compare slices against each other and the heap account for an allowance.

## Reproduction

```bash
pnpm --silent client:benchmark
```

The `benchmark` script sets `NODE_OPTIONS=--expose-gc`. Section 8 is self-checking: it fails if
the loaded replica already retains writes, if `rows + values` does not match the per-row JSON
account, if the journal or overlay scenario retains nothing, or if the inactive result holds a
row count other than the replica's `page` count. Defaults: `N=10000`, `SAMPLE=25`, `BRANCH=10`,
`REFS_PER_PAGE=2`, `BODY_BLOCKS=120`, `BODY_CHARS=200`.

The storage-side account is covered by `packages/storage/src/replica/replica.test.ts`
("retained bytes by category") and the UTF-8 counting by `size.test.ts`; the benchmark's shape
invariant is in `packages/client/src/benchmark/__tests__/replica-read-model.test.ts`.

## Open questions

- **Should `bytes()` fold into `stats()`?** It is separate today because it serializes every
  structure. If a caller wants both, it can make two calls; nothing reads bytes on a hot path.
- **Is JSON the unit the epic wants?** #992's budget needs a limit in the unit values are
  accounted in; JSON bytes are stable and category-comparable, but a V8 heap budget would need
  the heap harness. The category split is the part both can share.
- **What counts as an inactive result's bytes?** This note counts the entry's published
  `QueryResult` (projected rows included) and not its claim list or read set. #991 removes the
  rows; the remaining claim list is the registry's bookkeeping.
- **The index is one bucket.** #989's acceptance ("the index is smaller") may want its own split
  (adjacency vs component-existence vs version stamps) before it can attribute a win. This slice
  deliberately keeps the issue's seven categories.
