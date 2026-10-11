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

Per-request latency (poll → response, includes msgpack encode + `:httpc`).
These are client-side numbers; per-run reports also carry server-side
latency sourced from `ebb.*` telemetry — see
[Server-side telemetry](#server-side-telemetry):

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
utilization at 100 subscribers vs ~17% without). Delivery lag is a
client-side stamp (send → delivery), so it folds in client and transport
overhead; the server's own `ebb.fanout.push_latency_ms` reports commit →
dispatch separately (see [Server-side
telemetry](#server-side-telemetry)). **10k subscribers were not measured**
— at 1,000 subscribers on a 4-scheduler VM the box is already saturated
and RSS is 1 GiB; a 10k-subscriber point needs a dedicated machine and is
out of scope here.

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

## Correctness under load

Clean across every measured run above: **0 rejected Actions, 0
write/transport errors, 0 GSN holes**, watermark lag high-water bounded
by one batch (≤100) and 0 at the end of the run.

## Server-side telemetry

Server-side latency is read from the `ebb.*` `:telemetry` events added by
[#359](https://github.com/ebbjs/ebbjs/issues/359)–[#364](https://github.com/ebbjs/ebbjs/issues/364).
`EbbServer.Bench.Telemetry` attaches handlers in the bench process before
the measured window and stamps every sample with its offset from the
window start:

| Event                         | Measures                               | Metadata                    |
| ----------------------------- | -------------------------------------- | --------------------------- |
| `ebb.http.request_latency_ms` | time inside the request process        | `method`, `route`, `status` |
| `ebb.writer.batch_latency_ms` | one durable Writer flush               | `gsn_start`, `gsn_end`      |
| `ebb.fanout.push_latency_ms`  | commit → dispatch, per batch per group | `group_id`                  |

Every raw run report prints a **Server-side latency** table beside the
client-side one, and the fan-out section reports commit → dispatch
separately from the client-stamp delivery lag. The Writer flush timer
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

1. **EntityGroup membership writes are O(group size)** — filed as
   [#331](https://github.com/ebbjs/ebbjs/issues/331). It drives both the
   `spread`↔`hot` gap and the 100k-preload collapse.
2. **Single-Writer ceiling ≈ 21–24k Actions/sec is per-Action-bound** — batch
   coalescing shipped in [#332](https://github.com/ebbjs/ebbjs/issues/332)
   (commit count down ~5–6×, batch-1 throughput ~3×), `cf_updates` was
   removed in [#338](https://github.com/ebbjs/ebbjs/issues/338) (~+15% at the
   headline config), and per-flush index writes were deduped in
   [#339](https://github.com/ebbjs/ebbjs/issues/339) (~+14% on t0); the
   batch-100 rate is still bound by per-Action Elixir work, so the next lever
   is spreading it across schedulers, or multi-Writer
   ([#287](https://github.com/ebbjs/ebbjs/issues/287)).
3. **10k-subscriber fan-out** — needs a dedicated load-test machine and is
   out of scope here.
4. **Action-log compaction/retention**
   ([#123](https://github.com/ebbjs/ebbjs/issues/123)) — a longer-horizon
   lever this harness does not exercise.
5. **README drift corrected.** `:writer_count`, `:warmer_*`, and
   `:replication_peers` are read by nothing; the server README states the
   actual single-Writer behavior. `:writer_batch_timeout_ms` and
   `:writer_batch_max_size` were read by nothing as of #328 and are now
   reintroduced and read by [#332](https://github.com/ebbjs/ebbjs/issues/332).
