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
[Pipeline depth](#pipeline-depth-n-in-flight-calls-551).

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
   win and up to ~6× less CPU**, and commit → broadcast complete p50 falls to
   **~30 ms versus multi-second** (see
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
CPU**, plus commit → broadcast complete p50 of **~30 ms versus multi-second**.

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

1. **Latency: commit → broadcast p50 falls from multi-second to ~30 ms.** With
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
entity_index, group_index, dirty, cache, watermark, fanout`
(comma-separated). `build` and `encode` were added by
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

## Concurrent `write_batch` from multiple BEAM processes (#530)

Gating spike for epic [#529](https://github.com/ebbjs/ebbjs/issues/529). The
question was whether `:rocksdb.write_batch/3` can be called concurrently from
independent BEAM processes and actually overlap, or whether the NIF / RocksDB
serializes them. The NIF registers `write_batch` as
`ERL_NIF_DIRTY_JOB_IO_BOUND` and calls `DB::Write` directly, with no
per-database lock; the only serialization is RocksDB's own write thread.
The source trace is in
[`docs/research/530-concurrent-write-batch.md`](../../docs/research/530-concurrent-write-batch.md).

Measured **2026-10-19** on `recsy-vps` (same host as the tables above) with the
new `--tier t5` harness. Each caller is one BEAM process; caller `i` writes a
disjoint, contiguous 100-GSN range per call and each call commits the
production-shaped 100-Action × 2-Update batch (502 `cf_*` puts for `hot`; 700 for
`spread`). Batch assembly
(`Workbook` → action validation → ETF → `batch_put`) happens before the timer,
so the latency columns are the raw `:rocksdb.write_batch/3` call; the rate
column is wall Actions/sec and includes assembly. `enable_pipelined_write:
true`, `max_background_jobs: 4`, fresh temp DB, 20 s measured window after 3 s
warmup, median of 5 runs; the range is min–max across those runs.

```sh
mix bench.actions --tier t5 --concurrency 2 --duration 20 --warmup 3 \
  --batch-size 100 --updates-per-action 2 --distribution hot --durability sync
```

| Callers | `sync` | Actions/sec (median) |           Range | write_batch p50 |     p95 | Scheduler util | Speedup |
| ------: | :----- | -------------------: | --------------: | --------------: | ------: | -------------: | ------: |
|       1 | true   |               41,825 |   30,875–42,315 |         1.38 ms | 1.82 ms |           5.2% |   1.00× |
|       2 | true   |               75,810 |   70,505–76,890 |         1.42 ms | 2.55 ms |          10.0% |   1.81× |
|       4 | true   |               83,700 |   81,260–84,985 |         3.26 ms | 5.70 ms |          13.5% |   2.00× |
|       1 | false  |               61,885 |   61,575–63,645 |         0.59 ms | 0.77 ms |           7.9% |   1.00× |
|       2 | false  |               98,420 |  92,775–103,165 |         0.66 ms | 1.41 ms |          14.0% |   1.59× |
|       4 | false  |              116,800 | 114,695–119,210 |         1.40 ms | 4.08 ms |          22.4% |   1.89× |

**Verdict: go for #531.** The NIF does not serialize callers. Two sync callers
raise wall throughput **1.81×** while per-call p50 stays flat (1.38 → 1.42 ms),
which implies (derived from the flat per-call latency) the commit call itself scales
~**1.94×** (two lanes at nearly the same per-call latency) — above the research
note's _S_ ≥ 1.5 bar for the commit leg. At _S_ ≈ 1.94 the note's Phase-1 ceiling
is ~**1.32× end-to-end**, well above the epic's 1.08–1.15× estimate. The `sync: false` arm shows the same shape (1.59× wall, p50 0.59 →
0.66 ms), so fsync/group commit is not the limit. Four callers keep adding
throughput (2.00× sync, 1.89× async) but with rising p50/p95, i.e. sub-linear
scaling and queueing rather than a hard lock. Scheduler utilisation stays at
5–22% of the 8 normal + dirty-CPU scheduler entries — at most ~45% of the four
normal schedulers, since dirty-CPU is idle — so the 4-caller latency rise is not
normal-scheduler starvation. `:erlang.statistics(:scheduler_wall_time)` does not
cover dirty-IO time; the dirty-IO claim comes from the NIF registration
(`ERL_NIF_DIRTY_JOB_IO_BOUND`, `dirty_io=10`), not from an occupancy sample.

The 4-caller sync arm is not a reason to stop Phase 1: #531 needs two
committers to pay for the pipeline, and the flat p50 at two callers clears the
commit-leg bar. The step from 2 to 4 callers — p50 rises 2.3× and throughput
rises only ~10% — is RocksDB write-thread queueing plus background
flush/compaction at a much higher write rate, not the NIF; it is the same
territory as the write-stall hardening in
[#538](https://github.com/ebbjs/ebbjs/issues/538).

Caveats: the measured `t5` path bypasses the Writer, so its caches, watermark,
and fan-out stay idle (the storage tree still boots to open the DB and seed the
bench context). Its GSNs are synthetic (`1e9 × caller`) and its holes/lag are
reported `n/a`; the peak-dirty row is Workbook seed residue, not a t5 signal.
The rate includes per-call batch assembly (normal schedulers), so do not
compare it directly to `t0`/`t2`. The first sync/1 run (30,875/s) was the first
run of the batch and is cold; the other four were 41,150–42,315/s. The table's
median is robust to it, and the range is reported rather than hidden.

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

## Pipeline depth: N in-flight calls (#551)

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

> **Post-#533 harness change.** The tables below were measured before the
> cross-flush overlay landed. Since #533 the bench also boots the Writer with
> `max_in_flight = min(depth, 4)`, so a depth row now changes the Writer's
> claimed-range depth as well as the harness's outstanding calls. Re-measure
> this matrix against the new harness before treating these rows as current.

The workload uses the headline shape: batch 100, 2-Update Actions, `hot`,
`sync: true`. Measured **2026-10-19** on `recsy-vps`, 20 s window after 3 s
warmup, five reports per tier, each report containing every depth. The
median across the five passes is reported with the min–max range in
parentheses; the raw per-pass reports were the `--out` files from that
measurement and are not committed. Every run below had **0 rejected Actions, 0
write/transport errors, 0 GSN holes**; the final watermark lag was 0 except
at depth > 1, where the last 1 Hz sample still catches the calls that were in
flight when the window closed (255–283 GSNs at t2 depth 2/4).

```sh
mix bench.actions --tier t0 --duration 20 --warmup 3 --concurrency 1 \
  --in-flight 1,2,4 --batch-size 100 --updates-per-action 2 --distribution hot --seed 1
mix bench.actions --tier t2 --duration 20 --warmup 3 --concurrency 8 \
  --in-flight 1,2,4 --batch-size 100 --updates-per-action 2 --distribution hot --seed 1
```

### t0, one caller

| Callers | Calls in flight | Actions/sec (median) |         Range | Δ vs depth 1 | p50 (ms) | p95 (ms) | p99 (ms) | Actions/flush | Flush p50 (ms) | Commit p50 (ms) | Lag high-water |
| ------: | --------------: | -------------------: | ------------: | -----------: | -------: | -------: | -------: | ------------: | -------------: | --------------: | -------------: |
|       1 |               1 |               22,465 | 21,845–22,595 |            — |     4.14 |     5.25 |     6.34 |           100 |           3.49 |            2.11 |            100 |
|       1 |               2 |               25,765 | 22,205–26,240 |       +14.7% |     7.27 |     9.01 |    10.54 |           100 |           3.48 |            1.93 |            100 |
|       1 |               4 |               23,650 | 22,830–25,040 |        +5.3% |    16.05 |    19.44 |    21.57 |           201 |           7.25 |            3.43 |            211 |

Depth 2 is the only positive delta (**+14.7%** by median) and it is not
pipeline parallelism: the Writer still keeps one range in flight, the flush
stays 100 Actions, and its p50 stays 3.48 ms. Four of the five depth-2 passes
landed at 25,590–26,240/s, above every depth-1 pass (21,845–22,595/s); one
sampled 22,205, which is the only reason the min–max ranges overlap. The
reading consistent with the flat flush numbers is overlap of the _client-side_
work: the next call's Action construction, validation, and encode happen while
the Writer commits the previous one, so the sequencer is not idle waiting for
the caller's next `GenServer.call`. That is the work
[#553](https://github.com/ebbjs/ebbjs/issues/553) proposes to make an explicit
prepare stage. The delta sits in the 1.08–1.15× band the epic says a single run
cannot resolve; five 20 s reports is the method used here, and a dedicated run
on a quiet host should confirm the size before it is quoted as a win.

Depth 4 drops back to +5.3% because the two extra calls now coalesce into a
201-Action flush (p50 7.25 ms) whose per-Action cost is slightly worse, while
the overlap gain is already spent. p50 client latency grows with depth
(4.1 → 7.3 → 16.1 ms) because a call waits behind the flush it was coalesced
into; throughput is the metric to read here.

### t2, eight callers

| Run         | Calls in flight | Actions/sec (median) |         Range | Δ vs t0 baseline | p50 (ms) | p95 (ms) | p99 (ms) | Actions/flush | Flush p50 (ms) | Commit p50 (ms) | Lag high-water |
| :---------- | --------------: | -------------------: | ------------: | ---------------: | -------: | -------: | -------: | ------------: | -------------: | --------------: | -------------: |
| t0 baseline |               1 |               21,435 | 21,230–22,300 |                — |     4.20 |     5.84 |     7.75 |           100 |           3.54 |            2.14 |            100 |
| t2 pipeline |               1 |               17,985 | 17,025–18,925 |           −16.1% |    42.08 |    52.39 |    57.39 |           400 |          19.03 |            6.32 |            446 |
| t2 pipeline |               2 |               15,760 | 14,240–16,770 |           −26.5% |    98.28 |   113.89 |   125.70 |           800 |          49.89 |           12.20 |           1000 |
| t2 pipeline |               4 |               11,900 | 11,030–12,320 |           −44.5% |   261.70 |   310.60 |   336.13 |          1600 |         126.24 |           22.30 |           1660 |

**Depth hurts at t2.** Eight callers already coalesce into a 400-Action flush
per commit, and each extra call in flight multiplies that: 800 Actions at
depth 2, 1600 at depth 4. The commit leg scales roughly linearly (6.3 → 12.2 →
22.3 ms) but the sequencer-side flush grows faster than the Action count
(19.0 → 49.9 → 126.2 ms for 1×/2×/4× the Actions), so throughput falls 12.4%
from depth 1 to 2 and 33.8% from 1 to 4. Scheduler utilisation stays at
20–25% of four schedulers, so this is not client-side CPU starvation; it is
per-Action cost inside the serialized flush plus the larger burst's queueing.

### Separating depth from flush size

The t2 table above changes two things at once: pipeline depth and the coalesced
flush size. Two same-session follow-ups separate them.

**One caller, varying depth** (`--tier t2 --concurrency 1`, five reports):

| Callers | Calls in flight | Actions/sec (median) |         Range | Δ vs depth 1 | p50 (ms) | Actions/flush | Flush p50 (ms) | Commit p50 (ms) |
| ------: | --------------: | -------------------: | ------------: | -----------: | -------: | ------------: | -------------: | --------------: |
|       1 |               1 |               13,020 | 11,055–13,120 |            — |     6.67 |           100 |           3.52 |            2.03 |
|       1 |               2 |               21,745 | 21,170–21,930 |         +67% |     8.01 |           100 |           3.77 |            1.97 |
|       1 |               4 |               21,095 | 21,035–22,220 |         +62% |    17.53 |           199 |           8.01 |            3.40 |

The t0 depth-1 baseline measured in the same five reports was **22,705**
(22,315–23,925).

**Constant offered burst** (`--tier t2`, `callers × calls in flight = 8`, five
runs per row):

| Callers | Calls in flight | Actions/sec (median) |         Range | p50 (ms) | Actions/flush | Flush p50 (ms) | Commit p50 (ms) |
| ------: | --------------: | -------------------: | ------------: | -------: | ------------: | -------------: | --------------: |
|       8 |               1 |               19,415 | 19,110–20,295 |    39.29 |           400 |          18.15 |            6.92 |
|       4 |               2 |               20,210 | 18,260–20,575 |    37.91 |           400 |          17.46 |            6.87 |
|       2 |               4 |               20,305 | 19,355–20,680 |    37.60 |           400 |          17.32 |            6.50 |
|       1 |               8 |               20,200 | 18,075–20,225 |    37.98 |           400 |          18.11 |            6.96 |

Three things follow. First, at a constant offered burst every configuration
coalesces to the same 400 Actions/flush and lands at 19.4–20.3k with
overlapping ranges: **once the flush shape is held, depth is throughput-neutral**.
That is the clean form of "the current pipeline cannot use depth". Second, the
penalty in the t2 table above is flush bloat, not depth: going 8 → 16 → 32
outstanding calls lifts the flush 400 → 800 → 1600 and the per-Action cost with
it. Third, the one-caller sweep shows where the headroom actually is: with a
single serial caller the client is the bottleneck — each 6.7 ms call leaves the
sequencer idle while MessagePack, the request, the response, and the next
Action build run — so depth 2 lifts throughput **67%** with the flush unchanged.
That is the same "keep the sequencer fed" effect as the t0 depth-2 row,
amplified by the HTTP round trip. Depth 4 coalesces (199/flush) and adds
queueing without throughput.

Practically: **one client keeping two calls in flight beats eight serial clients**
on throughput (21,745 vs 19,415) and on p50 (8.0 ms vs 39.3 ms) at an eighth of
the connections. That is a client-side pipelining lever
([#201](https://github.com/ebbjs/ebbjs/issues/201) territory), not a
committer-pool win — and it needs a production client that pipelines, which is
out of scope for #551.

Caveat: the two tables were measured in different sessions. The t2 sweep table's
rows come from a session whose own t0 baseline was 21,435; this subsection's was
22,705, and the same c=8 depth-1 config measured 19,415 here versus 17,985
there. Compare rows within a table, not across tables.

### Verdict for the pipeline

The workload the epic wants to optimize (#551) shows **no temporal-parallelism
gain** on the pipeline as measured: depth could not overlap commits because
`max_in_flight` was 1. At a constant offered burst, depth is throughput-neutral
(19.4–20.3k across 8×1, 4×2, 2×4, 1×8) because every shape coalesces to the same
400-Action flush. The measurable wins — t0 depth 2 and t2 one-caller depth 2 —
come from keeping the sequencer fed while the caller prepares the next batch, not
from parallel commits. Increasing depth at a fixed caller count does not add
independent batches: it only deepens the coalesced flush, and past ~400 Actions
that costs throughput. V2 (#533/#534) has to show a gain on _this_ workload at a
comparable flush size; a depth sweep that only grows the batch is not evidence of
pipeline parallelism, and the constant-burst table is the control it should be
compared against.

### Harness model and limitations

- **What "in flight" counts.** The peak/mean columns count the harness's own
  outstanding `write_actions/1` calls per worker, not the Writer's in-flight
  batches. The Writer has no gauge for that yet
  ([#537](https://github.com/ebbjs/ebbjs/issues/537)); the rows below kept one
  claimed range in flight (`max_in_flight: 1`), which is what isolates the
  coalescing effect. Since #533 the harness raises `max_in_flight` with depth,
  so a re-measure mixes in the Writer's own pipeline depth.
- **The workload is not an isolated depth knob.** At a fixed `--concurrency`,
  a deeper pipeline means more calls waiting when the Writer flushes, so the
  flush grows. Compare depth rows against the `Actions/flush` and `Flush p50`
  columns before attributing a change to pipeline depth.
- **Fresh DB per depth.** Each pass boots an isolated storage tree and reseeds
  the bench context, so no depth pays for another's cache, dirty set, or
  compaction state. The t0 baseline is a separate boot too.
- **Baseline in the same report.** The t0 row is measured by the same process
  on the same host immediately before the pipelined passes; it is the
  no-regression check against the 22–26k t0 range published above, not a
  historical constant.
- **Ordering and noise.** Within a report the passes run baseline, 1, 2, 4, so
  late passes see slightly more host drift; the min–max ranges above overlap in
  places and a ±5–10% single-run delta is not resolvable on this VM.
- **Client overhead at t2.** The t2 rows include `:httpc`, MessagePack, and the
  request process; t0 is the cleaner pipeline number. Both tiers use the same
  Action shape and `sync: true`.

## Prepare stage (#553)

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

## Correctness under load

Clean across every measured run above: **0 rejected Actions, 0
write/transport errors, 0 GSN holes**, watermark lag high-water bounded
by one batch (≤100) and 0 at the end of the run. The `t5` spike has no
Writer frontier, so its GSN holes and watermark lag are `n/a` rather than
zero.

## Server-side telemetry

Server-side latency is read from the `ebb.*` `:telemetry` events added by
[#359](https://github.com/ebbjs/ebbjs/issues/359)–[#364](https://github.com/ebbjs/ebbjs/issues/364).
`EbbServer.Bench.Telemetry` attaches handlers in the bench process before
the measured window and stamps every sample with its offset from the
window start:

| Event                          | Measures                                               | Metadata                    |
| ------------------------------ | ------------------------------------------------------ | --------------------------- |
| `ebb.http.request_latency_ms`  | time inside the request process                        | `method`, `route`, `status` |
| `ebb.writer.batch_latency_ms`  | one durable Writer flush                               | `gsn_start`, `gsn_end`      |
| `ebb.writer.commit_latency_ms` | Committer wrapper encode + op assembly + `write_batch` | `gsn_start`, `gsn_end`      |
| `ebb.fanout.push_latency_ms`   | commit → broadcast complete, per batch per group       | `group_id`                  |

Every raw run report prints a **Server-side latency** table beside the
client-side one, and the fan-out section reports commit → broadcast complete
separately from the client-stamp delivery lag. It fires at the end of
`GroupServer.handle_cast({:push_actions, ...})`, after the per-subscriber
cast loop (O(N×A) before coalescing, O(N) after #509).
The Writer flush timer
starts after the request is dequeued, so the wait a call spends in the
Writer mailbox is not instrumented. `--tier t0` has no HTTP request, so
only the Writer flush is reported there.

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
   with commit → broadcast complete p50 **~30 ms versus multi-second**
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
6. **README drift corrected.** `:writer_count`, `:warmer_*`, and
   `:replication_peers` are read by nothing; the server README states the
   actual single-Writer behavior. `:writer_batch_timeout_ms` and
   `:writer_batch_max_size` were read by nothing as of #328 and are now
   reintroduced and read by [#332](https://github.com/ebbjs/ebbjs/issues/332).
