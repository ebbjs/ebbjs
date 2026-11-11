# ebb_server Actions/sec benchmark

Generated 2026-11-11T14:34:28.046774Z on `recsy-vps`.

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
| Ablated phases | dedup, dirty, fanout |
| Guardrails | enforced |
| Baseline | none |
| Port | 4111 |
| Seed | 1 |
| Output | /tmp/abl/dedup+dirty+fanout-2-1794407637.md |

Reproduction command:

```sh
mix bench.actions --tier t0 --duration 20 --warmup 3 --concurrency 1 --in-flight 1 --batch-size 100 --updates-per-action 2 --distribution hot --durability sync --entities 0 --subscribers 0 --rate 0 --batch-timeout-ms 0 --batch-max-size 1000 --commit-timeout-ms 2000 --conn-sample-rate 100 --writers 1 --port 4111 --seed 1 --ablate dedup,dirty,fanout --out /tmp/abl/dedup+dirty+fanout-2-1794407637.md
```

## Writer pipeline

| Run | Actions/flush | Flush p50 (µs) |
| --- | --- | --- |
| t0 baseline | 100 | 3016 |

`Actions/flush` and `Flush p50` come from `ebb.writer.batch_latency_ms`, so they describe the coalesced flush this run actually produced rather than the requested burst; the gauges and phases below are the same tables a sweep renders in its pipeline-depth section.

### Writer pipeline gauges

| Run | `queue_depth` peak | `queue_depth` mean | `in_flight_batches` peak | `in_flight_batches` mean | `oldest_unreleased_gsn` peak | `oldest_unreleased_gsn` mean |
| --- | --- | --- | --- | --- | --- | --- |
| t0 baseline | 1 | 1.0 | 1 | 0.5 | 398103 | 112426.5 |

`queue_depth` is the number of `write_actions/1` calls one flush drained, taken from `ebb.writer.batch_size`'s `callers`, so its peak/mean describe how deep the coalescing queue got, not a sampled mailbox length. The other two columns are the Writer's own `ebb.writer.in_flight_batches` and `ebb.writer.oldest_unreleased_gsn` gauges, emitted on every claim and release, so they describe the actual reorder buffer rather than the harness-side outstanding-call figures a depth sweep reports. `in_flight_batches` counts every open claim, including one applying; `oldest_unreleased_gsn` is the head of the claim order and `0` when the buffer is empty, so its mean includes idle samples.

### Flush phases (p50 / p95, µs)

| Run | queue | prepare | resolve | commit_wait | apply | notify | sum p50 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| t0 baseline | 58 / 114 | 146 / 248 | 769 / 1131 | 2216 / 3633 | 61 / 105 | 6 / 27 | 3303 |

Each phase cell is `p50 / p95` in µs. The six phases sum to one claimed range's lifetime, from the oldest coalesced call's send to the end of its `notify` phase, so `sum p50` (the per-range sum the collector records as `flush_total`) is the flush a caller waited on. `queue` and `prepare` are the terms `ebb.writer.batch_latency_ms` cannot see, because its timer starts after the request is dequeued and the payload is built. A phase that did not run is `0`, not missing, so an abandoned range reports `0` for the phases it never reached.

## Throughput

| Window | Seconds | Accepted | Accepted/sec | Rejected |
| --- | --- | --- | --- | --- |
| burst | 15 | 260900 | 17393.3 | 0 |
| overall | 20 | 346600 | 17330.0 | 0 |

## Latency

| Window | Samples | p50 | p95 | p99 |
| --- | --- | --- | --- | --- |
| burst | 2609 | 3339 | 32355 | 40484 |
| overall | 3466 | 3328 | 33472 | 40513 |

Client-side values are wall time around `Writer.write_actions/1` in the bench worker; server-side `ebb.writer.batch_latency_ms` measures the same flush from inside the Writer, and `ebb.writer.commit_latency_ms` covers only the frame encode, op assembly, and `write_batch` after the payload was built and encoded before the claim. The difference is worker overhead plus the time the call spent in the Writer mailbox, which `ebb.writer.flush_phase_ms` reports as `queue` (with `prepare` measured beside it); a sweep renders that phase table in the pipeline-depth section.

## Server-side latency (`ebb.*` telemetry)

| Event | Window | Samples | p50 | p95 | p99 |
| --- | --- | --- | --- | --- | --- |
| `ebb.writer.batch_latency_ms` | burst | 2609 | 3028 | 31950 | 40147 |
| `ebb.writer.batch_latency_ms` | overall | 3466 | 3016 | 32899 | 40179 |
| `ebb.writer.commit_latency_ms` | burst | 2609 | 2004 | 2903 | 37731 |
| `ebb.writer.commit_latency_ms` | overall | 3466 | 1993 | 2957 | 38102 |

Captured in the bench process by attaching handlers to the server's `ebb.*` events. `ebb.http.request_latency_ms` is measured inside the request process, so MessagePack encoding and transport are excluded; `ebb.writer.batch_latency_ms` covers one durable Writer flush, and `ebb.writer.commit_latency_ms` is the Committer's share of it (frame encode + `cf_*` op assembly + `write_batch`); `ebb.fanout.push_latency_ms` starts at the end of the post-commit apply (the fan-out notify send) and ends at the end of the `GroupServer` cast, per batch per group. `ebb.writer.batch_latency_ms` starts after the request is dequeued, so the wait a call spends in the Writer mailbox is not part of it: `ebb.writer.flush_phase_ms` reports that wait as `queue`, with `prepare` beside it, and a sweep renders the phase table in the pipeline-depth section. Durations are converted from native time units to microseconds and windowed like the client-side samples.

## Correctness and resources

| Metric | Value |
| --- | --- |
| Accepted Actions | 346600 |
| Rejected Actions | 0 |
| Write/transport errors | 0 |
| GSN holes | 0 |
| First missing GSN | none |
| Watermark lag high-water (GSNs) | 0 |
| Final watermark lag (GSNs) | 0 |
| Peak RSS | 223476 kB (218.2 MiB) |
| Peak process memory | 76.6 MiB |
| Peak dirty-set size | 0 |
| Scheduler utilization | 6.3% |
| Resource samples | 22 |

## Guardrails

Status: enforced. All guardrails passed.

Regression bands against a matched baseline: Actions/sec more than 10% below, or p50 more than 25% above. A GSN hole, an unbounded watermark lag, a rejected Action, or a write/transport error fails regardless of the baseline.

## Methodology and limitations

The measured window starts after 3s of warmup; warmup traffic is executed but its samples are discarded. The DB starts empty in a temp directory and is seeded before measurement with 1 bootstrap Action (the bench group plus `a_bench` membership) and 1 entity Action(s) (0 preloaded entities plus the hot entity). `hot` re-puts one pre-seeded entity and its existing membership row every Action, so writes contend on LWW materialization instead of growing the entity set. Client-side latency is timed in the bench worker (T0) or around `:httpc` (HTTP tiers); server-side latency is recorded by the server and read from the `ebb.*` telemetry events (`ebb.http.request_latency_ms`, `ebb.writer.batch_latency_ms`, `ebb.writer.flush_phase_ms`, `ebb.fanout.push_latency_ms`) with handlers attached in the bench process, so transport and server queueing are reported separately. Latency samples use reservoir sampling capped at ~200,000 across all workers (per-worker cap = cap / concurrency), so percentiles describe the retained sample. RocksDB compaction and flush backlog are not measured: the `rocksdb` package exposes no property for them and emits no `:telemetry` event. Durability is the production default (`sync: true`): every commit is fsynced before the GSN range is acknowledged. The run is shorter than 61s, so no sustained window is reported (steady = n/a). Ablation is active: the Writer skipped dedup, dirty, fanout on the write path, so this run measures a reduced write path and its latency, density, and dirty-cache numbers are not comparable to an unablated run.

## Machine-readable results

<!-- ebb-bench-results:v1
{
  "config": {
    "ablate": [
      "dedup",
      "dirty",
      "fanout"
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
  "generated_at": "2026-11-11T14:34:28.052171Z",
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
          "dedup",
          "dirty",
          "fanout"
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
        "accepted": 346600,
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
        "count": 3466,
        "p50": 3328,
        "p95": 33472,
        "p99": 40513
      },
      "throughput": {
        "accepted": 346600,
        "rate": 17330.0,
        "rejected": 0
      }
    }
  ],
  "schema": "ebb-bench-results",
  "version": 1
}
-->
