# Write-path spike (#485): decision support

Research note for [issue #485](https://github.com/ebbjs/ebbjs/issues/485) —
"spike the highest-ROI architectural write-path changes". It is the evidence
base for the spike's _Decisions_ section, not the spike itself.

**Sources read.** #485 (body + candidates + decisions + protocol); linked issues
#111, #113, #130, #287, #328, #331, #336, #338, #339, #340, #342, #343, #428;
`ebb_server/bench/RESULTS.md`; the write path (`writer.ex`, `dirty_tracker.ex`,
`entity_index.ex`, `system_cache.ex`, `watermark_tracker.ex`, `entity_store.ex`,
`field_merge.ex`, `rocks_db.ex`); the read path (`entity_store.ex`,
`field_merge.ex`, `sqlite.ex`); fan-out (`fan_out_router.ex`, `group_server.ex`,
`sse_connection.ex`); the bench harness (`bench/ebb_server/bench/*.ex`) and the
raw runs under `bench/results/`.

**Provenance / working-tree caveat.** All `file:line` references are the current
working tree at time of writing. The `--ablate <phase>` bench seam
(`ebb_server/lib/ebb_server/storage/writer.ex`,
`bench/ebb_server/bench/{options,metrics,boot}.ex`, `ebb_server/mix.exs`,
`test/support/test_helpers.ex`) is the spike's own apparatus and **landed as
commit `2ca55a4`** ("add a Writer ablation seam for the flush cost breakdown");
line numbers for those files are for that commit. Everything else is its parent
`242a0fa`, except that `ad8e43b` (the `:ordered_set` entity-group fix) is an
ancestor and post-dates the published `RESULTS.md` tables.

Numbers are labelled **[measured]**, **[estimate]** (a rough magnitude with a
stated basis), or **[unmeasured]** with the command that would settle it.

---

## TL;DR for the decisions section

- **[measured]** The current baseline is **~21–25 k Actions/s** at the canonical
  `t0`/`t2` config on the 4-scheduler `recsy-vps` VM. `bench/RESULTS.md`'s
  published **15.3 k** headline predates #338/#339/#340 and is stale
  (`bench/RESULTS.md:49-86` vs the retained raw runs, e.g.
  `bench/results/20261010T002145Z-recsy-vps.md` = 21,780/s t2 c=8 120s,
  `20261010T002359Z` = 24,977/s t0 c=8 30s).
- **[estimate]** The two-store-only overhead (everything past the `cf_actions`
  append) is a _minority_ of the flush wall: `build_ops` is ~25–27 % (#485 body,
  #336 close comment), fsync ~8 % at b100 (#342), and the remaining
  index/dirty/cache work is not separately attributed today. Removing **all**
  of it therefore cannot by itself reach the issue's ≥2× target; the recent
  history (#338 +19.6 %, #339 +13.6 %, #340 ≈0 %) is consistent with that shape.
- **[estimate]** The **cheapest large win is fan-out** (candidate #4). The T3
  cliff is **−91 % at 1,000 subscribers** [measured] (`bench/RESULTS.md:190-206`)
  and the mechanism is visible in code: `Jason.encode!` runs once per
  _(subscriber × action)_ at `sse_connection.ex:87`, inside a per-subscriber
  process, so the cost is O(S×A) total CPU, not a serialization point. One
  pre-encoded binary per group per action cuts it to O(S + A).
- **[unmeasured]** The materialization model (#1/#2) is the only candidate with
  the _ceiling_ to reach 2×, but it is the highest-effort/most-invasive and its
  memory bound is unmeasured. Decide it on a prototype, not on this note.
- **The no-NIF fork is real for a _custom engine_ only.** #111's rule is "the
  storage engine must be a _dependency_, not custom Rust code"
  (`#111` comment, "Hard Constraints"), and the README's current wording is
  "**Elixir/OTP only** for the server. No custom NIFs; we use the `rocksdb` hex
  package" (`ebb_server/README.md:577`). Candidates #1–#7 are all reachable in
  pure Elixir; only "write our own native storage engine" collides. Vendoring
  the existing `rocksdb` NIF for the #343 bulk call is a gray area (§5).

**ROI-per-effort ranking** (details in §2): **#4 > #3 > #5 > #1/#2 > #7 > #6.**
This ranking is pre-measurement and **superseded by §8.4** after the
ablation: the measured order is **#4 > #5 > #1/#2 > #7 > #3 > #6**.
This deliberately differs from #485's leverage ordering: #1 has the highest
_ceiling_ but the worst effort/risk ratio; #4 is the only change with a
[measured] cliff to recover at low blast radius.

---

## 1. Current flush cost model

One `write_batch` critical path, in order. "Cost class" is what the step spends.
Line numbers: parent commit `242a0fa` unless marked **(ablation seam)** = commit
`2ca55a4`.

| #      | Step                                | `file:line`                                                                                                                                                            | What it does                                                                                                                                                                                                                             | Cost class                                           |
| ------ | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 0      | HTTP intake (t1/t2/t3 only)         | `sync/router.ex:63`                                                                                                                                                    | Bandit → `Plug.Conn.read_body` → `decode_msgpack/1` `Msgpax.unpack` (`sync/router.ex:582-596`) → `PermissionChecker.validate_and_authorize/2` (`sync/router.ex:69`, `permission_checker.ex:88`)                                          | CPU (msgpack decode) + ETS (perms) + message passing |
| 0b     | Writer mailbox wait                 | —                                                                                                                                                                      | `GenServer.call` sits in the Writer's mailbox behind the current flush. **Not instrumented** (`RESULTS.md:378-380`).                                                                                                                     | message passing / queueing                           |
| 1      | Enqueue + coalesce decision         | `writer.ex:451` → `enqueue/3` `writer.ex:481`, burst-drain `send(self(), :flush)` `writer.ex:466-476`                                                                  | Appends `{from, actions}` to `pending`; either flushes inline at `batch_max_size` (default 1000, `writer.ex:346-351`), arms a timer at `batch_timeout_ms` (default 0, `writer.ex:353-358`), or sends the tail-of-mailbox `:flush` marker | message passing                                      |
| 2      | `flush/1`                           | `writer.ex:495`, `503` (ablation seam)                                                                                                                                 | Reverses `pending`, calls `plan/2`                                                                                                                                                                                                       | CPU                                                  |
| 3      | `plan/2`                            | `writer.ex:550` (ablation seam)                                                                                                                                        | Drops empty-Update Actions, `Enum.uniq_by` action id (first wins), then `drop_committed/2`                                                                                                                                               | CPU (alloc)                                          |
| 4      | `drop_committed/2`                  | `writer.ex:614-633`                                                                                                                                                    | One `RocksDB.multi_get/3` on `cf_action_dedup` for the whole flush (`rocks_db.ex:297`); zips results back to ids                                                                                                                         | I/O (NIF, hot block cache)                           |
| 5      | GSN claim                           | `writer.ex:512`; `gsn_counter.ex`                                                                                                                                      | `:atomics.add_get` one contiguous range for the coalesced burst                                                                                                                                                                          | atomics                                              |
| 6      | `caller_ranges` + reply bookkeeping | `writer.ex:569`, `587`                                                                                                                                                 | Maps each caller to its contiguous sub-range; deferred reply                                                                                                                                                                             | CPU (alloc)                                          |
| 7      | `write_batch/4`                     | `writer.ex:642` (ablation seam)                                                                                                                                        | Wraps build+commit+post-commit in `try/…/after`                                                                                                                                                                                          | CPU                                                  |
| 7a     | provisional dirty marks             | `writer.ex:673` `pending_marks/2` (ablation seam); `dirty_tracker.ex:88`                                                                                               | `affected_entities/1` (`writer.ex:991`, uniq by `subject_id`) then `mark_pending_batch/2` → one ETS insert per entity, value `{:pending, gen}`. `hot` ⇒ 2 entities/flush; `spread` ⇒ 2×batch                                             | ETS write                                            |
| 7b     | `build_ops/3`                       | `writer.ex:687` (ablation seam)                                                                                                                                        | Per-flush group-resolution memo + `:lists.append` + `type_entity_ops/2` (MapSet dedup, sort)                                                                                                                                             | CPU (alloc)                                          |
| 7b-i   | intra-action context                | `writer.ex:1144` → `PermissionHelper.build_intra_action_context/1`                                                                                                     | Maps entity → wire-carried groups so a create+membership in one Action indexes correctly                                                                                                                                                 | CPU (alloc)                                          |
| 7b-ii  | group resolution                    | `writer.ex:1171` `build_update_ops/6` (ablation seam) → `group_ids_for_update` `writer.ex:1200` → `entity_index.ex:96-132`                                             | ETS reads per Update, memoized per `{subject_type, subject_id}` across the flush (#340); `fan_out_preference/1` (`entity_index.ex:235`) picks wire vs source vs by-id                                                                    | ETS read                                             |
| 7b-iii | key encoding                        | `rocks_db.ex:148` `encode_entity_gsn_key`, `rocks_db.ex:219` `encode_type_entity_key`, `rocks_db.ex:165` `encode_group_action_key`, `rocks_db.ex:137` `encode_gsn_key` | One per Update / per group / per Action                                                                                                                                                                                                  | CPU                                                  |
| 7b-iv  | ETF encode                          | `writer.ex:1103` `:erlang.term_to_binary(to_storage_format(...))`; `to_storage_format/3` `writer.ex:1148`                                                              | Builds the stored map (incl. `"update_scopes"`, index-aligned with `"updates"`) and encodes once per Action                                                                                                                              | CPU (C BIF)                                          |
| 7b-v   | index op assembly                   | `writer.ex:1108-1126` (ablation seam); `writer.ex:712` `type_entity_ops/2`                                                                                             | `cf_entity_actions` put per Update; `cf_group_actions` put per unique group per Action (#339); `cf_type_entities` one put per unique key per flush (#339)                                                                                | CPU (alloc)                                          |
| 8      | `commit/7`                          | `writer.ex:718` (ablation seam) → `state.commit_fn.(ops, …)` → `rocks_db.ex:268`                                                                                       | `write_batch/2`: loop `:rocksdb.batch_put/4` per op (`rocks_db.ex:274`) then `:rocksdb.write_batch(…, sync: true)` (`rocks_db.ex:277`)                                                                                                   | NIF crossing per op + fsync                          |
| 9      | `mark_committed/3`                  | `writer.ex:1044` → `watermark_tracker.ex:111`                                                                                                                          | **One ETS tuple per GSN** (`{gsn, pid}`) inserted into the `:ordered_set`, then `advance_watermark/1`                                                                                                                                    | ETS write ×batch                                     |
| 10     | `advance_watermark/1`               | `watermark_tracker.ex:129` → `do_advance_loop` `135`, `prune_committed` `161`, `has_committed?`                                                                        | `:ets.select_delete` over the frontier + `:ets.match_object` per step + `:atomics.compare_exchange`                                                                                                                                      | ETS read/delete                                      |
| 11     | `apply_post_commit/2`               | `writer.ex:752` (ablation seam)                                                                                                                                        | `mark_dirty_batch/2` recomputes `affected_entities/1` a **second time** (`writer.ex:753`; `dirty_tracker.ex:63`) and ETS-inserts per entity                                                                                              | ETS write + alloc                                    |
| 12     | cache mutations                     | `writer.ex:777` `plan_cache_mutations/2`, `writer.ex:945-984` `apply_cache_mutation/2`                                                                                 | One pass over Updates planning `groupMember`/`entityGroup`/`relationship`/`entity_type` rows, `drop_repeats/1`, then ETS writes via `GroupCache`/`EntityGroupCache`/`RelationshipCache`/`EntityTypeCache`                                | CPU + ETS write                                      |
| 13     | `notify_batch_committed/5`          | `writer.ex:1064` → `notify_router/2` `writer.ex:1075`                                                                                                                  | `send/router` `{:batch_committed, from, to, groups_by_gsn, committed_at}`                                                                                                                                                                | message passing                                      |
| 14     | `after` → `resolve_range/3`         | `writer.ex:1052` (ablation seam; `after` at `writer.ex:642-668`)                                                                                                       | **Second** `mark_range_resolved` + `advance_watermark` per flush (idempotent; the `after` guarantee)                                                                                                                                     | ETS read/delete                                      |
| 15     | `Telemetry.execute` batch latency   | `writer.ex:661`                                                                                                                                                        | One sample per flush                                                                                                                                                                                                                     | —                                                    |
| 16     | fan-out: Router                     | `fan_out_router.ex:192` → `process_batch` → `push_and_update` `fan_out_router.ex:431`                                                                                  | Buffers the range, gates on the watermark, then `push_gsn_range/4`                                                                                                                                                                       | CPU + I/O                                            |
| 17     | fan-out: read + decode              | `fan_out_router.ex:513-532`                                                                                                                                            | `range_iterator` over `cf_actions` and `:erlang.binary_to_term/2` **per Action** (`fan_out_router.ex:526`); groups Updates by group via `ActionScope.updates_for_group/2` (`action_scope.ex:22`)                                         | I/O (NIF) + CPU                                      |
| 18     | fan-out: dispatch                   | `fan_out_router.ex:552` → `group_server.ex:76-80`                                                                                                                      | `GenServer.cast` `{:push_actions, …}` per group; GroupServer then nested-loops **per subscriber × per action** and casts to each `SSEConnection`                                                                                         | message passing                                      |
| 19     | fan-out: encode + send              | `sse_connection.ex:85-95`                                                                                                                                              | `Jason.encode!` **per action per subscriber**, then `send(parent, {:sse_chunk, "data", payload})`                                                                                                                                        | CPU + message passing                                |
| 20     | `[:fanout, :push_latency_ms]`       | `group_server.ex:86`                                                                                                                                                   | One sample per batch per group                                                                                                                                                                                                           | —                                                    |

### What is instrumented today, and what is not

Instrumented telemetry (`EbbServer.Telemetry`): `[:writer, :batch_size]`
(`writer.ex:515`), `[:writer, :actions_per_sec]` (`writer.ex:544`),
`[:writer, :batch_latency_ms]` (`writer.ex:661`), `[:writer, :commit_failed]`
(`writer.ex:741`), `[:writer, :range_resolved]` (`writer.ex:1021`),
`[:system_cache, :populated]` (`system_cache.ex:621`),
`[:entity_store, :materialize_latency_ms]` / `[:entity_store, :cache_hit_rate]`
(`entity_store.ex:106,144`), `[:fanout, :push_latency_ms]`
(`group_server.ex:86`). The bench collector attaches to three latency events
(`bench/ebb_server/bench/telemetry.ex:37-41`) and the harness's 1 Hz sampler
reads watermark/dirty-set/RSS/scheduler utilisation (`bench/.../sampler.ex:44`).

**Not instrumented, and why:**

- **Writer mailbox wait.** `batch_latency_ms` starts _after_ dequeue
  (`writer.ex:643`), so it excludes the queueing time; documented as a
  limitation at `RESULTS.md:378-380`.
- **Per-phase split of `write_batch`.** Only one whole-flush sample exists.
  There is no `build_ops` / `drop_committed` / `commit` / `mark_committed` /
  `apply_post_commit` timer. The #340 `build`-share numbers came from grabbing
  an allocation counter / profiler, not from telemetry (`RESULTS.md:337-345`).
- **`drop_committed` cost.** No sample; visible only in profiles.
- **Fan-out encode cost.** `[:fanout, :push_latency_ms]` is per _batch per group_
  (`group_server.ex:86`), so the O(subscriber) `Jason.encode!` in
  `sse_connection.ex:87` is invisible; the T3 collapse is inferred from
  throughput + scheduler utilisation (`RESULTS.md:184-206`).
- **RocksDB compaction/flush backlog.** The `rocksdb` package exposes no
  property and emits no telemetry (`RESULTS.md:418`).
- **The new `--ablate` seam (commit `2ca55a4`).** `writer.ex:1198` `ablate?/2`
  gates `dedup | group_resolution | entity_index | group_index | dirty | cache |
watermark | fanout` (`bench/.../options.ex:64`). This is the #485
  acceptance-measurement apparatus for "append the log and apply nothing else,
  then add each piece back". There is still no timer _inside_ `write_batch`;
  the per-phase cost is measured by **A/B throughput deltas** — the rate with
  the phase ablated versus without — which is the method actually used for the
  measured breakdown in §8.

**Takeaway.** The model is a single serialized `build → commit → post-commit`
pipeline whose largest named components are ETF encode + group resolution +
`commit` (NIF/fsync) + `cf_*` puts. Everything after the `cf_actions` put is
candidate-#1 territory; the fan-out legs 16–20 are candidate-#4 territory.

---

## 2. Candidate-by-candidate analysis

Each entry: hypothesis → measurable prediction → concrete code → leverage
[estimate/build basis] → risk/blast radius. Commands are the harness surface
from `bench/ebb_server/bench/options.ex` / `mix bench.actions`; `--ablate` is
commit `2ca55a4`.

### #1 — On-write, in-process materialization (collapse the dual store)

- **Hypothesis.** The log append is cheap; the two-store split is what forces
  `DirtyTracker` provisional/settled marks, the read-side
  scan→`FieldMerge`→SQLite upsert, and the per-Update index CFs
  (`cf_entity_actions`, `cf_type_entities`) — remove them and the write ceiling
  rises.
- **Measurable prediction.** With the `--ablate` seam (`2ca55a4`), one `t0` run
  at each step, each with a throughput delta:
  ```sh
  # log-only (cf_actions + ETF encode, no dedup/index/dirty/cache/watermark/fanout):
  mix bench.actions --tier t0 --duration 30 --warmup 3 --concurrency 8 \
    --batch-size 100 --updates-per-action 2 --distribution hot \
    --ablate dedup,group_resolution,entity_index,group_index,dirty,cache,watermark,fanout
  # add back one phase at a time, e.g. entity index:
  mix bench.actions --tier t0 --duration 30 --warmup 3 --concurrency 8 \
    --batch-size 100 --updates-per-action 2 --distribution hot \
    --ablate dedup,group_resolution,group_index,dirty,cache,watermark,fanout
  ```
  Prediction: log-only ≥ full t0; the sum of add-back deltas equals the
  two-store overhead, and that overhead is **[estimate] < 40 %** of the flush at
  b100 (basis: `build_ops` ~25–27 % per #485/#336, fsync ~8 % per #342, and
  #339's index dedup already captured ~14 %). A log-only run well above 2× the
  full t0 would falsify this and justify the rewrite; a log-only run near full
  t0 would park #1.
- **Concrete code.** This is not a small diff. What would change:
  - Writer deletes `cf_entity_actions` emission (`writer.ex:1189-1191`),
    `cf_type_entities` emission (`writer.ex:712-716`), and `DirtyTracker` calls
    (`writer.ex:673-680`, `752-757`); adds an in-process `EntityStore` apply of
    `FieldMerge.merge/2` per `put`/`patch`/`delete` during `apply_post_commit`
    (`field_merge.ex:68`, `entity_store.ex:364-419` are the reusable pieces).
  - `EntityStore.get/3` (`entity_store.ex:82-104`) drops the
    `DirtyTracker.dirty?` branch and the whole `do_materialize/2`
    (`entity_store.ex:153-303`) path; `query/4` (`entity_store.ex:450-478`)
    drops the dirty sweep and loses the SQL/JOIN layer
    (`sqlite.ex:329-372`).
  - `SQLite` and the `entities` table become a rebuildable projection (or
    disappear) — the §3/§4 decision.
- **Leverage.** Highest _ceiling_, lowest _certainty_. **[estimate]** Removing all
  non-append work bounds at <2× (log-only) unless the log append itself is
  already the limit; #130's _raw_ 60 k/s single-writer is not comparable (Apple
  Silicon, 10 schedulers, batch 1000). The realistic win is the read-side
  savings (no replay, no SQLite upsert) plus deletion of the dirty machinery —
  _not_ a 2× write number on its own.
- **Risk / blast radius.** Very high: changes the durability/source-of-truth
  story, the `SystemCache` rebuild/`rest_for_one` contract
  (`system_cache.ex:225-260`), the `EntityStore` read contract that `router.ex`
  serves (`router.ex:101,143`), and the SQLite rebuildability claim
  (`sqlite.ex:10-14`). Requires the memory measurement in §3 first.

### #2 — Read-path posture / side-car interface

- **Hypothesis.** If materialization is process-local, the **log** is the
  integration interface, not a shared DB file.
- **Measurable prediction.** Not a throughput number; a _shape_ decision
  (§3/§4). The bench-feasible part is the memory/boot cost of the local store
  (see #1 and #6). A prototype's read-path latency is measurable with
  `GET /entities/:id` / `POST /entities/query` — the harness does not currently
  have a read tier (**[unmeasured]**; be explicit that a read tier is new work).
- **Concrete code.** The shared-state surface to break: `SQLite` single
  GenServer (`sqlite.ex:156-200`), `EntityStore` composition
  (`entity_store.ex:44-47`), `SystemCache.populate_type` calling
  `EntityStore.materialize` (`system_cache.ex:503`), and the reader list in §4.
  The read replica fed by the log already has a blueprint: `ActionLog.read/3`
  (`action_log.ex:38-56`) feeding `ActionExport` (`action_export.ex:141-190`).
- **Leverage.** Enabler, not a number. **[estimate]** It is a prerequisite for
  #1's read-side savings; #113 and #367 already assume the log-reader interface
  (`#113` comment 2026-10-14: "the committed-log reader is owned by #367").
- **Risk.** Architectural; forks the whole plan. Couples to #428 (read pool for
  the _current_ SQLite posture) — if #428 ships, the shared-file posture is
  being invested in.

### #3 — Encode once

- **Hypothesis.** An Action is ETF-encoded for `cf_actions`, key-encoded per
  Update for three CFs, and JSON-encoded per subscriber; build the log record
  once and one fan-out binary per group.
- **Measurable prediction.** Count encodes, then measure:
  ```sh
  mix bench.actions --tier t3 --duration 15 --warmup 3 --concurrency 8 \
    --batch-size 10 --updates-per-action 2 --distribution hot --subscribers 1000
  ```
  Prediction: with one binary per group, the JSON-encode count drops from
  S×A to G×A (G = groups with a subscriber; the bench has one group, so ~1000×
  fewer encodes at 1,000 subscribers). T3 at 1,000 subscribers should move from
  the 611/s [measured] baseline (`RESULTS.md:193`) toward the T2 batch-10
  baseline (6,677/s, `RESULTS.md:186`), bounded by delivery fan-out.
- **Concrete code.** The ETF encode is _already once per Action_
  (`writer.ex:1103`) — that part is done. The remaining redundancy:
  `sse_connection.ex:87` (`Jason.encode!` per subscriber per action),
  `fan_out_router.ex:526` (`binary_to_term` per Action per pushed range),
  `entity_store.ex:314` (`binary_to_term` per Action on materialize),
  `entity_store.ex:287` + `router.ex:621,655` (`Jason.encode!` per entity /
  response). Key encodes at `rocks_db.ex:137,148,165,219`.
- **Leverage.** **[estimate]** Large only in the fan-out fan-count dimension;
  the write-side ETF/key encodes are inside `build_ops`'s ~25–27 % and cannot
  move much. Overlaps #4; land #4 first and #3 collapses into it.
- **Risk.** Medium. Building one JSON binary in `GroupServer` loses nothing
  subscriber-specific (all subscribers on a group get the same Updates after
  `ActionScope` filtering, `action_scope.ex:22`), but it moves the encode to
  the GroupServer process (one per group, shared scheduler pressure).
  Per-Update scoping (#473) must stay: encode per _(group, action)_, not per
  Action.

### #4 — Fan-out shape (highest ROI/effort)

- **Hypothesis.** One binary per group, coalesced delivery, dispatch off the
  commit scheduler recovers the T3 cliff.
- **Measurable prediction.** Re-run the subscriber sweep:
  ```sh
  mix bench.actions --tier t3 --duration 15 --warmup 3 --concurrency 8 \
    --batch-size 10 --updates-per-action 2 --distribution hot --subscribers 100
  mix bench.actions --tier t3 --duration 15 --warmup 3 --concurrency 8 \
    --batch-size 10 --updates-per-action 2 --distribution hot --subscribers 1000
  ```
  Baselines [measured]: 100 subs −82 % (1,176/s, `RESULTS.md:192`), 1,000 subs
  −91 % (611/s, `RESULTS.md:193`), 49 % scheduler utilisation at 100 subs
  (`RESULTS.md:196-197`). Prediction:
  O(S×A)→O(S+A) encoding recovers most of the loss; **the 10k point stays
  unmeasured** (needs a bigger machine, `RESULTS.md:203-206`).
- **Concrete code.** `group_server.ex:76-80` is the O(S×A) hot loop; encode once
  per `{group, action}` (or once per group-batch) and `send` the same binary to
  each subscriber. `sse_connection.ex:85-95` becomes a pure forwarder.
  `fan_out_router.ex:535-548` already builds per-group action lists, and
  `ActionScope` already filters per Update.
- **Crucial correction to the issue's premise.** #485 says "move dispatch off
  the commit scheduler". It is _already_ off the Writer: the Router
  (`fan_out_router.ex:192`), GroupServers, and SSEConnections are all separate
  processes. The bottleneck is total CPU volume (O(S×A) encodes), not a
  serialized dispatch point. The fix is fewer encodes, not a scheduler move.
  Also note `GroupServer.push_actions` is a `cast` (`group_server.ex:35`), so
  delivery is already asynchronous.
- **Leverage.** **[estimate]** Highest ROI: [measured] −91 % cliff, an
  O(S×A)→O(S+A) mechanism visible in code, pure Elixir, no storage-format
  change, and the measurement command already exists. Caveat: it reduces the
  _fan-out tax_, not the single-Writer ceiling — it will not by itself produce a
  2× t2 headline.
- **Risk.** Low–medium. `SSEConnection` becomes a forwarder; the
  `committed_at` latency sample (`group_server.ex:86`) stays per-group; no
  protocol change. Must preserve per-Update scoping and the self-echo presence
  filtering.

### #5 — Watermark / ETS bookkeeping

- **Hypothesis.** Per-GSN ETS tuples are the wrong representation.
- **Measurable prediction.**
  ```sh
  mix bench.actions --tier t0 --duration 30 --warmup 3 --concurrency 8 \
    --batch-size 100 --updates-per-action 2 --distribution hot --ablate watermark
  ```
  Prediction: removing `mark_range_committed`/`advance_watermark` (2× per flush)
  moves t0 by a few percent at most; basis: it is O(batch) ETS inserts + two
  `select_delete`/`match_object` scans per flush against a bounded table
  (`watermark_tracker.ex:159-165` prunes at/below the frontier).
- **Concrete code.** `watermark_tracker.ex:111-118` inserts one `{gsn, pid}` per
  GSN; for a single Writer the frontier is simply the last committed `to`, and
  `{from, to}` interval tuples would collapse batch inserts to one. `writer.ex`
  calls `advance_watermark` twice per flush (`writer.ex:1046` and
  `writer.ex:1054`); `affected_entities/1` is computed twice per flush
  (`writer.ex:676`, `writer.ex:753`) — pass the first result through.
- **Leverage.** **[estimate]** Small (single-digit percent) and cheap. It is
  _required groundwork_ for #287 multi-Writer, where per-GSN `{gsn, pid}`
  ownership is exactly the claim/abandon ambiguity #287 describes.
- **Risk.** Low, but the watermark is load-bearing for ordered fan-out and
  catch-up (`watermark_tracker.ex` moduledoc); a bitset/interval rewrite needs
  the #287 ownership semantics in mind, not just the single-Writer case.

### #6 — Startup snapshot

- **Hypothesis.** Boot scales with system-entity count because ETS is rebuilt
  from RocksDB; a checkpoint bounds it.
- **Measurable prediction.** The harness boots, then seeds (`runner.ex:33`
  `Workbook.seed`), and `--entities` preloads _through the Writer after boot_, so
  **the current harness does not measure restart-to-ready.** [unmeasured] Add a
  boot-time metric or time `Boot.start/1` + `SystemCache.populate_system_caches/1`
  at `--entities 0/10000/100000`.
- **Concrete code.** `system_cache.ex:161` `populate_system_caches/1` →
  `populate_caches_from_indexes/4` (`system_cache.ex:342`) →
  `populate_type/6` (`system_cache.ex:493`) which calls
  `EntityStore.materialize/2` per system entity; `backfill_type_entities/3`
  (`system_cache.ex:549`) is a **one-time** full `cf_actions` walk gated by a
  durable marker (`system_cache.ex:70-75, 598-608`). A snapshot/checkpoint
  (RocksDB checkpoint + a serialized ETS image, or a persisted frontier) would
  target the `cf_type_entities` walk.
- **Leverage.** **[estimate]** Likely **not a write-path lever**: `populate_type`
  only prefix-scans the three system types (`groupMember`, `entityGroup`,
  `relationship`), so 100k `todo` entities should not slow boot. Prediction to
  falsify: boot time is flat in `--entities` for a `todo`-only workload.
  This is a _hypothesis worth one measurement_, then park.
- **Risk.** Low if parked; medium if a snapshot format is added (migration +
  the "fail loud, never half-populated" contract at `system_cache.ex:56-60`).

### #7 — Single canonical encoding at the wire/log boundary

- **Hypothesis.** Wire=MessagePack, log=ETF, fan-out/SQLite=JSON, so every
  Action is decoded and re-encoded; persisting one canonical form saves a pass.
- **Measurable prediction.** No `--ablate encode` phase exists; measure via the
  t1/t2 delta and a profile, or add a bench phase. [unmeasured] The candidate
  exercise is a `t1` run at b1/b10 to expose msgpack decode share
  (`sync/router.ex:587`).
- **Concrete code.** `decode_msgpack/1` (`router.ex:582-596`) → `term_to_binary`
  (`writer.ex:1103`); readers re-decode (`fan_out_router.ex:526`,
  `entity_store.ex:314`, `catch_up.ex:124`, `system_cache.ex:560`). #113 plans to
  serve `cf_actions` values directly; #343 wants a bulk `batch_put`. A canonical
  persisted form should be chosen once, shared by #113's replication reader
  (`action_log.ex`) and #343's write path.
- **Leverage.** **[estimate]** Small alone; high _coordination_ value. It is the
  decision #485 must record for #113/#343, per §6.
- **Risk.** High if it changes the on-disk record: format migration, `[:safe]`
  decode guarantees (`action_log.ex:23`), and every reader. Prefer to keep ETF
  on disk and canonicalize the _wire→log_ pass only if the profile justifies it.

---

## 3. Materialization model question (#1/#2)

### What "collapse the dual store" concretely requires

The two-store split is not one mechanism; it is a set of mechanisms that exist
**only** because entity state is materialized lazily in a second engine. Each
has a distinct purpose and a distinct fate:

| Mechanism                                                    | Purpose                                                                                                                                                                               | `file:line`                                          | Fate if applied in-process                                                                                                                                                                            |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DirtyTracker` provisional marks `{:pending, gen}`           | Close the window between "commit returns" and "entity marked dirty": a read must never see a clean entity behind a committed Action                                                   | `dirty_tracker.ex:88`, `writer.ex:673`               | **Disappears.** State is applied in the same commit step, so there is nothing to re-materialize.                                                                                                      |
| `DirtyTracker` settled marks + generation compare-and-clear  | Correctness under concurrent materializers; a newer mark survives an older clear                                                                                                      | `dirty_tracker.ex:63,240`; `entity_store.ex:225-231` | **Disappears** with the dirty set.                                                                                                                                                                    |
| `clear_pending_batch` / `settle_all_pending`                 | Failure/recovery paths, crash reconcile                                                                                                                                               | `dirty_tracker.ex:113,136`; `writer.ex:400-417`      | **Disappears** (the reconcile becomes "rebuild the store from the log").                                                                                                                              |
| Read-side scan + incremental replay                          | Read only the delta since `last_gsn`                                                                                                                                                  | `entity_store.ex:190-203,305-419`                    | **Disappears from read**; the same `FieldMerge.merge/2` moves to the write/commit step.                                                                                                               |
| `FieldMerge.merge/2` / `stamp/2`                             | The protocol's LWW rule; pure, reusable                                                                                                                                               | `field_merge.ex:66-118`                              | **Moves** from read-replay to commit-apply. No rule change.                                                                                                                                           |
| SQLite `upsert_entity/2`                                     | Durable materialized row + the query layer                                                                                                                                            | `sqlite.ex:156,245-265`                              | **Demoted** to a rebuildable projection (or removed) — this is the #2 decision.                                                                                                                       |
| `plan_cache_mutations/2` + `apply_cache_mutation/2`          | Maintain the permission/scope caches (`groupMember`, `entityGroup`, `relationship`, `entity_type`) that auth and fan-out read                                                         | `writer.ex:777-793`, `writer.ex:945-984`             | **Survives.** These are not entity materialization; they are the permission/scope indexes. They could be fed by the same in-process apply pass, but the rows are still needed.                        |
| Per-Update index CFs `cf_entity_actions`, `cf_type_entities` | `cf_entity_actions`: the materialization delta index (one reader: `entity_store.ex:191`). `cf_type_entities`: boot-time repopulation of `EntityTypeCache` (`system_cache.ex:495,526`) | `writer.ex:712,1189`                                 | `cf_entity_actions` **disappears** (its only reader goes away). `cf_type_entities` **can disappear** if the type index is maintained in ETS/`persistent_term` and persisted as a periodic checkpoint. |
| `cf_group_actions`                                           | Group-scoped catch-up index (`catch_up.ex:51`), fan-out replay (`fan_out_router.ex:416`)                                                                                              | `writer.ex:1116`                                     | **Survives.** It is the group-scoped _log_ index for clients/replicas, independent of materialization.                                                                                                |
| `cf_action_dedup`                                            | Idempotency; doubles as the commit marker                                                                                                                                             | `writer.ex:618,1124`                                 | **Survives** (#113 dedup needs it).                                                                                                                                                                   |

**So the collapse deletes:** the dirty machinery, the read-side replay, the
SQLite upsert from the read path, and `cf_entity_actions` (plus, debatably,
`cf_type_entities`). **It keeps:** `FieldMerge` (relocated), the system-cache
mutation planner, `cf_group_actions`, `cf_action_dedup`, and a _rebuildable_
projection layer.

### What the read path becomes if the log is the integration interface

If the durable contract is "the log + the group index", then:

- A process-local materialized store is a **cache** rebuilt from the log.
- Reads are an in-process lookup (`get`) or an in-process predicate scan
  (`query`). The SQL/JOIN query layer (`sqlite.ex:329-372`) has **no in-process
  equivalent** — the membership JOIN and `json_extract` filters become Elixir
  scans, which is a real cost and the reason to keep an on-disk projection.
- External readers (replicas, #367 export, co-located read process) consume
  `ActionLog.read/3` (`action_log.ex:38-56`) + `cf_group_actions`, both already
  built; #113 records this as the shared primitive.

### Rough memory bound

**[estimate]** — no in-process store exists, so this is a magnitude, not a
measurement.

Assumptions: (a) an entity is stored as the merged `data` map (`%{"fields" =>
%{...}}`, leaf = `%{"value"=>v,"hlc"=>h,"update_id"=>id}`,
`field_merge.ex:101-110`); (b) ~3–10 leaves per entity (canonical bench `todo`
has 3 at `updates_per_action: 2`: `title`, `done`, `bench_sent_us`,
`workbook.ex:171-197`); (c) ~0.5–2 KiB of BEAM heap per entity including id/type
strings and 1–3 ETS/`persistent_term` index entries. BEAM word = 8 B; a 3-key
flat map is ~7 words (~56 B) plus its key/value binaries.

| Entities | [estimate] in-process heap | Note                                                                                          |
| -------: | -------------------------: | --------------------------------------------------------------------------------------------- |
|     10 k |                  ~5–20 MiB | trivially viable                                                                              |
|    100 k |                ~50–200 MiB | viable                                                                                        |
|      1 M |                 ~0.5–2 GiB | viable on the 16 GiB bench host (`RESULTS.md:35-44`) but no longer free; query scans dominate |

**[unmeasured]**; the current `--entities N` preload measures SQLite + dirty-set
RSS, **not** an in-process materialized map, so it is not a substitute. A
prototype must report `:erlang.memory(:total)` / `/proc/self/status VmRSS` via
the sampler (`bench/.../sampler.ex:44`) at each entity count. The relevant
question is not "does it fit" but "does the in-process `query` scan beat the
SQLite JOIN at these counts".

### Decidable from the code vs. needing a prototype

**Decidable from code:** the exact set of mechanisms and their single readers
(`cf_entity_actions`→`entity_store.ex:191`; `cf_type_entities` runtime readers
are all ETS, `entity_type_cache.ex`); that `FieldMerge` is pure and relocatable;
that `plan_cache_mutations` must survive; that the SQL query layer has no
in-process analog; that the log-reader interface already exists
(`action_log.ex`, #367).

**Needs a prototype:** write-side merge cost per Update; read-side `query` scan
cost vs SQLite; memory per entity at 10 k/100 k/1 M; whether removing the
non-append work actually yields ≥2× (the `--ablate` A/B answers this); whether
permission/query semantics survive without SQLite rows.

---

## 4. Read-path / side-car interface

### Who depends on SQLite / `EntityStore` today

`EntityStore` (the `EntityStore`+`SQLite` read path) callers:

| Caller                        | `file:line`           | What it needs                                |
| ----------------------------- | --------------------- | -------------------------------------------- |
| `GET /entities/:id`           | `sync/router.ex:101`  | point read, permission-checked via ETS first |
| `POST /entities/query`        | `sync/router.ex:143`  | filtered type query with SQL JOINs           |
| `SystemCache.populate_type/6` | `system_cache.ex:503` | materializes system entities at boot         |

`SQLite` direct callers:

| Caller                             | `file:line`                | What it needs                         |
| ---------------------------------- | -------------------------- | ------------------------------------- |
| `EntityStore.do_materialize/2`     | `entity_store.ex:181,295`  | current row + monotonic upsert        |
| `EntityStore.handle_empty_entries` | `entity_store.ex:215`      | row re-read after clear               |
| `EntityStore.query/4`              | `entity_store.ex:472`      | the JOIN/filter query                 |
| `ActionExport` cursors             | `action_export.ex:167,196` | durable named cursor (off write path) |

`SQLite` is a single GenServer with one `exqlite` connection
(`sqlite.ex:156-200,245-389`); `query_entities/2` holds the query while iterating
(`sqlite.ex:359-363`). Permission checks themselves are ETS-only
(`permission_checker.ex:171`), so **the shared SQLite file is only the entity
_content_ + query layer**, not authorization. This is #428's scope.

### Consequences

**(a) Co-located read process.** The cleanest move: the read path stops being a
`GenServer.call` on `EntityStore`/`SQLite` and becomes either (i) an ETS-backed
in-process store (no shared file, no connection), or (ii) a side-car process
reading its own read-only projection. Today, `EntityStore` is already a plain
module that reads ETS + calls two GenServers (`entity_store.ex:44-47`), so a
co-located reader is _cheap to stand up_ — but the query semantics
(`sqlite.ex:329-372`) are the hard part. If a co-located read process keeps
SQLite, it needs either the pool from #428 or a separate read-only connection.

**(b) Read replica.** A replica cannot use the shared SQLite file (SQLite is
single-writer; WAL is local, `sqlite.ex:48-54`). It must tail the log. The
existing `ActionLog.read/3` + a cursor is the transport
(`action_log.ex:38-56`, `action_export.ex:141-190`); #113 explicitly makes the
log the replication interface and shares the cursor convention ("Cursor
convention is shared: durable SQLite, one convention for #113's per-peer cursors
and #367's export cursor", #113 comment 2026-10-14). A replica that wants
`query` needs its own materialization — the same on-demand-vs-eager tradeoff as
the primary.

**(c) Replica fed by the log.** Same as (b), and it is _already the shape the
code wants_: replication is upstream of fan-out and applies Actions through the
local Writer (#113 comment: "Replication is upstream of the fan-out … applies
via the local Writer"). The barrier is the materialization posture: a
log-fed replica needs either its own in-process store or the SQLite projection.
If the primary drops `cf_entity_actions`, the replica must materialize from
`cf_actions`/`cf_group_actions` by GSN, not by per-entity delta index.

**Decision input.** A "log is the integration interface" posture is already
half-built (`ActionLog`, `ActionExport`, `cf_group_actions`, `cf_action_dedup`);
choosing it retires `cf_entity_actions` and the shared-file dependency but
requires solving the `query` layer. The alternative (on-disk projection) keeps
#428 and the SQLite query semantics, and makes #1 a perf-only change. This is
the fork the spike must record.

---

## 5. Elixir-only / no-NIF constraint

**#111's exact constraint.** #485 paraphrases it as _"Elixir/OTP only. No custom
NIFs."_ The canonical current wording is in the server README that #111 points
to:

> **Elixir/OTP only** for the server. No custom NIFs; we use the `rocksdb` hex
> package (v2.5.0).
> — `ebb_server/README.md:577-578`

and #111's own "Hard Constraints" say:

> **No Rust authorship** — the team does not know Rust. The storage engine must
> be a dependency, not custom Rust code.
> — #111 comment, "Hard Constraints (Crystallized Through Discussion)"

Note the precise scope: **no _custom_ NIFs / no _authored_ native code.** The
server already depends on two NIF packages, `rocksdb` and `exqlite`
(`mix.exs:36-37`), so "no NIFs at all" is not the rule.

### Which candidates are pure Elixir, which collide

| Candidate                                                                             | Pure Elixir?                                                                                                     | Collision                                                                                                                                                    |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| #1 in-process materialization                                                         | Yes                                                                                                              | none                                                                                                                                                         |
| #2 read-path posture                                                                  | Yes                                                                                                              | none                                                                                                                                                         |
| #3 encode once                                                                        | Yes                                                                                                              | none                                                                                                                                                         |
| #4 fan-out shape                                                                      | Yes                                                                                                              | none                                                                                                                                                         |
| #5 watermark/ETS bookkeeping                                                          | Yes                                                                                                              | none                                                                                                                                                         |
| #6 startup snapshot                                                                   | Yes, if it is a RocksDB checkpoint + a serialized ETS/term image; a _custom_ on-disk format is still pure Elixir | none unless it grows a native codec                                                                                                                          |
| #7 canonical encoding                                                                 | Yes                                                                                                              | none                                                                                                                                                         |
| **Custom storage engine** (not in the 7; floated by #111's native-engine exploration) | **No**                                                                                                           | **collides directly**                                                                                                                                        |
| **#343 vendored `rocksdb` bulk `batch_put`**                                          | Depends                                                                                                          | **gray area** — patching an existing dependency's C++ is not "custom authorship" by the letter, but it makes the server depend on a fork. Decide explicitly. |

### The fork to make explicit

- **Option A — engine stays `rocksdb`+`exqlite` (dependency, not authored).**
  All of #1–#7 remain on the table. This is what the README currently promises.
- **Option B — relax the rule for a native core.** Every storage decision
  changes (format, replication, SQLite's fate), and #111's "the storage engine
  must be a dependency" is reversed. Given candidates #1–#7 are all reachable
  pure-Elixir, **Option B is not required by any measured gap in this note**;
  #111's native-engine exploration was already ruled out on coordination
  complexity (#111 comment, "Rust NIF evaluation (ruled out)").

**Recommendation to record:** keep Option A for #1–#7; treat #343's vendored
NIF as the one explicit exception to debate on its own issue, not as a general
license for native code.

---

## 6. Log format / encoding as it stands

| Layer                            | Format                                                        | Says who                                                                        | `file:line`                          |
| -------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------ |
| Client ↔ server (wire, write)    | MessagePack                                                   | `Msgpax.unpack` on `POST /sync/actions`                                         | `sync/router.ex:587`                 |
| Server → client (HTTP responses) | JSON                                                          | `Jason.encode!`                                                                 | `sync/router.ex:621,655`             |
| RocksDB Action log               | **ETF**                                                       | `:erlang.term_to_binary(to_storage_format(...))` / `binary_to_term(_, [:safe])` | `writer.ex:1103`; `action_log.ex:56` |
| Fan-out (SSE)                    | JSON                                                          | `Jason.encode!` per subscriber per action                                       | `sse_connection.ex:87`               |
| SQLite entity cache              | JSON                                                          | `Jason.encode!(merged_data)`                                                    | `entity_store.ex:287`                |
| Replication (planned, #113)      | reads `cf_actions` (ETF) and applies through the local Writer | `ActionLog`, `/sync/replication`                                                | #113; `action_log.ex`                |

**The redundancy #485 cites is real:** every Action is `Msgpax.unpack`ed
(`router.ex:587`), stored as ETF (`writer.ex:1103`), re-decoded for fan-out
(`fan_out_router.ex:526`), re-decoded for materialization
(`entity_store.ex:314`), and JSON-encoded for each subscriber
(`sse_connection.ex:87`). Keys are re-encoded per Update/group
(`rocks_db.ex:137,148,165,219`).

### What #113 / #343 need to share

- **#113** consumes `cf_actions` by GSN cursor and applies through the local
  Writer; it needs a **stable, self-describing log record** and the `"id"`,
  `"actor_id"`, `"hlc"`, `"updates"`, `"update_scopes"` fields
  (`writer.ex:1148-1167`). The shared reader is `ActionLog.read/3`
  (`action_log.ex:38`), already used by #367; #113 records the shared cursor
  convention (#113 comment 2026-10-14). It does **not** need a wire-format
  change, only the record contract.
- **#343** operates below the format: a bulk `batch_put` taking a
  `[{cf, key, value}]` list in one NIF entry (`rocks_db.ex:268-278`). It is
  orthogonal to encoding but shares the "reduce per-op crossings" goal; it is
  largest _after_ #287 multi-Writer (#343 body).
- **#7's decision** is therefore narrower than it looks: keep ETF on disk (the
  reader contract is already ETF + `[:safe]`), and if anything changes, make the
  _wire→log_ pass canonical so a replicated Action is not decoded and re-encoded
  twice. Any on-disk format change must be a migration (`system_cache.ex:70-75`
  is the existing marker/migration pattern).

---

## 7. Open questions the prototype/measurement must answer

Each is phrased so one bench/measurement run settles it.

1. **What is the log-only ceiling?** Does
   `mix bench.actions --tier t0 --duration 30 --warmup 3 --concurrency 8
--batch-size 100 --updates-per-action 2 --distribution hot --ablate all`
   reach ≥2× the full-run t0 rate? (Settles whether #1 can reach the target at
   all.)
2. **What is each post-append phase worth?** Does adding back exactly one
   (`entity_index`, then `group_index`, then `dedup`, then `dirty`, then
   `cache`, then `watermark`, then `fanout`) produce per-phase deltas whose sum
   explains the gap? (Settles the acceptance "two-store-only cost breakdown".)
3. **Does fan-out encoding dominate the T3 cliff?** Run
   `mix bench.actions --tier t3 --duration 15 --warmup 3 --concurrency 8
--batch-size 10 --updates-per-action 2 --distribution hot --subscribers 1000`
   before/after one-binary-per-group. (Settles #3/#4.)
4. **Is fan-out already off the commit scheduler?** The code says yes
   (`fan_out_router.ex:192`, `group_server.ex:76`, `sse_connection.ex:85`);
   measure t3 scheduler utilisation to confirm the remaining cost is CPU volume,
   not serialization.
5. **How much memory does eager in-process materialization cost?** At
   `--entities 0/10000/100000` on a prototype store, what are `:erlang.memory`
   and VmRSS? (Settles §3's bound; the current preload is not a substitute.)
6. **Does the in-process `query` beat the SQL JOIN?** At 10 k/100 k entities,
   compare an Elixir membership+field scan against
   `SQLite.query_entities/2` (`sqlite.ex:329`). (Settles whether #2 can drop
   SQLite.)
7. **Is boot actually O(system entities)?** Time startup at
   `--entities 0/10000/100000` and check `system_cache.ex:493`'s
   `cf_type_entities` prefix walk. (Settles whether #6 is worth anything.)
8. **Does `spread` recover post-`ad8e43b`?** Run `t2`/`t0` with
   `--distribution spread` and re-read the preload table
   (`RESULTS.md:162-183`) now that the by-group index is an `:ordered_set`
   (`entity_group_cache.ex:11-13`). (The current `spread`/preload tables predate
   the fix; #485's protocol requires re-measuring before citing.)
9. **Is `bench/RESULTS.md` refreshed to ≥21 k?** Re-run the three
   `RESULTS.md:16-31` commands and replace the stale 15.3 k headline.
10. **What does #7's canonical form buy?** Add a bench phase/timer around
    `Msgpax.unpack` (`router.ex:587`) + `term_to_binary` (`writer.ex:1103`) at
    `t1` b1/b10; if it is <5 % of the path, record "no" and stop.

---

## Appendix — retained raw-run numbers used above

The published `RESULTS.md` is stale; these are the post-#338–#340 raw runs
(`bench/results/`, gitignored) behind the TL;DR. **[measured]**

| Run file                        | Tier | Config                | Overall /s |
| ------------------------------- | ---- | --------------------- | ---------: |
| `20261010T002145Z-recsy-vps.md` | t2   | c=8, 120 s, b100, hot |     21,780 |
| `20261010T001918Z-recsy-vps.md` | t2   | c=8, 120 s, b100, hot |     21,573 |
| `20261010T002359Z-recsy-vps.md` | t0   | c=8, 30 s, b100, hot  |     24,977 |
| `20261010T002317Z-recsy-vps.md` | t0   | c=8, 30 s, b100, hot  |     24,337 |
| `20261009T235351Z-recsy-vps.md` | t2   | c=8, 20 s, b100, hot  |     21,385 |
| `20261010T003030Z-recsy-vps.md` | t2   | c=64, 60 s, b100, hot |     16,703 |
| `20261016T213550Z-recsy-vps.md` | t0   | c=1, 10 s, b100, hot  |     27,240 |

The 2026-10-16 run is the newest file and reports 27,240/s at c=1; it is a
single short window and should be re-confirmed before it is published. No
retained raw run has `--entities > 0` or `--subscribers > 0` (the T3 and preload
tables exist only in `RESULTS.md`, which predates `ad8e43b` and #338–#340).

---

## 8. Measured addendum (post-ablation)

**This section supersedes the estimates in the TL;DR and §2.** Everything above
was written before the ablation measurements; where an [estimate] disagreed
with the ladder, the measured value here wins. Full per-run tables are
published in `bench/RESULTS.md`; the decisions drawn from these numbers are in
`bench/SPIKE-485.md`.

### 8.1 Apparatus

The breakdown came from the `--ablate <phase>` Writer seam landed as commit
**`2ca55a4`** ("add a Writer ablation seam for the flush cost breakdown"):
`writer.ex` `ablate?/2` gates
`dedup | group_resolution | entity_index | group_index | dirty | cache |
watermark | fanout` (`bench/.../options.ex:64`). Two independent runs of the
seam produce the tables below:

- **Additive ladder** — append the log and apply nothing
  (`--ablate dedup,group_resolution,entity_index,group_index,dirty,cache,watermark,fanout`),
  then add one phase back at a time. `t0`, b100, c=1, `hot`, u2, 20 s, median
  of 3.
- **Subtractive marginals** — ablate exactly one phase from the full path.
  `t0`, b100, c=1, `hot`, u2, 15 s, median of 3, full baseline 26,586.7/s.

All runs: `recsy-vps`, 4 schedulers, single Writer, `sync: true`.

### 8.2 Additive ladder (`t0`, b100, c=1, 20 s, median of 3)

| step                                                 |   rate | µs/Action | ms/flush |
| ---------------------------------------------------- | -----: | --------: | -------: |
| log-only                                             | 52,555 |     19.03 |    1.903 |
| +dedup                                               | 49,110 |     20.36 |    2.036 |
| +index (group_resolution, entity_index, group_index) | 32,950 |     30.35 |    3.035 |
| +dirty                                               | 33,365 |     29.97 |    2.997 |
| +cache                                               | 31,580 |     31.67 |    3.167 |
| +watermark                                           | 26,415 |     37.86 |    3.786 |
| full                                                 | 25,765 |     38.81 |    3.881 |

### 8.3 Marginal from full (`t0` 15 s, median of 3, full 26,586.7/s)

| phase ablated    |   rate | ms/flush | marginal ms |
| ---------------- | -----: | -------: | ----------: |
| (full)           | 26,587 |    3.761 |           — |
| dedup            | 26,727 |    3.741 |        0.02 |
| group_resolution | 28,173 |    3.550 |        0.21 |
| entity_index     | 32,173 |    3.108 |        0.65 |
| group_index      | 28,467 |    3.513 |        0.25 |
| dirty            | 26,613 |    3.758 |       ~0.00 |
| cache            | 27,840 |    3.592 |        0.17 |
| watermark        | 30,360 |    3.294 |        0.47 |

**Result.** Log-append floor **1.903 ms/flush**; all non-append work
**~1.978 ms = 51%** of the full 3.881 ms flush. Ceiling with _all_ non-append
work removed = 52,555 / 25,765 = **2.04×**. Largest pieces: `entity_index`
**0.65 ms**, `watermark` **0.47 ms**; `dirty` is **≈0 at `hot`** (2 entities per
flush, vs 2×batch in `spread`).

### 8.4 Corrections to estimates above

- **TL;DR, "two-store-only overhead is a _minority_ … <40%" — wrong.** The
  measured non-append share is **51%** (1.978 / 3.881 ms). The <40 % inference
  under-counted the index and watermark work that the earlier note had not
  separately attributed.
- **§2 #5, "removing `advance_watermark` moves t0 by a few percent at most" —
  wrong.** Measured **0.47 ms/flush = 12.5%** of the full flush, the largest
  single item after `entity_index`. This is why #5 is the recommended next
  prototype (`bench/SPIKE-485.md` §3).
- **§2 #4, "encode once recovers most of the loss" — falsified as stated, but
  the t3 Accepted/sec verdict is confounded.** The one-binary-per-group hoist
  appeared to regress the official t3 Accepted/sec metric ~10× at 1,000
  subscribers (**677 → 67/s**) even though server commit→broadcast complete p50
  improved (8.04 s → 4.09 s), delivery rate rose (27k → 39k/s) and RSS fell
  (928 → 447 MiB); `:binary.copy` did not recover it. The metric is confounded
  by the delivery backlog and the client-side latency window — in that run the
  window is **87s for a 15s run** (the worker loop checks the deadline only
  before each iteration and `Writer.write_actions/1` blocks past it), and
  `delivered_total` counts **post-deadline** Actions that `Accepted/sec` (0–15s)
  never windows. The new **`t4` harness** (commit `eacd296`, fixed write rate)
  measures the hoist as a **commit → broadcast complete p50 win** — ~3–4×
  lower (n=1000, r=50: 567,252/642,303/2,146,301 µs →
  167,232/374,096/494,278 µs; n=100, r=1000: 46,235/51,171/153,332 µs →
  16,814/25,986/31,628 µs) — that does not remove the O(N) per-group limit. It
  is **superseded by coalesced delivery** (`a292f58`): coalescing encodes one
  `data` frame per Action once, concatenates a group's frames into one binary
  and pushes it to every subscriber (one cast per subscriber, one `chunk/2`),
  which subsumes the per-subscriber encode hoist **and** collapses the N×A
  messages, so the hoist is kept as history, not as the next step.
- **§2 #4, coalesced delivery — measured and merged (`a292f58`).** One binary
  per group per batch, one cast per subscriber, one `chunk/2`; wire bytes
  identical. Back-to-back t4 A/B: commit → broadcast complete p50 falls
  **~5–16×** (n=1000, r=50: 537/637/649 ms → **104/114/125 ms**; n=100, r=1000:
  43/47/51 ms → **4.5/4.0/4.2 ms**) and utilization falls 42.3% → 22.1% at
  n=1000 r=100 and 30.4% → 15.7% at n=100 r=1000 — **measured but confounded**,
  because the t4 subscriber splits each coalesced chunk into per-Action frames,
  so the coalesced arm carries client-side work the baseline arm did not and
  there is no split-free control. Against the back-to-back control the delivered
  delta is **+15%** (87,752 → 100,686) and the latency win **8–16×**; against the
  earlier unstable baseline (98,765/s) they are **+2%** and **4–6×** — always
  cite the range. The r=300 comparison is stable (118,182 → 143,871, +22%). The
  new n=1000 knee is **~100k deliveries/s** (r=100 keeps up at 100,686/s; r=300
  delivers 143,871/s = 48%), i.e. the ceiling **rises ~2–22% depending on
  baseline but is not removed**: coalescing removes message and encode overhead,
  not the per-delivery **byte volume** (Actions × subscribers × payload), which
  is unchanged. The remaining levers are reducing bytes (client-side
  diffing/coalescing) or sharding across groups. The production-shaped (real SSE
  socket) measurement was **not** performed — both t3 and t4 use in-process
  subscribers — so it remains the outstanding gate before treating these
  numbers as production-representative.
- **§2 #4, "the bottleneck is total CPU volume, not a serialized dispatch
  point" — wrong.** The `GroupServer` **is** a serial O(N) dispatch point per
  group: it casts one message per (subscriber × action)
  (`group_server.ex:76-80`). t4 showed 10 subscribers at R=8000 delivering
  **72,733/s** (91% of need, diverging late) while n=1000 at R=300 delivered
  **117,992/s** (39%): total delivery saturates at ~100–120k/s once behind and
  the commit → broadcast complete p50 grows without bound.
- **For context on #3/#4.** The post-`ad8e43b` fan-out sweep (`t3`, b10, c=8,
  hot, 15 s) against the improved `t2` b10 baseline of **15,893/s** is: 100
  subscribers **1,647/s (−90%)**, 1,000 subscribers **677/s (−96%)**. The
  cliff is real and is the worst remaining problem; the `t4` harness now
  measures it without the write client as a variable (`bench/SPIKE-485.md` §6).
  Re-running candidate #4's own check **with coalescing** makes the t3
  Accepted/sec metric _worse_, not better — 0 subs 16,437/s, 100 subs 1,358/s,
  1,000 subs 136.7/s (util 28.5% / 48.9% / 49.7%) — the same confound as the
  encode-once hoist (t3 drives writes flat out while a subscriber storm exists,
  so a faster-draining fan-out starves the in-process `:httpc` clients). `t4` is
  the valid metric; t3 Accepted/sec cannot judge a fan-out shape change.
- **TL;DR ROI ranking — superseded.** The pre-measurement
  `#4 > #3 > #5 > #1/#2 > #7 > #6` put #3 above #5 on the guess that the
  fan-out encode would be the win. Measured, the write-side encode is already
  once per Action and the fan-out hoist is a t4-measured commit → broadcast
  complete win that coalescing supersedes, while the watermark is a contained
  **0.47 ms/flush**; the ranking is
  therefore **#4 (t4 harness now in place) > #5 (measured, contained) > #1/#2 >
  #7 > #3 > #6** (`bench/SPIKE-485.md` §3).
- **Marginal decomposition.** The additive ladder and the per-phase marginal
  table are in `bench/RESULTS.md` §Two-store-only. `fanout` is the one phase
  whose marginal is inside the ±5% run-to-run noise (removing it measured
  slower than the full run); the additive ladder bounds it at ~0.09 ms/flush.
