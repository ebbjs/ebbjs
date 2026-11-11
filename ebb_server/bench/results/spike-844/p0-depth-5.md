# ebb_server Actions/sec benchmark

Generated 2026-11-11T14:42:20.059916Z on `recsy-vps`.

**Tier t4** — fixed-rate Writer.write_actions/1 plus in-process SSE subscribers.

## Environment

| Field | Value |
| --- | --- |
| Hostname | recsy-vps |
| Kernel | Linux recsy-vps 6.8.0-147-generic #147-Ubuntu SMP PREEMPT_DYNAMIC Thu Sep 24 11:33:16 UTC 2026 x86_64 x86_64 x86_64 GNU/Linux |
| CPU | AMD EPYC 7763 64-Core Processor (4 schedulers) |
| Total memory | 16377008 kB |
| Elixir | 1.17.3 |
| OTP | 27 |
| RocksDB max_background_jobs | 4 |
| RocksDB enable_pipelined_write | true |
| RocksDB sync | true (prod default; false only for --durability async) |

## Configuration

| Option | Value |
| --- | --- |
| Tier | t4 (fixed-rate Writer.write_actions/1 plus in-process SSE subscribers) |
| Append engine | current — one write_batch/3 (NIF time only) |
| Measured window | 20s |
| Warmup | 3s |
| Concurrency | 1 |
| Calls in flight per worker | 1 |
| Actions per call/request | 10 |
| Updates per Action | 2 |
| Distribution | hot |
| Durability | sync |
| Preloaded entities | 0 |
| SSE subscribers | 1000 |
| Fan-out conn sample rate | 1 in 100 |
| Target Actions/sec | 300 |
| Writer batch timeout | 0 ms (burst drain) |
| Writer batch cap | 1000 Actions |
| Writer commit timeout | 2000 ms |
| Stalled commits | none |
| Writers | 1 |
| Ablated phases | none |
| Guardrails | enforced |
| Baseline | none |
| Port | 4111 |
| Seed | 1 |
| Output | /tmp/base2/t4-lean-1-1794408109.md |
| Subscriber mode | lean (per-subscriber counters, no lag sampling) |

Reproduction command:

```sh
mix bench.actions --tier t4 --duration 20 --warmup 3 --concurrency 1 --in-flight 1 --batch-size 10 --updates-per-action 2 --distribution hot --durability sync --entities 0 --subscribers 1000 --rate 300 --batch-timeout-ms 0 --batch-max-size 1000 --commit-timeout-ms 2000 --conn-sample-rate 100 --writers 1 --port 4111 --seed 1 --subscriber-lean --out /tmp/base2/t4-lean-1-1794408109.md
```

## Writer pipeline

| Run | Actions/flush | Flush p50 (µs) |
| --- | --- | --- |
| pipeline | 10 | 1725 |

`Actions/flush` and `Flush p50` come from `ebb.writer.batch_latency_ms`, so they describe the coalesced flush this run actually produced rather than the requested burst; the gauges and phases below are the same tables a sweep renders in its pipeline-depth section.

### Writer pipeline gauges

| Run | `queue_depth` peak | `queue_depth` mean | `in_flight_batches` peak | `in_flight_batches` mean | `oldest_unreleased_gsn` peak | `oldest_unreleased_gsn` mean |
| --- | --- | --- | --- | --- | --- | --- |
| pipeline | 1 | 1.0 | 1 | 0.5 | 4883 | 1224.0 |

`queue_depth` is the number of `write_actions/1` calls one flush drained, taken from `ebb.writer.batch_size`'s `callers`, so its peak/mean describe how deep the coalescing queue got, not a sampled mailbox length. The other two columns are the Writer's own `ebb.writer.in_flight_batches` and `ebb.writer.oldest_unreleased_gsn` gauges, emitted on every claim and release, so they describe the actual reorder buffer rather than the harness-side outstanding-call figures a depth sweep reports. `in_flight_batches` counts every open claim, including one applying; `oldest_unreleased_gsn` is the head of the claim order and `0` when the buffer is empty, so its mean includes idle samples.

### Flush phases (p50 / p95, µs)

| Run | queue | prepare | resolve | commit_wait | apply | notify | sum p50 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| pipeline | 49 / 1019 | 31 / 55 | 313 / 2742 | 1495 / 33358 | 46 / 81 | 19 / 38 | 2293 |

Each phase cell is `p50 / p95` in µs. The six phases sum to one claimed range's lifetime, from the oldest coalesced call's send to the end of its `notify` phase, so `sum p50` (the per-range sum the collector records as `flush_total`) is the flush a caller waited on. `queue` and `prepare` are the terms `ebb.writer.batch_latency_ms` cannot see, because its timer starts after the request is dequeued and the payload is built. A phase that did not run is `0`, not missing, so an abandoned range reports `0` for the phases it never reached.

## Throughput

| Window | Seconds | Accepted | Accepted/sec | Rejected |
| --- | --- | --- | --- | --- |
| burst | 15 | 3750 | 250.0 | 0 |
| overall | 20 | 4880 | 244.0 | 0 |

## Latency

| Window | Samples | p50 | p95 | p99 |
| --- | --- | --- | --- | --- |
| burst | 375 | 2366 | 34164 | 68736 |
| overall | 488 | 2427 | 34429 | 68736 |

Client-side values are wall time around `:httpc` for one request, including MessagePack encoding, transport, and response parsing; server-side `ebb.http.request_latency_ms` measures the request inside the server, so the difference is client and transport overhead. `ebb.writer.batch_latency_ms` reports the durable flush separately; the wait a request spends in the Writer mailbox sits between the two and is reported by `ebb.writer.flush_phase_ms` as `queue` (with `prepare` measured beside it), whose phase table a sweep renders in the pipeline-depth section.

## Server-side latency (`ebb.*` telemetry)

| Event | Window | Samples | p50 | p95 | p99 |
| --- | --- | --- | --- | --- | --- |
| `ebb.writer.batch_latency_ms` | burst | 375 | 1708 | 33745 | 68405 |
| `ebb.writer.batch_latency_ms` | overall | 488 | 1725 | 33888 | 68405 |
| `ebb.writer.commit_latency_ms` | burst | 375 | 1373 | 32185 | 67801 |
| `ebb.writer.commit_latency_ms` | overall | 488 | 1377 | 33026 | 67393 |
| `ebb.fanout.push_latency_ms` | burst | 375 | 3922 | 63970 | 68756 |
| `ebb.fanout.push_latency_ms` | overall | 488 | 4046 | 64330 | 68756 |

Captured in the bench process by attaching handlers to the server's `ebb.*` events. `ebb.http.request_latency_ms` is measured inside the request process, so MessagePack encoding and transport are excluded; `ebb.writer.batch_latency_ms` covers one durable Writer flush, and `ebb.writer.commit_latency_ms` is the Committer's share of it (frame encode + `cf_*` op assembly + `write_batch`); `ebb.fanout.push_latency_ms` starts at the end of the post-commit apply (the fan-out notify send) and ends at the end of the `GroupServer` cast, per batch per group. `ebb.writer.batch_latency_ms` starts after the request is dequeued, so the wait a call spends in the Writer mailbox is not part of it: `ebb.writer.flush_phase_ms` reports that wait as `queue`, with `prepare` beside it, and a sweep renders the phase table in the pipeline-depth section. Durations are converted from native time units to microseconds and windowed like the client-side samples.

## Fixed-rate fan-out (T4)

| Metric | Value |
| --- | --- |
| Target write rate | 300 Actions/sec |
| Achieved write rate | 244.0 |
| Subscribers | 1000 |
| Delivered Actions/sec | 243446.3 |
| Delivered per subscriber/sec | 243.4 |
| Server dispatched Actions/sec | 244000.0 |

Commit → broadcast complete latency (`ebb.fanout.push_latency_ms`) per 10s bucket:

| From second | Samples | p50 (µs) | p95 (µs) |
| --- | --- | --- | --- |
| 0 | 240 | 4142 | 64977 |
| 10 | 248 | 3916 | 36190 |

A flat p50 across buckets means fan-out keeps up; a rising p50 means the Router is falling behind the commit stream. `Server dispatched Actions/sec` counts the deliveries the server enqueued (`count × subscribers` per dispatched batch); `Delivered Actions/sec` counts what the bench subscribers actually received. If the two match, the server is the limit; if dispatched far exceeds delivered, the bench subscriber is the limit.

## Fan-out latency breakdown

| Hop | Samples | p50 (µs) | p95 (µs) | p99 (µs) |
| --- | --- | --- | --- | --- |
| `router_queue` | 488 | 45 | 168 | 1357 |
| `router_dwell` | 0 | n/a | n/a | n/a |
| `router_decode` | 488 | 61 | 95 | 118 |
| `router_encode` | 488 | 105 | 206 | 549 |
| `group_queue` | 488 | 14 | 85 | 2326 |
| `group_encode` | 488 | 1 | 9 | 23 |
| `group_cast` | 488 | 3679 | 64018 | 68460 |
| `conn_deliver` | 4880 | 683 | 4087 | 62764 |
| `conn_chunk` | 0 | n/a | n/a | n/a |

| Measurement | Samples | p50 (µs) | p95 (µs) | p99 (µs) | Δ vs push p50 (µs) | Δ vs push p50 |
| --- | --- | --- | --- | --- | --- | --- |
| `ebb.fanout.push_latency_ms` (re-based) | 488 | 4046 | 64330 | 68756 | — | — |
| `writer_notify` (context: #537 `notify` phase) | 488 | 19 | 38 | 51 | — | — |
| Sum of push-side hop p50s | — | 3905 | — | — | -141 | -3.5% |

Each hop is one `ebb.fanout.hop_ms` sample per range per hop (per range per group for the group hops), emitted by the server on the same measured window as every other `ebb.*` sample. `router_queue` runs from the Writer's notify send to the Router's `handle_info/2`; `router_dwell` is the wait in `Plan` for the committed watermark and is emitted only when a range actually waits, so an empty row means no range was held; `router_decode` is the `range_iterator` plus decode and group split; `router_encode` resolves the groups with a live `GroupServer` and builds their frames, one encode per (Action, distinct Update subset) for the whole range; `group_queue` is the cast to the `GroupServer` entry; `group_encode` is the flatten of the frames the Router built, not a frame encode; `group_cast` is the directly measured span from the end of that flatten to the last subscriber cast being enqueued, not a residual.

`conn_deliver` is sampled 1 delivery in 100 (`--conn-sample-rate 100`). Its sample count is therefore not the delivery count, and its server-side end is the parent `send/2` returning rather than the SSE handler's `chunk/2`. `conn_chunk` is the other per-subscriber hop: commit → `Plug.Conn.chunk/2` returning, emitted only for a sampled delivery that actually reached a socket, so a real-socket run gets it and an in-process one has no `conn_chunk` samples.

The sum covers `router_queue` + `router_dwell` + `router_decode` + `router_encode` + `group_queue` + `group_encode` + `group_cast`: the push-side hops that end inside the re-based `ebb.fanout.push_latency_ms`. `conn_deliver` and `conn_chunk` are excluded because both are per subscriber and can outlive the push. A hop with no samples in the window contributes 0. The sum balances when one group receives a range, the t4 shape; with several groups the group-scoped hops repeat per group while the range-scoped hops do not.

`writer_notify` is #537's `notify` phase in `ebb.writer.flush_phase_ms` and is immediately before the re-based push sample (plus the mailbox hand-off), so it is shown as context, not as another hop in the sum.

## Correctness and resources

| Metric | Value |
| --- | --- |
| Accepted Actions | 4880 |
| Rejected Actions | 0 |
| Write/transport errors | 0 |
| GSN holes | 0 |
| First missing GSN | none |
| Watermark lag high-water (GSNs) | 0 |
| Final watermark lag (GSNs) | 0 |
| Peak RSS | 199916 kB (195.2 MiB) |
| Peak process memory | 115.7 MiB |
| Peak dirty-set size | 4 |
| Scheduler utilization | 22.1% |
| Resource samples | 22 |

## Guardrails

Status: enforced. All guardrails passed.

Regression bands against a matched baseline: Actions/sec more than 10% below, or p50 more than 25% above. A GSN hole, an unbounded watermark lag, a rejected Action, or a write/transport error fails regardless of the baseline.

## Methodology and limitations

The measured window starts after 3s of warmup; warmup traffic is executed but its samples are discarded. The DB starts empty in a temp directory and is seeded before measurement with 1 bootstrap Action (the bench group plus `a_bench` membership) and 1 entity Action(s) (0 preloaded entities plus the hot entity). `hot` re-puts one pre-seeded entity and its existing membership row every Action, so writes contend on LWW materialization instead of growing the entity set. Client-side latency is timed in the bench worker (T0) or around `:httpc` (HTTP tiers); server-side latency is recorded by the server and read from the `ebb.*` telemetry events (`ebb.http.request_latency_ms`, `ebb.writer.batch_latency_ms`, `ebb.writer.flush_phase_ms`, `ebb.fanout.push_latency_ms`) with handlers attached in the bench process, so transport and server queueing are reported separately. Latency samples use reservoir sampling capped at ~200,000 across all workers (per-worker cap = cap / concurrency), so percentiles describe the retained sample. HTTP tiers use `:httpc` with a keep-alive session pool sized to twice the run's outstanding calls (concurrency × calls in flight per worker); MessagePack encoding and response parsing are included in every latency sample. RocksDB compaction and flush backlog are not measured: the `rocksdb` package exposes no property for them and emits no `:telemetry` event. Durability is the production default (`sync: true`): every commit is fsynced before the GSN range is acknowledged. The run is shorter than 61s, so no sustained window is reported (steady = n/a).

## Machine-readable results

<!-- ebb-bench-results:v1
{
  "config": {
    "ablate": [],
    "batch_size": 10,
    "concurrency": 1,
    "distribution": "hot",
    "durability": "sync",
    "duration": 20,
    "engine": "current",
    "entities": 0,
    "in_flight": [
      1
    ],
    "rate": 300,
    "socket_processes": 0,
    "subscriber_count_only": false,
    "subscriber_lean": true,
    "subscriber_socket": false,
    "subscribers": 1000,
    "tier": "t4",
    "updates_per_action": 2,
    "warmup": 3
  },
  "failures": [],
  "generated_at": "2026-11-11T14:42:20.065831Z",
  "guardrails": {
    "bands": {
      "p50_regression": 0.25,
      "rate_regression": 0.1
    },
    "baseline": false,
    "comparisons": [],
    "enforced": true,
    "violations": []
  },
  "runs": [
    {
      "config": {
        "ablate": [],
        "batch_size": 10,
        "concurrency": 1,
        "distribution": "hot",
        "durability": "sync",
        "duration": 20,
        "engine": "current",
        "entities": 0,
        "in_flight": [
          1
        ],
        "rate": 300,
        "socket_processes": 0,
        "subscriber_count_only": false,
        "subscriber_lean": true,
        "subscriber_socket": false,
        "subscribers": 1000,
        "tier": "t4",
        "updates_per_action": 2,
        "warmup": 3
      },
      "correctness": {
        "accepted": 4880,
        "errors": 0,
        "gsn_first_hole": null,
        "gsn_holes": 0,
        "rejected": 0,
        "socket_errors": null,
        "socket_holes": null,
        "socket_keep_up": null,
        "watermark_lag_final": 0,
        "watermark_lag_high": 0
      },
      "depth": 1,
      "label": "pipeline",
      "latency": {
        "count": 488,
        "p50": 2427,
        "p95": 34429,
        "p99": 68736
      },
      "throughput": {
        "accepted": 4880,
        "rate": 244.0,
        "rejected": 0
      }
    }
  ],
  "schema": "ebb-bench-results",
  "version": 1
}
-->
