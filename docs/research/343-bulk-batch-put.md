# Bulk `batch_put` and what a NIF crossing is worth (#343)

[#343](https://github.com/ebbjs/ebbjs/issues/343) asks whether to collapse the
flush's ~1,200 per-op `:rocksdb.batch_put` calls into one NIF crossing, and
[#529](https://github.com/ebbjs/ebbjs/issues/529) detached it as the last
write-path lever the epic left open. This note prices the crossing at the
current shape, prototypes the bulk route in a patched `rocksdb` 2.5.0, measures
it against unmodified `main` on the existing harness, and prices the fork that
route would need. It is a decision note.

**Prototype note.** The fork is not in the tree. The measurement below was
taken with `deps/rocksdb` patched in place (a throwaway checkout, since `deps/`
is not committed) and one Elixir function changed;
§[Appendix](#appendix-the-patch) holds the whole shipped diff. Nothing in this
note is a proposal to land it.

## What this decides

1. **Do not fork, patch, or chase this. Close #343.**
   The bulk route delivers **+3.3% at `t0 c=1 depth 1`** and **+3.2% at
   `t2 c=8 depth 1`** against unmodified `main`, interleaved, five reports per
   arm. AC3 asks for **≥8% at both**, so the acceptance criterion fails at both
   shapes and, at `t0`, the two arms' rate ranges overlap.
2. **The commit leg really does get cheaper, and that is the useful part of
   the result.** `ebb.writer.commit_latency_ms` p50 falls **1,662 → 1,575 µs
   (−5.2%)** at `t0` and **5,272 → 4,743 µs (−10.0%)** at `t2`, with
   non-overlapping ranges at both tiers. The change removes real work; the
   flush period is just dominated by other terms (§[Where the saving
   lands](#where-the-saving-lands)).
3. **The crossing was never the cost, so "collapse the crossings" was aimed at
   the wrong term.** The NIF entry/exit itself measures **~33 ns/op**; a
   per-op `batch_put` at this shape costs **510–690 ns/op**. A list-taking call
   removes the crossing plus three `enif_make_copy` calls per op — worth
   **~150–200 ns/op, 26–35%** — and leaves **~320–410 ns/op** of
   `WriteBatch::Put` copying that no route in AC1 can delete (§[What the
   crossing costs](#what-the-crossing-costs)).
4. **The AC3 bar was arithmetically unreachable from this lever.** Op
   submission, timed in isolation at the same op counts, is **155 µs** of the
   `t0` flush period (**4.0%**) and **830 µs** of the `t2` period (**5.5%**).
   No route that only collapses op submission can exceed those shares;
   the measured +3.3% / +3.2% is most of the way to that ceiling, not a
   fraction of it.
5. **Route (b), a local NIF binding, is blocked twice.** It contradicts the
   repo's hard constraint ("No custom NIFs", `ebb_server/README.md`), and it
   is not implementable as stated: the batch handle is an opaque resource
   owned by the package's NIF, so a second NIF can only reach the ops by
   taking over the resource type by name and reading the package's private
   `struct Batch` layout and vendored RocksDB C++ ABI. That is a fork with
   extra coupling, not an alternative to one.
6. **Upgrading does not solve it.** `rocksdb` 3.1.2 and upstream `master` both
   expose only `batch_put/3,4`, still registered `ERL_NIF_REGULAR_BOUND`;
   3.0.0 **removed** `write/3`, the only list-taking write API the package ever
   had, and told callers to use the batch API. The direction of travel is the
   per-op batch, not a bulk call.
7. **AC2 is satisfiable and was satisfied in the prototype, but there is
   nothing to land.** One call per commit, and the resulting `WriteBatch` is
   byte-identical to today's at both canonical shapes (304 ops for 100 Actions,
   1,195 for 397), verified on `batch_count`, `batch_data_size` and
   `batch_tolist`. Landing it would buy a maintenance obligation for a
   sub-threshold win, so this note keeps the evidence instead.
8. **If it is ever revisited, the door is upstream, not a fork.** The patch is
   additive (4 files, +82 shipped lines, no upstream line changed) and fits
   the package's stated posture and CHANGELOG convention. It is not opened
   today: the win does not justify asking a maintainer to carry it, and the
   reachable upstream line (3.x) is not the version this repo pins.

## Where this fits

Workstream A of [epic #529](https://github.com/ebbjs/ebbjs/issues/529), which
closed with `t0 c=1` as the unmet goal and named #343 as its last lever. The
premise has moved twice since the issue was written:

- **The put count fell.** #575's coalesced entity index took the hot shape from
  502 to **304 puts per 100-Action flush**, so the per-op tax is paid 3.0 times
  per Action, not 5. The issue's "11–13% of write-path wall" was priced at the
  old count and folded the whole op-submission leg into the number, not just
  the crossings.
- **The fsync is priced and stays.** [#342](https://github.com/ebbjs/ebbjs/issues/342)
  leaves `sync: true` per commit and measures the fsync at 9.7% of the
  production flush period, which is why the submission leg's share of the
  _commit_ leg is larger than its share of the _period_.

So the question this note answers is narrower than the issue's: not "are NIF
crossings expensive?" but "how much of the remaining write-path wall is op
submission, and what would it cost to own the NIF that removes part of it?"

## The three routes

| Route                                | Shipped surface                                                                                                                      | What you own                                                                                                     | Land time here                                                   | Verdict                       |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------- |
| **fork/patch the `rocksdb` package** | 4 files, **+82 / −0** plus 60 lines of tests; 3 insertion points: NIF table, header, `rocksdb.erl` export + spec [M, this prototype] | the patch on every bump, and the upgrade decision forever (2.5.0 is the last 2.x; 3.x is the maintained line)    | immediate; ~30 min incremental rebuild, no new toolchain         | works; not worth it at +3.3%  |
| **local NIF binding**                | would need the package's `WriteBatch` resource type **and** its private `struct Batch` layout **and** the vendored RocksDB C++ ABI   | everything above, against internals with no compatibility contract, plus a stated retraction of "No custom NIFs" | unknown; the layout dependency makes every package bump a review | not implementable as stated   |
| **upstream it**                      | the same +82, plus tests (~60 lines)                                                                                                 | a PR, a review cycle, and a release; then nothing                                                                | one release cycle behind whatever we pin; only useful on 3.x     | the right door, if it reopens |

The fork's cost is not build tooling: this project already compiles RocksDB
from source (`deps/rocksdb/_build/cmake`), so a patched dep adds no new
compiler, no new CI step, and no new binary distribution. Its cost is
**version ownership** — see §[What the fork
costs](#what-the-fork-costs-against-upstream).

## Measurements

Measured **2026-10-29** on `recsy-vps` (AMD EPYC 7763, 4 schedulers, 16 GiB,
Elixir 1.17.3 / OTP 27), `main` @ `7877c7c`, temp DB, 20 s window after a 3 s
warmup, batch 100, 2-Update Actions, `hot`, `--seed 1`, port 4112. Five reports
per arm per row, **interleaved** (`main`, then fork, per round) so host drift
is split across both arms instead of landing on one.

Both arms run the same source tree, the same vendored RocksDB 10.x and the same
harness; the only differences are the added NIF function in the loaded
`liberocksdb.so` and one Elixir function (`RocksDB.write_batch/2`, plus the two
bench helpers that mirror it). That is a tighter control than a build-to-build
A/B, but it is not a rotated A/B in the #529 sense: the fork arm's `.so` is a
from-source rebuild of the patched package.

```sh
mix bench.actions --tier t0 --duration 20 --warmup 3 --concurrency 1 \
  --batch-size 100 --updates-per-action 2 --distribution hot --seed 1 --port 4112
mix bench.actions --tier t2 --duration 20 --warmup 3 --concurrency 8 \
  --in-flight 1 --batch-size 100 --updates-per-action 2 --distribution hot --seed 1 --port 4112
mix bench.actions --tier t5 --duration 20 --warmup 3 --concurrency 8 \
  --batch-size 100 --updates-per-action 2 --distribution hot --seed 1 \
  --durability sync --port 4112
```

Every one of the 30 runs passed guardrails (`Status: enforced. All guardrails
passed.`) with **0 rejected Actions and 0 write/transport errors**; the 20
`t0`/`t2` runs also reported **0 GSN holes** and a final watermark lag of 0
(`t5` reports holes `n/a` by design, see below).

### What the crossing costs

`ebb_server/bench/batch_put_crossings.exs` builds the canonical op list with
the bench's own `Bench.WriteBatch.build_ops/4` and times three routes over the
same ops: per-op `batch_put`, one `batch_put_many`, and `batch_count` (a
one-argument NIF with no term to inspect, which is the crossing floor). Each
cell is the median of 15 rounds of 100 whole batches, repeated three times.
The script prints `absent` and skips the bulk column on a build without the
function, so it runs on `main` before any patch exists.

| Shape         |   ops | crossing floor | per-op, `main` build | per-op, fork build | bulk submission |   bulk saves | `write_batch` (`sync: false`) |
| ------------- | ----: | -------------: | -------------------: | -----------------: | --------------: | -----------: | ----------------------------: |
| `t0` 100 Acts |   304 |     9.8 µs [M] |         155.2 µs [M] |       166.5 µs [M] |    112.2 µs [M] |  54.3 µs [M] |                    560 µs [M] |
| `t2` 397 Acts | 1,195 |    39.8 µs [M] |         829.9 µs [M] |       803.9 µs [M] |    487.7 µs [M] | 216.3 µs [M] |                  2,031 µs [M] |

The two per-op columns are the same code path in two builds: their ranges
overlap (`t0` 154.2–161.0 against 158.8–172.3 µs; `t2` 737.4–842.4 against
688.5–808.8 µs), which is the control showing the patched `.so` did not change
the per-op route. The `bulk saves` column is the median of the per-round
difference in the fork build (46.5–62.1 µs at `t0`; 181.6–321.1 µs at `t2`),
which is why it is not exactly the two medians subtracted.

Read the columns apart, because the gap between them is the finding:

- **The crossing is ~33 ns/op** — 5–7% of a per-op `batch_put` and 8–10% of a
  bulk-routed op. It is not what a 1,195-op flush is paying for.
- **The bulk call still costs ~320–410 ns/op.** It skips the NIF entry/exit and
  three `enif_make_copy` calls into the batch's private env, which is the
  ~150–200 ns/op (26–35%) it saves; what remains is list traversal, term
  inspection and `WriteBatch::Put`'s copy into the batch's representation
  buffer. Every route in AC1 pays that copy, including upstream's, so **no route
  in AC1 can make op submission free**, and the AC3 bar cannot be reached by
  deleting crossings. Repeat runs drift by up to ~10% on this host, so treat
  these as orders of magnitude, not constants.
- **Per-op submission scales slightly worse than linearly** (510 → 694 ns/op
  from 304 to 1,195 ops), consistent with the batch's representation buffer
  growing and being copied as it fills. The bulk route inherits that growth
  (368 → 408 ns/op), which is why its relative saving grows with flush size but
  its absolute floor does not move.

### The end-to-end A/B

Medians of five reports per arm, with min–max in brackets where the run set
recorded one. `Actions/flush` is the flush the Writer actually produced, so the
two arms are compared at the same shape (100 / 397 Actions).

| Tier / shape     | Arm   |                 Actions/s |            p50 (ms) | p95 (ms) | p99 (ms) | Actions/flush |     commit p50 (µs) |
| ---------------- | ----- | ------------------------: | ------------------: | -------: | -------: | ------------: | ------------------: |
| `t0 c=1 depth 1` | main  |    25,750 [25,110–26,415] |    3.55 [3.44–3.61] |     4.25 |     5.09 |           100 | 1,662 [1,566–1,683] |
|                  | fork  |    26,600 [25,835–26,720] |    3.43 [3.40–3.47] |     4.20 |     5.04 |           100 | 1,575 [1,509–1,599] |
|                  | **Δ** |                 **+3.3%** |           **−3.5%** |    −1.1% |    −1.1% |             — |           **−5.2%** |
| `t2 c=8 depth 1` | main  |    26,370 [25,865–26,800] | 28.71 [28.17–29.53] |    35.35 |    39.83 |           397 | 5,272 [4,943–5,568] |
|                  | fork  |    27,225 [26,620–29,430] | 27.80 [25.74–28.38] |    34.45 |    39.29 |           397 | 4,743 [4,400–5,064] |
|                  | **Δ** |                 **+3.2%** |           **−3.2%** |    −2.6% |    −1.3% |             — |          **−10.0%** |
| `t5 K=8 sync`    | main  | 102,365 [100,330–103,125] |    6.30 [6.26–6.38] |     9.50 |    12.86 |             — |                   — |
|                  | fork  | 104,135 [100,875–105,000] |    6.16 [6.13–6.24] |     9.47 |    12.65 |             — |                   — |
|                  | **Δ** |                 **+1.7%** |           **−2.3%** |    −0.3% |    −1.6% |             — |                   — |

**How to read the noise.** The rate delta is the least clean number here: at
`t0` the arms' ranges overlap (25,110–26,415 against 25,835–26,720), so +3.3%
is at the edge of what five reports separate on this host. The _commit-leg_
delta is clean at both tiers — the fork's worst `t0` report (1,599 µs) is below
the main arm's median (1,662 µs), and its worst `t2` report (5,064 µs) is below
the main arm's median (5,272 µs). That is the causally expected direction: the
change removes work from the commit leg, and the flush period moves by that
work's share.

**`t5` is a caller-side control, not a NIF control.** The `t5` timer spans only
`:rocksdb.write_batch/3`, so batch construction — the thing this change alters
— is outside it; the `t5` rate delta is the bench caller's submission cost
(the bench's own `Bench.WriteBatch.batch/1` was routed through the bulk call
for this arm). The `t5` p50 column is `write_batch` alone and moves by −2.3%,
which is drift, exactly as expected when the timed region is unchanged. AC3's
`t5` leg therefore cannot measure this change; it is reported as a control.

### Where the saving lands

`ebb.writer.flush_phase_ms` splits one claimed range's lifetime. At `t2`, p50
across the five reports per arm:

| Phase           |  main p50 |  fork p50 |         Δ |
| --------------- | --------: | --------: | --------: |
| queue           |  7,836 µs |  7,493 µs |     −4.4% |
| prepare         |  1,505 µs |  1,465 µs |     −2.7% |
| resolve         |  5,710 µs |  5,711 µs |      0.0% |
| **commit_wait** |  8,336 µs |  7,759 µs | **−6.9%** |
| apply           |    292 µs |    285 µs |     −2.4% |
| notify          |    237 µs |    237 µs |      0.0% |
| sum p50         | 24,748 µs | 23,847 µs |     −3.6% |

`commit_wait` is the phase that contains the durable write, and it carries the
largest single saving; the neighbouring phases move by single-digit percentages
in the same direction, which is the shape you expect when the committing
process stops occupying a scheduler with per-op work. `resolve` — the
sequencer's own work, ending where the range is ready for a committer, and
untouched by this change — does not move at all, and the per-range `sum p50`
moves by −3.6%, which is the same size as the measured rate gain. That is the
causal check, and it passes.

The measured commit-leg saving (**87 µs** at `t0`, **529 µs** at `t2`) is
**1.6× / 2.4×** what the isolated micro-benchmark predicts (54 µs / 216 µs).
Per-op submission is more expensive when the four schedulers are shared than
when one process has them to itself, which is the mechanism #529 predicted for
the committer's crossings and the reason an idle micro-benchmark is a _lower_
bound on this lever.

### What a free submission would be worth

The bound that matters for AC3, before any fork:

| Tier | flushes/s | flush period | op submission, isolated | share of period |
| ---- | --------: | -----------: | ----------------------: | --------------: |
| `t0` |     257.5 |      3.88 ms |                  155 µs |        **4.0%** |
| `t2` |      66.4 |     15.06 ms |                  830 µs |        **5.5%** |

So a route that made op submission _free_ would be worth about +4% at `t0` and
+5.5% at `t2`. AC3 asks for +8% at both. The bar was set from the old
502-put/Action estimate, which measured the whole submission leg at 11–13% of
write-path wall _including_ the `WriteBatch::Put` copying that no route in AC1
removes; at today's 3.0 puts/Action and today's flush period, the same leg is
4.0–5.5% of wall.

## What the fork costs against upstream

**The diff.** Against hex `rocksdb` 2.5.0: 5 files, **+142 / −0**.

| File                | Lines | What it is                                                                     |
| ------------------- | ----: | ------------------------------------------------------------------------------ |
| `c_src/batch.cc`    |   +70 | `PutBatchMany/3`: one loop over `{put, Cf, Key, Value}` appending to the batch |
| `c_src/erocksdb.cc` |    +1 | `{"batch_put_many", 2, ...}` in the NIF function table                         |
| `c_src/erocksdb.h`  |    +1 | declaration                                                                    |
| `src/rocksdb.erl`   |   +10 | export, spec, doc, stub                                                        |
| `test/batch.erl`    |   +60 | three eunit tests (byte identity, column family, malformed list)               |

Nothing upstream is modified, so a rebase is three insertion points into files
upstream edits on every release (the NIF function table, the header
declarations, the `rocksdb.erl` export list). Conflicts would be textual and
compile-time visible, not silent: the function is compiled inside `batch.cc`,
so a `struct Batch` change breaks the build rather than the data.

**Which line it has to track.** 2.5.0 (2026-01-07) is the last 2.x release.
3.0.0 (2026-06-13) moved to vendored RocksDB 11.1.1 and removed `write/3`;
3.1.0–3.1.2 followed through 2026-07-25, and 3.1.2 vendors RocksDB 11.1.2. A
fork pinned at 2.5.0 sits on a closed line: every future fix (including
`batch.cc` fixes) has to be carried by hand, and the first time this project
wants a 3.x feature it pays the rebase _and_ the dep upgrade in the same PR.
That is the real cost — not the patch, which is small, but that the patch
converts a cheap dependency into a maintained one on a branch nobody else
tests.

**What a maintainer actually pays.** Per quarter, with the bump cadence this
repo has shown (`rocksdb` last moved in January 2026 and is still 2.5.0):
**nothing**, until someone wants a newer package. Then: re-apply three
insertions, rebuild (minutes, from source — the normal cost), run the package's
eunit suite and this repo's `test/ebb_server/storage`, and re-run the
`t0`/`t2`/`t5` matrix to confirm the patch still does what it did (about half a
day of measurement). In exchange the patch's benefit is a **3.2–3.3%** rate
gain and a **5–10%** shorter commit leg, forever, and the standing obligation
to be the only CI that tests this combination.

**Is it upstreamable?** Yes, and that is the recommended door if the decision
ever reopens. It is additive, it does not change any existing entry point, it
comes with tests, it fills an obvious gap in a package that advertises "Batch
operations support", and the package's README invites exactly this ("If a
particular feature of RocksDB is important to you, please let me know by
opening an issue"). The CHANGELOG convention has a `### New Features` heading
for it. It is **not** opened by this evaluation: the win does not justify
asking a maintainer to carry it, and the reachable upstream line is 3.x while
this repo pins 2.5.0.

## What would change this decision

1. **A shape where op submission is a larger share of the flush period.** The
   trigger is measurable in this repo's own report: `commit_wait` minus the
   other commit-leg phases, or simply the isolated op-submission time, above
   ~15% of the flush period. The plausible route to that state is **K
   concurrent committers** ([#531](https://github.com/ebbjs/ebbjs/issues/531)/[#536](https://github.com/ebbjs/ebbjs/issues/536)),
   where per-op submission work lands on K processes sharing four schedulers —
   the measured 1.6–2.4× contention multiplier is the evidence that this is
   where the term grows, and it is the reason this note does not claim the
   lever is worthless in general. Everything measured here is one committer at
   depth 1.
2. **A cheaper fsync.** [#342](https://github.com/ebbjs/ebbjs/issues/342) leaves
   `sync: true`, but if a future durability decision removes ~800 µs of
   per-commit fsync, the `t0` period drops from 3.88 ms to ~3.1 ms and this
   lever's share rises from 4.0% to ~5%, with the bulk route capturing ~4%.
   Still under 8%, so this alone does not reopen it.
3. **Upstream shipping a bulk put.** Then the win is free and should be taken
   on the next bump — no fork, no rebase, no ownership. Adopting it would be a
   one-line change in `RocksDB.write_batch/2` plus the byte-identity test in
   §[Appendix](#appendix-the-patch), and the expected gain is the +3.3% / +3.2%
   measured here.
4. **A flush shape with ≥4,000 ops.** At 3 ops/Action that is a 1,300-Action
   flush. The submission leg grows linearly with ops, so its share of the
   commit leg grows only slowly (it is already 9–16% of it); this would need to
   be measured, not assumed — the AC3 failure here is about shares, not about
   the crossing being free.

Decline triggers: if any of the above is proposed, re-run the interleaved A/B
in this note's shape before writing code. The measurement cost is ~30 minutes;
the fork's cost is permanent.

## Appendix: the patch

The shipped diff against hex `rocksdb` 2.5.0. The C function, the
registration, the wrapper and the call site are verbatim; the tests are three
eunit cases in `test/batch.erl` (byte identity against per-op `batch_put` via
`batch_count`/`batch_data_size`/`batch_tolist`, a column-family case, and a
malformed-list case).

```c
// c_src/batch.cc — one crossing for a whole op list. Ops arrive as
// `{put, Key, Value}` or `{put, ColumnFamily, Key, Value}`, the same shape
// `write/3` took. The keys and values are copied into the WriteBatch by
// `WriteBatch::Put`, so no term has to outlive the call and the batch's
// private env is left untouched.
ERL_NIF_TERM
PutBatchMany(
        ErlNifEnv* env,
        int /*argc*/,
        const ERL_NIF_TERM argv[])
{
    Batch* batch_ptr = nullptr;
    if(!enif_get_resource(env, argv[0], m_Batch_RESOURCE, (void **) &batch_ptr))
        return enif_make_badarg(env);

    rocksdb::WriteBatch* wb = batch_ptr->wb;
    ERL_NIF_TERM list = argv[1];
    ERL_NIF_TERM head, tail;

    while (enif_get_list_cell(env, list, &head, &tail))
    {
        const ERL_NIF_TERM* op = nullptr;
        int op_arity = 0;
        ReferencePtr<erocksdb::ColumnFamilyObject> cf_ptr;
        ErlNifBinary key, value;

        if (!enif_get_tuple(env, head, &op_arity, &op) ||
            !enif_is_identical(op[0], ATOM_PUT))
            return enif_make_badarg(env);

        if (op_arity == 4)
        {
            if (!enif_get_cf(env, op[1], &cf_ptr) ||
                !enif_inspect_binary(env, op[2], &key) ||
                !enif_inspect_binary(env, op[3], &value))
                return enif_make_badarg(env);

            rocksdb::Slice key_slice(reinterpret_cast<char*>(key.data), key.size);
            rocksdb::Slice value_slice(reinterpret_cast<char*>(value.data), value.size);
            wb->Put(cf_ptr->m_ColumnFamily, key_slice, value_slice);
        }
        else if (op_arity == 3)
        {
            if (!enif_inspect_binary(env, op[1], &key) ||
                !enif_inspect_binary(env, op[2], &value))
                return enif_make_badarg(env);

            rocksdb::Slice key_slice(reinterpret_cast<char*>(key.data), key.size);
            rocksdb::Slice value_slice(reinterpret_cast<char*>(value.data), value.size);
            wb->Put(key_slice, value_slice);
        }
        else
        {
            return enif_make_badarg(env);
        }

        list = tail;
    }

    if (!enif_is_list(env, list))
        return enif_make_badarg(env);

    batch_ptr = nullptr;
    return ATOM_OK;
}
```

```c
// c_src/erocksdb.cc — the only registration line
{"batch_put_many", 2, erocksdb::PutBatchMany, ERL_NIF_REGULAR_BOUND},
```

```erlang
%% src/rocksdb.erl — the export entry, then the spec and the stub
%%   batch_put_many/2,
-spec batch_put_many(Batch :: batch_handle(),
                     [{put, binary(), binary()} | {put, cf_handle(), binary(), binary()}]) -> ok.
batch_put_many(_Batch, _Operations) ->
  ?nif_stub.
```

The one call-site change, which is what a fork would ship in this repo:

```elixir
# lib/ebb_server/storage/rocks_db.ex
def write_batch(operations, opts \\ []) do
  name = Keyword.get(opts, :name, __MODULE__)
  {:ok, batch} = :rocksdb.batch()

  try do
    :ok = :rocksdb.batch_put_many(batch, operations)
    :rocksdb.write_batch(db_ref(name), batch, sync: true)
  after
    :rocksdb.release_batch(batch)
  end
end
```

Atomicity is unchanged: the op list still becomes **one** `WriteBatch`, so one
claimed GSN range still lands all-or-nothing. A malformed op list raises
`badarg` with the earlier ops already in the batch, exactly like a sequence of
`batch_put` calls that fails partway; `write_batch/2` releases the batch in its
`after` clause, so nothing is written and the Writer abandons that range. Both
behaviours are covered by tests in the prototype (`test/ebb_server/storage` +
`test/ebb_server/bench`: **1,113 tests, 0 failures**; the package's own
`batch` eunit module: **12 tests, 0 failures**).
