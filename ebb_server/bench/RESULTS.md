# ebb_server Actions/sec benchmark results

Headline results for the `ebb_server` write path, produced by
`mix bench.actions`. This is the trustworthy replacement for the
unverified numbers inherited from the raw-RocksDB spike (#130): the runs
below go through the real `ebb_server` pipeline, not a storage primitive.

Raw per-run Markdown output lands in `bench/results/` (gitignored); the
tables here are the published subset.

## Refresh (#485)

Refreshed **2026-10-16** on `recsy-vps` (AMD EPYC 7763, 4 schedulers for
the BEAM, 16 GiB, Elixir 1.17.3 / OTP 27), temp DB, `sync: true`, 2-Update
Actions. This refresh re-measured the headline/tier, `spread`/`hot`,
preload, and fan-out tables **in place** after
[#338](https://github.com/ebbjs/ebbjs/issues/338),
[#339](https://github.com/ebbjs/ebbjs/issues/339),
[#340](https://github.com/ebbjs/ebbjs/issues/340) and the `ad8e43b`
entity-group index fix (`:bag` → `:ordered_set`), and adds the
[#485](https://github.com/ebbjs/ebbjs/issues/485) two-store-only cost
breakdown, the superseded encode-once prototype and the merged coalesced
fan-out delivery (#509). It also **retracts the ~140k fan-out ceiling**:
that figure was a bench-subscriber artifact, fixed by the bench harness (#510) (see
[Harness artifact](#harness-artifact-the-140k-ceiling-was-the-bench-subscriber-fixed-in-510));
the real ceiling is ~1–1.6M deliveries/s. The
#332/#338/#339/#340 sections below and their tables are **pre-refresh
deltas measured against older bases** — they document each change, not
the current baseline. The batch-size, updates-per-Action, and
concurrency sweeps were likewise **not** re-measured in this refresh.

## Reproduction

```sh
cd ebb_server

# Production config, sustained (the headline number):
mix bench.actions --tier t2 --duration 120 --warmup 5 --concurrency 8 \
  --batch-size 100 --updates-per-action 2 --distribution hot

# Same config above saturation:
mix bench.actions --tier t2 --duration 120 --warmup 5 --concurrency 64 \
  --batch-size 100 --updates-per-action 2 --distribution hot

# Storage ceiling (no HTTP):
mix bench.actions --tier t0 --duration 120 --warmup 5 --concurrency 1 \
  --batch-size 100 --updates-per-action 2 --distribution hot

# Pipeline-depth sweep (t0 baseline, then 1/2/4 calls in flight per worker):
mix bench.actions --tier t2 --duration 20 --warmup 3 --concurrency 8 \
  --in-flight 1,2,4 --batch-size 100 --updates-per-action 2 --distribution hot
```

Tier meanings: `t0` = `Writer.write_actions/1` directly; `t1` = real
`POST /sync/actions` at concurrency 1; `t2` = `POST /sync/actions` at the
requested concurrency; `t3` = `t2` plus in-process SSE subscribers; `t4` =
fixed-rate `Writer.write_actions/1` plus in-process SSE subscribers.
`--in-flight N` keeps N `write_actions/1` calls outstanding per worker and
is supported on `t0`, `t2`, and `t3`; see
[Pipeline depth](#pipeline-depth-n-in-flight-calls-551-re-measured-for-the-v2-gate)
and, for the phase accounting and Writer gauges a sweep now renders,
[Flush phase attribution](#flush-phase-attribution-537).

## Run guardrails (#577)

`mix bench.actions` refuses to report an invalid run. After every measured
pass it evaluates the correctness invariants below and exits non-zero, naming
the invariant, when one fails. The report is still written first, so the
measurement is not lost; the failure and every comparison are rendered under
`## Guardrails`.

| Invariant                | Fails when                                                                         |
| ------------------------ | ---------------------------------------------------------------------------------- |
| `gsn_holes`              | any GSN in `1..max_gsn` has no `cf_actions` record; prints the count and first gap |
| `watermark_lag`          | the final watermark lag is at or above the run's accepted GSN count                |
| `rejected_actions`       | the run reports any rejected Action                                                |
| `write_transport_errors` | the run reports any write or transport error                                       |
| `baseline_throughput`    | with `--baseline`: Actions/sec more than **10%** below the matched pass            |
| `baseline_latency`       | with `--baseline`: p50 more than **25%** above the matched pass                    |
| `baseline_no_match`      | with `--baseline`: no baseline pass has the same workload config                   |

A normal tail drain passes: the lag only fails when it reaches the whole
accepted GSN count, which is the frozen-frontier shape from #553/#570. A
frontier that is deliberately not measured (`t5`, or `--ablate watermark`)
is skipped rather than treated as zero. GSN density is not tied to the
frontier: `--ablate watermark` still scans `cf_actions` and can fail on a
hole, while `t5` skips both because it writes at a synthetic GSN base.

`--no-guardrails` opts an intentionally degraded run (fault injection,
ablation experiments) out of the exit code. Violations are still evaluated
and rendered, and the report's configuration table prints
`disabled (--no-guardrails)`, so an exploratory report cannot quietly claim a
clean run.

### Comparing against a baseline

```sh
mix bench.actions --tier t2 --duration 20 --warmup 3 --concurrency 8 \
  --batch-size 100 --updates-per-action 2 --distribution hot \
  --baseline bench/results/20261022T120000Z-recsy-vps.md
```

`--baseline` pairs each measured pass with the pass in a previous report that
has the same workload fields: tier, duration, warmup, concurrency, in-flight
depth, batch size, updates per Action, distribution, durability, preloaded
entities, subscribers, target rate, and ablated phases. Seed, port, and output
path are excluded because they do not change the load shape. A report
carries an `ebb-bench-results:v1` machine block for this; a baseline must be a
report with the same machine-block version. Actions/sec and p50 are
enforced; p95 and p99 are compared and printed for diagnosis. The bands live in
`ebb_server/bench/ebb_server/bench/guardrails.ex`, next to the report and
failure text that quote them.

### Canonical reference budgets

The enforced rule is relative to a `--baseline` file, not an absolute number.
These are the published medians a contributor should recognise as the current
canonical shapes; treat a p50/p99 above them as worth a rotated A/B before it
is called a regression.

| Config                                             |     p50 |    p99\* |   Actions/sec |
| -------------------------------------------------- | ------: | -------: | ------------: |
| `t0 c=1`, batch 100, 2-Update, `hot`, `sync`, 20 s | 3.56 ms |  6.35 ms | 25,690–26,745 |
| `t2 c=8`, batch 100, 2-Update, `hot`, `sync`, 20 s | 29.5 ms | 50.42 ms | 24,615–25,945 |

The p50 figures are the Step 0 medians above. `*` p99 is the last published
measurement for the same shape and predates Step 0, which changed the p50; read
it as an upper reference until it is re-measured, not as a paired current
number. The values sit inside this VM's ±5–10% run-to-run spread, which is why
the baseline band is 10%/25% and not a tighter constant.

## Environment

| Field        | Value                                                                   |
| ------------ | ----------------------------------------------------------------------- |
| Host         | `recsy-vps`                                                             |
| CPU          | AMD EPYC 7763 64-Core Processor, **4 schedulers available to the BEAM** |
| Memory       | 16,377,020 kB (~16 GiB)                                                 |
| Kernel       | Linux 6.8.0-142-generic x86_64                                          |
| Elixir / OTP | 1.17.3 / OTP 27                                                         |
| RocksDB      | `enable_pipelined_write: true`, `max_background_jobs: 4`, `sync: true`  |
| Storage      | temp dir, DB starts empty and is seeded before measurement              |

The 4-scheduler figure matters: the box is a VM with a small CPU quota,
so these are single-node numbers on a modest machine class, not a
dedicated bench rig.

## Read / materialization (#515)

Produced by `mix bench.materialize`, a separate harness from
`mix bench.actions`; this section is not part of the write-path tables
above. Measured **2026-10-18** on the same host, five boots, 50
repetitions per scenario, medians across runs. The full report is the
`*-materialize-recsy-vps.md` file in `bench/results/`.

```sh
cd ebb_server
mix bench.materialize --runs 5 --reps 50 \
  --sizes 100,500,1000,2000,5000 --spread-entities 50 --query-ks 1,10,50
```

A "document" is a `todo` whose `content` field is a wire map of `run_<i>`
keys with ~130-byte values, so each stored leaf is ~207 B of JSON
(`value` + `hlc` + key). `hot` seeds one entity with N keys; `spread`
seeds 50 entities with `N / 50` keys each. `cold` is the first read of an
unmaterialized entity, `dirty` is a read after a one-key patch, `clean`
is a read of a materialized entity.

### Hot document, p50/p95 (µs)

|    N |    Blob B | cold p50 | dirty p50 | dirty p95 | clean p50 | clean p95 |
| ---: | --------: | -------: | --------: | --------: | --------: | --------: |
|  100 |    20,719 |    2,670 |       947 |     1,786 |       257 |       416 |
|  500 |   103,519 |    6,198 |     2,621 |     6,567 |     1,140 |     3,999 |
| 1000 |   207,021 |    5,500 |     4,259 |    12,269 |     2,284 |    20,698 |
| 2000 |   415,021 |   10,126 |     9,938 |    47,077 |     4,520 |    40,418 |
| 5000 | 1,039,021 |   48,555 |    89,400 |   137,894 |    10,967 |   100,199 |

`cold` runs once per boot (5 samples) and is noisy; `dirty`/`clean` have
250 samples. The clean read is ~95% `Jason.decode!` at every size. Dirty
materialize grows roughly linearly to N=2000 and then jumps ~9× from
N=2000 to N=5000 for a 2.5× blob.

### Dirty materialize, mean share by phase (hot)

|    N | `fetch_decode` | `encode` | `upsert` | `merge` | `entries_scan` | `actions_load` |
| ---: | -------------: | -------: | -------: | ------: | -------------: | -------------: |
|  100 |          59.1% |    12.0% |    13.3% |    0.5% |          13.1% |           2.0% |
|  500 |          39.9% |    32.6% |    19.0% |    0.2% |           6.1% |           2.1% |
| 1000 |          42.1% |    37.6% |    16.7% |    0.1% |           3.1% |           0.3% |
| 2000 |          43.0% |    44.1% |    11.6% |    0.1% |           1.1% |           0.1% |
| 5000 |          43.5% |    41.1% |    15.0% |    0.0% |           0.3% |           0.0% |

Blob JSON (`fetch_decode` + `encode`) is ~85% of a dirty materialize at
N≥1000; the SQLite upsert is ~12–15%; the merge is unmeasurable. Means
are shown because the per-phase medians are not co-monotonic (a slow
materialize is slow in every phase), so summing medians understates the
total; the report also publishes each sample's phase sum, which
reconciles with the wall clock.

### Query amplification (spread), p50 (µs)

|    N |   K |  total | decode | bytes decoded |
| ---: | --: | -----: | -----: | ------------: |
| 1000 |   1 |    688 |     37 |         4,118 |
| 1000 |  10 |  1,077 |    324 |        42,315 |
| 1000 |  50 |  2,907 |  1,641 |       212,115 |
| 5000 |   1 |  1,346 |    212 |        20,599 |
| 5000 |  10 |  3,506 |  2,012 |       207,125 |
| 5000 |  50 | 13,475 | 10,355 |     1,036,165 |

Each row decodes the whole blob, so query cost scales with `K × N`; the
permission join is a fixed ~1 ms on top.

### Generated-column ablation (µs)

|    N |  Blob B | 8 generated cols | no generated cols | delta | delta share |
| ---: | ------: | ---------------: | ----------------: | ----: | ----------: |
|  100 |  17,724 |               46 |                13 |    33 |       71.7% |
|  500 |  88,924 |              185 |                20 |   165 |       89.2% |
| 1000 | 177,925 |              428 |                31 |   397 |       92.8% |
| 2000 | 356,925 |              927 |               107 |   820 |       88.5% |
| 5000 | 893,925 |            7,023 |               253 | 6,770 |       96.4% |

The app's upsert SQL against two in-memory SQLite tables, with and
without the eight STORED `json_extract` columns. The generated columns
are ~90–96% of the upsert and are themselves superlinear in blob size
(~8× from N=2000 to N=5000). Absolute times exclude WAL and file I/O, so
read the delta, not the absolute.

### Entity history vs dirty read (#630)

[#630](https://github.com/ebbjs/ebbjs/issues/630) is a read-path fix, not a
stored-shape change: the entity-actions index is keyed `(entity_id, gsn)` but
the materializer read it with `prefix_iterator(entity_id)` and filtered
`gsn > last_gsn` in Elixir, so a dirty read walked the entity's **whole
history** to find its delta. The read now seeks to `(entity_id, last_gsn + 1)`.

Measured **2026-10-24** on `recsy-vps`, same host as the rest of this file, via
the new history axis (`--history-sizes`): one entity, one-key document,
`--runs 2 --reps 20`, one patch Action per sample, so the only variable is how
many prior Update Actions the entity has. p50 and the `entries_scan` phase
(mean) in µs:

```sh
mix bench.materialize --sizes 1000 --runs 2 --reps 20 \
  --history-sizes 0,100,1000,5000,20000 --scenarios dirty \
  --distributions hot
```

| Prior Updates | before p50 | after p50 | before `entries_scan` | after `entries_scan` |
| ------------: | ---------: | --------: | --------------------: | -------------------: |
|             0 |        421 |       377 |                    93 |                   32 |
|           100 |        676 |       336 |                   454 |                   27 |
|         1,000 |      5,063 |       294 |                 3,670 |                   34 |
|         5,000 |     24,122 |       300 |                27,350 |                   23 |
|        20,000 |    115,057 |       343 |               181,645 |                   29 |

The read is flat in history afterwards: **335× faster at 20k** and no worse
at any shorter history. The index still costs what it costs to write, which is
[#575](https://github.com/ebbjs/ebbjs/issues/575)'s question; nothing is pruned
yet ([#123](https://github.com/ebbjs/ebbjs/issues/123) owns the horizon).

## Coalesced entity index (#575)

[#575](https://github.com/ebbjs/ebbjs/issues/575) decided what
`cf_entity_actions` is for. It was one row per Update — 2 of the 5 `cf_*` puts
an Action paid for, and the largest single piece of the stored shape. It is now
**one row per (subject, flush)**, keyed at that subject's highest GSN in the
flush and carrying the subject's sorted GSN list as raw 8-byte big-endian
integers. The materializer still seeks to `(entity_id, last_gsn + 1)`, decodes
each row's list, filters the GSNs it has already applied, and `multi_get`s the
rest, so the read stays a seek plus its delta. Decision, option comparison and
bounds: [`docs/research/575-entity-actions.md`](../../docs/research/575-entity-actions.md).

Measured **2026-10-26** on `recsy-vps`, same host as the rest of this file, as a
rotated A/B: five 20 s passes per side per tier, alternating which build ran
first, medians across the five. Before is `origin/main` `357165e`; after is the
change. `t5` is the raw commit leg; `t0`/`t2` are the Writer with one and eight
callers at depth 1.

```sh
mix bench.actions --tier t5 --concurrency 8 --duration 20 --warmup 3 \
  --batch-size 100 --updates-per-action 2 --distribution hot --durability sync
mix bench.actions --tier t0 --duration 20 --warmup 3 --concurrency 1 \
  --batch-size 100 --updates-per-action 2 --distribution hot
mix bench.actions --tier t2 --duration 20 --warmup 3 --concurrency 8 \
  --batch-size 100 --updates-per-action 2 --distribution hot
```

| Tier              | Before Actions/s | After Actions/s |          Δ | Before p50 | After p50 |
| ----------------- | ---------------: | --------------: | ---------: | ---------: | --------: |
| `t5` K=8, sync    |           88,525 |         102,775 | **+16.1%** |    7.14 ms |   6.25 ms |
| `t0` c=1, depth 1 |           25,775 |          28,420 | **+10.3%** |    3.53 ms |   3.23 ms |
| `t2` c=8, depth 1 |           25,090 |          27,840 | **+11.0%** |    30.5 ms |   27.1 ms |

The win is the put count: at `hot` a 100-Action flush writes **2**
`cf_entity_actions` rows instead of 200, so the full op set falls from **502 to
304** puts. `spread` writes each new subject once, so there the row count does
not move (200 → 200); the win is a function of how often a flush touches the
same subject, and `hot` is where the index cost was measured.

### The index split apart, after

`cf_entity_actions` and `cf_type_entities` are separately ablatable now
(`:entity_actions`, `:type_entities`; `:entity_index` remains the combined
alias, so the published commands keep their meaning). Medians of three 20 s
passes on the changed build:

| `t5` K=8 op set         | puts / 100-Action batch | Actions/s | vs full |
| ----------------------- | ----------------------: | --------: | ------: |
| full                    |                     304 |   102,775 |       — |
| − `entity_actions`      |                     302 |   102,305 |   −0.5% |
| − `type_entities`       |                     302 |   105,560 |   +2.7% |
| − both (`entity_index`) |                     300 |   106,595 |   +3.7% |

The combined ablation's marginal cost was **+25.0%** before the change and
**+3.7%** after it — inside the host's run-to-run spread, which is what "the
phase drops out of the ladder" means. The `t0` ablations (three passes each)
land both above and below the full-shape median (26,865 / 30,750 vs 28,420
Actions/s), so neither half is resolvable against noise there either. The split
matters because the issue priced its "+22%" against the combined `entity_index`
atom, which also dropped the two flush-scoped type rows.

### Read guard (#515 scenarios)

`mix bench.materialize --sizes 1000 --runs 5 --reps 50` plus the history axis
(`--runs 2 --reps 20 --history-sizes 0,1000,20000 --scenarios dirty
--distributions hot`), p50 in µs, before → after:

| Scenario                 | Before | After |       Δ |
| ------------------------ | -----: | ----: | ------: |
| hot cold                 |  5,884 | 6,214 |   +5.6% |
| hot dirty                |  3,325 | 3,510 |   +5.6% |
| hot clean                |  2,453 | 2,387 |   −2.7% |
| spread cold              |    563 |   611 |   +8.5% |
| spread dirty             |    629 |   539 |  −14.3% |
| query K=1                |    548 |   574 |   +4.7% |
| query K=10               |    988 | 1,013 |   +2.5% |
| query K=50               |  3,738 | 3,705 |   −0.9% |
| history, 0 prior Updates |    352 |   368 |   +4.5% |
| history, 1,000 prior     |    316 |   382 | +20.9%† |
| history, 20,000 prior    |    366 |   327 |  −10.7% |

Every N=1000 cold/dirty/query path is inside the +10% p50 guard; the largest
rise is `spread cold` (5 samples). †The 1,000-history row is 40 samples, and
its `entries_scan` rose in the same samples, which this change cannot cause:
at that shape 1,000 per-Update rows collapse to 10 per-flush rows, and the 20k
row fell. That row is host noise, not a read regression. Catch-up and group
listing read no row of this CF (catch-up goes through `cf_group_actions` +
`cf_actions`; group listing materializes per page row, covered by the dirty
rows). Boot reconcile is `N_dirty ×` a full dirty read — the #564 re-mark
materializes each system entity — and coalescing moves only the non-empty
delta's row count.

## Restart boot re-mark (#564)

Dirty marks are ETS-only, so before #564 a restart left a patched-but-never-read
row looking clean and a never-materialized row absent. The fix re-marks every
`cf_type_entities` row dirty during the boot walk that already fills the type
cache. While pricing that trade-off, the boot/first-read path exposed a
redundant second SQLite SELECT + JSON decode in `EntityStore.materialize/2`: when
no action landed after the fetched row's `last_gsn`, it re-read the row it
already had. That is the common path for boot marks, so the same change returns
the pre-scan snapshot instead. The `final` column below is re-mark plus that
one-read materialize.

Measured **2026-10-22/23** on the 4-scheduler development host (load average ~5,
so absolute boot times are noisy; the query delta is orders of magnitude).
Dataset: 10,000 `todo` rows, each with an `entityGroup` filing it into one group,
plus the bootstrap `group` and `groupMember`, written through the real
`ActionValidator` → `Writer` → RocksDB path. SQLite starts with zero `todo`
rows because the write path never writes it. All arms restart on the same
seeded data dir; medians of five in-process restarts (the harness closes the
RocksDB/SQLite handles between boots to emulate a process restart).

```
N=10,000 (median of 5 restarts)     baseline   re-mark only   final
boot                                  3172 ms       2913 ms  1476 ms
system_cache.populated                3034 ms       2875 ms  1449 ms
dirty set after boot                       0        10,001    10,001
dirty todo / group ids                0 / 0    10,000 / 1 10,000 / 1
first query("todo", limit: 1)           2.4 ms       2091 ms  1389 ms
  rows returned                             0             1         1
  entities materialized                     0        10,001    10,001
  summed materialize latency                0       2045 ms  1351 ms
SQLite todo rows, before → after     0 → 0    0 → 10,000 0 → 10,000
dirty set after the query                   0             0         0
```

At **N=1,000** the same shape: boot 272 ms → 312 ms (re-mark only) → 122 ms
(final), dirty set 0 → 1,001, and the first query 0.5 ms → 233 ms → 63 ms. The
10,001 surviving marks are the 10,000 todos plus the never-eagerly-populated
`group`; the 10,000 `entityGroup` marks are placed by the walk and cleared by
the eager populator during the same boot.

A boot-only A/B, alternating fresh VMs on both commits, put re-mark boot medians
at **2409 ms baseline vs 2426 ms (+0.7%)**: the walk writes one mark per indexed
pair — roughly 20k here — but that ETS work is not measurable next to the
existing eager population, and only 10,001 marks survive to the first read. The
final boot is lower because removing the second read helps every already-current
eager row. The cost that remains is the herd, not the boot: `query/4`
materializes every dirty id of the requested type before it runs the SQL, so
`LIMIT 1` does not bound the work. (A type query also drains dirty system types,
`group` included, so the herd scales with group count as well; this dataset has
one group.) That is the price of serving current data after a restart; a large
lazy corpus pays it once, on its first read after boot. `ebb.dirty_set.size`
exposes the post-boot backlog.

After both changes, the scaling shape on warm restarts is:

```
N        boot       first query   materializations
1,000    122 ms       63 ms          1,001
10,000   1.48 s       1.39 s        10,001
100,000  11.9 s       7.67 s       100,001
1,000,000 120.9 s    126.5 s     1,000,001
```

1k/10k are medians of five restarts, 100k of three, and 1M a single warm restart
whose rows were already materialized. The earlier first-boot 1M figure (264 s
boot / 284 s query) included writing the SQLite rows for the first time, so it
is not directly comparable. At 100k, the warm re-mark-only medians were 20.4 s
boot / 11.2 s first query; the final rows above are 11.9 s / 7.67 s.

## Headline: production configuration

Single Writer, `sync: true`, 2-Update Actions, `--distribution hot`,
batch 100 Actions/request. Refreshed 2026-10-16 (#485); the old
15.3k/15.1k headline is superseded.

```sh
mix bench.actions --tier t2 --duration 120 --warmup 5 --concurrency 8 \
  --batch-size 100 --updates-per-action 2 --distribution hot
```

| Window           | Seconds | Accepted/sec | Scheduler util |  Peak RSS |
| ---------------- | ------: | -----------: | -------------: | --------: |
| burst (0–15s)    |      15 |   **21,440** |          23.8% | 446.2 MiB |
| steady (61–120s) |      59 |   **20,971** |          23.8% | 446.2 MiB |
| overall          |     120 |       21,173 |          23.8% | 446.2 MiB |

Storage ceiling, same batch and Action shape, direct `Writer` call:

```sh
mix bench.actions --tier t0 --duration 120 --warmup 5 --concurrency 1 \
  --batch-size 100 --updates-per-action 2 --distribution hot
```

| Window           | Seconds | Accepted/sec | Scheduler util |  Peak RSS |
| ---------------- | ------: | -----------: | -------------: | --------: |
| burst (0–15s)    |      15 |       24,613 |           9.4% | 370.7 MiB |
| steady (61–120s) |      59 |   **26,251** |           9.4% | 370.7 MiB |
| overall          |     120 |       26,243 |           9.4% | 370.7 MiB |

Both runs: **0 rejected Actions, 0 GSN holes, final watermark lag 0**;
peak dirty set 4 on both.

Pre-refresh history — the c=64 saturation run, its client-side latency,
and peak RSS were measured against the older base (pre-refresh c=8
throughput 15,298/s):

Above the saturation point (concurrency 64, same everything else):

| Window           | Seconds |  Accepted | Accepted/sec | Rejected |
| ---------------- | ------: | --------: | -----------: | -------: |
| burst (0–15s)    |      15 |   224,800 |       14,987 |        0 |
| steady (61–120s) |      59 |   850,600 |       14,417 |        0 |
| overall          |     120 | 1,746,000 |       14,550 |        0 |

Per-request latency (poll → response, includes msgpack encode + `:httpc`).
These are client-side numbers; per-run reports also carry server-side
latency sourced from `ebb.*` telemetry — see
[Server-side telemetry](#server-side-telemetry):

| Run                    |      p50 |      p95 |      p99 |
| ---------------------- | -------: | -------: | -------: |
| concurrency 8, burst   |  49.2 ms |  60.6 ms |  92.3 ms |
| concurrency 8, steady  |  51.5 ms |  61.4 ms |  71.2 ms |
| concurrency 64, steady | 441.7 ms | 485.1 ms | 513.1 ms |

Pre-refresh peak RSS was 511 MiB (c=8) and 645 MiB (c=64).

**Verdict.** Production is a single Writer with `sync: true`. On this
machine it sustains **~21.2k Actions/sec** (t2 c=8, 120s steady
**20,971**), with the direct storage ceiling at **26,251/s** steady
(t0 c=1). `t0` (26.2k) is now clearly above `t2` (21.0k): the
HTTP/Bandit layer costs **~20%** at c=8, contrary to the old
"`t0` ≈ `t2`" claim. The old 108k headline was a 2-writer raw-RocksDB
primitive and is not reproducible through `ebb_server` — the ceiling here
is single-Writer serialization plus per-Action Elixir work, not the disk.

## Pre-epic vs current: a rotated A/B (#529)

> **Pre-Step-0 — 2026-10-22.** The `8177744` arm below is the last commit
> before #579/#582/#581. This section is the honest record of what the epic
> cost before Step 0; current numbers are in
> [Step 0](#step-0-depth-1-parity-579-582-581).

The headline above is the last pre-epic refresh. This section measures the
epic's net effect on the write path directly, because the epic's own gate was
originally judged on within-session deltas and never against the state it
started from.

Method: `git worktree` at **`6cba789`** (the commit before the #531 merge that
introduced the sequencer/committer split) and the pre-Step-0 `main` @
**`8177744`**,
built and benchmarked alternately on the same host, five passes per row with
the order reversed on alternate passes, plus one 120 s run per row. Same shape
throughout: batch 100, 2-Update Actions, `hot`, `sync: true`, `--seed 1`. Both
builds report **0 GSN holes, 0 rejected Actions, 0 write/transport errors** on
every run. The pre-#531 build has no pipeline, so both arms run at depth 1 —
which is what production runs.

```sh
# per arm, from its own checkout
mix bench.actions --tier t0 --duration 20 --warmup 3 --concurrency 1 \
  --batch-size 100 --updates-per-action 2 --distribution hot --seed 1
mix bench.actions --tier t2 --duration 20 --warmup 3 --concurrency 8 \
  --batch-size 100 --updates-per-action 2 --distribution hot --seed 1
```

### 20 s windows (5 passes, median)

| Config   | Arm       |  Actions/s |         p50 |     p95 |     p99 | Scheduler util |
| -------- | --------- | ---------: | ----------: | ------: | ------: | -------------: |
| `t0 c=1` | pre-#531  | **26,740** |     3.45 ms | 4.36 ms | 5.22 ms |           9.5% |
| `t0 c=1` | `8177744` |     20,410 |     4.60 ms | 5.50 ms | 6.42 ms |          11.1% |
| `t2 c=8` | pre-#531  | **21,590** | **35.6 ms** | 42.1 ms | 47.0 ms |          24.3% |
| `t2 c=8` | `8177744` |     19,515 |     39.5 ms | 46.6 ms | 50.0 ms |          26.3% |

### 120 s steady window (one run per row)

| Config   | Arm       | Actions/s (steady) |         p50 |     p95 |     p99 | Scheduler util |
| -------- | --------- | -----------------: | ----------: | ------: | ------: | -------------: |
| `t0 c=1` | pre-#531  |         **25,402** |     3.59 ms | 4.57 ms | 5.46 ms |           9.6% |
| `t0 c=1` | `8177744` |             20,219 |     4.62 ms | 5.63 ms | 6.49 ms |          10.9% |
| `t2 c=8` | pre-#531  |         **20,985** | **36.1 ms** | 42.9 ms | 47.6 ms |          23.8% |
| `t2 c=8` | `8177744` |             19,249 |     39.8 ms | 46.5 ms | 50.5 ms |          26.4% |

### What it says

- **The epic costs throughput and latency at the shape production runs.** `t0
c=1` is **−24%** throughput and **+33%** p50; `t2 c=8` is **−10%**
  throughput and **+10%** p50. The 120 s steady windows agree (−20% / −8%), so
  this is not a short-window artifact.
- **The cost is the pipeline's depth-1 overhead, not the storage shape.** Both
  arms write the same five column families with the same records; the current
  arm adds the prepare hop, the committer handoff, the in-flight id guard, the
  overlay plan, and the ordered-release bookkeeping. The flush-only ablation
  ladder above attributes them: watermark +0.41 ms/flush, dedup +0.22,
  fanout +0.21, cache +0.11 against the pre-epic marginals. The gap is inside
  the flush: an earlier estimate put ~1 ms/call outside it, but that subtracted
  a flush **p50** from a per-call **mean**; matched to the same statistic the
  per-call gap is ~0.3 ms.
- **The pipeline's remaining measured advantage is the depth-2 shape**, which
  cannot run on the pre-#531 build: 31,015 Actions/s at `t0 c=1 depth 2`
  (+52.6% over its own depth-1 row, flush and commit p50 unchanged). At the
  production shape depth 2 buys +3.8% for 2× p50, so this advantage does not
  reach production traffic — it reaches single-heavy-client shapes (bulk
  import) and nothing else measured so far.
- **Therefore the pre-#531 state is the floor the epic has to beat, not the
  ceiling it already passed.** Any claim that the pipeline "paid for itself"
  has to show a depth-1 row at or above these numbers, because production is a
  depth-1 deployment.

## Step 0: depth-1 parity (#579, #582, #581)

Step 0 is the depth-1 debt the A/B above measured. Three changes landed on
2026-10-22, in order:

- [#579](https://github.com/ebbjs/ebbjs/issues/579) — `WatermarkTracker`
  advances the resolution frontier **per range** instead of one ETS row and
  one advance step per GSN ([#572](https://github.com/ebbjs/ebbjs/issues/572)).
- [#582](https://github.com/ebbjs/ebbjs/issues/582) — payload build + encode
  runs **on the Writer when its pipeline is idle**, and on the prepare pool
  otherwise ([#574](https://github.com/ebbjs/ebbjs/issues/574)).
- [#581](https://github.com/ebbjs/ebbjs/issues/581) — the durable write runs
  **inline in the Writer when `max_in_flight == 1`**; the committer pool is
  used at depth > 1.

Measured **2026-10-22** on `recsy-vps`, the same host and shape as the
rotated A/B: 4 schedulers, `sync: true`, batch 100, 2-Update Actions, `hot`,
`--seed 1`, 20 s window after 3 s warmup, five reports per row, medians with
min–max ranges where the run set recorded one. Every run had **0 GSN holes,
0 rejected Actions, 0 write-transport errors**.

```sh
mix bench.actions --tier t0 --duration 20 --warmup 3 --concurrency 1 \
  --batch-size 100 --updates-per-action 2 --distribution hot --seed 1
mix bench.actions --tier t2 --duration 20 --warmup 3 --concurrency 8 \
  --batch-size 100 --updates-per-action 2 --distribution hot --seed 1
```

| State                        |         `t0 c=1` Actions/s |    `t0` p50 |         `t2 c=8` Actions/s | `t2` p50 | `t2` Actions/flush |
| ---------------------------- | -------------------------: | ----------: | -------------------------: | -------: | -----------------: |
| pre-#531 A/B arm (`6cba789`) |                     26,740 |     3.45 ms |                     21,590 |  35.6 ms |               ~400 |
| `8177744` (before Step 0)    |    20,410 (20,219 @ 120 s) |     4.60 ms |    19,515 (19,249 @ 120 s) |  39.5 ms |                399 |
| after #579                   |                     24,690 |     3.79 ms |                     26,385 |  28.7 ms |                  — |
| after #579+#582              |                     24,160 |     3.85 ms |                     26,285 |  28.8 ms |                  — |
| after #579+#582+#581         | **25,935** (25,690–26,745) | **3.56 ms** | **25,710** (24,615–25,945) |  29.5 ms |            **272** |
| pre-#531, 120 s steady       |                     25,402 |     3.59 ms |                     20,985 |  36.1 ms |                  — |

**`t2 c=8` now runs at 272 Actions/flush, not the ~400 the older sections
describe.** In-line prepare and in-line commit mean the Writer no longer waits
on a pool for the payload or the durable write, so a burst drains sooner and
fewer calls are still waiting when the next flush closes. The 399–400
Actions/flush rows above and in
[Pipeline depth](#pipeline-depth-n-in-flight-calls-551-re-measured-for-the-v2-gate)
are properties of that older code, not of the current one; that is also why
depth comparisons have to be read against their own `Actions/flush` column.

**The depth-2 shape is capability, not a parity check.** `t0 c=1 depth 2` went
from 31,015 to **37,200** (35,660–39,585) Actions/s at p50 4.90 ms after
#579+#582. The pre-#531 build cannot run it at all (no pipeline,
`max_in_flight: 1`), so this row says what the pipeline can do, not whether it
regressed.

**Two items were measured and dropped, and that is part of the record.** An
O(range) in-flight id guard has no cost left to remove — the `--ablate dedup`
marginal measures **−1.0%**, i.e. nothing. And the original premise of
[#574](https://github.com/ebbjs/ebbjs/issues/574) was an arithmetic error: the
"1.28 ms per call outside the flush" subtracted a flush **p50** from a per-call
**mean**, and the real per-call gap, matched to the same statistic, is **~0.3
ms**.

**The watermark's own marginal fell with #579.** `--ablate watermark` at `t0
c=1` prices it at **0.35 ms** per 100-Action flush, down from **0.88 ms**
before the change; a later fresh ladder prices it at 0.21 ms.

**Gate outcome against the pre-#531 arm:** `t0 c=1` **−3.0%** (inside the ±5%
band), `t2 c=8` **+19.1%**, p50 +3% at `t0` and −17% at `t2`. The revert
fallback #529 pre-committed for this gate was retired on that basis.

### What it says

- **The epic had cost 24% of the storage ceiling and 10% of production
  throughput, with worse p50 at both metrics.** Step 0 does not argue that
  cost away; it removes it.
- **Step 0 closes the ceiling to −3% and puts production 19% ahead of
  pre-#531**, with p50 17% better at t2 and 3% worse at t0. The pipeline is
  now the faster configuration at the shape production runs.
- **The pipeline's remaining advantage over the pre-epic build is the depth-2
  shape** (37,200 at `t0 c=1`), which production does not use. What sits
  between here and the next tier is per-Action work inside the flush —
  `cf_entity_actions`, 21.5% of it
  ([#575](https://github.com/ebbjs/ebbjs/issues/575)) — not pipeline overhead.

## Tier and storage ceiling

Refreshed rows (2026-10-16, #485):

```sh
# t0 storage ceiling
mix bench.actions --tier t0 --duration 120 --warmup 5 --concurrency 1 \
  --batch-size 100 --updates-per-action 2 --distribution hot

# t2 production
mix bench.actions --tier t2 --duration 120 --warmup 5 --concurrency 8 \
  --batch-size 100 --updates-per-action 2 --distribution hot
```

| Run                   | Tier | Batch | Conc | Burst /s | Steady /s | Overall /s | Sched util |  Peak RSS |
| --------------------- | ---- | ----: | ---: | -------: | --------: | ---------: | ---------: | --------: |
| Storage ceiling, 120s | t0   |   100 |    1 |   24,613 |    26,251 |     26,243 |       9.4% | 370.7 MiB |
| Production, 120s      | t2   |   100 |    8 |   21,440 |    20,971 |     21,173 |      23.8% | 446.2 MiB |

Pre-refresh rows (older base, kept for history):

| Run (pre-refresh)             | Tier | Batch | Conc | Burst /s | Steady /s | Overall /s |      p50 |      p95 |      p99 |
| ----------------------------- | ---- | ----: | ---: | -------: | --------: | ---------: | -------: | -------: | -------: |
| Single HTTP client, 10s       | t1   |   100 |    1 |    9,610 |       n/a |      9,610 |   9.1 ms |  11.4 ms |  13.1 ms |
| Above saturation, 120s        | t2   |   100 |   64 |   14,987 |    14,417 |     14,550 | 441.7 ms | 485.1 ms | 513.1 ms |
| Async durability ceiling, 30s | t2   |   100 |    8 |   14,093 |       n/a |     16,327 |  43.2 ms |  71.8 ms |  90.6 ms |

`t0` (26.2k) is now clearly above `t2` (21.0k): the HTTP/Bandit layer
costs ~20% at c=8, so the storage path alone is no longer the whole
story. The `--durability async` run (`sync: false`) is only ~3–8% faster
than the `sync: true` run (pre-refresh), so fsync is not the dominant
cost at this batch size — the Elixir-side write path is, matching #130's
conclusion.

## Batch-size sweep

T2, concurrency 8, hot, 2-Update Actions, 10s windows:

| Actions/request | Accepted/sec |
| --------------: | -----------: |
|               1 |        1,140 |
|              10 |        6,677 |
|             100 |       15,430 |
|            1000 |       12,400 |

Per-request overhead dominates at batch 1; batch 100 is the sweet spot;
batch 1000 regresses (larger requests and per-request dedup scans).

## Updates-per-Action sweep

T2, batch 100, concurrency 8, hot, 30s windows. The canonical unit is a
2-Update Action (entity `put` + `entityGroup` put); N=1 re-puts a
pre-seeded owned entity (a 1-Update Action cannot create ownership), N=10
adds eight more `todo` puts to the same entity.

| Updates/Action | Accepted/sec |      p50 |
| -------------: | -----------: | -------: |
|              1 |       26,403 |  29.2 ms |
|  2 (canonical) |       15,347 |  50.7 ms |
|             10 |        4,810 | 162.8 ms |

Per-Update cost dominates, roughly inverse with Update count plus a fixed
per-Action component.

## Concurrency sweep

T2, hot, 2-Update Actions, 10s windows:

| Batch |   c=1 |        c=8 |   c=32 |   c=64 |  c=256 |
| ----: | ----: | ---------: | -----: | -----: | -----: |
|    10 | 4,694 |  **6,677** |      — |  6,607 |  6,602 |
|   100 | 9,610 | **15,430** | 12,870 | 12,680 | 15,300 |

Saturation is around 8 concurrent clients; beyond it throughput is flat
and latency grows linearly with queue depth at the single Writer.

## Entity distribution: hot vs spread

Batch 100, 2-Update Actions. Refreshed 2026-10-16 (#485) after the
`ad8e43b` group-index fix (`:bag` → `:ordered_set`):

```sh
# t0 spread
mix bench.actions --tier t0 --duration 30 --warmup 5 --concurrency 1 \
  --batch-size 100 --updates-per-action 2 --distribution spread

# t2 spread (same, at concurrency 8)
mix bench.actions --tier t2 --duration 30 --warmup 5 --concurrency 8 \
  --batch-size 100 --updates-per-action 2 --distribution spread
```

| Distribution                                    | Tier | Window | Burst /s | Overall /s | Sched util | Peak dirty set |
| ----------------------------------------------- | ---- | -----: | -------: | ---------: | ---------: | -------------: |
| `spread` (fresh entity + membership per Action) | t0   |    30s |   18,040 |     16,790 |      10.7% |      1,156,602 |
| `spread` (fresh entity + membership per Action) | t2   |    30s |   14,133 |     14,077 |      29.1% |        961,202 |
| `hot` (one entity, LWW contention), canonical   | t2   |   120s |   21,440 |     21,173 |      23.8% |              4 |

Pre-refresh (measured against the old `:bag` group index):

| Distribution (pre-refresh)                      | Burst /s | Overall /s | Peak dirty set |
| ----------------------------------------------- | -------: | ---------: | -------------: |
| `hot` (one entity, LWW contention)              |   15,147 |     15,347 |              4 |
| `spread` (fresh entity + membership per Action) |    1,147 |        883 |         80,602 |

The `ad8e43b` fix removed the O(group size) blowup: **`spread` is now
~14.1k/s (t2) instead of 883/s** (the old published value; t0 spread was
~1,070/s and is now 16,790/s), so `spread` is only ~1.5× slower than
`hot` rather than ~17×. The dirty set still grows to ~1.16M in the t0
spread run and ~961k in the t2 spread run, yet it no longer degrades
throughput. This is a **correction** of a stale baseline, not a new
optimization.

## DB state: fresh vs entities preloaded

Batch 100, 2-Update Actions, `hot`. `hot` re-puts one membership row; the
by-group ETS index then holds every preloaded membership under the single
bench group. Refreshed 2026-10-16 (#485) after the `ad8e43b` fix:

```sh
# 10k preload
mix bench.actions --tier t2 --duration 30 --warmup 5 --concurrency 8 \
  --batch-size 100 --updates-per-action 2 --distribution hot --entities 10000

# 100k preload
mix bench.actions --tier t2 --duration 90 --warmup 5 --concurrency 8 \
  --batch-size 100 --updates-per-action 2 --distribution hot --entities 100000
```

| Preloaded entities | Window | Burst /s |             Overall /s | Sched util | Peak dirty set |
| -----------------: | -----: | -------: | ---------------------: | ---------: | -------------: |
|          0 (fresh) |   120s |   21,440 |                 21,173 |      23.8% |              4 |
|             10,000 |    30s |   21,600 |                 21,677 |      23.9% |         20,004 |
|            100,000 |    90s |   21,413 | 21,441 (steady 21,521) |      23.7% |        200,004 |

Pre-refresh:

| Preloaded entities (pre-refresh) | Window |     Accepted/sec | Peak dirty set |
| -------------------------------: | -----: | ---------------: | -------------: |
|                           10,000 |    30s |            2,353 |         20,004 |
|                          100,000 |    90s | 204 (steady 207) |        200,004 |

The `ad8e43b` group-index fix removed the O(group size) blowup: **100k
preload is now ~21.4k/s instead of 204/s** and 10k preload is 21,677/s
instead of 2,353/s — the preload no longer degrades throughput. The
pre-refresh account of the mechanism: the rate degraded linearly with
group membership count because `EntityGroupCache.put_entity_group/2`
maintained a `:bag` keyed by group id, and ETS `:bag` insert/delete
traverses the key's bucket — O(group size) per membership write (a
micro-benchmark of the function alone gave 431 distinct inserts/sec and
3,970 µs per re-put with 100k members). The same mechanism drove the
`spread`↔`hot` gap, which is why both tables moved together. This is a
**correction** of a stale baseline, not a new optimization.

## Fan-out tax on write throughput

T3, batch 10, concurrency 8, hot, 15s windows. Refreshed 2026-10-16
(#485), after the `ad8e43b` index fix:

```sh
mix bench.actions --tier t3 --duration 15 --warmup 3 --concurrency 8 \
  --batch-size 10 --updates-per-action 2 --distribution hot \
  --subscribers <N>
```

| Subscribers | Baseline before prototype (median of 3) | After "encode once per group" (median of 3) | Delivery rate                 |                      Peak RSS |
| ----------: | --------------------------------------: | ------------------------------------------: | ----------------------------- | ----------------------------: |
|  0 (t2 b10) |                                  15,893 |                                      16,069 | —                             |                       272 MiB |
|         100 |                                   1,647 |                                       1,243 | —                             |                       371 MiB |
|        1000 |                                     677 |                                          67 | before ≈ 27k/s, after ≈ 39k/s | before 928 MiB, after 447 MiB |

Delivery rate is total delivered over the 87s drain (measured only on the
1000-subscriber runs). Relative to the **improved** 15,893/s baseline the
cliff is now **−90% at 100 subscribers and −96% at 1000 subscribers** (the
old doc's 6,677/s baseline made it −82% / −91%). Every subscriber receives
a JSON-encoded event per Action, so fan-out cost scales with subscriber
count and dominates the scheduler (49.8% utilization on the
1000-subscriber run). Delivery lag is a client-side stamp (send →
delivery), so it folds in client and transport overhead; the server's own
`ebb.fanout.push_latency_ms` reports commit → broadcast complete separately (see
[Server-side telemetry](#server-side-telemetry)).

### Fan-out tax with coalescing (T3 sweep re-run, #485)

Candidate #4's "re-run the T3 subscriber sweep", same command
(`--tier t3 --duration 15 --warmup 3 --concurrency 8 --batch-size 10
--distribution hot`), now with the shared vs `--subscriber-lean` subscriber
(the lean numbers replace the earlier coalesced re-run, which the shared
harness was capping):

| Subscribers | Shared (old) | **Lean** | Old reported delta | Corrected delta |
| ----------: | -----------: | -------: | ------------------ | --------------: |
|  0 (t2 b10) |       15,771 |   16,129 | —                  |               — |
|         100 |        1,319 |    8,038 | −92%               |        **−50%** |
|        1000 |          155 |    2,167 | −99%               |        **−87%** |

The previously published "−90%/−96% fan-out tax" (against the 15,893/s
baseline above) was largely the harness: the shared subscriber capped the
count. The tax is real but far milder — **−50% at 100 subscribers and −87% at
1000**.

The `t3` Accepted/sec metric is also **confounded**, the same direction as the
earlier encode-once hoist: `t3` drives writes flat out while a subscriber storm
exists, so a fan-out that drains the backlog faster starves the in-process
`:httpc` clients and depresses the accepted count. It is exactly why `t4`
(fixed write rate, deliveries + server-side latency) was built, and `t4` shows
the win. Publish both and say so.

### Fan-out: encode-once prototype (superseded, #485)

The prototype (attempted during the spike, then reverted — not merged) hoisted
encoding so each group's payload is built **once per group per committed
range** and the same binary is handed to every subscriber.

Server-side on the 1000-subscriber run:

| Metric                            | Baseline before |  After |
| --------------------------------- | --------------: | -----: |
| `ebb.fanout.push_latency_ms` p50  |          8.04 s | 4.09 s |
| `ebb.writer.batch_latency_ms` p50 |          4.5 ms | 3.8 ms |
| Scheduler utilization             |           49.8% |  49.8% |

So the hoist **improved** commit → broadcast complete latency and **halved** RSS
(928 MiB → 447 MiB) while the harness's Accepted/sec metric fell ~10×
(677/s → 67/s). `:binary.copy/1` per subscriber did not recover it,
ruling out shared-refc-binary refcount contention.

**Verdict.** The hoist (attempted during the spike, then reverted — not
merged) is **superseded by coalesced delivery (#509)**. Both were t4-measured
commit → broadcast complete p50 wins — the hoist p50 ~3–4× lower (n=1000,
r=50: 567,252/642,303/2,146,301 µs → 167,232/374,096/494,278 µs; n=100,
r=1000: 46,235/51,171/153,332 µs → 16,814/25,986/31,628 µs) — but the hoist
shaved only the **per-subscriber encode** while still sending N×A messages,
so it does **not** remove the per-group serial O(N) limit. Coalescing encodes
once per group **and** collapses the message count, so the hoist is kept here
as **history**, not as the recommended next step. The original park cited the
t3 Accepted/sec regression (677/s → 67/s); that metric is confounded by the
delivery backlog and client starvation, not a fan-out verdict, and coalescing
supersedes the hoist, so the hoist is now history. **10k
subscribers were not measured** — at 1,000 subscribers on a 4-scheduler VM
the box is already saturated and RSS was 928 MiB; a 10k-subscriber point
needs a dedicated machine and is out of scope here.

## Fixed-rate fan-out (t4, #485)

Tier `t4` (added in #510) drives `Writer.write_actions/1` at a fixed
rate `--rate R` and reports delivered Actions/sec plus **commit → broadcast
complete** p50 per 10s bucket, so fan-out is judged with the **write client
held constant**: `need = R × N` deliveries/sec, and a flat per-bucket p50
means fan-out keeps up while a rising one means it does not. The telemetry
fires at the **end** of `GroupServer.handle_cast({:push_actions, ...})`,
after the per-subscriber cast loop (O(N×A) before coalescing, O(N) after
#509), so the label is commit → broadcast complete, not
commit → dispatch.

```sh
mix bench.actions --tier t4 --rate <R> --subscribers <N> --duration 25 \
  --warmup 5 --concurrency 1 --batch-size 100 --updates-per-action 2 \
  --distribution hot
```

Keep-up sweep on `recsy-vps` (4 schedulers; p50 across 10s buckets, µs).
**Measured with the shared bench subscriber — the `delivered/s` column is
capped by the harness artifact below**; the corrected lean ceilings follow:

|     R |    N | need | achieved | delivered/s | % need | p50 buckets (µs)                    | verdict                       |
| ----: | ---: | ---: | -------: | ----------: | -----: | ----------------------------------- | ----------------------------- |
| 10000 |    1 |  10k |    9,848 |       9,524 |    95% | 29,069 / 6,615 / 24,787             | keeps up                      |
|  7000 |   10 |  70k |    7,000 |      69,959 |   100% | 4,737 / 4,829 / 4,752               | keeps up                      |
|   500 |  100 |  50k |      500 |      50,194 |   100% | 42,620 / 42,874 / 46,273            | keeps up                      |
|  1000 |  100 | 100k |    1,000 |     100,003 |   100% | 43,391 / 47,190 / 51,080            | keeps up                      |
|    50 | 1000 |  50k |       48 |      50,697 |   101% | 537,301 / 636,850 / 648,571         | keeps up (~0.6s)              |
|   100 | 1000 | 100k |      104 |      98,765 |    99% | 580,151 / 774,715 / 903,755         | at the edge                   |
|   300 | 1000 | 300k |      300 |     117,992 |    39% | 2,318,603 / 8,337,306 / 13,286,676  | diverges                      |
|   500 | 1000 | 500k |      504 |     116,457 |    23% | 2,964,171 / 10,483,715 / 17,388,314 | diverges                      |
|  2000 |  100 | 200k |    1,960 |     116,008 |    58% | 1,106,037 / 4,977,938 / 9,060,987   | diverges                      |
|  8000 |   10 |  80k |    7,844 |      72,733 |    91% | 4,544 / 7,081 / 947,764             | diverges late                 |
|  2000 | 1000 |   2M |    1,692 |     113,697 |     6% | 4,540,025 / 13,610,517 / 20,616,455 | diverges                      |
| 20000 |   10 | 200k |   13,476 |      68,554 |    34% | —                                   | **write-limited** (13.5k<20k) |

**Harness fix (#510).** `delivered_rate` now windows the **measured
window only** (warmup excluded). Before the fix, every report read ~86% of the
true rate because the denominator spanned warmup plus the measured window;
that "residual" was **warmup dilution, not end-of-run backlog**. Smoke proof:
`--rate 1000 --subscribers 10 --duration 5 --warmup 2` read 8,175.6/s before and
9,989.6/s after (need = 10,000/s). Below the knee, delivered/s ≈ need.

### Harness artifact: the ~140k ceiling was the bench subscriber (fixed in #510)

`EbbServer.Bench.Subscriber` shared **one `:counters` ref and one `:bag` ETS lag
table across all subscribers**. At high subscriber counts those serialized,
capping measured delivery at ~140k/s and inflating the t3 cliff. The fix is
`--subscriber-lean` (#510), which gives every subscriber its own counters
and skips the shared lag table. The same PR (#510) adds the server-side
`ebb.fanout.dispatched_actions` counter and counts pre-coalescing
`{:sse_chunk, "data", …}` as a delivery too.

Same load, default (shared) vs `--subscriber-lean`, n=1000 r=300 (need
300,000/s):

| subscriber       | achieved write/s | dispatched/s | delivered/s |     util |
| ---------------- | ---------------: | -----------: | ----------: | -------: |
| shared (default) |              192 |      140,000 |     146,275 |    40.8% |
| **lean**         |          **304** |  **300,000** | **302,817** | **7.6%** |

`dispatched/s` (server-side) equals `delivered/s` on both modes, so the server
was enqueueing **all** 300k/s; the shared subscriber was capping the count.

Corrected t4 ceilings with lean subscribers:

| config         | need | achieved | dispatched/s | delivered/s |  util |
| -------------- | ---: | -------: | -----------: | ----------: | ----: |
| n=1000, r=300  | 300k |      300 |      300,000 |     302,756 |  7.5% |
| n=1000, r=1000 |   1M |    1,000 |    1,000,000 |   1,000,705 | 24.2% |
| n=1000, r=3000 |   3M |    2,220 |    1,616,000 |   1,616,299 | 40.1% |
| n=100, r=2000  | 200k |    2,004 |      200,000 |     200,158 |  5.8% |
| n=100, r=3000  | 300k |    3,000 |      300,000 |     300,032 |  8.7% |
| n=100, r=10000 |   1M |    9,908 |      977,600 |     977,731 | 31.2% |

**The real fan-out ceiling is ~1–1.6M deliveries/s**, not 140k. At n=1000
r=1000 the server keeps up **100%** at 1,000,705 delivered/s on 24% CPU. The
~140k figure was the harness.

**Findings.**

1. **Aggregate delivery keeps up past 1M deliveries/s; the real ceiling is
   ~1–1.6M/s.** With lean subscribers the server holds 100% of need at
   1,000,705 delivered/s (n=1000, r=1000, 24% CPU) and reaches 1,616,299/s
   (n=1000, r=3000, 40% CPU). The "~100–120k/s" saturation in the shared
   keep-up sweep above was the bench subscriber, not the server (see the
   harness artifact). Above the real ceiling the commit → broadcast complete
   p50 grows without bound (n=1000, r=3000: only 2,220 of 3,000 write/s
   achieved).
2. **Per-batch latency is O(N).** At the _same_ ~100k deliveries/s, n=100 costs
   ~45–51 ms while n=1000 costs ~0.6–0.9 s. Before #509 a group was
   dispatched by one `GroupServer` process that serially cast one message per
   (subscriber × action) (`group_server.ex:76-80`), so the per-batch cost grew
   with subscribers; coalescing makes it one message per subscriber per batch.
3. **Consequence at scale, and what coalescing changed.** Before #509,
   1000 subscribers sustained ~100 Actions/s of fan-out at ~0.6–0.9 s
   dispatch latency while ~100 subscribers sustained ~1000 Actions/s at
   ~45 ms — the mechanism behind the t3 cliff. **Coalesced delivery is now
   merged** (#509): with lean subscribers it is a **~6× delivered-throughput
   win and up to ~6× less CPU**, and the pre-#583 commit → broadcast complete p50
   (timer started at the top of `apply_one/2`) falls to **~30 ms versus
   multi-second** (see
   [Coalesced fan-out delivery](#coalesced-fan-out-delivery-485-merged-in-509)).
   The earlier "+2–22% delivered, ceiling not removed" was an artifact-capped
   comparison: the shared harness capped _both_ arms at ~140k, hiding the real
   pre-coalescing cap (~175k/s, the `GroupServer`'s N×A loop) and the coalesced
   one (≥1M); with it removed, coalescing **does** remove the message-level
   ceiling. The encode-once hoist is **superseded** by coalescing; sharding
   `GroupServer`s was tested and ruled out (see below).
4. Only `n=10 R=20000` was **write-limited** (achieved 13,476 < 20,000); the
   other rows held `achieved ≈ target`, so their divergence is fan-out, not
   Writer saturation.

**Why the T3 Accepted/sec metric is confounded.** In the t3 run with the
hoist, the report's _client-side_ latency window is **87s for a 15s run**.
The worker loop checks the deadline only _before_ each iteration, so when
`Writer.write_actions/1` blocks for seconds the worker records post-deadline
samples. `delivered_total` counts those post-deadline Actions, while
`Accepted/sec` windows only 0–15s. That is why delivered exceeded accepted ×
subscribers (3.39M vs ~1.04M) and why the metric cannot be used to judge a
fan-out shape change.

**Encode-once hoist A/B (spike prototype, not merged), measured under t4:**

| config        | baseline p50 buckets (µs)     | with hoist p50 buckets (µs) | delivered/s     |
| ------------- | ----------------------------- | --------------------------- | --------------- |
| n=1000, r=50  | 567,252 / 642,303 / 2,146,301 | 167,232 / 374,096 / 494,278 | 41,595 → 45,456 |
| n=100, r=1000 | 46,235 / 51,171 / 153,332     | 16,814 / 25,986 / 31,628    | 85,788 → 85,918 |

The hoist lowers commit → broadcast complete p50 ~3–4× under a fixed write
rate. It does not remove the per-group serial O(N) limit (still diverges at
n=1000), but it is a real fan-out win — the opposite of what the confounded
t3 Accepted/sec metric said (677 → 67/s). It was nevertheless **parked at the
time (not merged then)**: the t4 harness uses **in-process subscribers**, so a
**production-shaped fan-out measurement** (real SSE sockets) gated
re-landing. The original park cited the t3 Accepted/sec regression
(677 → 67/s), which is confounded; the hoist is now **superseded by coalesced
delivery** (#509, below), which encodes once per group _and_ collapses the
N×A messages.

### Coalesced fan-out delivery (#485, merged in #509)

The deeper #4 shape change is **merged**. `GroupServer` encodes **one `data`
frame per Action once**, concatenates the committed range's frames into **one
binary**, and pushes that same reference-counted binary to every subscriber —
N casts per batch instead of N×A, and one parent message per subscriber per
batch. `SSEHandler` writes those bytes in a single `chunk/2`. **Wire bytes
are identical** (SSE is a byte stream, so one multi-event chunk equals many
chunks), so there is **no protocol or client change**.

Back-to-back A/B with **lean** subscribers (`--subscriber-lean`), n=1000, t4,
batch 100, `hot`, 2-Update, `--duration 25 --warmup 5 --concurrency 1`. Before
= pre-coalescing lib (before #509), after = coalesced (#509), both on the
lean subscriber:

| config            |  delivered/s pre → coal |   util pre → coal | commit→broadcast p50 pre → coal (µs)                               |
| ----------------- | ----------------------: | ----------------: | ------------------------------------------------------------------ |
| r=300 (need 300k) |   177,778 → **302,756** |  43.8% → **7.5%** | 2,244,930 / 6,258,054 / 9,488,254 → **32,430 / 31,634 / 27,522**   |
| r=1000 (need 1M)  | 170,408 → **1,000,705** | 43.8% → **24.2%** | 4,110,325 / 12,180,802 / 18,527,554 → **31,720 / 25,787 / 27,375** |

**The earlier "+2–22% delivered, ceiling not removed" was artifact-capped on
both arms.** The shared bench subscriber capped the pre-coalescing and
coalesced arms at ~140k deliveries/s, hiding the real pre-coalescing cap
(~175k/s, the `GroupServer`'s N×A loop) and the coalesced one (≥1M). With the
artifact removed, coalescing is a **~6× delivered-throughput win and ~6× less
CPU**, plus a pre-#583 commit → broadcast complete p50 of **~30 ms versus
multi-second** (the re-based and attributed number is in
[Fan-out latency breakdown](#fan-out-latency-breakdown-583)).

New n=1000 keep-up (coalesced, lean):

|    r | need | delivered/s | % need |
| ---: | ---: | ----------: | -----: |
|  300 | 300k |     302,756 |   101% |
| 1000 |   1M |   1,000,705 |   100% |
| 3000 |   3M |   1,616,299 |    54% |

The old "knee at ~100k deliveries/s" was the shared subscriber; with the
artifact gone the coalesced n=1000 knee is **~1M deliveries/s**, between
r=1000 (keeps up) and r=3000 (54% of need).

**Findings.**

1. **Latency: pre-#583 commit → broadcast p50 falls from multi-second to ~30 ms.** With
   lean subscribers, coalesced p50 is 32,430/31,634/27,522 µs at r=300 and
   31,720/25,787/27,375 µs at r=1000, against 2,244,930/6,258,054/9,488,254 µs
   and 4,110,325/12,180,802/18,527,554 µs pre-coalescing. A real,
   wire-compatible UX win.
2. **Delivered throughput: ~6×.** 177,778 → 302,756 at r=300 and 170,408 →
   1,000,705 at r=1000, i.e. the server reaches 100% of need at 1M
   deliveries/s once the harness artifact is gone.
3. **CPU: ~6× less** — utilization 43.8% → 7.5% (r=300) and 43.8% → 24.2%
   (r=1000). The coalesced arm still splits each chunk into per-Action frames
   to count deliveries, so the win is if anything conservative.
4. **The message-level ceiling is removed; the real ceiling is ~1–1.6M
   deliveries/s and still non-CPU.** Coalescing removes the `GroupServer`'s
   serial N×A cast loop that was the pre-coalescing cap (~175k/s); the resource
   limit that remains is non-CPU and configuration-dependent (see below).
5. **Production-shaped measurement still outstanding.** Both t3 and t4 use
   in-process subscribers, so these fan-out numbers are not yet
   production-representative — that remains the outstanding gate.

**Verdict: MERGE.** Measured win, wire bytes identical, 811 tests green. It
subsumes and supersedes the encode-once hoist (which shaved the per-subscriber
encode but left N×A messages); the original park cited the t3 Accepted/sec
regression, which is confounded, and coalescing supersedes the hoist, so the
hoist is now history. The remaining ceiling is **non-CPU at ~1.6M deliveries/s
and ~40% utilization** (see the harness-artifact table above), so the next step
is re-probing it with the lean harness rather than reducing bytes; sharding
`GroupServer`s was tested and ruled out below. The production-shaped (real SSE
socket) measurement was **not** performed: both t3 and t4 use in-process
subscribers, so these fan-out numbers are not yet production-representative —
that remains the outstanding gate.

### Group sharding (K GroupServers per group) — tested, no effect (prototype reverted)

An earlier prototype, not merged, sharded a group's fan-out across K
`GroupServer` processes — subscribers hashed across `{group_id, shard}`
registry keys, default K=1 — so one hot group's dispatch could run on K
processes. It was **reverted** after the sweep below: it changes the registry
key and the subscription shape for zero measured benefit.

```sh
mix bench.actions --tier t4 --rate R --group-shards K --subscribers N --duration 25 \
  --warmup 5 --concurrency 1 --batch-size 100 --updates-per-action 2 --distribution hot
```

K sweep at n=1000, r=300 (need 300,000 deliveries/s):

|   K | achieved write/s | delivered/s |  util | p50 buckets (µs)                 |
| --: | ---------------: | ----------: | ----: | -------------------------------- |
|   1 |              160 |     140,563 | 40.0% | 62,112 / 1,718,634 / 3,946,855   |
|   2 |              168 |     139,534 | 40.3% | 145,751 / 5,020,573 / 8,905,702  |
|   4 |              220 |     139,866 | 40.8% | 130,564 / 5,656,838 / 10,191,213 |
|   8 |              216 |     137,747 | 40.2% | 172,374 / 5,145,582 / 7,513,349  |

Delivered/s is **flat across K** (139–141k); utilization is flat at ~40%; p50
does **not** improve — later buckets get worse, partly because
`ebb.fanout.push_latency_ms` now emits one sample per batch per shard. At
n=1000/r=100 delivered is flat too (100,607 K=1 vs 100,347 K=4) though the
first-bucket p50 drops (96,517 → 14,095 µs); at r=150 delivered is flat
(129,767 vs 126,977).

**Conclusion: the `GroupServer` is not the current bottleneck.** After
coalescing its per-batch work is one cast per subscriber of a shared binary;
sharding it changes nothing. This sweep was measured on the **coalesced** code,
where the `GroupServer`'s N×A cast loop is already gone; _pre_-coalescing that
loop was the real cap (~175k/s), so sharding might have helped before
#509 — moot now. The sweep also ran with the **shared** subscriber, so its
flat delivered/s sits on the ~140k harness cap; the K=1/2/4/8 comparison is
still valid because every arm shares that cap.

**The ~140k ceiling was the harness, not configuration.** The pre-lean table
here read ~140–166k deliveries/s at 30–40% utilization and moved with
subscriber count; with `--subscriber-lean` the same box reaches **~1–1.6M
deliveries/s** (n=1000, r=1000: 1,000,705/s at 24%; n=1000, r=3000:
1,616,299/s at 40%; n=100, r=10000: 977,731/s at 31% — see the corrected lean
ceilings in the t4 section above), with `dispatched/s` equal to `delivered/s`.
The remaining ceiling is **~1.6M/s at ~40% CPU and still non-CPU**; candidates
are the single-process `FanOutRouter` (`push_gsn_range` reads and
`binary_to_term`s each Action) and the per-subscriber `SSEConnection` → parent
hop, re-probed with the lean harness.

**What this rules out:**

- sharding `GroupServer`s to raise the fan-out ceiling (this sweep);
- subgroups as a _parallelism_ fix, for the same reason — they would not have
  helped either;
- CPU saturation as the near-term fan-out limit at these rates.

Where the ~140k ceiling came from is **now understood**: it was the bench
subscriber's shared counter and ETS lag table, fixed by `--subscriber-lean`
(#510, see the harness-artifact table). The real ceiling (**~1.6M/s at
~40% CPU**) is still **non-CPU**, so the next step is a **lean-harness re-probe
with profiling** of the single Router and the per-subscriber hop.

## Fan-out latency breakdown (#583)

[#583](https://github.com/ebbjs/ebbjs/issues/583) splits the fan-out sample
into named hops so the number can be attributed and regressed. It also
re-bases `ebb.fanout.push_latency_ms` from the end of the post-commit apply
(the fan-out notify send) instead of the top of `apply_one/2`, so the
write-side `apply` phase is no longer inside the fan-out sample. The
write-side hand-off remains #537's `notify` phase in
`ebb.writer.flush_phase_ms`; the hop table below shows it as context, not as
part of the sum.

Each `ebb.fanout.hop_ms` sample is one range per hop (one range per group for
the group hops). `router_queue` is Writer send → Router entry;
`router_dwell` is time held in `Plan` for the watermark and is emitted only
when a range actually waits; `router_decode` is the RocksDB range read, ETF
decode, and group split; `group_queue` is Router cast → GroupServer entry;
`group_encode` is the frame build; `group_cast` is the GroupServer's
per-subscriber cast loop; `conn_deliver` is one sampled subscriber's cast →
SSEConnection → parent `send/2` return. The server-side end of
`conn_deliver` is the parent send, not the SSE handler's `chunk/2`, so these
are still in-process-subscriber numbers, not real-socket numbers.

Measured **2026-10-28** on `recsy-vps` (the environment table above), t4 with
the lean subscriber, batch 100, 2-Update Actions, `hot`, 25 s measured window
after 5 s warmup. `--conn-sample-rate 100` samples 1 delivery in 100 for the
per-subscriber hop; the other hops are not sampled.

```sh
mix bench.actions --tier t4 --rate R --subscribers N --duration 25 \
  --warmup 5 --concurrency 1 --batch-size 100 --updates-per-action 2 \
  --distribution hot --subscriber-lean --conn-sample-rate 100
```

|    N |     R |  push p50 / p95 | router_queue | router_dwell | router_decode | group_queue | group_encode | group_cast | conn_deliver (sampled) | sum p50 |      Δ |
| ---: | ----: | --------------: | -----------: | -----------: | ------------: | ----------: | -----------: | ---------: | ---------------------: | ------: | -----: |
|    1 |   100 |   3,232 / 4,819 |           45 |            0 |         1,227 |         269 |        1,356 |         18 |                     16 |   2,915 |  −9.8% |
|    1 |  1000 |   2,727 / 4,058 |           43 |            0 |         1,211 |         247 |        1,102 |         17 |                     12 |   2,620 |  −3.9% |
|    1 | 10000 |   2,663 / 3,908 |           37 |            0 |         1,183 |         230 |        1,051 |         13 |                     10 |   2,514 |  −5.6% |
|   10 |  7000 |   2,933 / 4,968 |           37 |            0 |         1,398 |         236 |        1,067 |         30 |                     33 |   2,768 |  −5.6% |
|  100 |  1000 |   4,015 / 6,038 |           42 |            0 |         1,173 |         243 |        1,312 |        676 |                    503 |   3,446 | −14.2% |
| 1000 |  1000 | 31,068 / 43,261 |           42 |            0 |         1,365 |         224 |        1,318 |     27,569 |                  7,831 |  30,518 |  −1.8% |

All values are µs. `Sum` is `router_queue + router_dwell + router_decode +
group_queue + group_encode + group_cast`; `conn_deliver` is excluded because
it is per subscriber and can outlive the push sample. The t4 n=1000 r=1000
row is the acceptance target: its hops sum to the end-to-end p50 within
**1.8%**. `group_cast` is a directly measured span (end of encode → the last
subscriber cast being enqueued), not a remainder. The sum balances when one
group receives a range, which is the t4 shape; with several groups the
group-scoped hops repeat per group while the range-scoped hops do not. The
n=100 row is −14.2% because a sum of per-hop p50s is not the p50 of the sum
when the hop distributions differ; that row is still fully attributed, not
residual.

Headline hop tails at t4 n=1000 r=1000 (the same run as the last row):

| Hop             | Samples |    p50 |    p95 |    p99 |
| --------------- | ------: | -----: | -----: | -----: |
| `router_queue`  |     250 |     42 |     72 |     82 |
| `router_dwell`  |       0 |    n/a |    n/a |    n/a |
| `router_decode` |     250 |  1,365 |  3,142 |  4,031 |
| `group_queue`   |     250 |    224 |    381 |    472 |
| `group_encode`  |     250 |  1,318 |  2,103 |  2,309 |
| `group_cast`    |     250 | 27,569 | 39,805 | 43,497 |
| `conn_deliver`  |   2,500 |  7,831 | 19,336 | 23,480 |

### The floor and what the ~30 ms is made of

The n=1 floor is **~2.7 ms** across r = 100, 1000, 10000, and it barely moves
with write rate. The per-subscriber component at n=1000 is therefore bounded
by subtraction: **~28.4 ms**, not assumed.

At n=1000 the Router side is small and flat: `router_queue` 42 µs,
`router_decode` 1.37 ms, `group_queue` 224 µs, `group_encode` 1.32 ms. The
**`group_cast` hop is 27.6 ms of the 31.1 ms total (89%)** and accounts for
97% of the n=1 → n=1000 increase. The serial per-subscriber cast loop, not
the Router read/decode and not the frame build, is what the ~30 ms buys at
this shape. That also makes #584 (Router read + decode) worth ~1.4 ms here,
not the headline cost; its value is in the shapes where the Router has a
backlog.

`router_dwell` was **0 samples in every run**: the Writer notifies after the
durable mark and t4 paces writes, so the Router never held a range for the
watermark. It remains instrumented because a deeper or recovered shape can
hold one; a claim-order test pins that path.

**Next step for the dominant hop (stated, not taken here):** profile the
`group_cast` loop directly at fixed deliveries/sec while varying N. The
candidates are the cost of 1,000 separate sends of one shared binary per
range (refcount and scheduler migration) and the single GroupServer process
serialising them. Group sharding was measured before under the shared
subscriber, whose ~140k/s cap hid any difference; re-test it with the lean
subscriber before changing the dispatch design. This issue does not change
fan-out behaviour.

### Measurement integrity

The same t4 n=1000 r=1000 shape was run in three alternating pairs against
the uninstrumented `main` build, each pass a fresh boot. Uninstrumented p50:
**27,085 / 29,718 / 29,687 µs** (median 29,687); instrumented p50:
**29,302 / 29,137 / 28,429 µs** (median 29,137, **−1.9%**). The uninstrumented
p95s were 39,315 / 38,388 / 40,595 µs and the instrumented p95s 43,344 /
41,799 / 42,110 µs, at the edge of this machine's pass-to-pass spread. With
`--conn-sample-rate 0` the instrumented p50 was **28,798 / 29,573 µs**, so the
hop timers themselves do not move the sample; the remaining tail is the
sampled `conn_deliver` path. The uninstrumented timer starts earlier (at the
top of `apply_one/2`, including the write-side apply), so the re-based p50
should read slightly lower, not higher. The first harness version called `:rand.uniform/1` once per
subscriber for the 1-in-K decision; that alone moved p50 by ~12 ms at
n=1000. The final selector draws one offset per batch and then strides, so
the measurement does not perturb the loop it measures. `conn_deliver`
defaults to 1 delivery in 100 and `--conn-sample-rate 0` turns it off
entirely. No hop adds a `GenServer.call` or a new message.

## Writer batch coalescing (#332)

[#332](https://github.com/ebbjs/ebbjs/issues/332) coalesces concurrent
`Writer.write_actions/1` calls that land in the same mailbox burst into one
`write_batch` and one GSN range, replying to each caller with its own
contiguous sub-range. Defaults are `:writer_batch_max_size` 1000 and
`:writer_batch_timeout_ms` 0 (burst-drain, no added uncontended latency).

Same machine (`recsy-vps`, 4 schedulers), same command, before and after the
change, with three to four runs per side because this VM's run-to-run spread
is ±5%:

```sh
mix bench.actions --tier t2 --duration 120 --warmup 5 --concurrency 8 \
  --batch-size 100 --updates-per-action 2 --distribution hot
```

| Side   | Steady /s                         | Median | Overall /s                        | Median |
| ------ | --------------------------------- | -----: | --------------------------------- | -----: |
| before | 14,673 / 15,256 / 14,746          | 14,746 | 14,966 / 15,139 / 14,824          | 14,966 |
| after  | 15,764 / 14,466 / 14,910 / 14,690 | 14,800 | 15,948 / 14,662 / 15,017 / 14,761 | 14,889 |

The headline config is **flat** (+0.4% median steady, −0.5% overall). This is
not a coalescing failure: the Writer's watermark high-water jumps from 100 to
~500–600 GSNs, i.e. five to six `write_actions` calls now share one commit.
The per-commit fixed cost is simply small next to the per-Action work at
batch 100 — `:scheduler.utilization` sits at ~19%, so the single Writer
saturates one scheduler while three sit idle, and merging commits cannot move
a per-Action-bound rate. Forcing a wider window confirms the direction:
`:writer_batch_timeout_ms = 5` (batches of ~800) drops steady throughput to
12,585/s, because the added latency is not repaid at this batch size.

The win is where the per-commit fixed cost dominates the per-Action cost —
small batches:

```sh
mix bench.actions --tier t0 --duration 30 --warmup 3 --concurrency 8 \
  --batch-size 1 --updates-per-action 2 --distribution hot
```

| Run            | Before /s | After /s |  Change |
| -------------- | --------: | -------: | ------: |
| t0 batch 1     |     1,152 |    3,600 | +212.5% |
| t0 batch 1 p50 |    6.5 ms |   2.1 ms |       — |

Every run: 0 rejected Actions, 0 GSN holes, final watermark lag 0. The
sub-range mapping is what keeps the benchmark honest — `runner.ex` counts
`gsn_end - gsn_start + 1` per call, so a caller must never be handed the whole
coalesced range.

**Verdict.** Coalescing cuts commit count ~5–6× and roughly triples direct
batch-1 write throughput, with no durability, ordering, or GSN semantics
change. It does **not** raise the batch-100 headline rate: that rate is bound
by per-Action Elixir work on a single scheduler, not by per-commit overhead.
Raising it needs the per-Action work spread across schedulers (or
multi-Writer, [#287](https://github.com/ebbjs/ebbjs/issues/287)) rather than
larger batches.

## Writer write amplification: drop `cf_updates` (#338)

`cf_updates` was a write-only column family: the `Writer` emitted one row
per Update, but every reader takes updates from the `cf_actions` value
(materialization, fan-out, catch-up).
[#338](https://github.com/ebbjs/ebbjs/issues/338) stops writing it and
removes the family. For the canonical 2-Update Action that is one fewer
`batch_put` and one fewer ETF encode per Update: **bytes/Action 1,585 →
932 (−41%), ops/Action 10 → 8**.

Same machine, headline config, one 120s run per side on the same base
(measured before #332 landed; coalescing and write-amplification removal
target different costs):

| Tier | Window           | Before /s | After /s | Change |
| ---- | ---------------- | --------: | -------: | -----: |
| t0   | steady (61–120s) |    17,139 |   19,466 | +13.6% |
| t0   | overall          |    17,334 |   20,279 | +17.0% |
| t2   | steady (61–120s) |    15,937 |   18,605 | +16.7% |
| t2   | overall          |    16,282 |   19,137 | +17.5% |

All four runs: 0 rejected Actions, 0 GSN holes, final watermark lag 0.

## Writer write amplification: dedup per-flush index writes (#339)

Within one coalesced flush the `Writer` emitted byte-identical index puts:
`cf_type_entities` once per Update even when the `(subject_type,
subject_id)` key repeated across Actions, and `cf_group_actions` could write
the same `(group_id, gsn)` row twice within one Action when a `todo` update
and its `entityGroup` update resolved to the same group.
[#339](https://github.com/ebbjs/ebbjs/issues/339) collects the
`cf_type_entities` keys in a per-flush set and emits the `cf_group_actions`
rows from the per-Action group union: **ops/Action 8 → 5.02** for the
canonical hot 2-Update Action at batch 100 (measured with a counting
`commit_fn`; the residual 0.02 is the two unique type-index keys amortised
across the batch).

Same machine, t0 headline config, one 120s run per side (the base already
includes #338):

| Tier | Window           | Before /s | After /s | Change |
| ---- | ---------------- | --------: | -------: | -----: |
| t0   | burst (0–15s)    |    21,267 |   24,413 | +14.8% |
| t0   | steady (61–120s) |    20,553 |   22,827 | +11.1% |
| t0   | overall          |    20,779 |   23,607 | +13.6% |

Both runs: 0 rejected Actions, 0 GSN holes, final watermark lag 0. Three
short 20s A/B runs agreed on the direction and size (median overall 20,485 →
24,335, +18.8%).

## Writer op-building allocation: drop `List.flatten`, memoize group resolution (#340)

`build_ops/3` carries three allocation hot spots in the coalesced b100
profile: `List.flatten/1` over the flush's op lists (~3.6%), repeated
`EntityIndex.resolve_groups/3` per Update (~4.6%), and the Action/Update
ETF encode (~9.7%). [#340](https://github.com/ebbjs/ebbjs/issues/340)
takes the first two; the duplicate Update encode was already removed with
`cf_updates` in [#338](https://github.com/ebbjs/ebbjs/issues/338).

- the flush op list is assembled with `:lists.append/1` instead of
  `List.flatten/1` (same swap inside `build_action_ops/5`);
- the cache-only group resolution is memoized per subject (`subject_type`
  plus `subject_id`) across one flush, with each Action's intra-action
  membership unioned on top through `EntityIndex.apply_intra_action/3`.
  The system caches are not mutated during `build_ops`, so a flush sees
  one snapshot; keying on the full subject identity (not just the id)
  keeps a `"relationship"` or `"entityGroup"` lookup from answering a
  user entity that happens to share the id.

The flatten swap is a direct win: assembling the same 100-Action, 5-op
list 20,000 times takes `:lists.append/1` 678,792 µs against
`List.flatten/1` 764,419 µs (−11%).

Measured on a build-path harness (isolated `Writer` with a no-op
`commit_fn`, canonical 100-Action hot flush, 400 iterations, three runs
per side), allocated words per Action fall **719 → 694 (−3.4%)** while
wall time per flush is flat (~1.70 ms both sides). On the real t0
headline config the rate is unchanged — median overall **19,933/s →
19,893/s** over three 30s runs per side (this VM's run-to-run spread is
±5%, and `:scheduler.utilization` sits at ~12.7% both sides), with 0
rejected Actions and 0 GSN holes. The `spread` distribution pays ~+5%
allocated words for the memo map, which never hits there, but that path
is ~17× slower and is not the headline. (`:eprof`'s `:tools` application
is not on this VM's mix code path, so the `build`-share wording in #340
is checked against the allocation counter rather than a sampled share.)

**Verdict.** Both named allocators are gone and build-path allocation
drops ~3%, but that is small next to the per-Action ETF encode and the
durable write, so the t0 headline does not move. The single-Writer
ceiling is still per-Action-bound; spreading op building across
schedulers is [#336](https://github.com/ebbjs/ebbjs/issues/336).

## Two-store-only cost breakdown (#485)

[#485](https://github.com/ebbjs/ebbjs/issues/485) measures how much of
the flush critical path is the durable log append versus the
**two-store-only** bookkeeping a collapsed materialized store would
remove. The `--ablate <phases>` seam (#510) skips named
phases of the write path — `dedup, group_resolution, build, encode,
entity_actions, type_entities, entity_index, group_index, dirty, cache,
watermark, fanout` (comma-separated; `entity_index` is the combined alias for
`entity_actions` + `type_entities`). `build` and `encode` were added by
[#532](https://github.com/ebbjs/ebbjs/issues/532) to price the pre-claim
payload work; the tables below predate those phases and were measured
before they existed.

```sh
mix bench.actions --tier t0 --duration 20 --warmup 5 --concurrency 1 \
  --batch-size 100 --updates-per-action 2 --distribution hot \
  --ablate <phases>
```

### Additive ladder — median of 3 × 20s runs

Phases enabled (= not ablated):

| Step (phases enabled, = not ablated)          | Actions/s | µs/Action | ms/flush (100 Actions) |
| --------------------------------------------- | --------: | --------: | ---------------------: |
| log only (only `cf_actions` write)            |    52,555 |     19.03 |                  1.903 |
| + dedup                                       |    49,110 |     20.36 |                  2.036 |
| + group resolution, entity index, group index |    32,950 |     30.35 |                  3.035 |
| + dirty marks                                 |    33,365 |     29.97 |                  2.997 |
| + cache mutations                             |    31,580 |     31.67 |                  3.167 |
| + watermark bookkeeping                       |    26,415 |     37.86 |                  3.786 |
| + fan-out notify (= full flush)               |    25,765 |     38.81 |                  3.881 |

### Marginal cost — ablate one phase from the full flush, median of 3 × 15s runs

| Phase ablated                                           | Actions/s | ms/flush |   marginal cost (ms/flush) |
| ------------------------------------------------------- | --------: | -------: | -------------------------: |
| (none = full)                                           |    26,587 |    3.761 |                          — |
| dedup                                                   |    26,727 |    3.741 |                      ~0.02 |
| group_resolution                                        |    28,173 |    3.550 |                       0.21 |
| entity_index (`cf_entity_actions` + `cf_type_entities`) |    32,173 |    3.108 |                   **0.65** |
| group_index (`cf_group_actions`)                        |    28,467 |    3.513 |                       0.25 |
| dirty                                                   |    26,613 |    3.758 |                      ~0.00 |
| cache                                                   |    27,840 |    3.592 |                       0.17 |
| watermark                                               |    30,360 |    3.294 |                   **0.47** |
| fanout                                                  |    25,393 |    3.938 | not resolvable (±5% noise) |

`fanout` is the one phase whose marginal sits inside this VM's ±5%
run-to-run spread (removing it measured _slower_ than the full run); the
additive ladder above bounds it at ~0.09 ms/flush (3.786 → 3.881 ms).
Scheduler utilization across the ladder runs from **4.5% (log-only) to
~10% (full)** on the 4-scheduler VM.

**Conclusion.** The durable log append floor is **1.903 ms/flush**, about
**50%** of the full 3.881 ms flush. Every two-store-only piece together
is the other **~1.98 ms (51%)**. Removing **all** of it is a **2.04×**
ceiling on t0 (52,555 / 25,765). `entity_index` (0.65 ms) and
`watermark` (0.47 ms) are the two largest single pieces; `dirty` marks
are unmeasurable at `hot` because the dirty set stays at 4 (the dirty-set
cost is O(affected entities), so `hot` understates it — the t0 `spread`
run's dirty set grows to ~1.16M).

## Concurrent `write_batch` from multiple BEAM processes (#530, extended)

Gating spike for epic [#529](https://github.com/ebbjs/ebbjs/issues/529). The
question was whether `:rocksdb.write_batch/3` can be called concurrently from
independent BEAM processes and actually overlap, or whether the NIF / RocksDB
serializes them. The NIF registers `write_batch` as
`ERL_NIF_DIRTY_JOB_IO_BOUND` and calls `DB::Write` directly, with no
per-database lock; the only serialization is RocksDB's own write thread.
The source trace is in
[`docs/research/530-concurrent-write-batch.md`](../../docs/research/530-concurrent-write-batch.md).

Measured with the `--tier t5` harness. Each caller is one BEAM process; caller
`i` writes a disjoint, contiguous 100-GSN range per call and each call commits
the production-shaped 100-Action × 2-Update batch (502 `cf_*` puts for `hot`;
~700 for `spread`). Batch assembly (`Workbook` → action validation → ETF →
`batch_put`) happens before the timer, so the latency columns are the raw
`:rocksdb.write_batch/3` call; the rate column is wall Actions/sec and includes
assembly. `enable_pipelined_write: true`, `max_background_jobs: 4`, fresh temp
DB, 20 s measured window after 3 s warmup, median of 5 runs, min–max across
those runs. Extended **2026-10-21** from the original K = 1/2/4 sweep out to
K = 16, and with an op-set arm that drops op groups from the batch (see below);
the K = 1 and async K = 2/4 rows are the 2026-10-19 session, the rest are
2026-10-21, and the shared K = 2 sync row reproduces to within 1.6%.

```sh
# commit-leg scaling
mix bench.actions --tier t5 --concurrency 8 --duration 20 --warmup 3 \
  --batch-size 100 --updates-per-action 2 --distribution hot --durability sync

# the cheapest durable write an Action can have: cf_actions only
mix bench.actions --tier t5 --concurrency 8 --duration 20 --warmup 3 \
  --batch-size 100 --updates-per-action 2 --distribution hot --durability sync \
  --ablate dedup,entity_index,group_index
```

### Scaling the commit leg

| Callers | `sync` | Actions/sec (median) |           Range | write_batch p50 |      p95 | Scheduler util |
| ------: | :----- | -------------------: | --------------: | --------------: | -------: | -------------: |
|       1 | true   |               41,825 |   30,875–42,315 |         1.38 ms |  1.82 ms |           5.2% |
|       2 | true   |               74,625 |   73,755–75,515 |         1.39 ms |  2.50 ms |          10.2% |
|       4 | true   |               82,470 |   81,025–83,980 |         3.23 ms |  5.70 ms |          14.1% |
|       8 | true   |           **90,240** |   88,750–91,550 |         7.06 ms | 10.90 ms |          16.7% |
|      16 | true   |           **92,040** |   90,420–93,600 |        15.49 ms | 21.33 ms |          16.1% |
|       1 | false  |               61,885 |   61,575–63,645 |         0.59 ms |  0.77 ms |           7.9% |
|       2 | false  |               98,420 |  92,775–103,165 |         0.66 ms |  1.41 ms |          14.0% |
|       4 | false  |              116,800 | 114,695–119,210 |         1.40 ms |  4.08 ms |          22.4% |
|       8 | false  |          **124,720** | 122,020–125,095 |         3.82 ms |  8.92 ms |          29.6% |
|      16 | false  |          **128,100** | 126,350–130,845 |         8.53 ms | 15.99 ms |          35.6% |

**The commit leg saturates at ~92k Actions/s with `sync: true` and ~128k with
`sync: false`.** The knee is at four callers: K = 8 buys 9% over K = 4 for
2.2× the per-call latency, and K = 16 buys another 2% for another 2.2×. Past
the knee this is write-thread queueing plus background flush/compaction, not
the NIF. The `sync: false` arm shows the same shape at 1.4× the rate, so fsync
is ~28% of the saturated path but not what sets the ceiling.

### What an Action costs to store

`--ablate` on `t5` drops op groups from the committed batch (it names no
Writer phases there). K = 8, `sync: true`, same workload:

| Op set                  | puts / 100-Action batch | Actions/sec | vs full | write_batch p50 |
| :---------------------- | ----------------------: | ----------: | ------: | --------------: |
| full (five CFs)         |                     502 |      90,240 |   1.00× |         7.06 ms |
| − `dedup`               |                     402 |      92,855 |   1.03× |         6.86 ms |
| − `group_index`         |                     402 |      94,440 |   1.05× |         6.84 ms |
| − `entity_index`        |                     302 |     110,205 |   1.22× |         6.01 ms |
| log only (`cf_actions`) |                     100 | **132,275** |   1.47× |         4.99 ms |
| log only, `sync: false` |                     100 | **219,405** |   2.43× |         1.76 ms |

and the log-only arm's own scaling: K = 2 → 102,240 (1.26 ms), K = 4 →
124,535 (2.30 ms), K = 8 → 132,275 (4.99 ms), K = 16 → 132,430 (10.83 ms), so
it knees at K = 8 and adds nothing after.

Three things follow. First, **a `cf_actions`-only batch with two committers
(102,240/s) already beats the full five-CF batch with sixteen (92,040/s)** —
the stored shape of an Action, not the number of committers, is what caps the
durable write. Second, the costs are super-additive: the three op groups
individually give +3%, +5% and +22%, but removing all of them gives +47%,
because per-batch bytes and memtable work fall together. Third, `cf_entity_actions`
(2 of the 5 puts per Action) is the single most expensive piece of the stored
shape by a wide margin, which matches the Writer-side ablation ladder, where
`entity_index` is the second largest phase of the flush (0.67 ms of 3.63 ms).

The `spread` distribution (same Actions, ~700 puts a batch) lands at 78,835/s
at K = 8 sync and 72,705/s at K = 4, i.e. +39% ops/bytes costs ~13%
throughput. Fitting hot against spread puts the serialized cost of a put at
~0.8 µs, which is what the log-only row above then measures directly.

### Verdict

Go for #531, unchanged: the NIF does not serialize callers, and two sync
callers give **1.81×** wall throughput with a flat per-call p50, which is what
the committer pool needs. The extension adds the ceiling: **~7.2× on one
caller to ~92k sync**, and the shape of the curve says to choose K at the knee
(4) and stop — every caller past it trades ~2× latency for <10% throughput.

For the wider epic, the useful bound is that the full-op-set sync path cannot
carry more than ~92k Actions/s even with no Writer at all, so any target above
that requires changing what an Action stores (drop or derive the secondary
CFs, `entity_index` first) or relaxing durability. See the pipeline-depth
section for what the Writer itself costs on top, and the latency consequence:
at the K = 8/16 rows the per-commit p50 is 7–15 ms, so throughput bought by
queueing shows up as p50/p99 in every client.

Caveats, unchanged: the `t5` path bypasses the Writer, so its caches,
watermark, and fan-out stay idle (the storage tree still boots to open the DB
and seed the bench context). Its GSNs are synthetic (`1e9 × caller`) and its
holes/lag are reported `n/a`; the peak-dirty row is Workbook seed residue, not
a t5 signal. The rate includes per-call batch assembly (normal schedulers), so
do not compare it directly to `t0`/`t2`. The original K = 1 sync run (30,875/s)
was cold; the other four were 41,150–42,315/s, and the median is robust to it.

## Sequencer + committer A/B (#531)

V0 of the [#529](https://github.com/ebbjs/ebbjs/issues/529) pipeline moved
the immutable half of the flush — `to_storage_format`, ETF encode, `cf_*`
op assembly, `write_batch` — onto a linked Committer process. The Writer
stays the sequencer (coalescing, dedup, GSN claim, group resolution,
provisional dirty marks, apply, watermark, notify, reply) and allows
exactly one in-flight commit. Measured **2026-10-19** on `recsy-vps`, with
the branch and `origin/main` (`366cf9c`) benchmarked alternately on the
same host, fresh temp DB, `sync: true`, 15 s window after 3 s warmup,
2-Update Actions, `hot`, batch 100. Each throughput arm is the median of
3–4 alternating runs (t0 baseline 3, t0 branch 4, t2 baseline 3, t2
branch 4); the range is in parentheses. The ablate-all check is two 10 s
runs per side. The raw reports are the gitignored
`bench/results/531-{base,after}-*.md` files from that measurement.

```sh
mix bench.actions --tier t0 --duration 15 --warmup 3 --concurrency 1 \
  --batch-size 100 --updates-per-action 2 --distribution hot --durability sync
mix bench.actions --tier t2 --duration 15 --warmup 3 --concurrency 8 \
  --batch-size 100 --updates-per-action 2 --distribution hot --durability sync
```

| Tier     | `origin/main` Actions/sec |  Sequencer + committer | Delta |
| :------- | ------------------------: | ---------------------: | ----: |
| t0 (c=1) |    25,433 (22,573–26,473) | 24,003 (22,367–24,187) | −5.6% |
| t2 (c=8) |    19,900 (18,147–20,827) | 18,380 (17,547–19,087) | −7.6% |

Server-side `ebb.writer.batch_latency_ms` p50 rose from **17.5 ms** to
**19.4 ms** at t2. The new `ebb.writer.commit_latency_ms` attributes
**7.5 ms** of that flush (p50) to the Committer's build + encode +
`write_batch`; the rest is the sequencer. Both arms had 0 rejected
Actions, 0 write/transport errors, and 0 GSN holes; the final watermark
lag was 0 and the high-water mark stayed bounded by one burst.

The gap is the seam's own cost, not a rocksdb effect. With every bench
phase ablated (`--ablate all`, so the batch is one `cf_actions` put),
t0 fell from 53,645 to 50,235 Actions/sec (−6.4%): one extra process
hand-off and one extra copy of the prepared payload per flush. V0 cannot
recover that cost because the only work it overlaps is enqueueing; the
sequencer still cannot begin the next batch's group resolution until the
current batch's cache mutations have applied (#529 Invariant 7), so the
serial critical path is unchanged. The Phase-1 win in #529 needs the
cross-flush overlay (#533) and the ordered apply/notify stage (#534),
not the single-committer seam alone.

## GSN-free Action payload + pre-encode (#532)

V1 of the [#529](https://github.com/ebbjs/ebbjs/issues/529) pipeline makes
the stored `cf_actions` value GSN-independent and moves the payload build
and ETF encode before the claim. A new record is

```text
term_to_binary({payload_etf, update_scopes})
payload_etf = term_to_binary(%{"id", "actor_id", "hlc", "updates"})
```

so the GSN lives only in the `cf_actions` key; readers inject it after
decode. Legacy plain-map records still decode, so a database holding both
shapes reads uniformly and a rollback to an older reader still sees its
own records. The Writer builds and encodes each call's payload on arrival —
while the previous commit is in flight — and the Committer only wraps that
ETF with the cache-derived scopes at claim time (a binary copy, not a map
traversal).

Measured **2026-10-19** on `recsy-vps`, same host and temp-DB setup as the
#531 run: 15 s window after 3 s warmup, 2-Update Actions, `hot`, batch 100,
`sync: true`. Each arm is the median of 11 alternating runs, min–max in
parentheses. The pre-#532 arm is `origin/main` at `662b585` (which already
contains #531).

```sh
mix bench.actions --tier t0 --duration 15 --warmup 3 --concurrency 1 \
  --batch-size 100 --updates-per-action 2 --distribution hot --durability sync
mix bench.actions --tier t2 --duration 15 --warmup 3 --concurrency 8 \
  --batch-size 100 --updates-per-action 2 --distribution hot --durability sync
```

| Tier     |   pre-#532 Actions/sec |  GSN-free + pre-encode | Delta |
| :------- | ---------------------: | ---------------------: | ----: |
| t0 (c=1) | 24,513 (22,087–25,260) | 24,073 (22,080–25,293) | −1.8% |
| t2 (c=8) | 19,107 (16,993–20,853) | 20,993 (13,460–21,860) | +9.9% |

**The expected 1.15–1.25× was not reached.** t0 has a single serial caller,
so there is no in-flight commit to overlap the pre-encode with: the work
still runs on the Writer's call path and the caller waits for it. The only
visible t0 change is the wrapper's extra binary copy, inside this VM's
±5–10% run-to-run spread. The t2 arm is where this slice pays: calls arrive
while the previous commit is in flight, so the sequencer builds and encodes
their payloads during the durable write. One branch t2 run sampled
13,460/s (the low end of its range); the median is robust to it. Every
headline run had 0 rejected Actions, 0 write/transport errors, and 0 GSN
holes.

### Pricing the moved work — `--ablate build,encode` (t0)

`:build` skips the payload map construction; `:encode` skips the payload
ETF encode and stores a precomputed ETF for a structurally valid empty
Action so the record stays decodable. Both arms still write the wrapper and the durable batch. Median
of 5 × 15 s runs with the run order rotated to spread host drift:

| Arm                     |    Actions/s (min–max) | ms/flush (100 Actions) | Delta vs full | Removed (ms/flush) |
| :---------------------- | ---------------------: | ---------------------: | ------------: | -----------------: |
| full                    | 24,327 (23,780–25,180) |                  4.111 |             — |                  — |
| `--ablate encode`       | 27,293 (26,380–28,327) |                  3.664 |        +12.2% |               0.45 |
| `--ablate build`        | 28,040 (27,067–29,073) |                  3.566 |        +15.3% |               0.54 |
| `--ablate build,encode` | 27,667 (27,100–28,787) |                  3.614 |        +13.7% |               0.50 |

The payload build + encode is ~0.45–0.54 ms/flush, or **12–15%** of a t0
flush. The two removals overlap and are not additive: they take similar
slices of one flush, and the single-phase arms' ordering sits inside their
ranges. This is the work V1 moves off the claimed path and overlaps with
the in-flight commit at t2. The full arm here (24,327/s) sits inside the
headline branch range, so the ablation set is consistent with the A/B
above.

The scope wrapper was chosen over a companion scopes value: it is one
atomic `cf_actions` put, while a companion adds a second durable put and a
second read on every Action. The companion variant was not built or
measured; the wrapper's claim-time cost is a binary copy plus the scopes
list and is inside `ebb.writer.commit_latency_ms`, while the ablation above
prices the payload build + encode that moved before the claim.

## Pipeline depth: N in-flight calls (#551, re-measured for the V2 gate)

> **Measured before Step 0 (2026-10-21).** Current numbers are in
> [Step 0](#step-0-depth-1-parity-579-582-581); the conclusions below still
> stand.

Harness-only workload for [epic #529](https://github.com/ebbjs/ebbjs/issues/529).
`--in-flight 1,2,4` keeps N `Writer.write_actions/1` calls outstanding per
worker instead of one, so the harness can put several batches in the Writer's
queue at once and measure whether temporal parallelism is worth anything.
Depth 1 is the original serial worker loop; a list is a sweep, and each depth
runs in its own pass against a freshly booted and seeded DB. In sweep mode the
report also measures a **t0 depth-1 baseline** (one caller, no pacing, no
subscribers) first, so the no-regression row comes from the same host and
session as the pipelined rows. `--in-flight` is rejected on `t1`/`t4` (pacing
and per-request isolation are single-producer by construction) and on `t5`
(the spike bypasses the Writer).

> **Re-measured 2026-10-21 on the current harness, after the V2 work.** Since
> #533 the bench boots the Writer with `max_in_flight = min(depth, 4)`, so a
> depth row now changes the Writer's claimed-range depth as well as the
> harness's outstanding calls. The first pass of this matrix on that harness
> also caught a Writer scheduling bug that silently dropped claimed GSN ranges
> above depth 1 — see
> [Depth > 1 lost claimed ranges](#depth--1-lost-claimed-ranges-until-the-553-scheduling-fix).
> It is fixed, and every number below is post-fix. The pre-#533 tables this
> section used to carry are superseded.

The workload uses the headline shape: batch 100, 2-Update Actions, `hot`,
`sync: true`. Measured **2026-10-21** on `recsy-vps`, 20 s window after 3 s
warmup, five reports per tier, each report containing every depth. The median
across the five passes is reported with the min–max range in parentheses; the
raw per-pass reports were the `--out` files from that measurement and are not
committed. Every run below had **0 rejected Actions, 0 write/transport errors
and 0 GSN holes**; the final watermark lag was ≤ 300 GSNs, which is the last
1 Hz sample still seeing the calls that were in flight when the window closed.

```sh
mix bench.actions --tier t0 --duration 20 --warmup 3 --concurrency 1 \
  --in-flight 1,2,4 --batch-size 100 --updates-per-action 2 --distribution hot --seed 1
mix bench.actions --tier t2 --duration 20 --warmup 3 --concurrency 8 \
  --in-flight 1,2,4 --batch-size 100 --updates-per-action 2 --distribution hot --seed 1

# The depth>1 leak (below) reproduces with live subscribers:
mix bench.actions --tier t3 --duration 20 --warmup 3 --concurrency 8 \
  --in-flight 2 --subscribers 4 --batch-size 100 --updates-per-action 2 \
  --distribution hot --seed 1
```

### t0, one caller

| Callers | Calls in flight | Actions/sec (median) |         Range | Δ vs depth 1 | p50 (ms) | p95 (ms) | p99 (ms) | Actions/flush | Flush p50 (ms) | Commit p50 (ms) | Lag high-water |
| ------: | --------------: | -------------------: | ------------: | -----------: | -------: | -------: | -------: | ------------: | -------------: | --------------: | -------------: |
|       1 |               1 |               20,320 | 19,710–20,525 |            — |     4.62 |     5.55 |     6.35 |           100 |           3.66 |            2.15 |            100 |
|       1 |               2 |           **31,015** | 30,135–31,435 |   **+52.6%** |     5.99 |     7.59 |     8.75 |           100 |           4.96 |            1.98 |            100 |
|       1 |               4 |               29,890 | 29,580–30,030 |   **+47.1%** |    12.88 |    15.46 |    17.15 |           100 |          11.82 |            2.00 |            100 |

**Depth 2 is now a real pipeline win, and it is overlap rather than cheaper
work.** The flush stays at 100 Actions at every depth (the prepare-burst marker
bounds it), and the commit leg is unchanged (2.15 → 1.98 → 2.00 ms), yet the
writer completes 310 flushes/s where a depth-1 flush occupies 3.66 ms of a
single sequencer — more than one flush's work is in flight at any moment. The
extra 100-Action flushes at depth 4 no longer bloat the batch (the old 201-Action
bloat is gone), but p50 grows 4.6 → 6.0 → 12.9 ms because a call waits behind
the flush it was coalesced into; throughput is the metric to read here.

Against the pre-#533 rows this section used to publish (22,465 / 25,765 / 23,650
with the flush bloating to 201 at depth 4): depth 1 is ~9% lower today
(20,320 vs 22,465, non-overlapping ranges, so probably a real depth-1 cost from
the #533/#534/#553 seam rather than host drift) while depth 2 is 20% higher
(31,015 vs 25,765) and depth 4 is 26% higher. That depth-1 delta deserves a
rotated A/B against a pre-#533 commit before it is quoted anywhere.

### t2, eight callers

| Run         | Calls in flight | Actions/sec (median) |         Range | Δ vs depth 1 | p50 (ms) | p95 (ms) | p99 (ms) | Actions/flush | Flush p50 (ms) | Commit p50 (ms) | Lag high-water |
| :---------- | --------------: | -------------------: | ------------: | -----------: | -------: | -------: | -------: | ------------: | -------------: | --------------: | -------------: |
| t0 baseline |               1 |               20,430 | 18,605–21,545 |            — |     4.62 |     5.61 |     6.35 |           100 |           3.66 |            2.14 |            100 |
| t2 pipeline |               1 |               19,150 | 17,060–19,910 |            — |    40.24 |    46.38 |    50.42 |           399 |          18.59 |            6.09 |            483 |
| t2 pipeline |               2 |               19,875 | 17,965–20,365 |        +3.8% |    77.69 |    94.05 |   103.93 |           526 |          47.51 |            9.84 |            632 |
| t2 pipeline |               4 |               18,200 | 17,465–18,415 |        −5.0% |   170.72 |   202.52 |   216.66 |           636 |         130.44 |           11.30 |            961 |

**Depth is still throughput-neutral at t2, and now for the honest reason.**
Eight callers already keep the sequencer fed, so there is no idle time to
overlap; extra depth only adds calls to the coalesced flush (399 → 526 → 636
Actions), and past ~500 Actions the per-Action cost and the queueing grow with
it. Depth 2 sits inside the ±5–10% band (+3.8%) while p50 nearly doubles
(40 → 78 ms); depth 4 pays latency and loses throughput. Compare these rows at
a matched `Actions/flush` before attributing anything to depth.

### Depth > 1 lost claimed ranges until the #553 scheduling fix

The first run of this matrix on the post-#533 harness did not look neutral, it
looked broken. At t2/t3 with depth ≥ 2 and a coalesced flush above ~500 Actions:

- Passes ended with **3,000–8,000 GSN holes** in `cf_actions` (5 of 5 passes at
  t2 depth 4; 2 of 5 at depth 2) and a watermark that never moved again — the
  final lag equalled the whole run's GSN count (409,500 at 20 s, 852,800 at
  60 s), so `ebb.watermark.lag` was pinned at "everything".
- Live delivery died with it: t3, c=8, depth 2 delivered **117,500
  Actions/subscriber** over 20 s with 150 pushes and a final lag of 325,900,
  against **320,400** with 691 pushes at depth 1 (−63%).
- Every lost claim was exactly `:writer_batch_max_size` (1000) Actions, and the
  reported rejected/error counters stayed at 0 because the affected calls never
  returned at all.

What a temporary trace of `CommitPipeline` showed: those claims reached
`phase_prepared` and then vanished from the pipeline without a commit, a
release, or an abandon event — and the mode was a `phase_committing` for an
older range arriving with a pipeline state that no longer contained the new
claim. The cause was one line in `Writer.advance_pipeline/1`:

```elixir
# before: the flush's return value is discarded …
if state.burst_max_seq == nil, do: schedule_flush_now(state), else: state
maybe_schedule_prepare_flush(state)
```

When that nested `schedule_flush_now/1` found ≥ 1000 Actions waiting it did a
full flush — claim a GSN range, prepare it, hand it to a committer — and the
resulting state, holding the new claim, was thrown away: `maybe_schedule_prepare_flush/1`
returned the pre-flush state, so the claim disappeared from the pipeline while
its GSNs stayed spent. GSNs are never reused, so each lost range is a permanent
hole, and the ordered release frontier can never pass the first one — which is
what froze the watermark and stopped fan-out. It was introduced by #553
(`2f62ed7`, the prepare-stage rewrite) and only fires when a commit ack frees
the pipeline while a cap-sized burst is already waiting, i.e. above depth 1.

The fix is to bind the result, so the successor sees the post-flush state:

```elixir
state =
  if state.burst_max_seq == nil, do: schedule_flush_now(state), else: state

maybe_schedule_prepare_flush(state)
```

After it, the repros above report 0 holes, 0 rejected, 0 errors; t3 c=8 depth 2
delivers 294,900 Actions/subscriber over 497 pushes with a final lag of 208; and
`mix test test/ebb_server/storage test/ebb_server/sync` passes (795 tests). The
pre-fix t2 rows in the tables above understate throughput, because a lost range
blocks its callers — depth 1 and every 100-Action shape were unaffected, which is
why the t0 rows look the same either way.

### Separating depth from flush size

The t2 table above changes two things at once: pipeline depth and the coalesced
flush size. Two same-session follow-ups separate them.

**One caller, varying depth** (`--tier t2 --concurrency 1`, three reports):

| Callers | Calls in flight | Actions/sec (median) |         Range | Δ vs depth 1 | p50 (ms) | Actions/flush | Flush p50 (ms) | Commit p50 (ms) |
| ------: | --------------: | -------------------: | ------------: | -----------: | -------: | ------------: | -------------: | --------------: |
|       1 |               1 |               11,620 | 11,400–11,890 |            — |     7.60 |           100 |           3.99 |            2.09 |
|       1 |               2 |               19,540 | 19,470–20,105 |       +68.2% |     9.01 |           100 |           4.73 |            2.10 |
|       1 |               4 |               24,100 | 23,535–24,935 |      +107.4% |    15.37 |           101 |          10.32 |            2.16 |

The t0 depth-1 baseline measured in the same three reports was **20,870**
(20,360–21,055). A single serial HTTP caller is the bottleneck — each 4.0 ms
flush is followed by the response, the next MessagePack encode, and the next
request — so depth 2 lifts throughput 68% with the flush unchanged, and depth 4
still holds the flush at 101 Actions and doubles it again. This is the
client-pipelining lever ([#201](https://github.com/ebbjs/ebbjs/issues/201)
territory), not a committer-pool win, and it needs a production client that
pipelines.

**Constant offered burst** (`--tier t2`, `callers × calls in flight = 8`, five
runs per row):

| Callers | Calls in flight | Actions/sec (median) |         Range | Δ vs 8×1 | p50 (ms) | Actions/flush | Flush p50 (ms) | Commit p50 (ms) |
| ------: | --------------: | -------------------: | ------------: | -------: | -------: | ------------: | -------------: | --------------: |
|       8 |               1 |               19,075 | 17,850–19,445 |        — |    40.42 |           400 |          18.45 |            6.57 |
|       4 |               2 |               22,120 | 21,635–22,480 |   +16.0% |    34.51 |           254 |          20.41 |            4.95 |
|       2 |               4 |               22,930 | 22,500–23,370 |   +20.2% |    33.36 |           152 |          24.37 |            3.13 |
|       1 |               8 |               23,085 | 22,500–23,560 |   +21.0% |    33.07 |           152 |          24.13 |            3.09 |

The #551-era form of this table was flat at 19.4–20.3k because every shape
coalesced to the same 400-Action flush. That is no longer true: the flush
shape now _follows_ the shape of the offered burst (400 → 254 → 152 Actions),
so this table cannot separate depth from flush size either, and its +21% should
be read as "fewer, denser callers coalesce into a smaller flush and cost less
per Action" rather than as committer-pool parallelism. What it does show is that
one client with eight calls in flight beats eight serial clients on both
throughput (23,085 vs 19,075) and p50 (33.1 vs 40.4 ms) at an eighth of the
connections.

### Verdict for the pipeline

- **t0 depth 2 is a genuine 1.5× win** (+52.6%, flush unchanged, commit latency
  unchanged): the sequencer overlaps prepare/flush work with commit. Depth 4
  adds queueing and no throughput.
- **At production shapes the pipeline still cannot use depth.** Below ~500
  Actions/flush there is no overlap gain to collect because the callers already
  feed the sequencer; above it, flush cost and latency grow faster than the
  overlap saves. `max_in_flight` therefore stays a correctness-shaped knob, not
  a throughput knob, and raising the production default from 1 would buy latency
  and nothing else.
- **The one lever with a large, repeatable gain is client-side pipelining**
  (one caller, two to four calls in flight: +68% to +107%), which is #201
  territory and out of scope here.
- **None of the above was measurable before the #553 scheduling fix.** Any
  depth>1 number published from the post-#533 harness before 2026-10-21 is
  suspect: the run could lose claimed ranges and freeze its own frontier.

### Harness model and limitations

- **What "in flight" counts.** The peak/mean columns count the harness's own
  outstanding `write_actions/1` calls per worker, not the Writer's in-flight
  batches. The Writer's own `ebb.writer.in_flight_batches` and
  `ebb.writer.oldest_unreleased_gsn` gauges are published in
  [Flush phase attribution](#flush-phase-attribution-537).
- **Depth and flush size move together.** Since #553 the coalescing window is a
  prepare-burst marker, so the flush size is a function of the offered burst and
  not a constant. Compare depth rows against the `Actions/flush` and
  `Flush p50` columns, and use the one-caller row when a fixed flush size
  matters.
- **Fresh DB per depth.** Each pass boots an isolated storage tree and reseeds
  the bench context, so no depth pays for another's cache, dirty set, or
  compaction state. The t0 baseline is a separate boot too.
- **Baseline in the same report.** The t0 row is measured by the same process
  on the same host immediately before the pipelined passes; it is the
  no-regression check against the 20–21k t0 range above, not a historical
  constant.
- **Ordering and noise.** Within a report the passes run baseline, 1, 2, 4, so
  late passes see slightly more host drift; the min–max ranges overlap in
  places and a ±5–10% single-run delta is not resolvable on this VM.
- **Client overhead at t2.** The t2 rows include `:httpc`, MessagePack, and the
  request process; t0 is the cleaner pipeline number. Both tiers use the same
  Action shape and `sync: true`.

## Flush phase attribution (#537)

[#537](https://github.com/ebbjs/ebbjs/issues/537) splits one claimed range's
latency into the phases the pipeline depth actually spends it in. The Writer
emits [`ebb.writer.flush_phase_ms`](https://github.com/ebbjs/ebbjs/issues/537)
once per range with six native durations, and the bench sweep renders them
per depth beside the two pipeline gauges and a flush queue depth. This is an
**accounting** section: the point is that every microsecond the client p50
sees is named, not that a new number is faster.

Measured **2026-10-23** on `recsy-vps` (AMD EPYC 7763, 4 schedulers, 16 GiB,
Elixir 1.17.3 / OTP 27), the same host and shape as the rotated A/B: batch
100, 2-Update Actions, `hot`, `sync: true`, `--seed 1`, 20 s window after 3 s
warmup, three reports per row (the t0 depth-1 row pools the six baseline
passes the two sweeps each measure). Median of the per-report medians. Every
run had **0 GSN holes, 0 rejected Actions, 0 write/transport errors**.

```sh
mix bench.actions --tier t0 --duration 20 --warmup 3 --concurrency 1 \
  --in-flight 1,2,4 --batch-size 100 --updates-per-action 2 --distribution hot --seed 1
mix bench.actions --tier t2 --duration 20 --warmup 3 --concurrency 8 \
  --in-flight 1,2,4 --batch-size 100 --updates-per-action 2 --distribution hot --seed 1
```

Raw reports: `bench/results/20261023T213502Z-recsy-vps.md`,
`20261023T213700Z`, `20261023T213841Z`, `20261023T214043Z`,
`20261023T214214Z`, `20261023T214419Z` (gitignored, as usual).

### The phases sum to the client p50

| Run (median of 3) | Actions/s | Client p50 | Client p95 | Writer flush p50 | Phase sum p50 |          Residual |
| ----------------- | --------: | ---------: | ---------: | ---------------: | ------------: | ----------------: |
| t0 depth 1        |    26,020 |    3.56 ms |    4.40 ms |          2.82 ms |       3.54 ms |  +0.03 ms (+0.8%) |
| t0 depth 2        |    37,070 |    4.90 ms |    6.35 ms |          3.85 ms |       4.83 ms |  +0.07 ms (+1.4%) |
| t0 depth 4        |    35,340 |   10.82 ms |   13.04 ms |          9.45 ms |      10.74 ms |  +0.08 ms (+0.7%) |
| t2 depth 1        |    25,585 |   29.93 ms |   37.16 ms |          8.06 ms |      26.63 ms | +3.30 ms (+12.4%) |
| t2 depth 2        |    30,700 |   49.24 ms |   62.80 ms |         28.44 ms |      45.67 ms |  +3.57 ms (+7.8%) |
| t2 depth 4        |    29,395 |  105.88 ms |  125.46 ms |         78.99 ms |     102.31 ms |  +3.57 ms (+3.5%) |

`Phase sum p50` is the collected `flush_total` sample: the p50 of the per-range
**sum** of the six phases, from the oldest coalesced call's send to the end of
its `notify` phase. Do not add the phase p50 cells in the table below to
reproduce it — percentiles do not add; the sum column is its own measurement.
The `Residual` is client-minus-phase-sum, and it is not an unmeasured phase: at
`t0` there is no HTTP (0.7–1.4%, the harness timer around `write_actions/1`),
and at `t2` it is the client-side HTTP/MessagePack/`:httpc` cost the client
timer includes and the Writer cannot see. It shrinks as a share of the client
number as depth grows the range lifetime: 12.4% at depth 1, 7.8% at depth 2,
3.5% at depth 4.

The acceptance check in #537 asked for the t2 depth-2 sum to land within 10%
of the client p50: it lands at **7.8%**, and the t0 depth-1 check at **0.8%**.
The issue's "4.95 ms wall plus the prepare hop" wording predates #574/#582:
the payload build now runs inline on an idle Writer, so that hop is the
`prepare` phase itself and the sum accounts for the wall directly.

### The phase breakdown (median p50 / p95, ms)

| Run        |         queue |      prepare |      resolve |   commit_wait |       apply |      notify |
| ---------- | ------------: | -----------: | -----------: | ------------: | ----------: | ----------: |
| t0 depth 1 |   0.12 / 0.33 |  0.25 / 0.41 |  0.98 / 1.34 |   2.02 / 2.51 | 0.08 / 0.13 | 0.02 / 0.04 |
| t0 depth 2 |   0.12 / 0.36 |  0.43 / 0.61 |  1.08 / 1.69 |   2.95 / 4.22 | 0.10 / 0.16 | 0.02 / 0.04 |
| t0 depth 4 |   0.23 / 1.07 |  0.46 / 0.76 |  0.97 / 1.86 |  8.59 / 10.61 | 0.11 / 0.17 | 0.02 / 0.04 |
| t2 depth 1 |  7.38 / 16.15 | 9.63 / 14.47 |  3.87 / 7.44 |   4.88 / 8.41 | 0.20 / 0.34 | 0.05 / 0.10 |
| t2 depth 2 | 10.71 / 18.82 | 2.49 / 10.58 | 7.83 / 14.52 | 22.02 / 31.94 | 0.53 / 0.89 | 0.07 / 0.19 |
| t2 depth 4 | 14.73 / 27.15 | 2.84 / 15.33 | 9.79 / 23.27 | 70.02 / 89.12 | 0.85 / 1.57 | 0.08 / 0.23 |

Phase boundaries are fixed in `EbbServer.Telemetry`:

- `queue` — the oldest coalesced call's mailbox wait plus the wait from its
  payload being ready to the flush dequeue. This is the term
  `ebb.writer.batch_latency_ms` has never seen.
- `prepare` — payload build and ETF encode, inline or on the prepare pool. A
  pooled call's pool queueing is included, which is why `t2 depth 1`'s
  `prepare` (9.63 ms) is mostly waiting for a pool worker, not encoding: with
  8 callers the Writer is rarely idle, so most calls take the pooled path.
  This is the phase [epic #529](https://github.com/ebbjs/ebbjs/issues/529)'s
  "prepare hop" question can now be read against.
- `resolve` — dedup/in-flight filtering, the GSN claim, group resolution +
  `update_scopes`, and the cache mutation plan.
- `commit_wait` — the hand-off to a Committer through the durable ack,
  including waiting behind an earlier range for the resolution gate.
- `apply` — the durable mark and the ordered apply: any wait behind an earlier
  range in claim order, cache mutations, and the dirty settle.
- `notify` — the fan-out nudge and the callers' replies.

A phase a range never reached is `0`, so an abandoned range still emits one
event (`outcome: :abandoned`, with its `reason`); a commit failure reports
`apply` and `notify` as `0`, not as missing data.

### What it says

- **Depth is a commit-wait tax, not an apply cost.** At `t2 depth 4`,
  `commit_wait` is 70.02 ms of the 102.31 ms phase sum (68%); across every row
  and both tiers `apply` stays at or below 0.85 ms and `notify` at or below
  0.08 ms. Cache mutations and fan-out are not where depth spends its latency
  — waiting for the durable ack behind an earlier range is.
- **The unattributed gap at t2 depth 2 decomposes into named phases.** The
  current build reports a 49.24 ms client p50 against a 28.44 ms flush,
  leaving ~21 ms that the flush timer never covered; the phases assign it:
  `queue` 10.7, `prepare` 2.5, `resolve` 7.8, `commit_wait` 22.0, `apply`
  0.53, `notify` 0.07. The remaining 3.6 ms is outside the Writer
  (HTTP/transport). The instrumentation itself is within noise — the
  interleaved A/B below is +2.0% rate / −1.8% p50 at `t0` c=1. The issue's
  original 30.2 ms gap was measured on the pre-Step-0 build (77.7 ms client
  vs 47.5 ms flush); its shape — most of it before the claim and in the
  committer wait — is the same.
- **The Writer mailbox is a real term only under concurrency.** `queue` is
  0.12 ms at `t0` c=1 (the Writer is never contended), but 7.38 ms at
  `t2` c=8 depth 1 — 28% of the range lifetime before the claim. That is the
  number a mailbox/batch-window change should move (#576).
- **Inline prepare is cheap; pooled prepare is a queue.** At `t0` c=1 the
  inline encode is 0.25 ms into a 3.54 ms range. Serialised through the pool
  under t2 concurrency, the same work shows up as a 9.63 ms p50 `prepare` that
  is dominated by pool waiting — the phase boundary deliberately keeps that
  wait in `prepare`, not `queue`.

### Writer pipeline gauges (median of the per-report peak/mean)

| Run        | `queue_depth` peak | mean | `in_flight_batches` peak | mean | `oldest_unreleased_gsn` peak |    mean |
| ---------- | -----------------: | ---: | -----------------------: | ---: | ---------------------------: | ------: |
| t0 depth 1 |                  1 |  1.0 |                        1 |  0.5 |                      598,003 | 168,926 |
| t0 depth 2 |                  1 |  1.0 |                        2 |  1.5 |                      857,303 | 486,287 |
| t0 depth 4 |                  1 |  1.0 |                        4 |  3.5 |                      818,203 | 464,829 |
| t2 depth 1 |                  7 |  2.7 |                        1 |  0.5 |                      586,503 | 165,295 |
| t2 depth 2 |                 10 |  5.2 |                        2 |  1.5 |                      706,403 | 399,864 |
| t2 depth 4 |                 10 |  6.3 |                        4 |  3.5 |                      671,903 | 378,086 |

`queue_depth` is the number of `write_actions/1` calls one flush drained
(`ebb.writer.batch_size`'s `callers`), so its peak/mean describe how deep the
coalescing queue got: at `t0` c=1 one 100-Action call is flushed at a time at
every depth, while `t2` c=8 grows from 2.7 to 6.3 calls per flush — which is
the same growth the `Actions/flush` column shows (271 → 635). A depth increase
at `t0` therefore buys overlap inside the Writer, not a deeper flush; at `t2`
it buys both.

The other two columns are the Writer's own `ebb.writer.in_flight_batches` and
`ebb.writer.oldest_unreleased_gsn` gauges, emitted on every claim and release,
so they describe the actual reorder buffer rather than the harness-side
`Observed` columns. `in_flight_batches` tracks the requested depth exactly
(mean = depth − 0.5, because a claim emits N and its release N − 1).
`oldest_unreleased_gsn` is an **absolute GSN**, not a lag, so its peak/mean
describe where the run sat in the log rather than a backlog; the gauge's value
is as a time series — a head that stops advancing while claims advance is a
stalled range — which is why the tables publish peak/mean only because #537
asks for them.

### Instrumentation cost

`t0` c=1, three runs per arm, interleaved (`origin/main` before the branch),
same shape as above but single-depth:

| Arm                       | Actions/s (median) | p50 (median) | p95 (median) |
| ------------------------- | -----------------: | -----------: | -----------: |
| `origin/main` (no phases) |             25,455 |     3.633 ms |     4.425 ms |
| this branch (`#537`)      |             25,970 |     3.566 ms |     4.355 ms |
| delta                     |              +2.0% |        −1.8% |        −1.6% |

Both deltas are inside the published ±5–10% single-run VM spread (an earlier
three-run session on the same host measured −1.3% rate / +0.6% p50, so the
sign is noise), so the per-range stamps and the extra telemetry samples per
flush are not measurably visible at the ceiling.

## Flush operating point (#576)

[#576](https://github.com/ebbjs/ebbjs/issues/576) asks whether the
production coalescing policy — `writer_batch_timeout_ms: 0` and
`writer_batch_max_size: 1000` — should move to the ~150–250 Actions/flush
the pre-Step-0 curve priced as ~20% faster. Current code already runs at
~272 Actions/flush, so the question narrowed to whether any `(timeout,
cap)` pair in the issue's grid beats that by **≥5% at no worse p50**.

Measured **2026-10-24** on `recsy-vps` (AMD EPYC 7763, 4 schedulers,
16 GiB, Elixir 1.17.3 / OTP 27), the same host and shape as the #537
section: batch 100, 2-Update Actions, `hot`, `sync: true`, `--seed 1`,
20 s window after a 3 s warmup. The host was otherwise idle (the bench
was the only CPU consumer); port 4112 was used to stay clear of 4111,
which other processes on this shared VM hold intermittently. Every
run reported here has **0 GSN holes, 0 rejected Actions, 0
write/transport errors**, and the runner's guardrails were enforced — a
failing run exits non-zero, and none did.

**Verdict: flat at the production shape.** No `(timeout, cap)` pair
beats the current default by 5% when the offered burst is eight single
calls. The cap is neutral between 182 and 279 Actions/flush, a positive
timeout is a loss wherever it is tried, and the only screened cell that
clears +5% changes the _caller split_ to 2 callers × 4 calls in flight —
a shape whose 149 Actions/flush and +8% throughput are already there
with the default knobs. Per AC2 this issue should close with this
measurement instead of shipping a policy change.

### Method

The grid needs two knobs that were application-env only, so this branch
adds `--batch-timeout-ms` and `--batch-max-size` to `mix bench.actions`
(forwarded by `Bench.Boot.writer_opts/1` as `batch_timeout_ms:` /
`batch_max_size:`, defaulting to the production `0` / `1000`). It also
renders `Actions/flush`, the Writer gauges, and the
`ebb.writer.flush_phase_ms` table in a single-depth report: the #537
phase table was rendered only for depth sweeps, and this sweep measures
one fixed shape per report.

Screening ran all 48 cells (four caller splits × timeout {0, 1, 5} ×
cap {128, 256, 512, 1000}) as one report per cell, in a shuffled order
so host drift is not confounded with a knob, all at the same fixed
offered burst of eight outstanding calls:

```sh
mix bench.actions --tier t2 --duration 20 --warmup 3 \
  --concurrency <C> --in-flight <D> --batch-size 100 --updates-per-action 2 \
  --distribution hot --seed 1 --port 4112 \
  --batch-timeout-ms <0|1|5> --batch-max-size <128|256|512|1000>
```

A screening cell is a single draw (this VM's run-to-run spread is
±5–10%), so the decision rows were re-measured with five reports each,
interleaved round-robin so every row sees the same drift. One `8×1 (0, 128)` confirmation report hit
a latency stall (p95 66.9 ms, p99 167 ms, 22,470 Actions/s against a
26,155 median); it was re-run under the session protocol and the five
clean reports are published — the stall is excluded, not averaged in.
Raw reports are `bench/results/576-screen-*.md`, `576-confirm-*.md`, and
`576-t0-*.md` (gitignored, as usual).

### Screening: 48 cells at eight outstanding calls

Sorted by Actions/s. `queue` and `commit_wait` are per-range p50 phase
values from a single report, so read them as shape, not as tight
numbers. The `8×1 (0, 1000)` row is this session's low draw (24,465
against the 26,210 five-report median below); it is kept because it is
the cell the confirmation replaces, not the decision row.

| Split | Timeout (ms) |  Cap | Actions/flush | Actions/s | p50 (ms) | p99 (ms) | `queue` p50 (ms) | `commit_wait` p50 (ms) | `queue_depth` peak / mean |
| ----- | -----------: | ---: | ------------: | --------: | -------: | -------: | ---------------: | ---------------------: | ------------------------: |
| 2×4   |            1 |  128 |           159 |    29,835 |    25.22 |    37.19 |             2.22 |                  16.45 |                   2 / 1.6 |
| 4×2   |            0 | 1000 |           249 |    28,925 |    25.97 |    39.13 |             4.45 |                  11.87 |                   6 / 2.5 |
| 2×4   |            0 |  128 |           147 |    28,875 |    26.22 |    37.21 |             2.19 |                  17.16 |                   2 / 1.5 |
| 1×8   |            1 |  128 |           159 |    28,760 |    26.33 |    36.70 |             2.27 |                  17.14 |                   2 / 1.6 |
| 4×2   |            0 |  512 |           247 |    28,535 |    26.27 |    38.82 |             4.52 |                  11.96 |                   6 / 2.5 |
| 1×8   |            1 | 1000 |           176 |    28,455 |    26.51 |    38.02 |             2.10 |                  17.10 |                   5 / 1.8 |
| 4×2   |            1 | 1000 |           253 |    28,315 |    26.55 |    38.70 |             4.84 |                  12.29 |                   6 / 2.5 |
| 2×4   |            0 |  512 |           150 |    28,000 |    27.13 |    36.77 |             1.98 |                  17.63 |                   4 / 1.5 |
| 2×4   |            1 |  256 |           171 |    27,980 |    27.04 |    38.30 |             2.11 |                  17.64 |                   3 / 1.7 |
| 4×2   |            1 |  512 |           252 |    27,930 |    26.96 |    40.45 |             5.01 |                  12.11 |                   6 / 2.5 |
| 4×2   |            0 |  256 |           248 |    27,895 |    26.81 |    41.06 |             5.16 |                  13.01 |                   3 / 2.5 |
| 1×8   |            0 |  256 |           150 |    27,885 |    27.15 |    39.41 |             1.91 |                  17.79 |                   3 / 1.5 |
| 2×4   |            5 |  128 |           170 |    27,790 |    27.26 |    38.24 |             5.92 |                  15.02 |                   2 / 1.7 |
| 2×4   |            0 | 1000 |           149 |    27,710 |    27.41 |    38.76 |             1.98 |                  17.84 |                   4 / 1.5 |
| 1×8   |            0 |  128 |           147 |    27,525 |    27.50 |    38.83 |             2.35 |                  18.05 |                   2 / 1.5 |
| 4×2   |            1 |  256 |           245 |    27,525 |    27.21 |    40.90 |             5.73 |                  12.67 |                   3 / 2.5 |
| 1×8   |            1 |  512 |           175 |    27,515 |    27.53 |    38.57 |             2.18 |                  18.00 |                   5 / 1.8 |
| 2×4   |            1 | 1000 |           173 |    27,475 |    27.47 |    40.40 |             2.13 |                  17.83 |                   5 / 1.7 |
| 1×8   |            5 |  128 |           169 |    27,465 |    27.68 |    39.31 |             5.95 |                  15.18 |                   2 / 1.7 |
| 1×8   |            1 |  256 |           169 |    27,380 |    27.72 |    38.25 |             2.15 |                  18.23 |                   3 / 1.7 |
| 1×8   |            0 | 1000 |           150 |    27,195 |    27.84 |    39.58 |             2.02 |                  18.24 |                   4 / 1.5 |
| 1×8   |            5 |  256 |           225 |    26,900 |    28.20 |    39.93 |             5.91 |                  14.29 |                   3 / 2.3 |
| 4×2   |            5 |  128 |           179 |    26,665 |    28.56 |    39.47 |            11.44 |                  10.18 |                   2 / 1.8 |
| 1×8   |            0 |  512 |           150 |    26,650 |    28.30 |    41.48 |             1.92 |                  18.61 |                   4 / 1.5 |
| 1×8   |            5 |  512 |           383 |    26,615 |    28.12 |    41.41 |             5.77 |                  12.14 |                   6 / 3.8 |
| 2×4   |            5 |  512 |           387 |    26,555 |    28.18 |    41.09 |             5.67 |                  12.18 |                   6 / 3.9 |
| 2×4   |            5 |  256 |           228 |    26,380 |    28.71 |    41.21 |             6.01 |                  14.81 |                   3 / 2.3 |
| 4×2   |            5 |  256 |           217 |    26,365 |    28.86 |    39.66 |             9.63 |                  11.58 |                   3 / 2.2 |
| 2×4   |            1 |  512 |           170 |    26,330 |    28.67 |    42.19 |             2.26 |                  18.78 |                   4 / 1.7 |
| 2×4   |            0 |  256 |           150 |    26,310 |    28.86 |    40.87 |             2.16 |                  18.83 |                   3 / 1.5 |
| 4×2   |            1 |  128 |           197 |    26,285 |    28.96 |    39.35 |            10.43 |                  12.24 |                   2 / 2.0 |
| 4×2   |            5 |  512 |           386 |    25,890 |    28.84 |    43.54 |             5.82 |                  12.56 |                   6 / 3.9 |
| 8×1   |            0 |  128 |           185 |    25,735 |    29.92 |    39.35 |            10.65 |                   3.41 |                   2 / 1.9 |
| 8×1   |            0 |  256 |           225 |    25,705 |    29.81 |    39.35 |             9.70 |                   4.41 |                   3 / 2.3 |
| 1×8   |            5 | 1000 |           410 |    25,685 |    28.99 |    42.93 |             5.71 |                  12.84 |                   8 / 4.1 |
| 8×1   |            0 |  512 |           279 |    25,665 |    29.73 |    39.92 |             7.33 |                   4.87 |                   6 / 2.8 |
| 8×1   |            1 |  128 |           183 |    25,450 |    30.13 |    41.79 |            13.72 |                   3.36 |                   2 / 1.8 |
| 4×2   |            0 |  128 |           197 |    25,335 |    29.99 |    41.65 |            10.98 |                  12.93 |                   2 / 2.0 |
| 8×1   |            1 |  256 |           225 |    25,270 |    30.24 |    41.03 |            11.10 |                   4.50 |                   3 / 2.3 |
| 8×1   |            5 |  256 |           258 |    24,885 |    30.55 |    45.19 |            14.86 |                   4.62 |                   3 / 2.6 |
| 8×1   |            0 | 1000 |           274 |    24,465 |    31.06 |    45.54 |             7.90 |                   5.06 |                   8 / 2.7 |
| 4×2   |            5 | 1000 |           449 |    24,250 |    31.01 |    43.62 |             5.89 |                  13.49 |                   8 / 4.5 |
| 8×1   |            1 | 1000 |           342 |    24,195 |    31.37 |    46.63 |            10.04 |                   6.03 |                   8 / 3.4 |
| 8×1   |            5 |  128 |           188 |    24,150 |    32.19 |    43.75 |            19.37 |                   3.42 |                   2 / 1.9 |
| 8×1   |            5 |  512 |           391 |    22,925 |    33.59 |    50.07 |            14.09 |                   7.23 |                   6 / 3.9 |
| 2×4   |            5 | 1000 |           477 |    22,880 |    32.77 |    51.24 |             6.23 |                  14.21 |                   8 / 4.8 |
| 8×1   |            1 |  512 |           334 |    22,685 |    33.89 |    48.20 |            10.89 |                   6.17 |                   6 / 3.3 |
| 8×1   |            5 | 1000 |           601 |    21,925 |    34.87 |    48.88 |             7.89 |                  10.39 |                   8 / 6.0 |

Three things the grid shows before any confirmation:

- **Within `8×1`, the cap does nothing.** 185, 225, 279, and 274
  Actions/flush all land within 24.5–25.7k in this draw; the 24,465 row
  is the low outlier that the confirmation re-measured at 26,210.
- **A positive timeout is a loss at every split, worst at `8×1`.** With
  `t=5, cap=1000` the burst widens to 601 Actions/flush and the rate
  falls to 21,925 (-16.3% against the confirmed
  default-knob row). `t=1` is already below `t=0` at every cap.
- **The caller split dominates.** At the same eight outstanding calls,
  `2×4` is the top of the screen (29,835) and the confirmation puts it
  2.2k (8.3%) above `8×1` with the _default_ policy, while its flush is
  already 147–253 Actions without a cap.

### Confirmation: five reports per row

`2×4 (0, 1000)` is included to separate the split from the knobs: it is
the same split as the best cell with the production policy. Medians with
min–max in parentheses.

| Row                      | Reports | Actions/flush | Actions/s (median, min–max) |            p50 (ms) |            p95 (ms) |            p99 (ms) | `queue` p50 (ms) | `commit_wait` p50 (ms) | `queue_depth` peak / mean | fsyncs / 1k Actions |
| ------------------------ | ------: | ------------: | --------------------------: | ------------------: | ------------------: | ------------------: | ---------------: | ---------------------: | ------------------------: | ------------------: |
| baseline `8×1 (0, 1000)` |       5 |           272 |      26,210 (25,225–26,470) | 29.16 (28.91–30.30) | 36.45 (35.50–37.57) | 40.46 (39.92–42.21) |             7.07 |                   4.74 |                   7 / 2.7 |                3.67 |
| `8×1 (0, 128)`           |       5 |           182 |      26,155 (25,440–26,960) | 29.43 (28.56–30.22) | 35.75 (34.69–36.62) | 39.32 (37.59–40.20) |            10.47 |                   3.32 |                   2 / 1.8 |                5.48 |
| `2×4 (1, 128)`           |       5 |           158 |      28,885 (28,435–29,450) | 26.13 (25.60–26.64) | 32.53 (31.55–32.71) | 36.61 (35.48–38.55) |             2.25 |                  16.98 |                   2 / 1.6 |                6.29 |
| `2×4 (0, 1000)`          |       5 |           149 |      28,380 (27,150–29,295) | 26.67 (25.82–27.92) | 33.53 (32.76–34.86) | 37.87 (36.99–39.64) |             1.92 |                  17.35 |                   4 / 1.5 |                6.68 |

Deltas against the confirmed baseline:

| Comparison                        | Actions/s |    p50 |
| --------------------------------- | --------: | -----: |
| `8×1 (0, 128)` vs baseline        |     -0.2% |  +0.9% |
| `2×4 (1, 128)` vs baseline        |    +10.2% | -10.4% |
| `2×4 (0, 1000)` vs baseline       |     +8.3% |  -8.5% |
| `2×4 (1, 128)` vs `2×4 (0, 1000)` |     +1.8% |  -2.0% |

At the production shape, capping the flush at 182 Actions is
**-0.2%** throughput with p50 **+0.9%**; the confirmed baseline
(26,210 Actions/s at 29.16 ms, 272 Actions/flush) is inside the issue's
2026-10-23 reference of 25,585 at 29.93 ms, 271 Actions/flush. The
`2×4` row clears the 5% bar, but holding the split fixed shows where it
comes from: the default knobs already give **+8.3%** at
149 Actions/flush, and the `(1, 128)` pair adds only
**+1.8%** on top — inside run-to-run noise.

### t0 control

`t0 c=1 depth 1` offers one 100-Action call at a time, so a cap ≥ 128
cannot bind; the control is the production policy, and the candidate is
run both cap-only and with its 1 ms timer. Medians with min–max.

| Row                    | Reports | Actions/flush | Actions/s (median, min–max) |         p50 (ms) |         p99 (ms) | `queue` p50 (ms) | `commit_wait` p50 (ms) |
| ---------------------- | ------: | ------------: | --------------------------: | ---------------: | ---------------: | ---------------: | ---------------------: |
| `(0, 1000)` control    |       3 |           100 |      25,560 (24,735–25,740) | 3.62 (3.60–3.69) | 5.11 (5.11–5.86) |             0.13 |                   2.05 |
| `(0, 128)` cap only    |       3 |           100 |      26,410 (25,555–26,615) | 3.50 (3.49–3.61) | 5.11 (4.94–5.38) |             0.13 |                   1.99 |
| `(1, 128)` timer + cap |       3 |           100 |      19,250 (19,210–19,610) | 4.89 (4.84–4.89) | 6.46 (6.19–6.88) |             1.75 |                   1.97 |

The cap alone is safe at the ceiling: 26,410 Actions/s at 3.50 ms
p50 against 25,560 at 3.62 ms, and Actions/flush is 100 on both
sides of the comparison — one call is 100 Actions, which is below every
cap in the grid, so the flush cannot fall further and the fsync
amortization that AC3 guards is unchanged. The timer is not safe: `(1, 128)`
costs **-24.7%** throughput and **+34.9%**
p50, because on an uncontended Writer it replaces the burst-drain marker
with a 1 ms wall-clock wait — `queue` goes from 0.13 ms to 1.75 ms while
nothing else coalesces.

### Where the flush size shows up

The 2026-10-23 update to #576 says the verdict columns are `queue`,
`commit_wait`, and `queue_depth`, not Actions/s alone. Medians of the
confirmation reports:

| Row                      | Actions/flush | Client p50 (ms) | `queue` | `prepare` | `resolve` | `commit_wait` | `apply` | `notify` | Phase sum p50 (ms) | `queue_depth` peak / mean |
| ------------------------ | ------------: | --------------: | ------: | --------: | --------: | ------------: | ------: | -------: | -----------------: | ------------------------: |
| baseline `8×1 (0, 1000)` |           272 |           29.16 |    7.07 |      9.23 |      3.79 |          4.74 |    0.20 |     0.05 |              25.96 |                   7 / 2.7 |
| `8×1 (0, 128)`           |           182 |           29.43 |   10.47 |      9.73 |      2.07 |          3.32 |    0.14 |     0.04 |              26.84 |                   2 / 1.8 |
| `2×4 (1, 128)`           |           158 |           26.13 |    2.25 |      0.79 |      1.62 |         16.98 |    0.22 |     0.03 |              22.89 |                   2 / 1.6 |
| `2×4 (0, 1000)`          |           149 |           26.67 |    1.92 |      0.82 |      1.62 |         17.35 |    0.15 |     0.02 |              23.21 |                   4 / 1.5 |

Read together, the four rows explain the flat curve:

- **The cap moves time from `commit_wait` and `resolve` into `queue`.**
  At `8×1 (0, 128)`, `resolve` falls 3.79 → 2.07 ms and `commit_wait`
  4.74 → 3.32 ms, but `queue` rises 7.07 → 10.47 ms: the eight-call
  burst now drains in four two-call flushes, and the calls that used to
  share one flush wait in the Writer mailbox for the next. `apply` and
  `notify` are unchanged (≤0.22 ms in every row). The saved commit time
  is handed back as queueing, and p50 nets +0.9%.
- **Flush size is a symptom of pipelining, not an independent lever.**
  `2×4` reaches 149 Actions/flush with the _default_ cap because each
  caller has four calls outstanding; its `queue` is 1.92 ms, not
  10.47 ms, because no call is stranded behind a capped flush. Forcing
  the same indicator at depth 1 does not reproduce the rate.
- **`commit_wait` at `2×4` (17.0 ms) is the depth tax #537 documented**,
  not a flush-size effect; the rate comes from overlapping four flushes
  per caller, which is the #529 depth story rather than a coalescing
  default.
- **`queue_depth` follows the cap:** 7 / 2.7 calls per flush at the
  default, 2 / 1.8 with the 128 cap, 4 / 1.5 at `2×4` with the default.

### Verdict

**Flat — no coalescing default changes.** The cells that clear the 5%
bar are not adoptable policies:

- At `8×1`, the production shape, `(0, 128)` is
  **-0.2%** Actions/s at **+0.9%** p50; the
  `8×1 (0, 256)` screening cell is the same band (25,705 against the
  confirmed 26,210 baseline). Neither is a win, and a positive timeout is
  strictly worse (-16.3% at `t=5, cap=1000`).
- The best cell, `2×4 (1, 128)`, is **+10.2%** at p50
  **-10.4%**, but **+8.3%** of that is the caller split
  alone (`2×4` with default knobs) and the knobs contribute
  **+1.8%**. Shipping `(1, 128)` as a production default would
  not reproduce the win at `8×1`, and it fails the t0 gate
  (**-24.7%** throughput, **+34.9%** p50 at `t0 c=1`).
- A smaller flush costs fsyncs: 3.67 → 5.48 write_batches per 1,000
  Actions at `8×1 (0, 128)` (+49%) and 6.29 at `2×4 (1, 128)` (+71%).
  That is the fsync-fragility the issue predicted, and it is why a tie
  would not justify the change either. #342 is not triggered, because
  nothing is adopted.

On current code the 150–250 Actions/flush window is not a throughput
lever at the production shape: the default 272 and the capped 182–225
measure the same rate within this VM's spread. The ~150 Actions/flush
that does run faster is produced by pipelining callers (`2×4`), which is
[#529](https://github.com/ebbjs/ebbjs/issues/529)'s depth lever, not a
`writer_batch_*` default. Recommendation per AC2: **close #576 with this
measurement.** If the `2×4` rate is wanted, the follow-up belongs in the
depth/caller-split work, not here.

## Prepare stage (#553)

> **Measured before Step 0 (2026-10-20).** Current numbers are in
> [Step 0](#step-0-depth-1-parity-579-582-581); the conclusions below still
> stand.

[#553](https://github.com/ebbjs/ebbjs/issues/553) moves the GSN-free
payload build and ETF encode from the Writer's `handle_call` path into a
linked `PreparePool`. It is a structural change first: arrival order and
the coalesced flush shape are fixed by a prepare-burst marker, so the
pool can finish a later call early without reordering claims. The Writer
now bounds the in-flight prepare queue and times out a job that never
finishes; neither path claims a GSN.

Measured **2026-10-20** on the same host as the depth tables above, with
`origin/main` at `8abf4b7` and the prepare branch at the same base plus
the prepare stage. Two to eight reports per row; the t2 c8 depth-2 row was
re-run with baseline and prepare interleaved after the final timer fix.
Medians with the min–max range in parentheses. Default prepare settings
were used (pool 2, queue 1,024 calls, timeout 2,000 ms). Every run had
**0 rejected Actions, 0 write/transport errors, 0 GSN holes**, and a final
watermark lag of 0.

```sh
mix bench.actions --tier t0 --duration 20 --warmup 3 --concurrency 1 \
  --in-flight 1,2 --batch-size 100 --updates-per-action 2 --distribution hot --seed 1
mix bench.actions --tier t2 --duration 20 --warmup 3 --concurrency 1 \
  --in-flight 1,2 --batch-size 100 --updates-per-action 2 --distribution hot --seed 1
mix bench.actions --tier t2 --duration 20 --warmup 3 --concurrency 8 \
  --in-flight 1,2 --batch-size 100 --updates-per-action 2 --distribution hot --seed 1
```

| Tier | Callers | Calls in flight | `origin/main` Actions/sec | Prepare stage Actions/sec |     Δ |
| :--- | ------: | --------------: | ------------------------: | ------------------------: | ----: |
| t0   |       1 |               1 |    21,183 (17,970–21,640) |    20,425 (19,990–21,240) | −3.6% |
| t0   |       1 |               2 |    30,228 (29,400–31,055) |    31,820 (31,255–33,380) | +5.3% |
| t2   |       1 |               1 |    11,855 (11,850–11,860) |    11,450 (11,300–11,600) | −3.4% |
| t2   |       1 |               2 |    19,675 (19,475–19,875) |    19,870 (19,055–20,155) | +1.0% |
| t2   |       8 |               1 |    19,085 (18,715–19,455) |    19,268 (19,215–19,320) | +1.0% |
| t2   |       8 |               2 |    19,253 (18,860–19,935) |    19,585 (16,870–20,320) | +1.7% |

**Verdict: a documented null result.** The deltas are inside this VM's
±5–10% single-run noise. The t2 one-caller depth-1 row is the one that
looks negative, but its own report's t0 baseline was ~4% lower in the
prepare session than in the `origin/main` session, so the t0-normalized
ratio is flat. The t2 c8 depth-2 rows overlap heavily: the interleaved
pair was 18,860/19,225 (`origin/main`) against 19,400/16,870 (prepare),
and the prepare runs' flush count varied 637–736 against 705–721 for the
baseline — burst-shape noise, not a consistent regression.

Throughput is unchanged because the flush is still dominated by cache
resolution and `write_batch`: in the same runs' Server-side latency
tables, `commit_latency_ms` p50 was 9.3–10.2 ms against a
`batch_latency_ms` p50 of 48.5–58.7 ms. Overlapping a payload build of a
few hundred microseconds with the commit cannot move the headline. The
win is structural — prepare no longer runs on the Writer's call path and
a slow or dead worker cannot hold a claimed GSN — not a throughput
number.

## Action envelope (#552)

[#552](https://github.com/ebbjs/ebbjs/issues/552) prices the stored
`cf_actions` value — the envelope around the pre-encoded payload — and picks
one. The decision, the reasoning and the full per-path argument are in
[`docs/research/552-action-envelope.md`](../../docs/research/552-action-envelope.md);
this section publishes the numbers and the harness that produced them.

Harness: `mix bench.envelope` (new). It compares four shapes **in one booted
storage tree**, each in its own disjoint GSN window so all four share one WAL,
compaction state and block cache, and it **rotates the shape order every
round** so host drift lands on every shape equally. Three legs: an _encode
leg_ (per-Action value construction, no RocksDB), a _write leg_ (one
`write_batch(sync: true)` holding the full flush shape), and _read legs_
(`materialize`, `catch_up`, `export` as path models that do the same gets and
decode calls as the module they name).

```sh
mix bench.envelope --flush-sizes 100,152 --reads 1000 --runs 3
```

Measured **2026-10-24** on `recsy-vps`, same host and shape as the rest of
this file. Two independent runs (A / B). Shapes: `wrapper` = what
`origin/main` stores, `versioned_wrapper` = the same with a version integer,
`companion` = scopes in a second record, `frame` = the shipped shape, the
scopes beside the payload in one value. The version tag in
`versioned_wrapper` was priced and then dropped: Ebb is greenfield, so a tag
buys only a different error message, and the shipped reader accepts exactly
one shape.

µs/Action p50. Encode: 1,000 Actions per sample. Read: shape order rotated per
pass, 1,000 samples per path.

| Shape               |  encode (A / B) | `materialize` (A / B) | `catch_up` (A / B) | `export` (A / B) |   B/Action on disk |
| :------------------ | --------------: | --------------------: | -----------------: | ---------------: | -----------------: |
| `wrapper`           |     0.48 / 0.47 |           3.75 / 4.75 |        4.84 / 5.48 |     10.35 / 6.36 |                781 |
| `versioned_wrapper` |     0.46 / 0.49 |           3.75 / 4.50 |        4.82 / 5.54 |     10.60 / 6.62 |                783 |
| `companion`         | **0.38 / 0.37** |           3.69 / 4.38 |        8.00 / 8.15 |     16.19 / 8.79 | 807 + a second put |
| `frame`             |     0.59 / 0.57 |       **3.69 / 4.38** |    **4.74 / 5.22** |  **9.41 / 5.75** |                779 |

Write leg, ms/flush p50, 51 flushed samples per cell:

| Shape               | 100 A/flush (A / B) | 152 A/flush (A / B) |
| :------------------ | ------------------: | ------------------: |
| `wrapper`           |         1.86 / 1.70 |         2.45 / 2.16 |
| `versioned_wrapper` |         1.88 / 1.69 |         2.48 / 2.22 |
| `companion`         |         2.11 / 1.86 |         2.72 / 2.54 |
| `frame`             |         1.92 / 1.68 |         2.40 / 2.15 |

**What it says.** The three single-record shapes are within ±3% of each other
on the durable write — the write leg cannot see an envelope that encodes in
0.5 µs/Action when the flush is bounded by op count and fsync — and the
`companion`'s second durable put costs +8–13% of a flush. On the read side the
`frame` is the cheapest single-record shape on every path (2–8% on
materialize, 2–5% on catch-up, 5–10% on export), the `companion` pays its
second point read on both scope-reading paths (+53–72%) and is only level with
or slightly ahead of the frame on materialize, where its 6%-smaller value pays
a `multi_get`-bound path; a version integer alone moves nothing, which is why
the tag was dropped rather than carried.

The chosen shape is the `frame`. The write path is unchanged at the operating
point: `t0 c=1` `commit_latency_ms` p50 5.17→5.22 ms, and `t2 c=8` 25,388→25,110
Actions/s with 30.09→30.43 ms client p50 (six alternating runs per arm,
medians) — all inside the ±5–10% single-run spread this file publishes. The
read-side `materialize` profile (`mix bench.materialize --sizes 1000 --runs 5
--reps 50`, three alternating runs per arm) is a noise floor in both
directions: the cells that never read `cf_actions` (the clean paths) move as
much as the rest, and the `actions_load` phase — the `multi_get` plus decode
the envelope lives in — goes 889→800 µs mean on cold and 23.1→19.1 µs on dirty.
End-to-end timing on this host cannot resolve a 0.4 µs-per-Action change (see
the noise-floor paragraph in the research note), so the per-path decision
rests on the encode and read legs above, and the operating-point runs are there
to show nothing regressed.

## Correctness under load

Clean across every measured run above: **0 rejected Actions, 0
write/transport errors, 0 GSN holes**, watermark lag high-water bounded
by one flush and 0 at the end of the run. The `t5` spike has no
Writer frontier, so its GSN holes and watermark lag are `n/a` rather than
zero.

That was not true for one class of run. On 2026-10-21 the depth matrix
above found a Writer scheduling bug that dropped claimed GSN ranges at
depth > 1 and froze the resolution frontier with it; it is fixed (see
[Depth > 1 lost claimed ranges](#depth--1-lost-claimed-ranges-until-the-553-scheduling-fix)).
Any depth>1 number produced on the post-#533 harness between #553
(`2f62ed7`) and that fix should be treated as suspect, and a run whose
report shows GSN holes or a final watermark lag that equals the run's GSN
count is a leak, not scheduler noise.

## Server-side telemetry

Server-side latency is read from the `ebb.*` `:telemetry` events added by
[#359](https://github.com/ebbjs/ebbjs/issues/359)–[#364](https://github.com/ebbjs/ebbjs/issues/364).
`EbbServer.Bench.Telemetry` attaches handlers in the bench process before
the measured window and stamps every sample with its offset from the
window start:

| Event                          | Measures                                                                        | Metadata                                                     |
| ------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `ebb.http.request_latency_ms`  | time inside the request process                                                 | `method`, `route`, `status`                                  |
| `ebb.writer.batch_latency_ms`  | one durable Writer flush, from just before the GSN claim                        | `gsn_start`, `gsn_end`                                       |
| `ebb.writer.commit_latency_ms` | Committer wrapper encode + op assembly + `write_batch`                          | `gsn_start`, `gsn_end`                                       |
| `ebb.writer.flush_phase_ms`    | one range split into `queue`/`prepare`/`resolve`/`commit_wait`/`apply`/`notify` | `gsn_start`, `gsn_end`, `outcome`, `reason` (abandoned only) |
| `ebb.fanout.push_latency_ms`   | commit → broadcast complete, per batch per group                                | `group_id`                                                   |

Every raw run report prints a **Server-side latency** table beside the
client-side one, and the fan-out section reports commit → broadcast complete
separately from the client-stamp delivery lag. It fires at the end of
`GroupServer.handle_cast({:push_actions, ...})`, after the per-subscriber
cast loop (O(N×A) before coalescing, O(N) after #509).
The Writer flush timer starts after the request is dequeued, so the wait a
call spends in the Writer mailbox is not part of `batch_latency_ms`:
`ebb.writer.flush_phase_ms` reports it as `queue`, with the payload build as
`prepare`, and a sweep renders the phase table in its pipeline-depth section
([Flush phase attribution](#flush-phase-attribution-537)). `--tier t0` has no
HTTP request, so only the Writer flush and its phases are reported there.

`ebb.watermark.lag` and `ebb.dirty_set.size` are read directly from
`WatermarkTracker` and `DirtyTracker` by the harness's own 1 Hz sampler
(the app's gauge sampler is not booted), and surface as the watermark-lag
and dirty-set rows in the correctness table.

The tables published above predate this change and are client-side;
re-running the reproduction commands regenerates them with both
perspectives. The change itself was regression-checked on `t0`: three 10s
runs per side (hot, batch 100) gave medians of 26,670/s before and
27,400/s after, inside this VM's ±5% run-to-run spread.

## Methodology and limitations

- **Client- and server-side latency.** Throughput and client-side latency
  are measured by wrapping the call or request from the client process, so
  HTTP latencies include MessagePack encoding, connection reuse, and
  `:httpc` request-manager overhead. The harness also attaches to the
  server's `ebb.*` telemetry and reports server-side latency
  (`ebb.http.request_latency_ms`, `ebb.writer.batch_latency_ms`,
  `ebb.fanout.push_latency_ms`) alongside it; see
  [Server-side telemetry](#server-side-telemetry).
- **Burst vs sustained.** Windows are reported separately: `burst` is the
  first 15s, `steady` is 61–120s. Warmup traffic runs for 5s before the
  measured window and its samples are discarded.
- **DB state at run start.** The DB is a fresh temp directory. It is
  seeded before measurement with 1 bootstrap Action (bench group +
  `a_bench` membership) and, for `hot`, 1 entity Action. `--entities N`
  preloads N entities and is reported in each raw run file.
- **Fresh Action ids.** Every measured Action has a unique id, so it never
  hits the idempotency dedup path (which would consume zero GSNs and
  inflate the rate).
- **Latency sampling.** Client-side latency uses reservoir sampling capped
  at ~200,000 samples across all workers; percentiles describe the retained
  sample. Server-side telemetry samples are kept in ETS up to a
  2,000,000-sample cap.
- **RocksDB compaction/flush backlog is not measured.** The `rocksdb`
  package exposes no property for it and emits no `:telemetry` event.
- **`sync: false` is a ceiling only**, never a candidate configuration.
- **Machine class.** These are 4-scheduler VM numbers. Absolute rates will
  differ on other hardware; the relative shapes (batch, concurrency,
  distribution, fan-out) should reproduce.

## Gaps and follow-ups

1. **EntityGroup membership writes are no longer O(group size)** —
   [#331](https://github.com/ebbjs/ebbjs/issues/331) was fixed by
   `ad8e43b` (`:bag` → `:ordered_set`) and re-measured in this refresh:
   `spread` is ~14.1k/s (t2) instead of 883/s and 100k preload is ~21.4k/s
   instead of 204/s. The dirty set still grows (~1.16M in the t0 spread
   run), but it no longer degrades throughput.
2. **Any change that keeps a durable log append is capped at ~2.04×** — the
   append floor is already ~50% of the full flush (1.903 of 3.881 ms/flush,
   t0 b100, #485), so collapsing the dual store cannot deliver the spike's
   ≥2× on its own: it removes only a subset of the non-append work (`dirty`
   ≈ 0, `cache` 0.17 ms, part of `entity_index`) and leaves
   `cf_group_actions`, `cf_action_dedup` and the watermark in place. Batch
   coalescing ([#332](https://github.com/ebbjs/ebbjs/issues/332), commit
   count down ~5–6×, batch-1 throughput ~3×), `cf_updates` removal
   ([#338](https://github.com/ebbjs/ebbjs/issues/338), ~+15% at the headline
   config) and per-flush index dedup
   ([#339](https://github.com/ebbjs/ebbjs/issues/339), ~+14% on t0) are
   already spent; the next lever is spreading per-Action work across
   schedulers or multi-Writer
   ([#287](https://github.com/ebbjs/ebbjs/issues/287)).
3. **Fan-out: the ~140k ceiling was a harness artifact — the real ceiling is
   ~1.6M/s and non-CPU.** The previously published ~100–120k/~140k
   deliveries/s ceiling is **retracted**: it was the shared bench subscriber
   (one `:counters` ref and one `:bag` ETS lag table across all subscribers),
   fixed by `--subscriber-lean` (#510). Server-side `dispatched/s` equals
   `delivered/s`, so the server enqueues everything. The real ceiling is
   **~1–1.6M deliveries/s at ~40% CPU** (n=1000, r=3000: 1,616,299/s at 40.1%;
   n=1000, r=1000: 1,000,705/s at 24.2%), still **non-CPU** and
   configuration-dependent; re-probe it with the lean harness and profiling to
   find the remaining serialization (candidates: the single `FanOutRouter`, the
   per-subscriber `SSEConnection` → parent hop) before treating it as a server
   limit. **Coalesced delivery is merged** (#509): one binary per group per
   batch, one cast per subscriber, one `chunk/2`, identical wire bytes; with
   lean subscribers it is a **~6× delivered-throughput win and up to ~6× less CPU**,
   with a pre-#583 commit → broadcast complete p50 **~30 ms versus multi-second**
   pre-coalescing. The earlier "+2–22%"/"ceiling not removed" figure was
   artifact-capped on both arms. **Sharding is ruled out**: sharding one
   group's fan-out across K `GroupServer` processes (an earlier prototype, not
   merged) measured **flat** delivered/s across K=1/2/4/8 at n=1000 r=300
   (140,563 / 139,534 /
   139,866 / 137,747), but that sweep ran on the **coalesced** code (where the
   N×A loop is already gone) and with the shared subscriber, so its flat values
   sit on the harness cap. The `t3` Accepted/sec metric **remains confounded**
   (a faster-draining fan-out starves the in-process `:httpc` clients) and was
   also harness-capped; the corrected t3 tax is **−50% at 100 subscribers and
   −87% at 1000**. Note the t4 subscriber-split limitation: it splits a
   coalesced chunk into per-Action frames to count deliveries, so the coalesced
   arm carries client-side work the baseline arm did not; the utilization
   figures are therefore not a perfectly clean server-only measurement, though
   the extra client work only makes the ~6× CPU win at r=300 conservative. The
   production-shaped (real SSE socket) measurement remains outstanding — both
   t3 and t4 use in-process subscribers.
4. **10k-subscriber fan-out** — needs a dedicated load-test machine and is
   out of scope here.
5. **Action-log compaction/retention**
   ([#123](https://github.com/ebbjs/ebbjs/issues/123)) — a longer-horizon
   lever this harness does not exercise.
6. **The depth>1 scheduling path has no regression test.** The
   `advance_pipeline/1` state-discard that dropped claimed GSN ranges above
   depth 1 (see
   [Depth > 1 lost claimed ranges](#depth--1-lost-claimed-ranges-until-the-553-scheduling-fix))
   is covered only by the bench: no storage test drives a commit ack while a
   cap-sized (`:writer_batch_max_size`) burst is pending, which is the shape
   that fired it. A `Writer`-level test that claims at depth ≥ 2, leaves a
   1000-Action burst pending, and asserts that a freed slot flushes it into a
   second commit would pin it.
7. **t0 depth-1 may be ~9% slower than the #551 session.** 20,320/s here versus
   22,465/s then, with non-overlapping ranges on the same host and shape. The
   #551 rows predate #533/#534/#553, so this is plausibly the seam cost of the
   prepare/overlay/ordered-release work rather than drift. The rotated A/B in
   [Pre-epic vs current](#pre-epic-vs-current-a-rotated-ab-529) measured the
   same direction against pre-#531 (−24% rather than −9%), and
   [Step 0](#step-0-depth-1-parity-579-582-581) is the follow-up that closed
   most of it (−3.0%); re-read this gap against those two sections rather
   than the #551 session.
8. **README drift corrected.** `:writer_count`, `:warmer_*`, and
   `:replication_peers` are read by nothing; the server README states the
   actual single-Writer behavior. `:writer_batch_timeout_ms` and
   `:writer_batch_max_size` were read by nothing as of #328 and are now
   reintroduced and read by [#332](https://github.com/ebbjs/ebbjs/issues/332).
