# ebb_server Actions/sec benchmark results

Headline results for the `ebb_server` write path, produced by
`mix bench.actions`. This is the trustworthy replacement for the
unverified numbers inherited from the raw-RocksDB spike (#130): the runs
below go through the real `ebb_server` pipeline, not a storage primitive.

Raw per-run Markdown output lands in `bench/results/` (gitignored); the
tables here are the published subset.

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
  --batch-size 100 --distribution hot
```

Tier meanings: `t0` = `Writer.write_actions/1` directly; `t1` = real
`POST /sync/actions` at concurrency 1; `t2` = `POST /sync/actions` at the
requested concurrency; `t3` = `t2` plus in-process SSE subscribers.

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

## Headline: production configuration

Single Writer, `sync: true`, 2-Update Actions, `--distribution hot`,
batch 100 Actions/request.

| Window           | Seconds |  Accepted | Accepted/sec | Rejected |
| ---------------- | ------: | --------: | -----------: | -------: |
| burst (0–15s)    |      15 |   233,300 |   **15,553** |        0 |
| steady (61–120s) |      59 |   890,200 |   **15,088** |        0 |
| overall          |     120 | 1,835,700 |       15,298 |        0 |

Above the saturation point (concurrency 64, same everything else):

| Window           | Seconds |  Accepted | Accepted/sec | Rejected |
| ---------------- | ------: | --------: | -----------: | -------: |
| burst (0–15s)    |      15 |   224,800 |       14,987 |        0 |
| steady (61–120s) |      59 |   850,600 |       14,417 |        0 |
| overall          |     120 | 1,746,000 |       14,550 |        0 |

Per-request latency (poll → response, includes msgpack encode + `:httpc`;
there is no server-side `:telemetry` yet, see #125):

| Run                    |      p50 |      p95 |      p99 |
| ---------------------- | -------: | -------: | -------: |
| concurrency 8, burst   |  49.2 ms |  60.6 ms |  92.3 ms |
| concurrency 8, steady  |  51.5 ms |  61.4 ms |  71.2 ms |
| concurrency 64, steady | 441.7 ms | 485.1 ms | 513.1 ms |

Both runs: **0 rejected Actions, 0 GSN holes, final watermark lag 0**;
peak RSS 511 MiB (c=8) and 645 MiB (c=64).

**Verdict.** Production is a single Writer with `sync: true`. On this
machine it sustains ~15.1k Actions/sec, inside the README's 10–20k
target. The old 108k headline was a 2-writer raw-RocksDB primitive and is
not reproducible through `ebb_server` — the ceiling here is the
single-Writer serialization plus per-Action Elixir work, not the disk.

## Tier and storage ceiling

| Run                           | Tier | Batch | Conc | Burst /s | Steady /s | Overall /s |      p50 |      p95 |      p99 |
| ----------------------------- | ---- | ----: | ---: | -------: | --------: | ---------: | -------: | -------: | -------: |
| Storage ceiling, 120s         | t0   |   100 |    1 |   16,033 |    15,825 |     16,043 |   5.8 ms |   7.7 ms |  11.0 ms |
| Single HTTP client, 10s       | t1   |   100 |    1 |    9,610 |       n/a |      9,610 |   9.1 ms |  11.4 ms |  13.1 ms |
| Production, 120s              | t2   |   100 |    8 |   15,553 |    15,088 |     15,298 |  51.5 ms |  61.4 ms |  71.2 ms |
| Above saturation, 120s        | t2   |   100 |   64 |   14,987 |    14,417 |     14,550 | 441.7 ms | 485.1 ms | 513.1 ms |
| Async durability ceiling, 30s | t2   |   100 |    8 |   14,093 |       n/a |     16,327 |  43.2 ms |  71.8 ms |  90.6 ms |

`t0` ≈ `t2` shows the HTTP/Bandit layer is not the ceiling at batch 100;
the storage path is. The `--durability async` run (`sync: false`) is only
~3–8% faster than the `sync: true` run, so fsync is not the dominant cost
at this batch size — the Elixir-side write path is, matching #130's
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

T2, batch 100, concurrency 8, 2-Update Actions, 30s windows:

| Distribution                                    | Burst /s | Overall /s |     p50 | Peak RSS | Peak dirty set |
| ----------------------------------------------- | -------: | ---------: | ------: | -------: | -------------: |
| `hot` (one entity, LWW contention)              |   15,147 |     15,347 | 50.7 ms |  457 MiB |              4 |
| `spread` (fresh entity + membership per Action) |    1,147 |        883 |  799 ms |  297 MiB |         80,602 |

`spread` is ~17× slower than `hot` **at the storage layer** (t0 spread is
also ~1,070/s), so this is a real write-path cost, not HTTP or fan-out:
creating a new entity plus its membership row per Action is far more
expensive than re-putting one hot row. The group index and dirty set grow
monotonically in `spread`, and the growth is the same `EntityGroupCache`
cost identified below.

## DB state: fresh vs entities preloaded

T2, batch 100, concurrency 8, hot. `hot` re-puts one membership row; the
by-group ETS bag then holds every preloaded membership under the single
bench group.

| Preloaded entities | Window |     Accepted/sec |      p50 | Peak dirty set |
| -----------------: | -----: | ---------------: | -------: | -------------: |
|          0 (fresh) |   120s |           15,088 |  51.5 ms |              4 |
|             10,000 |    30s |            2,353 | 336.8 ms |         20,004 |
|            100,000 |    90s | 204 (steady 207) |    3.9 s |        200,004 |

This is **not** a clean memtable/compaction measurement: the rate
degrades linearly with group membership count because
`EntityGroupCache.put_entity_group/2` maintains a `:bag` keyed by group
id, and ETS `:bag` insert/delete traverses the key's bucket — O(group
size) per membership write. A micro-benchmark of the function alone: 431
distinct inserts/sec and 3,970 µs per re-put with 100k members in the
group. The same mechanism drives the `spread`↔`hot` gap above. Filed as
[#331](https://github.com/ebbjs/ebbjs/issues/331); a clean
compaction-effect measurement is blocked until it is fixed.

## Fan-out tax on write throughput

T3, batch 10, concurrency 8, hot, 15s windows, comparing to the T2
baseline at the same batch/concurrency (6,677 Actions/sec):

|     Subscribers | Accepted/sec | vs T2 | p50 request | Delivery lag p50 | Delivery lag p99 |  Peak RSS |
| --------------: | -----------: | ----: | ----------: | ---------------: | ---------------: | --------: |
| 0 (T2 baseline) |        6,677 |     — |           — |                — |                — |         — |
|             100 |        1,176 |  −82% |     58.2 ms |           813 ms |         2,711 ms |   384 MiB |
|            1000 |          611 |  −91% |     59.7 ms |         7,655 ms |        17,174 ms | 1,031 MiB |

Every subscriber receives a JSON-encoded event per Action, so fan-out
cost scales with subscriber count and dominates the scheduler (49%
utilization at 100 subscribers vs ~17% without). Delivery lag includes
server-side queueing before the commit (there is no commit timestamp
without `:telemetry`), so it is an upper bound, not a commit→delivery
measurement. **10k subscribers were not measured** — at 1,000 subscribers
on a 4-scheduler VM the box is already saturated and RSS is 1 GiB; a
10k-subscriber point needs a dedicated machine and is out of scope here.

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

## Correctness under load

Clean across every measured run above: **0 rejected Actions, 0
write/transport errors, 0 GSN holes**, watermark lag high-water bounded
by one batch (≤100) and 0 at the end of the run.

## Methodology and limitations

- **Outside-in measurement.** Server-side `:telemetry` does not exist yet
  (#125), so throughput and latency are measured by wrapping the call from
  the client process. HTTP latencies include MessagePack encoding,
  connection reuse, and `:httpc` request-manager overhead.
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
- **Latency sampling.** Reservoir sampling capped at ~200,000 samples
  across all workers; percentiles describe the retained sample.
- **RocksDB compaction/flush backlog is not measured.** The `rocksdb`
  package exposes no property for it and there is no telemetry hook.
- **`sync: false` is a ceiling only**, never a candidate configuration.
- **Machine class.** These are 4-scheduler VM numbers. Absolute rates will
  differ on other hardware; the relative shapes (batch, concurrency,
  distribution, fan-out) should reproduce.

## Gaps and follow-ups

1. **EntityGroup membership writes are O(group size)** — filed as
   [#331](https://github.com/ebbjs/ebbjs/issues/331). It drives both the
   `spread`↔`hot` gap and the 100k-preload collapse.
2. **Single-Writer ceiling ≈ 15k Actions/sec is per-Action-bound** — batch
   coalescing shipped in [#332](https://github.com/ebbjs/ebbjs/issues/332)
   and does not move the batch-100 rate (see the section above); the next
   lever is spreading per-Action work across schedulers, or multi-Writer
   ([#287](https://github.com/ebbjs/ebbjs/issues/287)).
3. **No commit-level telemetry**
   ([#125](https://github.com/ebbjs/ebbjs/issues/125)) — fan-out delivery
   lag is a client-side upper bound until `Writer`/`FanOutRouter` emit
   timestamps.
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
