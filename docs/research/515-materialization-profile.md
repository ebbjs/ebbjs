# Server-side entity materialization profile (#515)

Profile of the `ebb_server` read / materialization path, and the ranked
recommendation for what to do about it. This is measurement and
recommendation only — no storage change is implemented here.

Built on the finding in `docs/research/496-map-field-write-path.md` §3.6
(branch `research/496-map-field-write-path`): the Elixir merge is cheap
because maps are persistent, and the server's real O(entity-size) cost is
JSON on the read path. This profile measures that cost, adds the
production telemetry to keep measuring it, and sanity-checks against the
§3.6 throwaway bench.

Base: `origin/main` @ `a44662a` (PR #514, "skip the redundant decode on
entity materialize", **is** merged). Instrumentation and the harness land
in the PR for this issue.

## Headline

For any read after a write, materialization is the cost, and it is JSON:

| Pattern                             | Turns expensive when                                     | What dominates                                                         |
| ----------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------- |
| Clean `get` (already materialized)  | ~500 run keys (p50 crosses 1 ms; 2.3 ms @1k, 11 ms @5k)  | `Jason.decode!` of the whole blob — 88–96% of the read [measured]      |
| Dirty `get` (after a one-key patch) | ~2k run keys (p50 4.3 ms @1k, 9.9 ms @2k, **89 ms @5k**) | decode + encode ~85%; SQLite upsert 12–15%; merge <0.5% [measured]     |
| `query` of K rows                   | K × N (13.5 ms p50 for 50 rows of 100-key maps = ~1 MB)  | per-row decode ~75% at large K×N, plus a fixed ~1.1 ms join [measured] |

The SQLite upsert is itself ~90–96% the eight STORED `json_extract`
generated columns, and those are **superlinear** in blob size (~8× from
N=2000 to N=5000 for 2.5× bytes). That superlinearity is why the dirty
path has a knee between 2k and 5k keys rather than a straight line.

**Recommendation: a decoded / resident read model is the fix the profile
picks** (see [Ranked recommendation](#ranked-recommendation)). The merge
is already free; the blob is the problem, and a resident decoded map
removes it for both the clean and dirty read paths.

## Method

Harness: `mix bench.materialize` (new). One run boots an isolated storage
tree in a temp dir, seeds the documents, and measures cold / dirty / clean
`get` and `query`, in that order so a cold sample is always the first read
of the entity. Five boots, 50 repetitions per scenario. Totals are the
bench's wall clock; phases and sizes come from the server's own
`ebb.entity_store.*` telemetry (see the PR). Host: `recsy-vps`, AMD EPYC
7763, 4 schedulers for the BEAM, Elixir 1.17.3 / OTP 27, temp DB.

A document is a `todo` whose `content` field is a wire map of `run_<i>`
keys with ~130-byte values. Each stored leaf is ~207 B of JSON (`value` +
`hlc` + key), so `hot` N=5000 is a ~1.04 MB blob. `hot` seeds one
document; `spread` seeds 50 documents of `N/50` keys.

Reproduce with:

```sh
cd ebb_server
mix bench.materialize --runs 5 --reps 50 \
  --sizes 100,500,1000,2000,5000 --spread-entities 50 --query-ks 1,10,50
```

Raw report: `ebb_server/bench/results/20261018T121646Z-materialize-recsy-vps.md`
(gitignored). Published summary: `ebb_server/bench/RESULTS.md`, "Read /
materialization (#515)".

Everything below is **[measured]** unless labelled otherwise. The phase
shares are means; the totals are p50 unless stated. Per-phase medians are
not co-monotonic (a slow materialize is slow in every phase), so a mean
share is used and the harness also publishes each sample's phase sum,
which reconciles with the wall clock — e.g. N=5000 hot dirty: phase-sum
p50 89.3 ms vs wall p50 89.4 ms.

## Baseline sanity check

§3.6 measured, with a throwaway bench, a dirty materialize of 100-char
runs at 5.57 ms (N=1000) / 41.53 ms (N=5000) before #514 and 4.52 ms /
27.42 ms after. Its blob was ~130 B/run serialized; this harness's is
~207 B/run because every leaf carries an HLC. Normalising by blob bytes,
this profile's dirty N=5000 mean phase total (~78 ms for ~1.04 MB) is
~29 ms at the §3.6 666 KB size — within ~6% of the post-#514 27.4 ms
[measured, size-normalised estimate]. The harness and the baseline agree;
the remaining gap is run-to-run variance on the 4-scheduler VM.

## Where the time goes

### Clean `get` — decode is the read

|    N |    Blob B | read p50 µs | decode p50 µs | decode share |
| ---: | --------: | ----------: | ------------: | -----------: |
|  100 |    20,719 |         257 |           210 |          82% |
|  500 |   103,519 |       1,140 |         1,003 |          88% |
| 1000 |   207,021 |       2,284 |         2,020 |          88% |
| 2000 |   415,021 |       4,520 |         4,073 |          90% |
| 5000 | 1,039,021 |      10,967 |        10,473 |          96% |

A clean read is a `SQLite.get_entity` GenServer call plus one
`Jason.decode!`. The decode share rises with size because the SELECT is
constant. At the README's `<2 ms` `ctx.get` target, the decode alone
crosses 2 ms at ~1,000 keys.

### Dirty `get` — decode + encode, with a superlinear SQLite tail

Mean share of one materialize:

|    N | `fetch_decode` | `encode` | `upsert` | `merge` | `entries_scan` | `actions_load` | blob JSON | SQLite |
| ---: | -------------: | -------: | -------: | ------: | -------------: | -------------: | --------: | -----: |
|  100 |          59.1% |    12.0% |    13.3% |    0.5% |          13.1% |           2.0% |       71% |    13% |
|  500 |          39.9% |    32.6% |    19.0% |    0.2% |           6.1% |           2.1% |       73% |    19% |
| 1000 |          42.1% |    37.6% |    16.7% |    0.1% |           3.1% |           0.3% |       80% |    17% |
| 2000 |          43.0% |    44.1% |    11.6% |    0.1% |           1.1% |           0.1% |       87% |    12% |
| 5000 |          43.5% |    41.1% |    15.0% |    0.0% |           0.3% |           0.0% |       85% |    15% |

`fetch_decode` is the SQLite SELECT plus `Jason.decode!` of the existing
blob; `encode` is `Jason.encode!`; `upsert` includes the generated columns;
`merge` is `EbbServer.Storage.FieldMerge` over the replay. **The merge is
unmeasurable at every size** — consistent with §3.6's 0.5 µs one-key patch.
The dirty path pays decode + encode even though only one key changed.

### `query` — linear in K × N

|    N |   K | total p50 µs | decode p50 µs | decode share | bytes decoded |
| ---: | --: | -----------: | ------------: | -----------: | ------------: |
| 1000 |   1 |          688 |            37 |           5% |         4,118 |
| 1000 |  50 |        2,907 |         1,641 |          56% |       212,115 |
| 5000 |   1 |        1,346 |           212 |          16% |        20,599 |
| 5000 |  10 |        3,506 |         2,012 |          57% |       207,125 |
| 5000 |  50 |       13,475 |        10,355 |          77% |     1,036,165 |

`query/4` decodes every returned row. The permission join is a fixed
~1.1 ms; decode dominates once K × N is large. There is no per-row span
(by design), so the decode is measured as one sample over the row set.

### SQLite generated columns

|    N |  Blob B | 8 stored cols µs | no stored cols µs | delta µs | delta share |
| ---: | ------: | ---------------: | ----------------: | -------: | ----------: |
|  100 |  17,724 |               46 |                13 |       33 |         72% |
|  500 |  88,924 |              185 |                20 |      165 |         89% |
| 1000 | 177,925 |              428 |                31 |      397 |         93% |
| 2000 | 356,925 |              927 |               107 |      820 |         89% |
| 5000 | 893,925 |            7,023 |               253 |    6,770 |         96% |

The same upsert SQL against two in-memory tables, with and without the
eight `json_extract` STORED columns. The columns are ~90–96% of the
upsert, and the delta grows ~8× from N=2000 to N=5000 (2.5× bytes). As a
share of the whole dirty materialize that is ~10% (N=2000) to ~15%
(N=5000). Absolute times exclude WAL and file I/O, so the delta is the
number, not the absolute.

### Cold `get` and variance

Cold (first read, no existing blob) is dominated by the full replay's
`encode` + `upsert` and runs once per boot, so its 5 samples are noisy:
p50 2.7 ms @N=100 to 48.6 ms @N=5000. It is the write-after-all shape,
not a steady-state read.

The p95s at large N are much higher than the p50s (dirty N=5000: 137.9 ms
vs 89.4 ms p50; clean: 100.2 ms vs 11.0 ms). Per-run p50s are tight
(85.6–95.6 ms dirty), so this is within-run tail (GC / scheduler), not
run-to-run drift. Any fix should be judged on both p50 and the tail.

## Ranked recommendation

The profile picks **a decoded / resident read model** first. Details,
effort, risk, and the condition that would flip each option:

### 1. Decoded cache / in-process materialized read model — **do this**

Keep the merged entity's decoded field map resident (process-local or a
shared read model), invalidated when the entity is written. The clean read
becomes an ETS/map lookup instead of `SELECT` + `Jason.decode!`; the dirty
read becomes merge + invalidate, skipping the re-decode on the next read.

- **Attacks:** ~95% of the clean read and ~85% of the dirty read (decode +
  encode). The merge is already free, so this is close to the whole
  remaining read cost at large N.
- **Effort:** M–L. **Risk:** med. Correctness is the hard part: dirty-mark
  compare-and-clear (#281), multi-writer (#287), and the memory bound of
  the resident set. #485 candidate 1 ("on-write, in-process
  materialization") is the same direction; this profile is the read-side
  justification.
- **Flip condition (would drop it a rank):** the resident set is not
  bounded by the working set — e.g. millions of distinct cold documents at
  a low hit rate. Then measure hit rate first; telemetry now reports it
  (`ebb.entity_store.cache_hit_rate` with `path`).

### 2. ETF (or decode-once) storage instead of JSON at rest

Store the entity blob as ETF and use `:erlang.binary_to_term` /
`term_to_binary` instead of `Jason.decode!` / `Jason.encode!`.

- **Attacks:** the same JSON share as #1, but for every read (including
  cold) and without a memory bound. `binary_to_term` of a term is usually
  cheaper than parsing JSON text.
- **Blocker:** the eight STORED `json_extract` generated columns need
  `data` to be JSON. ETF storage requires either a parallel JSON column
  (keeping the generated-column cost) or moving the eight indexed fields
  into real columns at write time and dropping `json_extract`. The latter
  also removes the ablation's 10–15%, so it is attractive on its own.
- **Effort:** M. **Risk:** med (query layer, migration, the shared cache).
- **Flip condition (would promote it above #1):** the eight generated
  columns are replaced by real columns anyway (because of #428 or a query
  change) **and** the working set is too large for a decoded cache.

### 3. Nothing (defer)

If production documents stay under ~500 run keys, the clean read is
~1.1 ms p50 and the dirty path ~2.6 ms — within the stated targets. The
cost only becomes a bottleneck at ~1,000 keys (clean) and ~2,000–5,000
keys (dirty). The new telemetry (`byte_size`, `path`, and the phase
events) makes real traffic measurable, so the flip condition is data, not
opinion.

- **Flip condition (would promote a fix):** production `byte_size` shows
  documents routinely above ~200 KB, or the `dirty_materialize` p95 enters
  the tens of milliseconds.

### 4. Per-key side table

Normalize `content` keys into rows so a one-key patch is a one-row upsert
and reads decode nothing.

- **Attacks:** the blob entirely, and the generated columns too.
- **Blocker:** it collides with entity identity, `last_gsn`, one dirty mark
  per entity, and the per-entity membership/permission join — `#496` §6.1
  worked this through for the same shape and called it "a larger change
  than the map cost it removes". It is a product/identity change, not a
  read-path change.
- **Effort:** L. **Risk:** high.
- **Flip condition (would promote it):** per-key permissions or per-key
  conflict rows become a product requirement, or documents routinely pass
  ~10k keys where even a decoded cache is too large.

## Follow-up

Filed as [#516](https://github.com/ebbjs/ebbjs/issues/516)
("perf(storage): decoded entity read cache to remove the blob JSON
round-trip"). It is the #1 option above and is deliberately not
implemented here.

Refs: [#496](https://github.com/ebbjs/ebbjs/issues/496),
[#513](https://github.com/ebbjs/ebbjs/issues/513),
[#514](https://github.com/ebbjs/ebbjs/pull/514),
[#485](https://github.com/ebbjs/ebbjs/issues/485),
[#428](https://github.com/ebbjs/ebbjs/issues/428).
