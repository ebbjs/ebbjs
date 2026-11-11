# SPIKE-844 — log-first write path: prototype and measurement ledger

Spike: [#844](https://github.com/ebbjs/ebbjs/issues/844). Design under test:
[`docs/research/write-path-rewrite-design.md`](../docs/research/write-path-rewrite-design.md).
Numbers: `bench/RESULTS.md` → "Log-first spike (#844) — D3, P0, P1"; raw reports in
`bench/results/spike-844/`. PR: [#846](https://github.com/ebbjs/ebbjs/pull/846).

**Build:** `497de4fd` on `spike/844-log-first-write-path` (base `main` `0f7292f4`).
**Host:** `recsy-vps`, 4 schedulers, AMD EPYC 7763, 15 GiB, ext4, Elixir 1.17.3 / OTP 27,
`sync: true`. One pass at a time, 3 s warmup / 20 s window, `--seed 1`, fresh DB per pass.

**Outcome: park the rewrite. Keep the window framing and the segment writer.** The one
falsifier this spike existed to run (D3) shows the durable append is bound by the filesystem
flush, not by per-key work, so the engine swap buys 8 % at b100 and 17 % at b1000 — not the
4.75× H1 asked for. The reusable artifacts (D1 recovery code + property test, the P1 record
shape, the P0 baseline) ship; P2–P5 do not.

## Verdict table

| unit                                        | gate                                                                                         | measured                                                                                                                                                                                                                                                                                                                                                                       | verdict                               |
| ------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| **D1** segment writer + property test       | append, CRC, torn-tail truncate, GSN→offset index; random stream through kill points replays | 20 randomized streams × random batch sizes × random byte cuts: recovery keeps exactly the intact prefix, truncates at the boundary, no half-read record, retry converges. 7 tests.                                                                                                                                                                                             | **pass**                              |
| **D2** `as_of` membership on current caches | H2: byte-identical `update_scopes` for the corpus, resolution ≥3× serial                     | not implemented. Blocking measurement: `t2 --distribution spread --updates-per-action 2` is **100 % rejected** with `not_authorized: cannot resolve the model of the entity being added to a group` — the authorizer reads committed state for an entity the Action creates, so an `as_of`-only resolver cannot authorize create-with-membership without intra-action context. | **parked** (mechanism above)          |
| **D3** pwrite vs write_batch                | log leg **≤0.4 ms**/flush at b100; falsified if within 1.5× of 1.903 ms                      | log-first append at b100 = **1.982 ms** p50 matched (1.254 ms I/O floor); `write_batch` matched = 2.162 ms. Decomposition: `fdatasync` 1.15–1.27 ms, assembly 0.55 ms, one 51 KB `pwrite` 0.105 ms.                                                                                                                                                                            | **fail** — H1 falsified               |
| **P0** instrument + re-baseline             | timers sum to the measured flush within 10 %                                                 | phases sum 3,621 µs p50 vs 3,647 µs client p50 (**0.7 %**); server `batch_latency` is 15 % lower by construction (starts after queue/prepare). Re-baselined `t0`/`t2`/`t4` and `mix bench.component_index`.                                                                                                                                                                    | **pass**                              |
| **P1** window record on RocksDB             | log leg ≤0.6 ms/flush at b100; no catch-up or materialization regression                     | one window record as one `cf_actions` put: p50 **2,029 µs** at b100 (vs 2,162 matched), 9,417 µs at b1000 (vs 10,690). Append-shape gate met in direction; catch-up page p50 and materialization **not measured**, so the phase gate is **unmet**.                                                                                                                             | **adopt-in-part** (append shape only) |
| **P2** dedicated log                        | H1 by the better backend; R1/R2 decided; I2/I4                                               | not started: H1 is dead at D3, so a dedicated log cannot pay on this host.                                                                                                                                                                                                                                                                                                     | **parked** (depends on H1)            |
| **P3** membership + resolver pool           | H2 + I1                                                                                      | not started: depends on P2's record format; D2's blocking finding applies.                                                                                                                                                                                                                                                                                                     | **parked**                            |
| **P4** consumers + reads + tap              | H4 hot-group row; R3                                                                         | not started. Existence-index cost measured instead: +7.2 % at k=2, +20.2 % at k=4, +21.6 % at k=8 (`mix bench.component_index`).                                                                                                                                                                                                                                               | **parked**                            |
| **P5** matrix + decisions                   | H5 ledger clean; H6 reported                                                                 | matrix produced for the current writer and the three append arms; H5 crash ledger **not run** (needs the prototype's consumers); H6 reported below.                                                                                                                                                                                                                            | **partial**                           |

## Per-hypothesis verdict

- **H1 (append) — falsified.** The gate was ≤0.4 ms per 100-Action flush at `hot`. Measured
  1.254 ms for one `pwrite` + `datasync` (the irreducible part) and 1.982 ms for the full
  matched append. The 1.903 ms "log-only" rung is ~65 % `fdatasync` (1.15–1.27 ms), ~30 %
  frame/op assembly (0.55–0.69 ms), ~5 % the write itself (0.105 ms). Replacing 100
  `batch_put` crossings with one sequential write is worth ~130 µs at b100, not ~1.5 ms. On
  tmpfs (device latency removed) the same arms fall to 633 µs / 763 µs, confirming the disk
  is the floor. The _direction_ H1 predicted is real: at b1000 the log-first append is 17 %
  cheaper and the gap widens with window size, but it never reaches the gate.
- **H2 (resolution) — not established.** Not attempted, and the corpus diff is blocked by the
  authorizer's create-with-membership rejection (D2). What was established: the current
  authorizer answers a create Action from committed state, so `as_of` reads alone cannot make
  the `spread` workload authorizable; the design's "intra-action context" clause is load-
  bearing, not an optimisation.
- **H3 (end-to-end) — not reachable, by arithmetic.** The P0 baseline shows the flush is
  3.0–3.6 ms p50 at `t0`, of which the durable commit is 2.2 ms (`commit_wait`) and scope
  resolution 1.0 ms (`resolve`). Even with every non-append phase deleted, the ceiling at
  b100 is ≈2.1×, below the 4× gate; the append alone is 1.2–2.0 ms.
- **H4 (cost of derivation) — partially measured, not gated.** Existence-index write
  amplification on this build: +7.2 % / +20.2 % / +21.6 % at k = 2 / 4 / 8. The
  `dedup,dirty,fanout` ablation is the largest single lever (+53 %). No consumer or
  partition was built, so "consumer lag is the ceiling" is untested.
- **H5 (safety) — partially measured.** D1's kill-point property test covers append-level
  loss and replay (no acked record lost, no half record read). Crash injection through
  consumers, the 20-point ledger, and double-apply detection need P2/P4 and were not run.
- **H6 (complexity) — reported.** +1,164 lines added, −16 changed, **0 deleted** from the
  production write path (`git show --stat 497de4fd`): segment writer 329, bench append module
  289, tests 359, harness 180. Config keys: **+1** (`--engine`, bench-only, `t5`-only), **0**
  on the ack path. Net lines deleted: 0, because nothing was cut over. The design's target
  (≥2,500 deleted) is untouched, not refuted.

## Contract renegotiations R1–R3

None may be decided without the phase that needs it, and no phase ran:

- **R1 (duplicate replies with the winner's range)** — **deferred**. Untested; I6 also
  untested (needs two batches in flight through a log leader).
- **R2 (a cursor can become invalid)** — **deferred**. Untested; retention was not built.
- **R3 (reads fresh at a revision)** — **deferred**. Untested; no read path was built.

Client-visible delta for each: none shipped, because the prototype never reached the client.

## Discarded alternatives

- **`disk_log`** — not measured. The owned-segment and `write_batch` arms already establish
  that the flush dominates, and `disk_log` sits on the same `datasync`; measuring it would
  compare two bookkeeping layers over one disk.
- **Owned segments vs window-record-on-RocksDB** — measured. At b100: 1,982 µs vs 2,029 µs
  (0.5 % apart, inside run-to-run spread); at b1000: 8,855 µs vs 9,417 µs (6 %). The owned
  log's extra 6 % is not worth a new recovery surface when the format risk is the whole point
  of the spike.
- **Catch-up source (`.gix` sidecar vs scan-and-filter)** — not decided; it needs the real
  record format and a catch-up page benchmark, which is P1's unmeasured half.
- **Window sizes** — measured: 10 / 100 / 1000. Larger windows amortise the fsync (b1000 is
  0.89–1.07 ms per 100 Actions) and are the only lever that reaches the H1 per-Action band.

## Smallest subset that still pays

1. **The window record (P1's shape), if catch-up is shown not to regress.** 8 % at b100 and
   17 % at b1000 at the append, with +3.2 % durable bytes (509 B/Action vs 494 B/Action).
   Cheap to trial behind the existing `cf_actions` value with no new recovery surface.
2. **The `t2` create-with-membership authorization bug.** It blocks every `spread × u2`
   measurement, and it is the same surface I1/D2 has to answer. Worth its own issue.
3. **The ~50 ms p99 tail.** It costs 2–3× mean throughput on every tier and survives on
   tmpfs at 2.8 % CPU. Until it is explained, no throughput number on this host can separate
   a design from a stall, and the 4× H3 gate is unmeasurable in either direction.

## Tests that survive the spike

- `test/ebb_server/storage/log_first/segment_test.exs` — append/read, sparse index, torn tail
  across every byte of the last record, CRC corruption, empty file, and the 60-seed
  kill-point property (recovery prefix + retry convergence).
- `test/ebb_server/bench/log_append_test.exs` — the window record holds the exact
  `cf_actions` bytes the batch arm writes, GSN contiguity, verifier catches torn/CRC/order
  faults, `perform/4` append round-trip.
- `test/ebb_server/bench/options_test.exs` — `--engine` is `t5`-only and defaults to the
  current `write_batch`.

## Follow-up issues

1. `fix(storage)`: authorize an Action that creates the entity it files into a group
   (`spread × u2` at `t2` is 100 % rejected).
2. `perf(bench)`: explain the 40–60 ms p99 stall present at 2.8 % CPU and on tmpfs.
3. `perf(storage)`: frame the write window on RocksDB (P1's shape) behind a flag, measure
   catch-up and materialization, and cut over only if both hold.
4. `spike(storage)`: #844's remaining questions (retention/R2, dedup digest, partition skew)
   stay open; P2–P5 are parked, not answered.

## Reproduction

```sh
cd ebb_server
bash ../scripts/ebb-server-deps.sh   # once per worktree

# D3 / P1, b100 (median of 3, interleaved)
mix bench.actions --tier t5 --engine log_first --duration 20 --warmup 3 --concurrency 1 \
  --batch-size 100 --updates-per-action 2 --distribution hot --seed 1 \
  --ablate dedup,entity_index,group_index
mix bench.actions --tier t5 --engine current_window --duration 20 --warmup 3 --concurrency 1 \
  --batch-size 100 --updates-per-action 2 --distribution hot --seed 1 \
  --ablate dedup,entity_index,group_index

# P0 re-baseline
mix bench.actions --tier t0 --duration 20 --warmup 3 --concurrency 1 --batch-size 100 \
  --updates-per-action 2 --distribution hot
mix bench.actions --tier t2 --duration 20 --warmup 3 --concurrency 8 --batch-size 100 \
  --updates-per-action 2 --distribution hot
mix bench.component_index

# verify the append segments written by the log_first arm
mix run --no-start -e 'IO.inspect(EbbServer.Bench.LogAppend.verify_all())'
```
