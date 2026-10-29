# The durability contract and what `sync: true` costs (#342)

[#342](https://github.com/ebbjs/ebbjs/issues/342) asks two things in one issue:
make fsync cheap enough that the coalesced flush can stay small (group commit),
and settle whether `sync: true` per commit is still the right contract. This note
answers both from measurement on current code. It is a decision note; the
published tables are in
[`ebb_server/bench/RESULTS.md`](../../ebb_server/bench/RESULTS.md#the-durability-contract-and-the-fsync-share-342).

**Scope note.** Ebb is greenfield and a database written by an older build is
discarded, not migrated. What is decided here is therefore the contract a
client may rely on from this build forward, not a transition.

## What this decides

1. **The shipped contract stays.** A claimed range commits with
   `write_batch(sync: true)` — hardcoded, not a knob
   (`rocks_db.ex:415`) — and a client is acked only after that fdatasync
   returns. The loss window for an acked Action is **zero**. The server has no
   configuration that weakens this; the only `sync: false` path in the tree is
   the bench's `--durability async` ablation.
2. **Group commit is not built.** At the default `max_in_flight: 1` the Writer
   has exactly one commit in flight at a time — its own moduledoc says it
   "never issues two batches concurrently, so `enable_pipelined_write: true` is
   dormant" (`writer.ex`). A group commit has nothing to group there, so a
   bounded window could only delay an ack waiting for a successor range that
   cannot be claimed until that ack is sent.
3. **Where commits _can_ overlap, RocksDB already groups them.** Concurrent
   `sync: true` writers merge into one write group whose leader does one
   fdatasync for the whole group — the source trace in
   [`530-concurrent-write-batch.md`](./530-concurrent-write-batch.md) — and Ebb
   reaches that state by raising `max_in_flight`, which also raises the
   committer pool size. Measured, the residual of removing the sync there is
   **+2.3%** of rate (t2 depth 2) against a **+78%** p50. That is the depth tax
   [#537](https://github.com/ebbjs/ebbjs/issues/537) already priced, not a new
   lever.
4. **The fsync is priced, so the _other_ option can be decided with numbers.**
   The only mechanism that captures the fsync's 8–25% of wall at the shapes we
   run is the one the epic struck: acks that do not wait for durability, i.e. a
   stated loss window (`sync: false` plus a bound). That is a retraction of
   #529's invariant 2, a product decision, and it needs a versioned client
   statement — not a performance change. §[Measurements](#measurements) is the
   price. Reopen #342 only under the triggers in
   §[What would change this decision](#what-would-change-this-decision).
5. **AC4 is reworded, not met.** `commit_latency_ms` cannot be split
   internally: RocksDB exposes no per-write "time spent in fdatasync" to the
   caller. The sync share is the `--durability async` ablation, which runs all
   the way through the Writer's `commit_fn` seam today, so the number AC4 asked
   for is measurable — as an ablation, not as a phase inside one commit.

## Where this fits

Workstream B of [epic #529](https://github.com/ebbjs/ebbjs/issues/529). The
epic's realignment already trimmed #342 to "group commit only" (a stated
durability window acks before durability and is out), and its sequencing put
#342 after the flush operating point because that decision shifts the curve.

[#576](https://github.com/ebbjs/ebbjs/issues/576) then closed **flat**: at the
production shape, capping the flush at 128–225 Actions is −0.2% rate at +0.9%
p50, and a positive coalescing timeout loses 16–25% wherever it is tried. So
the 152-Action regime #342 was written for does not exist as a policy outcome.
It is reachable today only through the `2×4` caller split, which is the depth
lever, and that row is measured below precisely because it is the smallest
flush shape the current code actually produces.

The issue's 28–40% figure is the **saturated `t5` commit path**, not the
production shape. The table below separates the three denominators, because
conflating them is what made the prize look bigger than it is at the operating
point and smaller than it is at the ceiling.

## Measurements

Measured **2026-10-29** on `recsy-vps` (AMD EPYC 7763, 4 schedulers, 16 GiB,
Elixir 1.17.3 / OTP 27), `main` @ `7877c7c`, temp DB, 20 s window after a 3 s
warmup, batch 100, 2-Update Actions, `hot`, `--seed 1`, port 4112. Three reports
per row for the depth-1 shapes and two for depth 2 and `2×4`, alternating
sync/async within a pass so host drift is not confounded with durability. Every
run: **0 GSN holes, 0 rejected Actions, 0 write/transport errors**, guardrails
enforced and passed.

`--durability async` injects `EbbServer.Bench.Boot.async_commit/2` as the
Writer's `:commit_fn` (`boot.ex`, `writer.ex`), so the t0/t2 rows are the same
pipeline with one line changed in the NIF call. The delta against the `sync`
row of the same shape is therefore exactly what the fdatasync buys.

```sh
# the three Writer shapes: ceiling, production, and the smallest flush we run
mix bench.actions --tier t0 --duration 20 --warmup 3 --concurrency 1 \
  --batch-size 100 --updates-per-action 2 --distribution hot --seed 1 --port 4112 \
  --durability sync     # and: --durability async

mix bench.actions --tier t2 --duration 20 --warmup 3 --concurrency 8 --in-flight 1 \
  --batch-size 100 --updates-per-action 2 --distribution hot --seed 1 --port 4112 \
  --durability sync     # and: --durability async

mix bench.actions --tier t2 --duration 20 --warmup 3 --concurrency 2 --in-flight 4 \
  --batch-size 100 --updates-per-action 2 --distribution hot --seed 1 --port 4112 \
  --durability sync     # and: --durability async

# the saturated commit path, no Writer: the issue's 28% denominator
mix bench.actions --tier t5 --duration 20 --warmup 3 --concurrency 8 \
  --batch-size 100 --updates-per-action 2 --distribution hot --durability sync
  # and: --durability async
```

### Each shape, both arms

Medians of the per-report medians; min–max in parentheses where it moves.
`commit p50` is `ebb.writer.commit_latency_ms` (frame encode + op assembly +
`write_batch`); `fsync / commit` is the sync row's commit p50 minus the async
row's, and the share is that against the shape's steady-state flush period
(`Actions/flush ÷ Actions/s`).

| Shape       | Durability | Actions/flush |                 Actions/s | p50 (ms) | p99 (ms) |     commit p50 (µs) |
| ----------- | ---------- | ------------: | ------------------------: | -------: | -------: | ------------------: |
| `t0 c=1 d1` | `sync`     |           100 |    25,980 (25,085–26,340) |     3.50 |     5.18 | 1,616 (1,611–1,671) |
| `t0 c=1 d1` | `async`    |           100 |    32,650 (31,725–32,945) |     2.73 |     4.16 |       812 (803–874) |
| `t2 8×1 d1` | `sync`     |           397 |    25,755 (25,505–25,865) |    29.41 |    41.67 | 5,349 (5,223–5,584) |
| `t2 8×1 d1` | `async`    |           392 |    27,800 (27,790–28,885) |    27.05 |    39.01 | 3,852 (3,777–3,911) |
| `t2 2×4 d4` | `sync`     |           143 |    27,658 (27,560–27,755) |    27.34 |    39.59 | 2,743 (2,720–2,765) |
| `t2 2×4 d4` | `async`    |           143 |    30,800 (30,385–31,215) |    24.29 |    35.87 | 1,518 (1,489–1,547) |
| `t2 8×2 d2` | `sync`     |           516 |    28,990 (28,735–29,245) |    52.32 |    74.49 | 8,685 (8,622–8,747) |
| `t2 8×2 d2` | `async`    |           493 |    29,645 (29,535–29,755) |    51.19 |    74.23 | 6,586 (6,562–6,611) |
| `t5 K=8`    | `sync`     |  100 / commit | 102,725 (101,920–104,190) |     6.28 |    12.92 | — (write_batch p50) |
| `t5 K=8`    | `async`    |  100 / commit | 150,560 (149,500–154,025) |     2.77 |    10.27 |                   — |

### What removing the sync buys, and what the sync costs

| Shape                           | Actions/flush | Δ Actions/s |  Δ p50 | fsync / commit | fsync / Action | share of flush period |
| ------------------------------- | ------------: | ----------: | -----: | -------------: | -------------: | --------------------: |
| `t0 c=1 d1`                     |           100 |  **+25.7%** | −21.9% |         804 µs |        8.04 µs |             **20.9%** |
| `t2 2×4 d4`                     |           143 |  **+11.4%** | −11.2% |       1,225 µs |        8.53 µs |             **23.6%** |
| `t2 8×1 d1`                     |           397 |   **+7.9%** |  −8.0% |       1,497 µs |        3.77 µs |              **9.7%** |
| `t2 8×2 d2`                     |           516 |   **+2.3%** |  −2.2% |       2,099 µs |        4.07 µs |             **11.8%** |
| `t5 K=8` (saturated, no Writer) |  100 / commit |  **+46.6%** | −55.9% |              — |              — |                     — |

The cost is not a constant: it tracks the WAL bytes one commit writes, so a
100-Action commit pays ~0.8 ms and a 397-Action commit pays ~1.5 ms, and the
per-Action term is 8.0 / 8.5 / 3.8 µs at 100 / 143 / 397 Actions per flush. That is the
amortisation #342 wanted, and the operating point already has it: the production
flush of 397 Actions is now four times the 100-Action flush the `t0` ceiling
runs, and its per-Action sync cost is less than half.

### Depth 2 already is the group commit

The two `t2` rows above are the same offered load at depth 1 and depth 2. Adding
the second in-flight range lets two commits overlap, which is the only way a
sync can be shared without delaying an ack:

| Shape               | Δ Actions/s from removing the sync | Depth-2 sync row vs depth-1 sync row                                            |
| ------------------- | ---------------------------------: | ------------------------------------------------------------------------------- |
| `8×1 d1` → `8×2 d2` |                  +7.9% → **+2.3%** | +12.6% Actions/s (**25,755 → 28,990**), +78% p50 (**29.4 → 52.3 ms**), +79% p99 |

Removing the sync at depth 1 is worth 7.9% of rate. At depth 2 — where the
committer pool has two workers and the write thread merges the syncs — the same
removal is worth 2.3%, because the pipeline is now latency-bound rather than
commit-bound (`commit_wait` grows from 8.5 ms to 21.5 ms p50, #537's finding).
So the "group commit" option exists in the product already, priced as the depth
knob, and its whole benefit over the current default is +12.6% rate for +78%
p50. The epic rejected that trade on its latency goal, and this note does not
reopen it.

### The saturated ceiling

At `t5` K=8 — no Writer, eight BEAM processes calling `write_batch` directly —
removing the sync raises the ceiling by **46.6%** (102,725 → 150,560 Actions/s),
and the `write_batch` p50 goes 6.28 → 2.77 ms. That is the largest number any
durability relaxation can buy, and it is the wrong denominator for #342: it is
eight writers queueing behind the write thread's sync, not a production-shaped
flush. It is also the number that moves when the stored shape changes, which is
why the stored-shape workstream now owns the ceiling question.

## Why a bounded window cannot capture this

Two mechanisms are available, and neither is a win at the shapes we run:

- **Overlapping commits** (the depth knob). Measured above: +12.6% rate for
  +78% p50, and only 2.3% of it is the fsync. This is not a durability change
  at all — the ack still waits for a sync covering its range.
- **`manual_wal_flush: true` + a periodic `sync_wal`.** The only mechanism that
  groups _sequential_ commits. The open option exists in the pinned package
  (`rocksdb.erl`, `erocksdb_db.cc`) but `sync_wal/1` is a `?nif_stub` on the
  Erlang side, so it needs the same fork/patch door #343 is contemplating. More
  importantly it weakens the contract in a way that is _not_ just latency: with
  manual WAL flush a `write_batch(sync: false)` returns before the WAL is
  written to the OS, so a process — not just a machine — crash can lose a range
  the server has already applied, notified, and let subscribers read. Every
  release gate that today keys off "the commit returned" (ordered apply,
  fan-out frontier, resolution frontier, in-flight id release, restart
  reconcile) would have to be re-gated on a second, later durability event.

The latency cost of _waiting_ for a group is already priced, and it is larger
than the whole prize: #576 measured a coalescing timeout of 5 ms at −16.3% rate
(`t2`) and of 1 ms at −24.7% (`t0 c=1`). A group-commit window is the same wait
by another name.

## The contract, stated

For clients and for `docs/`:

- An Action is **acked** only after its range's `write_batch` with
  `sync: true` has returned. Process crash or machine crash loses **no acked
  Action**; RocksDB WAL replay restores the range on restart.
- A range that is claimed but never commits (committer crash, raised op
  assembly, timeout) leaves a **permanent GSN hole**. Holes are valid: the
  watermark is a resolution frontier, not a gap-free log (`writer.ex`). A
  client whose range was abandoned gets an error, never an ack.
- `sync: true` is **not configurable** on the server. A deployment cannot
  trade durability for throughput, by accident or on purpose.
- Commit durability is per range and ordered per claim: at `max_in_flight > 1` a
  successor range may become durable before its predecessor, but no client is
  acked before its own range is.

## What would change this decision

Raise #342 again only if one of these becomes true, and re-run the ablation
before designing anything:

1. **The product accepts a stated loss window.** Then the answer is option (b),
   not group commit: retract invariant 2 explicitly, publish the bound, and
   version the client statement. This note prices it — +7.9% at the production
   shape, +11.4% at 143/flush, +25.7% at the `t0` ceiling, +46.6% at the t5
   ceiling — so the decision can be made on numbers rather than on the issue's
   stale 28–40%.
2. **The deployment disk is slower than this host's.** Everything here is
   `recsy-vps` with a temp DB. If `fdatasync` costs more than ~2 ms on the
   volume a deployment actually uses (`/app/data`, see
   [`docs/self-hosting.md`](../self-hosting.md)), the shares above roughly
   double and the calculus changes. Re-run the async arm on that volume.
3. **The commit leg gets much cheaper.** #343 (bulk `batch_put`) and further
   stored-shape work shrink the non-sync part of the commit, which raises the
   sync's share. When a 100-Action commit is under ~0.4 ms, the fixed sync is
   the dominant term and the flush-size arithmetic is different from this note.
4. **A deployment runs depth ≥ 2 as its default with an acceptable p99.** Then
   the fsync is already shared; only the 2.3% residual is on the table, and the
   question is dead.

Commands to re-measure are in §[Measurements](#measurements); the raw reports
are `bench/results/*-recsy-vps.md`, gitignored as usual.
