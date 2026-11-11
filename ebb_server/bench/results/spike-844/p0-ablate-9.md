# ebb_server Actions/sec benchmark

Generated 2026-11-11T14:30:43.077312Z on `recsy-vps`.

**Tier t0** — Writer.write_actions/1, no HTTP.

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
| Tier | t0 (Writer.write_actions/1, no HTTP) |
| Append engine | current — one write_batch/3 (NIF time only) |
| Measured window | 20s |
| Warmup | 3s |
| Concurrency | 1 |
| Calls in flight per worker | 1 |
| Actions per call/request | 100 |
| Updates per Action | 2 |
| Distribution | hot |
| Durability | sync |
| Preloaded entities | 0 |
| SSE subscribers | 0 |
| Fan-out conn sample rate | 1 in 100 |
| Target Actions/sec | unpaced |
| Writer batch timeout | 0 ms (burst drain) |
| Writer batch cap | 1000 Actions |
| Writer commit timeout | 2000 ms |
| Stalled commits | none |
| Writers | 1 |
| Ablated phases | group_index |
| Guardrails | enforced |
| Baseline | none |
| Port | 4111 |
| Seed | 1 |
| Output | /tmp/abl/group_index-1-1794407413.md |

Reproduction command:

```sh
mix bench.actions --tier t0 --duration 20 --warmup 3 --concurrency 1 --in-flight 1 --batch-size 100 --updates-per-action 2 --distribution hot --durability sync --entities 0 --subscribers 0 --rate 0 --batch-timeout-ms 0 --batch-max-size 1000 --commit-timeout-ms 2000 --conn-sample-rate 100 --writers 1 --port 4111 --seed 1 --ablate group_index --out /tmp/abl/group_index-1-1794407413.md
```

## Writer pipeline

| Run | Actions/flush | Flush p50 (µs) |
| --- | --- | --- |
| t0 baseline | 100 | 3147 |

`Actions/flush` and `Flush p50` come from `ebb.writer.batch_latency_ms`, so they describe the coalesced flush this run actually produced rather than the requested burst; the gauges and phases below are the same tables a sweep renders in its pipeline-depth section.

### Writer pipeline gauges

| Run | `queue_depth` peak | `queue_depth` mean | `in_flight_batches` peak | `in_flight_batches` mean | `oldest_unreleased_gsn` peak | `oldest_unreleased_gsn` mean |
| --- | --- | --- | --- | --- | --- | --- |
| t0 baseline | 1 | 1.0 | 1 | 0.5 | 271903 | 76751.5 |

`queue_depth` is the number of `write_actions/1` calls one flush drained, taken from `ebb.writer.batch_size`'s `callers`, so its peak/mean describe how deep the coalescing queue got, not a sampled mailbox length. The other two columns are the Writer's own `ebb.writer.in_flight_batches` and `ebb.writer.oldest_unreleased_gsn` gauges, emitted on every claim and release, so they describe the actual reorder buffer rather than the harness-side outstanding-call figures a depth sweep reports. `in_flight_batches` counts every open claim, including one applying; `oldest_unreleased_gsn` is the head of the claim order and `0` when the buffer is empty, so its mean includes idle samples.

### Flush phases (p50 / p95, µs)

| Run | queue | prepare | resolve | commit_wait | apply | notify | sum p50 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| t0 baseline | 57 / 98 | 161 / 261 | 1031 / 1772 | 2298 / 3158 | 75 / 127 | 34 / 60 | 3685 |

Each phase cell is `p50 / p95` in µs. The six phases sum to one claimed range's lifetime, from the oldest coalesced call's send to the end of its `notify` phase, so `sum p50` (the per-range sum the collector records as `flush_total`) is the flush a caller waited on. `queue` and `prepare` are the terms `ebb.writer.batch_latency_ms` cannot see, because its timer starts after the request is dequeued and the payload is built. A phase that did not run is `0`, not missing, so an abandoned range reports `0` for the phases it never reached.

## Throughput

| Window | Seconds | Accepted | Accepted/sec | Rejected |
| --- | --- | --- | --- | --- |
| burst | 15 | 176000 | 11733.3 | 0 |
| overall | 20 | 236900 | 11845.0 | 0 |

## Latency

| Window | Samples | p50 | p95 | p99 |
| --- | --- | --- | --- | --- |
| burst | 1760 | 3738 | 54152 | 58456 |
| overall | 2369 | 3712 | 53753 | 58456 |

Client-side values are wall time around `Writer.write_actions/1` in the bench worker; server-side `ebb.writer.batch_latency_ms` measures the same flush from inside the Writer, and `ebb.writer.commit_latency_ms` covers only the frame encode, op assembly, and `write_batch` after the payload was built and encoded before the claim. The difference is worker overhead plus the time the call spent in the Writer mailbox, which `ebb.writer.flush_phase_ms` reports as `queue` (with `prepare` measured beside it); a sweep renders that phase table in the pipeline-depth section.

## Server-side latency (`ebb.*` telemetry)

| Event | Window | Samples | p50 | p95 | p99 |
| --- | --- | --- | --- | --- | --- |
| `ebb.writer.batch_latency_ms` | burst | 1760 | 3160 | 52844 | 57589 |
| `ebb.writer.batch_latency_ms` | overall | 2369 | 3147 | 52238 | 57224 |
| `ebb.writer.commit_latency_ms` | burst | 1760 | 2042 | 2786 | 54427 |
| `ebb.writer.commit_latency_ms` | overall | 2369 | 2034 | 2777 | 53714 |

Captured in the bench process by attaching handlers to the server's `ebb.*` events. `ebb.http.request_latency_ms` is measured inside the request process, so MessagePack encoding and transport are excluded; `ebb.writer.batch_latency_ms` covers one durable Writer flush, and `ebb.writer.commit_latency_ms` is the Committer's share of it (frame encode + `cf_*` op assembly + `write_batch`); `ebb.fanout.push_latency_ms` starts at the end of the post-commit apply (the fan-out notify send) and ends at the end of the `GroupServer` cast, per batch per group. `ebb.writer.batch_latency_ms` starts after the request is dequeued, so the wait a call spends in the Writer mailbox is not part of it: `ebb.writer.flush_phase_ms` reports that wait as `queue`, with `prepare` beside it, and a sweep renders the phase table in the pipeline-depth section. Durations are converted from native time units to microseconds and windowed like the client-side samples.

## Fan-out latency breakdown

| Hop | Samples | p50 (µs) | p95 (µs) | p99 (µs) |
| --- | --- | --- | --- | --- |
| `router_queue` | 2369 | 52 | 93 | 209 |
| `router_dwell` | 0 | n/a | n/a | n/a |
| `router_decode` | 2369 | 503 | 839 | 1084 |
| `router_encode` | 2369 | 8 | 18 | 54 |
| `group_queue` | 0 | n/a | n/a | n/a |
| `group_encode` | 0 | n/a | n/a | n/a |
| `group_cast` | 0 | n/a | n/a | n/a |
| `conn_deliver` | 0 | n/a | n/a | n/a |
| `conn_chunk` | 0 | n/a | n/a | n/a |

| Measurement | Samples | p50 (µs) | p95 (µs) | p99 (µs) | Δ vs push p50 (µs) | Δ vs push p50 |
| --- | --- | --- | --- | --- | --- | --- |
| `ebb.fanout.push_latency_ms` (re-based) | 0 | n/a | n/a | n/a | — | — |
| `writer_notify` (context: #537 `notify` phase) | 2369 | 34 | 60 | 77 | — | — |
| Sum of push-side hop p50s | — | 563 | — | — | n/a | n/a |

Each hop is one `ebb.fanout.hop_ms` sample per range per hop (per range per group for the group hops), emitted by the server on the same measured window as every other `ebb.*` sample. `router_queue` runs from the Writer's notify send to the Router's `handle_info/2`; `router_dwell` is the wait in `Plan` for the committed watermark and is emitted only when a range actually waits, so an empty row means no range was held; `router_decode` is the `range_iterator` plus decode and group split; `router_encode` resolves the groups with a live `GroupServer` and builds their frames, one encode per (Action, distinct Update subset) for the whole range; `group_queue` is the cast to the `GroupServer` entry; `group_encode` is the flatten of the frames the Router built, not a frame encode; `group_cast` is the directly measured span from the end of that flatten to the last subscriber cast being enqueued, not a residual.

`conn_deliver` is sampled 1 delivery in 100 (`--conn-sample-rate 100`). Its sample count is therefore not the delivery count, and its server-side end is the parent `send/2` returning rather than the SSE handler's `chunk/2`. `conn_chunk` is the other per-subscriber hop: commit → `Plug.Conn.chunk/2` returning, emitted only for a sampled delivery that actually reached a socket, so a real-socket run gets it and an in-process one has no `conn_chunk` samples.

The sum covers `router_queue` + `router_dwell` + `router_decode` + `router_encode` + `group_queue` + `group_encode` + `group_cast`: the push-side hops that end inside the re-based `ebb.fanout.push_latency_ms`. `conn_deliver` and `conn_chunk` are excluded because both are per subscriber and can outlive the push. A hop with no samples in the window contributes 0. The sum balances when one group receives a range, the t4 shape; with several groups the group-scoped hops repeat per group while the range-scoped hops do not.

`writer_notify` is #537's `notify` phase in `ebb.writer.flush_phase_ms` and is immediately before the re-based push sample (plus the mailbox hand-off), so it is shown as context, not as another hop in the sum.

## Correctness and resources

| Metric | Value |
| --- | --- |
| Accepted Actions | 236900 |
| Rejected Actions | 0 |
| Write/transport errors | 0 |
| GSN holes | 0 |
| First missing GSN | none |
| Watermark lag high-water (GSNs) | 0 |
| Final watermark lag (GSNs) | 0 |
| Peak RSS | 225748 kB (220.5 MiB) |
| Peak process memory | 76.0 MiB |
| Peak dirty-set size | 4 |
| Scheduler utilization | 8.3% |
| Resource samples | 22 |

## Guardrails

Status: enforced. All guardrails passed.

Regression bands against a matched baseline: Actions/sec more than 10% below, or p50 more than 25% above. A GSN hole, an unbounded watermark lag, a rejected Action, or a write/transport error fails regardless of the baseline.

## Methodology and limitations

The measured window starts after 3s of warmup; warmup traffic is executed but its samples are discarded. The DB starts empty in a temp directory and is seeded before measurement with 1 bootstrap Action (the bench group plus `a_bench` membership) and 1 entity Action(s) (0 preloaded entities plus the hot entity). `hot` re-puts one pre-seeded entity and its existing membership row every Action, so writes contend on LWW materialization instead of growing the entity set. Client-side latency is timed in the bench worker (T0) or around `:httpc` (HTTP tiers); server-side latency is recorded by the server and read from the `ebb.*` telemetry events (`ebb.http.request_latency_ms`, `ebb.writer.batch_latency_ms`, `ebb.writer.flush_phase_ms`, `ebb.fanout.push_latency_ms`) with handlers attached in the bench process, so transport and server queueing are reported separately. Latency samples use reservoir sampling capped at ~200,000 across all workers (per-worker cap = cap / concurrency), so percentiles describe the retained sample. RocksDB compaction and flush backlog are not measured: the `rocksdb` package exposes no property for them and emits no `:telemetry` event. Durability is the production default (`sync: true`): every commit is fsynced before the GSN range is acknowledged. The run is shorter than 61s, so no sustained window is reported (steady = n/a). Ablation is active: the Writer skipped group_index on the write path, so this run measures a reduced write path and its latency, density, and dirty-cache numbers are not comparable to an unablated run.

## Machine-readable results

<!-- ebb-bench-results:v1
{
  "config": {
    "ablate": [
      "group_index"
    ],
    "batch_size": 100,
    "concurrency": 1,
    "distribution": "hot",
    "durability": "sync",
    "duration": 20,
    "engine": "current",
    "entities": 0,
    "in_flight": [
      1
    ],
    "rate": 0,
    "socket_processes": 0,
    "subscriber_count_only": false,
    "subscriber_lean": false,
    "subscriber_socket": false,
    "subscribers": 0,
    "tier": "t0",
    "updates_per_action": 2,
    "warmup": 3
  },
  "failures": [],
  "generated_at": "2026-11-11T14:30:43.082239Z",
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
        "ablate": [
          "group_index"
        ],
        "batch_size": 100,
        "concurrency": 1,
        "distribution": "hot",
        "durability": "sync",
        "duration": 20,
        "engine": "current",
        "entities": 0,
        "in_flight": [
          1
        ],
        "rate": 0,
        "socket_processes": 0,
        "subscriber_count_only": false,
        "subscriber_lean": false,
        "subscriber_socket": false,
        "subscribers": 0,
        "tier": "t0",
        "updates_per_action": 2,
        "warmup": 3
      },
      "correctness": {
        "accepted": 236900,
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
      "label": "t0 baseline",
      "latency": {
        "count": 2369,
        "p50": 3712,
        "p95": 53753,
        "p99": 58456
      },
      "throughput": {
        "accepted": 236900,
        "rate": 11845.0,
        "rejected": 0
      }
    }
  ],
  "schema": "ebb-bench-results",
  "version": 1
}
-->
