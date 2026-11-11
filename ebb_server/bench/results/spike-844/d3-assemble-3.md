# ebb_server Actions/sec benchmark

Generated 2026-11-11T14:02:31.459697Z on `recsy-vps`.

**Tier t5** — raw durable append from N concurrent callers, no Writer, --ablate names op groups, --engine picks the append.

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
| Tier | t5 (raw durable append from N concurrent callers, no Writer, --ablate names op groups, --engine picks the append) |
| Append engine | log_first — window record assembly only (no I/O) |
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
| Ablated phases | dedup, entity_index, group_index |
| Guardrails | enforced |
| Baseline | none |
| Port | 4111 |
| Seed | 1 |
| Output | /tmp/d3/log_first_assemble-1794405725.md |

Reproduction command:

```sh
mix bench.actions --tier t5 --duration 20 --warmup 3 --concurrency 1 --in-flight 1 --batch-size 100 --updates-per-action 2 --distribution hot --durability sync --entities 0 --subscribers 0 --rate 0 --batch-timeout-ms 0 --batch-max-size 1000 --commit-timeout-ms 2000 --conn-sample-rate 100 --writers 1 --port 4111 --seed 1 --engine log_first_assemble --ablate dedup,entity_index,group_index --out /tmp/d3/log_first_assemble-1794405725.md
```

## Throughput

| Window | Seconds | Accepted | Accepted/sec | Rejected |
| --- | --- | --- | --- | --- |
| burst | 15 | 1818600 | 121240.0 | 0 |
| overall | 20 | 2471200 | 123560.0 | 0 |

## Latency

| Window | Samples | p50 | p95 | p99 |
| --- | --- | --- | --- | --- |
| burst | 18186 | 557 | 729 | 1094 |
| overall | 24712 | 554 | 696 | 1043 |

Values are wall time around building one window record — Action construction, validation, ETF encoding, per-Action length/CRC stamping and the concatenation — with no I/O in the sample.

## Concurrent write_batch (T5)

| Metric | Value |
| --- | --- |
| Append engine | log_first — window record assembly only (no I/O) |
| Callers (BEAM processes) | 1 |
| Durable append sync | sync: true |
| Actions per call | 100 |
| Updates per Action | 2 |
| GSN ranges | disjoint per caller, contiguous per call |
| Achieved Actions/sec | 123560.0 |

Each caller is one BEAM process issuing the selected durable append directly at a synthetic GSN base; only that append's cost is measured (`current` is `:rocksdb.write_batch/3`; `log_first` is one window record through `:file.pwrite/3` plus `:file.datasync/1`). The measured path bypasses the Writer, so its caches, watermark, and fan-out stay idle (the storage tree still boots to open the DB and seed the bench context). Nothing here reflects the production write path's bookkeeping, and GSN holes/watermark lag are reported `n/a` because the spike writes at a synthetic GSN base and never advances the Writer's frontier. Comparing callers at the same sync mode is the point: the gap between one and two callers is the headroom a committer pool could use. The peak-dirty row in the resources table is Workbook seed residue, not a t5 signal.

## Correctness and resources

| Metric | Value |
| --- | --- |
| Accepted Actions | 2471200 |
| Rejected Actions | 0 |
| Write/transport errors | 0 |
| GSN holes | n/a |
| First missing GSN | n/a |
| Watermark lag high-water (GSNs) | n/a |
| Final watermark lag (GSNs) | n/a |
| Peak RSS | 131204 kB (128.1 MiB) |
| Peak process memory | 71.1 MiB |
| Peak dirty-set size | 4 |
| Scheduler utilization | 12.5% |
| Resource samples | 22 |

## Guardrails

Status: enforced. All guardrails passed.

Regression bands against a matched baseline: Actions/sec more than 10% below, or p50 more than 25% above. A GSN hole, an unbounded watermark lag, a rejected Action, or a write/transport error fails regardless of the baseline.

## Methodology and limitations

The measured window starts after 3s of warmup; warmup traffic is executed but its samples are discarded. The DB starts empty in a temp directory and is seeded before measurement with 1 bootstrap Action (the bench group plus `a_bench` membership) and 1 entity Action(s) (0 preloaded entities plus the hot entity). `hot` re-puts one pre-seeded entity and its existing membership row every Action, so writes contend on LWW materialization instead of growing the entity set. No server-side telemetry is captured for this tier: the call bypasses the HTTP stack and the Writer. Latency samples use reservoir sampling capped at ~200,000 across all workers (per-worker cap = cap / concurrency), so percentiles describe the retained sample. RocksDB compaction and flush backlog are not measured: the `rocksdb` package exposes no property for them and emits no `:telemetry` event. Durability is the production default (`sync: true`): every commit is fsynced before the GSN range is acknowledged. The run is shorter than 61s, so no sustained window is reported (steady = n/a). Ablation is active: the Writer skipped dedup, entity_index, group_index on the write path, so this run measures a reduced write path and its latency, density, and dirty-cache numbers are not comparable to an unablated run.

## Machine-readable results

<!-- ebb-bench-results:v1
{
  "config": {
    "ablate": [
      "dedup",
      "entity_index",
      "group_index"
    ],
    "batch_size": 100,
    "concurrency": 1,
    "distribution": "hot",
    "durability": "sync",
    "duration": 20,
    "engine": "log_first_assemble",
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
    "tier": "t5",
    "updates_per_action": 2,
    "warmup": 3
  },
  "failures": [],
  "generated_at": "2026-11-11T14:02:31.464711Z",
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
          "entity_index",
          "group_index"
        ],
        "batch_size": 100,
        "concurrency": 1,
        "distribution": "hot",
        "durability": "sync",
        "duration": 20,
        "engine": "log_first_assemble",
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
        "tier": "t5",
        "updates_per_action": 2,
        "warmup": 3
      },
      "correctness": {
        "accepted": 2471200,
        "errors": 0,
        "gsn_first_hole": null,
        "gsn_holes": null,
        "rejected": 0,
        "socket_errors": null,
        "socket_holes": null,
        "socket_keep_up": null,
        "watermark_lag_final": null,
        "watermark_lag_high": null
      },
      "depth": 1,
      "label": "pipeline",
      "latency": {
        "count": 24712,
        "p50": 554,
        "p95": 696,
        "p99": 1043
      },
      "throughput": {
        "accepted": 2471200,
        "rate": 123560.0,
        "rejected": 0
      }
    }
  ],
  "schema": "ebb-bench-results",
  "version": 1
}
-->
