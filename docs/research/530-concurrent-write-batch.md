# Concurrent `write_batch` (#530): can two BEAM processes overlap?

Research note for [issue #530](https://github.com/ebbjs/ebbjs/issues/530) — the
gating spike for [epic #529](https://github.com/ebbjs/ebbjs/issues/529) (Phase 0
of the sequenced-commit pipeline). It answers "does the NIF or RocksDB serialize
two concurrent `write_batch` callers?" from source. It contains **no
measurements**; the 1/2/4-caller table is the spike's own job.

**Sources read.** #530 and #529 (bodies, acceptance, phasing); the vendored NIF
(`ebb_server/deps/rocksdb/c_src/*`, hex package `rocksdb` 2.5.0 per
`deps/rocksdb/hex_metadata.config:2128`); the embedded RocksDB 10.7.5
(`deps/rocksdb/deps/rocksdb/include/rocksdb/version.h:14-16`) — `db/`
`db_impl_write.cc`, `db/write_thread.{h,cc}`, `include/rocksdb/options.h`,
`include/rocksdb/write_batch.h`, `db/db_impl/db_impl_open.cc`, `HISTORY.md`;
the Elixir wrapper `lib/ebb_server/storage/rocks_db.ex`; `bench/RESULTS.md` §#485
ablation; `bench/ebb_server/bench/{options,boot}.ex`; OTP 27 `erl_nif.h`.

The 1/2/4-caller measurements are published in
[`ebb_server/bench/RESULTS.md` § Concurrent `write_batch` (#530)](../ebb_server/bench/RESULTS.md#concurrent-write_batch-from-multiple-beam-processes-530).

**Provenance.** All `file:line` are the working tree on
`spike/issue-530-concurrent-write-batch`. `deps/` is gitignored but pinned by hex
(`mix.lock`); the built `deps/rocksdb/priv/liberocksdb.so` was checked with `nm
-C --defined-only` to confirm the source I cite is what is compiled
(`T erocksdb::WriteBatch(enif_environment_t*, int, unsigned long const*)` at
`0x35a010`). Claims are **[measured]** (someone ran it), **[derived]** (computed
from measured inputs), or **[from source]** (read out of code/docs).

---

## TL;DR

- **[from source] The NIF does not lock.** `write_batch/3` runs on a **dirty IO
  scheduler** and calls `db_ptr->m_Db->Write(*opts, wb)` directly
  (`deps/rocksdb/c_src/batch.cc:136`). There is no per-database mutex, no
  `DbObject` lock, no global write lock in erocksdb — only an atomic refcount
  (`c_src/refobjects.h:74,143-151`) and a close-request flag
  (`c_src/refobjects.cc:216-236`) that the write path never blocks on. **The
  only serialization is inside RocksDB's write thread.**
- **[from source] RocksDB allows both calls to be in flight, but merges them
  into one write group** whose leader does the WAL append (one `write()`, one
  `fdatasync()`) for the whole group (`db/db_impl_write.cc:1712,1773`). Memtable
  inserts are the parallel stage: each group member inserts its own batch
  (`:669-670,862`, `:1109-1111`).
- **[from source] `enable_pipelined_write: true`** (which production sets,
  `rocks_db.ex:77`) splits that into two queues: the WAL stage and the memtable
  stage run **concurrently for different groups** (`options.h:1217-1230`,
  `db_impl_write.cc:971-1096`). Group N's memtable insert overlaps group N+1's
  WAL write. It is already exactly the pipeline #529 wants, one level down.
- **[from source] `sync: true`** makes the group leader `fdatasync` the WAL once
  for the whole group before waking the followers
  (`db_impl_write.cc:1066,1741-1783`; `options.h:2223-2239`). So N sync callers
  arriving together share **one** fsync. Sync writes are never folded into a
  non-sync group's group (`write_thread.cc:510-512`).
- **[derived] The fsync is not the ceiling.** `--durability async` is only 3–8 %
  faster at b100 (`RESULTS.md:250-252`), and the durable-log floor is
  1.903 ms/flush of a 3.761 ms flush (`RESULTS.md:907,937-941`). Nearly all of
  that leg is Elixir-side assembly, 100 `batch_put` crossings and `InsertInto`
  (~0.3 ms is `fdatasync`). **The scaling ceiling is parallel batch assembly +
  parallel memtable insert, with the WAL append serialized but group-amortized.**
- **[derived] Go/no-go threshold.** With the commit leg = 1.903 ms and the rest =
  1.86 ms, 2 callers at raw speedup _S_ give an end-to-end V0 ceiling of
  `3.76 / (1.86 + 1.90/S)`. _S_ = 1.5 → 1.20×; _S_ = 2.0 → 1.34×. Below _S_ ≈ 1.2
  (→ ≤1.06×) the pipeline cannot pay for itself and Phase 1 should stop.

---

## 1. The NIF call path

| Fact                         | `file:line`                                                                                   |
| ---------------------------- | --------------------------------------------------------------------------------------------- |
| `write_batch/3` registration | `deps/rocksdb/c_src/erocksdb.cc:179` → **`ERL_NIF_DIRTY_JOB_IO_BOUND`**                       |
| `batch/0`, `release_batch/1` | `erocksdb.cc:177-178` → `ERL_NIF_REGULAR_BOUND`                                               |
| `batch_put/3,4`              | `erocksdb.cc:180-181` → `ERL_NIF_REGULAR_BOUND`                                               |
| Declaration                  | `c_src/erocksdb.h:93`                                                                         |
| **Definition**               | `c_src/batch.cc:120-147` (in `batch.cc`, **not** `erocksdb.cc` — that file only registers it) |
| The write itself             | `c_src/batch.cc:136` `rocksdb::Status status = db_ptr->m_Db->Write(*opts, wb);`               |
| `sync` → `WriteOptions.sync` | `c_src/erocksdb_db.cc:1020-1043`, `sync` branch at `:1026`                                    |
| DB handle acquisition        | `c_src/util.cc:100-111` → `refobjects.cc:216-236` (refcount only)                             |
| Elixir stub                  | `deps/rocksdb/src/rocksdb.erl:1731-1733`                                                      |
| Ebb's call site              | `lib/ebb_server/storage/rocks_db.ex:268-281`; `sync: true` hardcoded at `:277`                |
| Ebb's tuning                 | `rocks_db.ex:77` `[max_background_jobs: 4, enable_pipelined_write: true]`                     |

**Dirty IO scheduler vs normal.** `ERL_NIF_DIRTY_JOB_IO_BOUND` (`erl_nif.h:234-238`
in OTP 27) puts the call on the dirty **IO** pool, which is separate from the
normal scheduler pool and from the dirty **CPU** pool. A blocked `write_batch`
therefore occupies no normal scheduler slot — the waiter is parked in a NIF
thread. Pool sizes here are `normal=4, dirty_cpu=4, dirty_io=10`
(`erlang:system_info/1` on the bench host) [measured], so 4 concurrent committers
fit without starving the dirty-IO pool.

**Consequence for #529's numbers.** The 9.4 %/23.8 % `:scheduler.utilization` is
not scheduler starvation. It is a single `Writer` GenServer waiting on a NIF
thread. Concurrency here is free of scheduler cost; the cost of extra callers is
dirty-IO pool occupancy and RocksDB contention, not normal-scheduler pressure.

**No per-database lock.** The NIF body is three steps: resolve the DB resource,
resolve the batch resource, `DB::Write`. `DbObject` has no mutex on this path —
its only mutex is the close-request condition variable
(`refobjects.cc:75,86,133`), and `RetrieveDbObject` merely _checks_ the
`m_CloseRequested` flag. Nothing in `c_src/` wraps `DB::Write` in a
`MutexLock`; `c_src/mutex.h` is an eleveldb leftover used only by cache and
compaction-filter objects (`cache.cc:168-223`, `compaction_filter.cc:58-92`).

**Two NIF-level caveats that do matter:**

1. **One batch handle per caller.** After `Write` returns the NIF calls
   `wb->Clear()` and `enif_clear_env(batch_ptr->env)` (`batch.cc:137-140`).
   `WriteBatch` is explicitly not safe for concurrent non-const calls
   (`include/rocksdb/write_batch.h:20-23`), so a committer pool must build its
   own batch per call — which `rocks_db.ex:270` already does.
2. **Batch assembly is on normal schedulers.** A 100-op batch is 100
   `batch_put` NIF crossings at `ERL_NIF_REGULAR_BOUND` (`erocksdb.cc:180-181`),
   i.e. normal-scheduler work. At K = 4 committers on a 4-scheduler VM the
   **build** stage, not `write_batch`, can be what saturates. The 1/2/4-caller
   table must therefore report `:scheduler.utilization` per arm, or a build-stage
   ceiling will be misread as a RocksDB serialization point.

---

## 2. RocksDB internal concurrency

`DB::Write` → `DBImpl::Write` (`db_impl_write.cc:151-163`) → `WriteImpl`
(`:370`) → either `PipelinedWriteImpl` (`:540-543`, taken because Ebb sets the
option) or the classic single-queue path (`:545` onward).

| Stage                               | Classic path (option off)                                | Pipelined path (Ebb's config)                               |
| ----------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------- |
| Queue / leader election             | `JoinBatchGroup` `:552`                                  | `JoinBatchGroup` `:984` (WAL queue)                         |
| Group formation (≤1 MiB)            | `EnterAsBatchGroupLeader` `:649`; cap `options.h:1281`   | `EnterAsBatchGroupLeader` `:999`; same cap                  |
| WAL append (whole group, one write) | `WriteGroupToWAL` `:767` → `MergeBatch` `:1712`          | `WriteGroupToWAL` `:1066` → same                            |
| WAL fsync (one per group)           | inside `WriteGroupToWAL`, `:1741,1773`                   | same, before the group exits                                |
| Memtable insert                     | leader-and/or-parallel `:855-877`; `parallel` `:669-670` | second queue: `EnterAsMemTableWriter` `:1108`, `:1109-1111` |
| WAL queue released                  | —                                                        | `ExitAsBatchGroupLeader` `:1096` (after fsync)              |
| Overlap                             | memtable of group N starts only after its WAL            | memtable of group N ∥ WAL of group N+1                      |

**Does a single leader serialize them?** The WAL stage, yes; the call, no.
Concretely:

- Both BEAM processes enter `DBImpl::Write` concurrently; nothing rejects the
  second.
- If the second arrives while the first is still queued, the leader absorbs it
  into its group (`write_thread.cc:440-540`), writes **both** batches as one WAL
  record (`db_impl_write.cc:1712-1735`), and fsyncs **once** (`:1773`).
- The follower then applies its own batch to the memtable itself, on its own
  thread (`:556-598` caller side, `:1109-1111` launch side,
  `write_thread.cc:571-596` ordering).
- If the second arrives after the leader has already sealed its group, it is a
  **new** group behind the first in the WAL queue — serialized behind the first
  group's write+fsync, but (pipelined) not behind its memtable insert.

**`enable_pipelined_write: true` changes exactly this** (`options.h:1217-1230`,
verbatim): one queue becomes two; a writer "first enter[s] WAL writer queue and
then memtable writer queue", so queued writers "only have to wait for previous
writers to finish their WAL writing but not the memtable writing". The option is
only useful with **multiple concurrent writer threads and WAL enabled** —
upstream added it for that case (`HISTORY.md:2598-2609`, 5.5.0). A single Writer
never removes a stage, which is why #529 says the setting is unexercised today.

**Can the two calls share one WAL fsync?** Yes, when both land in one group: one
`MergeBatch` + one `Sync` (`:1712,1773`). Sync and non-sync writers are kept in
separate groups (`write_thread.cc:510-512`), so a mixed workload does not
silently upgrade or downgrade anyone.

**Can two memtable inserts proceed in parallel?** Yes, but only within one
memtable write group and only for compatible memtables: the leader calls
`LaunchParallelMemTableWriters` when `memtable_write_group.size > 1 &&
allow_concurrent_memtable_write` (`:1109-1111`; default `true`,
`options.h:1266`). `options.h:1258-1266` restricts this to `SkipListFactory`,
and `write_thread.cc:594` disables memtable grouping entirely if the leader's
batch `HasMerge()`. Ebb's batches are all `Put`s (`rocks_db.ex:273-275`), so it
qualifies — but only while no committer merges.

---

## 3. `sync` semantics and where the ceiling actually is

`sync: true` means "the DB write is not complete until the WAL has been
fdatasync'd" (`options.h:2223-2239`; `use_fsync` defaults `false`, so
`fdatasync`, `:822`). In the write path the flag becomes
`WalContext::need_wal_sync` (`db_impl_write.cc:991` pipelined, `:618` classic)
and is consumed by `WriteGroupToWAL`, which merges the group and then, once,
syncs every live WAL file (`:1741-1783`).

Group commit and sync interact the way the epic hopes:

- the fsync is charged **once per group**, not per caller;
- the fsync happens **before** followers are woken (`:1066` → `:1096`), so a
  follower's `write_batch` return still implies "my bytes are durable";
- therefore syncs of _different_ groups are strictly serialized, but syncs of
  _callers in the same group_ are free.

**Is the ceiling parallel WAL writes, parallel memtable writes, or something
else?** Neither of the first two alone. **[derived]** At b100 the fsync is ~8 %
of the flush ([#342](https://github.com/ebbjs/ebbjs/issues/342); consistent with
async being only 3–8 % faster, `RESULTS.md:250-252`), i.e. ~0.3 ms of the
3.761 ms flush, while the whole durable-log leg is 49 % (`RESULTS.md:907,937-941`).
So the serialized WAL stage is ~0.3 ms of `fdatasync` plus the checksum/append of
the merged record; the other ~1.6 ms of that leg is Elixir-side batch assembly,
100 `batch_put` NIF crossings and `InsertInto`. **The ceiling is parallel work
that today sits inside one process: batch assembly + memtable insert.** Group
commit (#342) amortizes the piece that is already smallest.

---

## 4. Known caveats

- **A `WriteBatch` is single-threaded for mutation** (`write_batch.h:20-23`) and
  the NIF clears it after the write (`batch.cc:137-140`). Never hand one batch to
  two committers.
- **`enable_pipelined_write` is a throughput option for concurrent writers**
  (`HISTORY.md:2609`), not a latency option. It is incompatible with
  `unordered_write` and with `atomic_flush` (`db_impl_open.cc:263-272`) — the
  latter is a real constraint for Ebb's five column families.
- **Upstream history contains pipelined-write correctness fixes**:
  callback-failure propagation in 6.0.0 (`HISTORY.md:2277,2314`), and in 5.15.0 a
  deadlock with `max_successive_merges > 0` plus a stuck-write bug that had
  existed since 5.5.0 (`:2389,2407,2413`). The vendored 10.7.5 is well past all
  three, but the option is not a "free" concurrency switch.
- **Concurrent memtable writes are SkipList-only** and incompatible with
  `inplace_update_support`/`filter_deletes` (`options.h:1258-1266`).
- **All concurrent writers stall together.** Backlog triggers
  (`write_buffer_manager_->ShouldFlush()`, `flush_scheduler_`, write-controller
  delay) make the group leader take `mutex_` and wait in `PreprocessWrite`
  (`db_impl_write.cc:1492-1560`), which blocks the queue behind it. Ebb passes
  no `no_slowdown` (`rocks_db.ex:277`), so a stalled pool stalls all committers.
  Concurrent callers do not make a stalled DB faster; they make the queue
  deeper. This is exactly #538's territory.
- **The Elixir wrapper does not serialize.** The `RocksDB` GenServer is lifecycle
  only; accessors "can be called from any process" (`rocks_db.ex:15-22`), and
  the DB handle is a `:persistent_term` (`rocks_db.ex:489-495`). A committer pool
  needs no protocol change to reach the DB.
- **No telemetry for WAL/fsync or group size.** The `rocksdb` package exposes
  neither (`RESULTS.md:1011-1012`), so the 1/2/4 table must infer grouping from
  per-call latency shape (flat p50 with rising aggregate = group commit;
  flat per-call throughput = serialization).

---

## 5. Implications for #531

The decision is not "does anything overlap" — the tape above says memtable work
must overlap. It is **how much of the 1.903 ms commit leg a second committer can
take.** [derived] from `RESULTS.md:907,937-941`: if the commit leg moves fully
off the sequencer and 2 callers achieve speedup _S_ on it, while the other
1.86 ms/flush stays serial:

| _S_ (2 callers on the commit leg) | V0 flush (ms) | V0 speed at b100 | Read                                               |
| --------------------------------: | ------------: | ---------------: | -------------------------------------------------- |
|                               1.0 |         3.761 |            1.00× | no overlap — stop                                  |
|                               1.2 |         3.444 |            1.09× | marginal: below #529's 1.08–1.15× Phase 1 estimate |
|                               1.5 |         3.127 |            1.20× | **go**                                             |
|                               2.0 |         2.812 |            1.34× | go, and expect V2's 2-committer step to pay off    |

**What the 1/2/4 table must show.**

1. **Primary go signal:** `sync: true`, commit-only workload, aggregate
   Actions/s at 2 callers ≥ **1.5×** the 1-caller rate (equivalently ≤ ~13 µs per
   Action vs 19 µs), and 4 callers ≥ 2× but visibly sub-linear. That clears the
   _S_ ≥ 1.5 bar above with margin. Measure aggregate rate at a _fixed offered
   load_ with each caller keeping one batch in flight; "4 callers × the 1-caller
   per-call rate" is not a parallelism measurement.
2. **Diagnostic split:** the `sync: false` arm separates NIF/RocksDB locking from
   fsync. If `sync: false` scales (~1.8× at 2 callers) but `sync: true` does not
   (~1.0×), the serialization is the WAL stage — the committer pool is
   **blocked on [#342](https://github.com/ebbjs/ebbjs/issues/342) group commit**,
   and #531 should land coupled to it or not at all. Given `RESULTS.md:250-252`
   predicts only a 3–8 % fsync share, this outcome would falsify the epic's cost
   model and is worth checking for that reason alone.
3. **Negative result.** Both arms flat (2 callers ≈ 1 caller, p50 latency
   unchanged, `dirty_io` pool not saturated): the DB handle serializes for Ebb's
   batch shape, and #529's Phase 1–3 phasing is unsound as written. The correct
   response is the one #530's acceptance already names — document the bottleneck
   and stop — and to pursue the measured 2.04× ceiling by **shortening** the
   flush (fewer CFs per Action, `entity_index` 0.65 ms and `watermark` 0.47 ms
   are the two largest slices, `RESULTS.md:919-934`) rather than by adding
   committers.
4. **Also record in the table**, because they change the reading: per-arm
   `:scheduler.utilization` (build stage runs on normal schedulers,
   `erocksdb.cc:180-181`), dirty-IO pool occupancy (`dirty_io=10` here), and
   whether throughput at 4 callers is limited by a saturating normal-scheduler
   pool rather than by RocksDB. Without those columns a build-stage ceiling and
   a RocksDB ceiling look identical.

**What a positive result does _not_ prove.** That the sequencer can be removed
from the path. #531 keeps claim, group resolution, apply and notify on one
process by design (#529 Invariants 5–7), so _S_ only ever buys the commit leg.
The honest summary for the epic: the NIF and RocksDB permit the pipeline
[from source]; the epic's 1.08–1.15× Phase 1 target needs _S_ ≥ 1.2
[derived]; and the pipeline's own ceiling (1.34× at _S_ = 2) is set by what
stays serial, not by how many committers are added.

---

## Sources

**Issues.** #530 (question, method, acceptance), #529 (epic: pipeline, invariants,
measured anchors 3.76 / 1.90 / 1.98 ms, 2.04× ceiling, phasing), #342 (fsync
share), #130 (raw 2-writer spike), #538 (overload hardening).

**NIF (`ebb_server/deps/rocksdb`).** `c_src/erocksdb.cc:176-192` (batch
registration), `c_src/batch.cc:120-147` (`WriteBatch` implementation),
`c_src/erocksdb.h:93`, `c_src/erocksdb_db.cc:1020-1043` (`parse_write_option`),
`c_src/util.cc:100-111` (`enif_get_db`), `c_src/refobjects.{h,cc}` (refcounting,
close mutex), `c_src/mutex.h`, `c_src/{cache,compaction_filter}.cc` (only mutex
users), `src/rocksdb.erl:1731-1733`, `hex_metadata.config:2128` (2.5.0),
`priv/liberocksdb.so` (`nm -C` symbol check).

**RocksDB 10.7.5 (`deps/rocksdb/deps/rocksdb`).**
`db/db_impl/db_impl_write.cc:151-163,370,540-543,552,618,649,669-670,767,790,855-877,971-1111,1492-1560,1653-1698,1700-1815`
(`Write`, `WriteImpl`, `PipelinedWriteImpl`, `PreprocessWrite`, `WriteToWAL`,
`WriteGroupToWAL`), `db/write_thread.{h,cc}:34-81,440-540,510-512,571-596,751`
(state machine, group formation, merge/sync exclusion, memtable grouping),
`include/rocksdb/options.h:1217-1230,1258-1266,1281,2223-2239,822`,
`include/rocksdb/write_batch.h:20-23`, `db/db_impl/db_impl_open.cc:263-272`,
`include/rocksdb/version.h:14-16`, `HISTORY.md:2277,2314,2389,2407,2413,2597-2609`.
