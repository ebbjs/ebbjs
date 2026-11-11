# SPIKE-844 — log-first write path: prototype and measurement ledger

Spike: [#844](https://github.com/ebbjs/ebbjs/issues/844). Design under test:
[`docs/research/write-path-rewrite-design.md`](../docs/research/write-path-rewrite-design.md).
Numbers: `bench/RESULTS.md` → "Log-first spike (#844) — D3, P0, P1"; raw reports in
`bench/results/spike-844/`. PR: [#846](https://github.com/ebbjs/ebbjs/pull/846).

**Build:** `497de4fd` on `spike/844-log-first-write-path` (base `main` `0f7292f4`).
**Host:** `recsy-vps`, 4 schedulers, AMD EPYC 7763, 15 GiB, ext4, Elixir 1.17.3 / OTP 27,
`sync: true`. One pass at a time, 3 s warmup / 20 s window, `--seed 1`, fresh DB per pass.

**Outcome: the full rewrite stays parked, but D3 did not reach its stop condition and the
append leg is worth ~2×.** The first D3 pass measured the append into a sparse file and
concluded the floor was `fdatasync`; that was a filesystem-metadata artifact (see
"Corrections"). With the segment's blocks written before the window — the shape a production
log would use — one append per 100-Action window is **960 µs**, 2.0× the matched
`write_batch` arm and 2.0× the pre-spike 1.903 ms leg, with the same record format. H1's
≤400 µs target is still missed; its own falsifier (≥1.27 ms) is not met. So the engine swap is
back in scope for the append, the reusable artifacts ship (D1 recovery code + property test,
the segment strategies, the P0 baseline), and P2–P5 remain parked because the _rest_ of the
design — resolution off the serial path, consumers, reads — was not built.

## Verdict table

| unit                                        | gate                                                                                         | measured                                                                                                                                                                                                                                                                                                                    | verdict                                                                               |
| ------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| **D1** segment writer + property test       | append, CRC, torn-tail truncate, GSN→offset index; random stream through kill points replays | 20 randomized streams × random batch sizes × random byte cuts: recovery keeps exactly the intact prefix, truncates at the boundary, no half-read record, retry converges. 7 tests.                                                                                                                                          | **pass**                                                                              |
| **D2** `as_of` membership on current caches | H2: byte-identical `update_scopes` for the corpus, resolution ≥3× serial                     | 1,200 generated Actions through the real Writer, 3 seeds: `update_scopes` **byte-identical 1,200/1,200**, including moves and deletes. Resolution ~1–2 µs/call for both the index and the current caches, so **no per-call speedup**; the Writer’s 10.3 µs/Action resolve is fold/planning, not the lookup.                 | **correctness pass; speed gate miss**                                                 |
| **D3** pwrite vs write_batch                | log leg **≤0.4 ms**/flush at b100; falsified if within 1.5× of 1.903 ms                      | sparse append 1.982 ms, **recycled (pre-written) segment 0.960–0.986 ms** p50 matched; `write_batch` matched 1.963–1.965 ms. `disk_log` (D3b) 1.927 ms, i.e. 0.98× today and 1.95× the recycled segment — no win. Component probe: in-place 64 KB `pwrite`+`datasync` 337–381 µs, sparse 811–832 µs, past-EOF 809–1,080 µs. | **owned log: target missed, falsifier not met; `disk_log`: falsifier met, discarded** |
| **P0** instrument + re-baseline             | timers sum to the measured flush within 10 %                                                 | phases 3,621 µs p50 vs 3,647 µs client p50 = **0.7 %**; server `batch_latency` is 15 % lower by construction (starts after queue/prepare). t0/t2/t4 + component index re-baselined, and the sampler now reports hypervisor steal + longest scheduler pause (18–39 % steal here).                                            | **pass** (absolute rates not reproducible; see Measurement validity)                  |
| **P1** window record on RocksDB             | log leg ≤0.6 ms/flush at b100; no catch-up or materialization regression                     | one window record as one `cf_actions` put: p50 **2,029 µs** at b100 (vs 2,162 matched), 9,417 µs at b1000 (vs 10,690). Append-shape gate met in direction; catch-up page p50 and materialization **not measured**, so the phase gate is **unmet**.                                                                          | **adopt-in-part** (append shape only)                                                 |
| **P2** dedicated log                        | H1 by the better backend; R1/R2 decided; I2/I4                                               | not started: H1 is dead at D3, so a dedicated log cannot pay on this host.                                                                                                                                                                                                                                                  | **parked** (depends on H1)                                                            |
| **P3** membership + resolver pool           | H2 + I1                                                                                      | not started: depends on P2's record format; D2's blocking finding applies.                                                                                                                                                                                                                                                  | **parked**                                                                            |
| **P4** consumers + reads + tap              | H4 hot-group row; R3                                                                         | not started. Existence-index cost measured instead: +7.2 % at k=2, +20.2 % at k=4, +21.6 % at k=8 (`mix bench.component_index`).                                                                                                                                                                                            | **parked**                                                                            |
| **P5** matrix + decisions                   | H5 ledger clean; H6 reported                                                                 | matrix produced for the current writer and the three append arms; H5 crash ledger **not run** (needs the prototype's consumers); H6 reported below.                                                                                                                                                                         | **partial**                                                                           |

## Corrections to this ledger

Two claims were published and then withdrawn. Both are kept with the mechanism so the record
shows what changed the verdict, not only the final number.

1. **"`t2 × spread × u2` is rejected because the authorizer reads committed state."** Wrong.
   The workbook emits a new entity's two `entityGroup` ownership Updates first and truncates
   to `--updates-per-action`, so u2 drops the content Updates and files an entity it never
   creates. The authorizer's refusal is correct and fail-closed; same-Action creation (`u5`)
   authorizes. Fixed in `aebe5c20`; the harness shape is follow-up #2 below.
2. **"The append floor is 1.15–1.27 ms of `fdatasync`, so H1 is falsified."** Wrong. The arm
   appended past EOF into a sparse preallocated file, so every `datasync` also committed ext4
   block allocation and an inode-size change. In place, the same 64 KB write+datasync costs
   337–381 µs. Pre-writing the segment (`log_first_recycled`) halves the append to 960 µs and the
   stop rule is not met. `RESULTS.md` carries the probe table. The gap also holds under
   concurrency (c=8, three interleaved passes): 1.6× the rate and 2.4× better p50
   (`log_first_recycled` 2,343–2,364 µs vs `current_window` 5,444–6,380 µs).
3. **"t0 regressed 45 % since #485 (20,320 → 11,105 Actions/s)."** Withdrawn as a code claim.
   The runs now report hypervisor steal from `/proc/stat`: 25.3 % → 10,855 Actions/s, 26.8 % →
   10,730, **39.4 % → 8,070**, while per-flush cost is unchanged (20.4 ms per 399 Actions at
   `t2` now vs 20.8 ms then) and p50 improved (3.6 vs 4.62 ms). A 25→40 % steal swing covers the
   whole spread, so the drop cannot be attributed to #799 from these runs.

## Per-hypothesis verdict

- **H1 (append) — target missed, direction confirmed, not falsified.** The gate was ≤0.4 ms
  per 100-Action flush at `hot`. Measured with the design's record format: 1.982 ms into a
  sparse append, **0.960 ms into a pre-written segment** (41,410 Actions/s vs 27,140 for the
  matched `write_batch`), 7.349 ms per 1,000 Actions at b1000. The gate is missed by 2.4× at
  b100 (0.406 ms for the append alone, excluding assembly), but the issue's falsifier — "the
  leg stays within 1.5× of today", i.e. ≥1.27 ms — is **not** met, so this hypothesis does not
  stop the spike. The first reading (1.2 ms "fsync floor") was an ext4 metadata artifact:
  in-place writes cost 337–381 µs, appends that allocate or extend the file pay 809–1,080 µs. The
  owned log's advantage comes from controlling the file's block state, not the record shape.
- **H2 (resolution) — correctness established, speed gate missed.** `as_of: gsn` entity→group
  resolution reproduces the Writer's persisted `update_scopes` **byte-for-byte on 1,200/1,200**
  generated Actions (3 seeds) covering create-in-same-Action, second-group filing, move,
  membership delete and field update. It does **not** run faster per call: 1–2 µs for the
  versioned index and for the current ETS caches, and a 4-process pool is no better. The
  Writer's resolve phase is 10.3 µs/Action, so the cost is fold + planning + memoization, not
  the membership read. H2's "≥3× serial" is therefore not met by resolution alone; it can only
  be met by moving the whole prepare stage, which is P3 and was not built. Two traps the corpus
  found are recorded in `RESULTS.md`: an entity can hold two live rows naming the same group,
  and the persisted scope order is the cache bag's insertion order.
- **H3 (end-to-end) — unmeasured; the arithmetic no longer rules it out.** The t0 flush at
  b100 is 3.0–3.6 ms p50, of which the durable commit is 2.2 ms and scope resolution 1.0 ms.
  Replacing the commit with the measured 0.96 ms append puts the flush near 2.3 ms (~1.6×);
  reaching 4× needs the non-append phases (resolve, prepare, fan-out, caches) off the serial
  path, which is P3/P4 and was not built. The earlier claim that 4× was arithmetically
  impossible rested on the retracted 1.2 ms floor and is withdrawn.
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

- **`disk_log`** — **measured (D3b, build `fcdd7936`) and discarded.** 1,927 µs per 100-action
  flush (lower is better) against 1,965 µs for the matched `write_batch` and 986 µs for the
  recycled segment: 0.98× today and 1.95× slower than owning the segment. The earlier reason
  given here ("it sits on the same `datasync`") was wrong as stated — `sync/1` is `file:sync/1`
  (fsync) — but the conclusion holds for a better reason: a halt log preallocates nothing, so
  every append grows the file, which is the ~1,080 µs metadata path, and an external-format
  file cannot even be read back by `chunk/3`, so it does not replace D1's recovery.
- **Owned segments vs window-record-on-RocksDB** — measured. At b100: 1,982 µs vs 2,029 µs
  (0.5 % apart, inside run-to-run spread); at b1000: 8,855 µs vs 9,417 µs (6 %). The owned
  log's extra 6 % is not worth a new recovery surface when the format risk is the whole point
  of the spike.
- **Catch-up source (`.gix` sidecar vs scan-and-filter)** — not decided; it needs the real
  record format and a catch-up page benchmark, which is P1's unmeasured half.
- **Window sizes** — measured: 10 / 100 / 1000. Larger windows amortise the fsync (b1000 is
  0.89–1.07 ms per 100 Actions) and are the only lever that reaches the H1 per-Action band.

## Measurement validity on this host

The harness now reports **hypervisor steal** (`/proc/stat`) and the **longest scheduler pause**
(a 1 ms watchdog) for every pass. On `recsy-vps` both are material: 18–22 % steal during the
`t5` arms, 25–39 % during `t0`, a 456 ms pause in a 20 s busy loop, and a 50 ms pause even in a
1 ms sleep loop. The p99 of 53–80 ms that every tier shows is that, not the code: it survives
on tmpfs and at 3–9 % scheduler utilisation.

What that means for every row in this ledger:

- **p50 from interleaved A/B passes is usable.** The append comparison was run A/B/A/B/A/B; its
  ~2× p50 gap held in all three pairs while the host's steal moved. D3b (disk_log) ran alongside
  another child's measurement and its steal swung 15–69 %; its p50 ordering still held, its
  Actions/s column does not — treat that column as indicative only.
- **Absolute Actions/s, p95 and p99 are not reproducible here.** Two passes of the same config
  differed by 26 % with steal moving 25→39 %.
- **Any cross-build comparison (including #485's published numbers) is unsupported** until it is
  repeated on a quiet host or with steal reported alongside it. That is why correction 3
  withdraws the "drift since #485" claim rather than keeping it as a regression.

## Smallest subset that still pays

1. **Recycled (pre-written) segments for the append.** 960 µs vs 1,963 µs at b100 and 7,349
   vs 10,690 µs at b1000, with D1's record format and no new wire surface. It needs one
   decision the spike did not make: zero-fill on creation (measured, ~1.7 bytes written per
   byte logged) or recycle dropped segments by epoch (not measured, removes the double write).
2. **A versioned membership index, if P3 continues.** It reproduces the contract today
   (1,200/1,200 byte-identical), so correctness is not the blocker; per-call cost is unchanged,
   so the win has to come from moving fold/planning too. The format must also decide scope
   ordering (insertion order vs normalized) before anyone calls scopes byte-identical across
   engines.
3. **The `spread × u2` benchmark shape.** Invalid today (ownership Updates truncate the
   content), so it measures a rejected Action at `t2` and an unauthorized write at `t0`.
4. **Re-run the append matrix against the recycled segment before anything else.** The
   published matrix was measured on the sparse append; its append rows are 2× pessimistic.
5. **A quiet host for absolute numbers.** The tail is now explained — 18–39 % hypervisor steal
   plus 50–456 ms pauses — so the action is measurement, not code: repeat the matrix on a host
   that reports near-zero steal before quoting Actions/s or p99, and keep A/B interleaved.

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

1. `fix(bench)`: `--distribution spread --updates-per-action 2` emits an Action that files an
   entity it never creates (ownership Updates are emitted first and truncate the content), so
   the run is 100 % rejected at `t2` and measures an unauthorized write at `t0`. Either make
   u2 spread target a preloaded entity (two content Updates) or reject the combination in
   `Options.parse/1`. Same-Action creation needs u5/u10.
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
