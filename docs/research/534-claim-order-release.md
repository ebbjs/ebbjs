# Claim-order release and fan-out ordering (#534): gap audit

Gap audit for [issue #534](https://github.com/ebbjs/ebbjs/issues/534) —
"fix(sync): release applied batches and fan-out notifications in claim
order" — on `feat/issue-534-claim-order-release` @ `ff527d0` (`origin/main`
after #563). It answers, per proposal and test bullet, what is already on
main, what is genuinely missing, whether the resolution watermark has to
move from the commit ack to the release, and the smallest defensible scope
for a PR that `Closes #534`. **No production code or test was changed for
this note.**

**Provenance.** Every `file:line` is `ff527d0`. Dependency work read for
provenance: #549 (PR 554, `CommitPipeline`), #550 (PR 556, per-range
containment + the ordered drain), #533 (PR 561, overlay chain +
`advance_pipeline/1`), #431 (PR 560, pure `FanOutRouter.Plan`), #531
(PR 545, `mark_committed_result/2` at the ack), #532 (PR 548,
`ActionFormat`), #551 (PR 559, depth bench), #286 (the persisted
`FanOutFrontier`).

**Audit baseline and landing.** The audit ran against `ff527d0`. The
`Closes #534` branch then landed the ranked items in §4; §6 maps that
delta. Read the status tables as the baseline and §6 as what the PR adds.

## TL;DR

- **Four of six proposal bullets are already delivered by dependencies.**
  Ordered apply/notify, the frontier-after-push rule, `decode/2`, and
  release-as-a-pure-transition are on `main` today. Two are partial: the
  watermark advances at the ack, not at the release; and the reorder buffer
  has no telemetry and no runtime depth config.
- **No acceptance bullet is actually violated at `ff527d0`.** The Writer
  notifies only the committed prefix, and only after the batch's cache
  mutation and dirty-mark settle, so no ordering of acks can open a
  delivery gap. What is missing is _reachability_ (depth > 1 is opts-only)
  and _evidence_ (the claim-order tests are pure-module only).
- **The watermark question resolves to "reachable, harmless, and not a
  no-op to move."** It is reachable at every depth for the batch being
  released, and at depth > 1 for a successor, but nothing reads it to skip
  a push. Moving `advance_watermark/1` from the ack to the apply is not
  required by #534 and carries two ordering traps (the Router's only
  re-drain trigger, and the `write_actions/2` reply ordering). The one
  behaviour it would change is the Writer-crash window, and only for a
  Writer-only restart.
- **The `Closes #534` PR is mostly tests plus two small surfaces**:
  `ebb.writer.in_flight_batches` / `ebb.writer.oldest_unreleased_gsn`,
  `:writer_max_in_flight`, doc corrections, and four missing tests. The
  tangled part is the watermark sentence in
  `CommitPipeline`'s moduledoc, which should be resolved by _restating the
  invariant_, not by moving the call.

## 1. Proposal bullets

| #534 proposal bullet                                                                    | Status      | Where                                                                                                   |
| --------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------- |
| ordered apply/notify keyed by claim order                                               | IMPLEMENTED | `writer.ex:1221-1232`, `1276-1303`; `commit_pipeline.ex:415-427`                                        |
| per released batch: settle, cache, watermark, notify                                    | PARTIAL     | `writer.ex:1326-1372`, `1607-1627`, `1835-1850`; watermark at `1156`/`1821-1825`                        |
| `FanOutFrontier` persisted after push, never past an unpushed range                     | IMPLEMENTED | `fan_out_router.ex:289-311`; `plan.ex:154-174`; `fan_out_frontier.ex:69-83`                             |
| telemetry `in_flight_batches`/`oldest_unreleased_gsn`, buffer bounded by pipeline depth | PARTIAL     | bound: `commit_pipeline.ex:215-233`, `523`; telemetry: absent                                           |
| `ActionFormat.decode/2` with the `cf_actions` key GSN, mixed shapes                     | IMPLEMENTED | `action_format.ex:96-120`; readers at `fan_out_router.ex:337`, `catch_up.ex:132`, `entity_store.ex:416` |
| release state owned by the pipeline state machine                                       | IMPLEMENTED | `commit_pipeline.ex:360-427`; shell only in `writer.ex:1276-1303`                                       |

**Ordered apply/notify.** `handle_commit_result(:ok, ...)` marks the range
committed and calls `advance_pipeline/1` (`writer.ex:1148-1160`), which
drains `CommitPipeline.releasable/1` — the committed prefix of
`claim_order`, stopping at the first `:committing`/`:applying` batch
(`commit_pipeline.ex:415-427`). `apply_one/2` applies and releases one
batch and recurses (`writer.ex:1276-1303`). Introduced by PR 556 (#550),
restructured into `advance_pipeline/1` by PR 561 (#533).

**Per-released-batch work.** Dirty-mark settle and cache mutations
(`apply_post_commit/2`, `writer.ex:1607-1627`), the fan-out notification
(`1835-1850`), the latency sample, and the caller replies (`1326-1372`)
are all per released batch. **The watermark is not**: it is marked and
advanced in `mark_committed_result/2` (`writer.ex:1312-1322` →
`1821-1825`) on the commit ack, before `advance_pipeline/1` and therefore
before this batch or any earlier one is applied. See §3.

**Frontier after push.** `push_and_update/2` pushes each releasable range
and then persists `state.plan.last_pushed_gsn` (`fan_out_router.ex:289-311`,
put at `:305`); `Plan.split_pushable/2` only releases the acked prefix
whose end is at or below the watermark and takes the frontier as a
monotone maximum of released ends (`plan.ex:154-174`);
`FanOutFrontier.put/2` cannot lower the stored value
(`fan_out_frontier.ex:69-83`). One residual, pre-existing and declared by
#550's PR body: an **abandoned range whose write actually landed** is
resolved as a hole, so `Plan.resolve/2` (`plan.ex:137-143`) drops it and a
later release pushes `last_pushed_gsn` past durable-but-never-pushed GSNs.
That is the crash-after-write boundary, not an ack-ordering defect.

**Telemetry + depth bound.** The bound exists: `at_capacity?/1` caps the
open batches at `max_in_flight` (`commit_pipeline.ex:523`), `schedule/3`
returns `:wait` at capacity (`:215-233`), and `handle_info(:flush, ...)`
refuses a flush while at capacity (`writer.ex:775-782`). But nothing emits
`in_flight_batches`/`oldest_unreleased_gsn` (the catalogue has only
`batch_size`/`range_resolved`/`commit_failed` counters plus the sampled
`in_flight_action_ids` gauge, `telemetry.ex:17-29`), and `max_in_flight`
is read from Writer opts only (`writer.ex:527`), capped at 4
(`writer.ex:346`, validated `:529-535`). Depth > 1 is therefore reachable
only from a test or the bench: **the "bound it by the configured pipeline
depth" half of the bullet has no configuration to bound by.**

**`decode/2`.** `ActionFormat.decode/2` takes the key's GSN as
`Map.put_new/3` for the new wrapper and for a legacy map, and takes scopes
from the wrapper or the legacy map (`action_format.ex:96-120`). Every
reader passes the decoded key GSN. Mixed old/new _behaviour_ is untested —
§2, T5.

**Release ownership.** `committed`/`applying`/`release`/`abandon`/
`releasable` are all pure transitions (`commit_pipeline.ex:360-427`); the
Writer owns only the imperative walk. The remaining Writer-side ordering
decision is the commit gate for a resolution-affecting predecessor
(`ready_batch/1`, `writer.ex:1256-1274`), which is a #533 overlay rule,
not a release decision.

## 2. Test bullets

| #534 test bullet                                                                                          | Status  | Coverage                   |
| --------------------------------------------------------------------------------------------------------- | ------- | -------------------------- |
| 1. ranges 1–100 / 101–200, ack 101–200 first, notify in claim order; frontier ≤ 100 before the first push | PARTIAL | pure only                  |
| 2. abandon 1–100 while 101–200 commits: resolve the hole, nudge, then push 101–200                        | PARTIAL | Writer covered, Router not |
| 3. crash between push and `FanOutFrontier.put`: resume re-pushes (at-least-once)                          | MISSING | only the pure replay case  |
| 4. multi-group Action with per-Update scopes reaches exactly its groups                                   | COVERED | real Router                |
| 5. mixed DB (legacy plain map + new wrapper) releases in claim order                                      | MISSING | shapes covered separately  |

**T1 — ordered notifications under out-of-order acks.** Pure coverage is
good: `commit_pipeline_test.exs:96` ("a later committed batch cannot be
released before an earlier claim"), `:113`, `:129` (randomized ack orders);
`plan_test.exs:66`, `:78`, `:149` (300 random orders asserting the released
prefix, monotone `last_pushed_gsn`, and no surviving claim below the
frontier), `:176` (200 random ack/abandon orders). The only real-Writer
test at depth 2 with the later range acked first is
`writer_committer_pool_test.exs:206` — it asserts the later caller's reply
is withheld across a Writer kill, but not notification order and not the
frontier. **Missing:** a real Writer `max_in_flight: 2` + real Router test
(posted through `StorageCase`, two ranges held by a blocking `commit_fn`)
that acks 101–200 first and asserts `{:batch_committed, 1, 100}` precedes
`{:batch_committed, 101, 200}`, that a subscriber receives them in that
order, and that `FanOutFrontier.get()` does not exceed 100 between them.

**T2 — abandon between two committed ranges.** The best existing test is
real and close: `writer_committer_pool_test.exs:91` asserts
`{:range_resolved, 1, 1}`, then no `{:batch_committed, ...}` for 100 ms,
then `{:batch_committed, 2, 2}`. Pure: `commit_pipeline_test.exs:113`,
`plan_test.exs:93`. **Missing:** the Router half — nothing drives a real
`FanOutRouter` that holds an acked, watermark-blocked claim while
`{:range_resolved, ...}` drops the head, then asserts the subscriber gets
101–200 and the frontier moves to 200. (`Plan.resolve/2` is exercised only
purely; the Router's own claim path is never pre-registered, see §3.F.)

**T3 — crash between push and `FanOutFrontier.put`.** Not tested. The
restart suite (`fan_out_router_restart_test.exs:26`, `:58`) kills the
Router while the range is still _buffered_, i.e. before the push. The
duplicate-tolerant side is pure only: `plan_test.exs:140` ("a stale replay
below the frontier pushes but does not rewind it") and
`fan_out_router_restart_test.exs:94` (sub-frontier duplicate). **Missing:**
a test that forces the persisted frontier to lag a pushed range (a seam
around `push_and_update/2`, or a frontier reset between push and put) and
asserts the subscriber receives the range twice after resume.

**T4 — per-Update scoped delivery.** Covered on the real Router:
`fan_out_router_integration_test.exs:328` (per-Update delivery) and
`fan_out_router_restart_test.exs:210` (scoped delivery from log recovery).
Not combined with out-of-order acks, but the filter does not depend on
release order, so this bullet needs no new test.

**T5 — mixed legacy + wrapper DB.** Each shape is covered alone:
`action_format_test.exs:66-99` (both decode branches),
`fan_out_router_integration_test.exs:138` (wrapper through the live push),
`catch_up_test.exs:115` (legacy map through catch-up), `:163` (wrapper
through catch-up). **Missing:** one `cf_actions` seeded with a legacy plain
map at GSN N and a wrapper at GSN N+1, both released in claim order, with
the key GSN, id, and scopes asserted for each.

Also untested at `ff527d0`: `:writer_max_in_flight` (does not exist yet)
and the reorder-buffer gauge (does not exist yet). §6 records which of
these the uncommitted tree already covers.

## 3. The watermark: can the frontier pass a durable-but-unapplied range?

**Call sites.** `mark_committed/3` (`writer.ex:1821-1825`) marks and
advances, and is reached from the ack (`1156` → `1312-1322`).
`resolve_range/3` (`1827-1833`) marks and advances, and is reached from
`abandon_batch/3` (`1708-1740`). The only other advance is the boot
reconcile (`reconcile_resolution_frontier/1`, `652-672`); the Router and
the catch-up path only read the value.

Trace, by case:

- **A. Same batch (any depth, including production).** The ack advances
  the frontier over range N, then `advance_pipeline/1` runs
  `apply_post_commit/2` for N. So the frontier covers a durable, unapplied
  range in every deployment. Unobservable: the Router has no notification
  yet (notify is after apply, `1326-1372`), and the other readers use the
  frontier only as a _high bound_, not a cache-state claim — catch-up reads
  up to it (`catch_up.ex:59-63`), the exporter lags against it
  (`action_export.ex:142`), and both read the durable log. Provisional
  dirty marks were placed before the commit (`writer.ex:1585-1599`), so a
  read in the window materializes from the log instead of trusting a stale
  cache.
- **B. Successor durable first, then the head commits (depth ≥ 2).**
  101–200 is marked and its advance is a no-op (gap at 1); 1–100's ack
  then walks the frontier to 200 while 101–200 is still `:committed`,
  unapplied, unnotified. Reachable **only** at depth > 1, which at
  `ff527d0` means a test or bench option (`writer.ex:527`) — the
  supervisor passes no `max_in_flight`.
- **C. Successor durable first, then the head abandons (depth ≥ 2).** Same
  as B, with `resolve_range/3`'s advance (`1831`) doing the crossing. The
  successor is applied in the same GenServer turn by the drain the abandon
  triggers (`1199-1213` → `advance_pipeline/1`).
- **D. Writer crash between the ack marking and the apply (any depth).**
  This is the only _observable_ case. `WatermarkTracker` is a sibling
  under `Storage.Supervisor` (`storage/supervisor.ex:43-52`,
  `rest_for_one`), so a Writer-only crash leaves the advanced frontier in
  place. The replacement Writer's `reconcile_resolution_frontier/1` reads
  `counter = max(counter, RocksDB max)` and `watermark`, and since
  `counter == watermark` it resolves nothing (`652-672`): the durable,
  never-applied, never-notified range is silently past the frontier, with
  no `[:writer, :range_resolved]` sample and no Router nudge. The Actions
  stay durable and catch up on reconnect; the live stream loses the range
  until then. This is the crash-after-write boundary #550's PR body
  already declares, reached by a different door.
- **E. Full storage-tree restart.** `WatermarkTracker.init/1` seeds from
  `RocksDB.get_max_gsn()` (`watermark_tracker.ex:198-232`), i.e. the max
  _durable_ GSN, which jumps the seed over holes and over any
  never-applied durable range; `reconcile_resolution_frontier/1` then sees
  `counter == watermark` and is a no-op. The seed can also _rewind_ below
  a frontier that had advanced over holes (`max_gsn < watermark`), and
  `reconcile` re-advances it to `counter`; monotone only at quiescence.
  Consequence: moving the advance does **not** help a full-tree restart —
  only case D (Writer-only restart).
- **F. Router restart.** `resume/1` derives the recovery window from
  `RocksDB.get_max_gsn()`, not the frontier, and gates pushes on the
  frontier (`fan_out_router.ex:143-162`); a durable range that was never
  notified is recovered regardless of whether the frontier already covers
  it. `cold_start/0` seeds the persisted frontier from the _current
  watermark_ on purpose (`:133-138`), so a cold boot never replays. The
  Router cannot skip a durable range on resume.

**Verdict.**

- **(a) Required by #534's acceptance?** No. No ordering of acks produces
  a live-delivery gap, because the notification (not the frontier) is the
  push trigger and it follows the apply. It is required only if "resolution
  frontier" is to mean "applied", which `WatermarkTracker`'s own moduledoc
  does not claim (`watermark_tracker.ex:6-20`).
- **(b) Safe to move?** Yes, but only with two ordering constraints.
  (i) The advance must land **after** `apply_post_commit/2` and **before**
  `notify_fanout/5`: `handle_info({:batch_committed, ...})` is the Router's
  only re-drain trigger besides `{:range_resolved, ...}`
  (`fan_out_router.ex:186-217`), so notifying under an un-advanced frontier
  leaves the range buffered with no future nudge — the last batch of a
  burst would never be pushed. (ii) It must land **before** `reply_all/3`,
  or `write_actions/2` returns before the frontier moves and every existing
  `committed_watermark(...) == N` assertion (the test helpers boot the
  tracker with `initial_gsn: 0`, `test/support/test_helpers.ex:235`)
  becomes racy. That means splitting `mark_committed/3` into mark-at-ack
  and advance-at-apply and restructuring `settle_after_commit/3`. The
  abandon path must still advance when nothing follows (`resolve_range/3`),
  or a trailing hole stalls catch-up, which caps its read at the frontier
  (`catch_up.ex:59-63`).
- **(c) A behavioural no-op?** No. It changes case D from a silent skip to
  a reconcile-visible hole (telemetry; still not a live push, because
  `reconcile_resolution_frontier/1` resolves the tail rather than replaying
  it), and it changes the reply/advance ordering above. Every other case is
  observationally identical.

**Decision (recorded in the PR).** Keep the commit-ack advance and
document `ebb.watermark.lag` as a **durability** frontier; the Router's
`Plan` is the notification gate. Moving the advance to release time is
rejected for the two ordering traps above, and the Writer-crash window
(case D) stays a separate follow-up.

**Recommendation.** Do not move it in the `Closes #534` PR. Replace the
`CommitPipeline` sentence "At a test depth above one the resolution
frontier may still advance over a durable range before its apply; #534
owns tightening that ordering" (`commit_pipeline.ex:66-69`) with the
precise invariant — the frontier is durable-or-deliberately-resolved and
never gates a push; the ordered notification does — and add a test that
pins it (§5, W1). File the Writer-crash window (case D) as its own issue
rather than widening #534: fixing it means replaying the durable range from
the log, which needs the caches rebuilt, and `rest_for_one` deliberately
does not restart `SystemCache` for a Writer-only crash.

## 4. Recommended scope for `Closes #534`

Ranked by correctness value over risk.

| Rank | Item                                                                                                                    | Risk                         |
| ---- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| 1    | Four missing tests (§5, T1/T2/T3/T5) — real Writer + real Router where possible                                         | none (test-only)             |
| 2    | `ebb.writer.in_flight_batches` + `ebb.writer.oldest_unreleased_gsn` gauges, emitted on buffer enter/leave               | low                          |
| 3    | `:writer_max_in_flight` app env, default 1, existing 1..4 validation kept                                               | low                          |
| 4    | Doc corrections: `CommitPipeline` (§3), `WatermarkTracker` one sentence, Writer moduledoc, README config + event tables | none                         |
| 5    | Watermark move to release                                                                                               | high — omit, follow-up issue |
| 6    | Router nudge from `reconcile_resolution_frontier/1`                                                                     | omit — unreachable today     |

This branch lands ranks 1–4. Ranks 5 and 6 are deliberately omitted for the
reasons in §3; §6 maps the landed changes.

**Why 2 is a gauge on transitions and not a sampler.** The buffer size is
known only inside the Writer's state; `Telemetry.Sampler` deliberately
reads lock-free projections and must not `:sys.get_state/1` the sequencer
(`telemetry/sampler.ex:1-20`). Emitting on claim/release/abandon is two
small events per batch and carries the number a graph needs. Shape:
`[:ebb, :writer, :in_flight_batches]` with `%{count: n}` and
`[:ebb, :writer, :oldest_unreleased_gsn]` with `%{gsn: gsn}`, no metadata.
`oldest_unreleased_gsn: 0` when idle — a sentinel is unambiguous because
the counter's first claim is 1 (`gsn_counter.ex:53-58`). Keep the existing
`ebb.writer.in_flight_action_ids` gauge; the two differ (ids vs ranges).
Alternatively fold it into the sampler by recomputing from
`InFlightActions.size` — rejected, it cannot produce the oldest GSN.

**Why 3 belongs in the PR.** Without it, "bound the reorder buffer by the
configured pipeline depth" has no configuration surface, and both the
depth-2 tests and the #551 bench have to construct the Writer directly.
The `at_capacity?`/`schedule`/flush checks already exist, so this is one
`Application.get_env` read plus the range validation that already raises.
Document that 1 is the production default and that > 1 remains opt-in.

**Declare as already-delivered in the PR body** (so review does not
re-litigate them):

- proposal bullet 1 (ordered apply/notify) — #549's state machine, #550's
  ordered drain, #533's `advance_pipeline/1`;
- bullet 2's settle/cache/notify/reply clauses — #550 + #533 (only the
  watermark clause is deliberately _not_ moved, §3);
- bullet 3 (frontier after push, never past an unpushed range) — #431's
  `Plan` prefix rule + #286's persisted frontier; the durable-hole residual
  is #550's declared boundary;
- bullet 5 (`decode/2` + key GSN) — #532 (PR 548); only the mixed-DB test
  is new;
- bullet 6 (release state in the state machine) — #549/#550;
- the depth bound itself — #549's `schedule/3`, #533's `min(depth, 4)` cap.

## 5. Tests to add

| Id  | Test                                                                                                                                                                                                                         | Level                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| T1  | `writer_committer_pool_test`-style: `max_in_flight: 2`, blocking `commit_fn`, ack 101–200 first; assert notifications and the subscriber order are 1–100 then 101–200, and the persisted frontier ≤ 100 until the first push | real Writer + real Router (`StorageCase`) |
| T2  | Abandon 1–100 while 101–200 commits against a real Router; assert the hole is resolved, the nudge drains, 101–200 is pushed, frontier = 200                                                                                  | real Writer + real Router                 |
| T3  | Crash between the push and `FanOutFrontier.put`; assert resume re-pushes and the subscriber sees the range twice, frontier not rewound                                                                                       | real Router                               |
| T5  | Seed `cf_actions` with a legacy plain map and a new wrapper; release both in claim order and assert key GSN, id, and scopes for each                                                                                         | real Router (push) and/or `CatchUp`       |
| W1  | Depth 2, later range acked first: assert the frontier has already crossed the successor before its notification, and the Router still pushes in claim order                                                                  | real Writer + real Router; pins §3        |
| U1  | `CommitPipeline.buffer_stats/1`: empty → `0/0`; one claim; claim+abandon; claim+release                                                                                                                                      | pure                                      |
| U2  | `ebb.writer.in_flight_batches` / `ebb.writer.oldest_unreleased_gsn` fire with the right numbers when a claim enters and when a batch is released or abandoned                                                                | Writer                                    |
| U3  | `:writer_max_in_flight` env is honoured by the Writer and out-of-range values raise                                                                                                                                          | Writer                                    |

T1/T2 need no lib change: `StorageCase` accepts `writer_opts`
(`test/support/integration/storage_case.ex:30-40`), so `max_in_flight: 2`
plus a `commit_fn` that parks each worker is enough to force reverse acks.

Coverage on this branch: T1, T2, and T5 are the three cases in
`fan_out_router_claim_order_e2e_test.exs` (real Writer, real Router,
multi-GSN reverse acks, a real abandon, and a depth-2 push where the
successor's durable record is rewritten into its legacy shape before the
release); T3 is in `fan_out_router_claim_order_test.exs`; U1 is in
`commit_pipeline_test.exs`; U2/U3 are in `writer_claim_order_test.exs` and
`writer_telemetry_test.exs`. W1 is not pinned by a test: observing between
the ack-time mark and the post-apply notify needs a test-only seam in
`handle_commit_result/3`, so the invariant is documented in
`CommitPipeline` and `WatermarkTracker` instead. See §6.

## 6. Landed in this branch

Ranks 1–4 of §4 are implemented:

- `commit_pipeline.ex`: `buffer_stats/1` and a "Pipeline depth and the
  reorder buffer" section that states the §3 invariant and drops the
  "#534 owns tightening" sentence.
- `writer.ex`: `:writer_max_in_flight` fallback for `:max_in_flight`, and
  `emit_pipeline_gauges/1` on claim, release, and abandon.
- `telemetry.ex` + `README.md`: the two catalogue rows, their measurement
  semantics, the `:writer_max_in_flight` config row, and the
  `ebb.watermark.lag` row restated as a durability frontier (the recorded
  decision from the issue's remaining-work list).
- `watermark_tracker.ex`: the §3 invariant paragraph (the frontier can
  cover a durable range whose notification has not been sent; the Router
  pushes on the notification), i.e. the "restate, do not move" option.
- Tests: `writer_claim_order_test.exs` (reverse acks through the real
  Writer, abandoned head, the gauge sequence, `:writer_max_in_flight`
  including the out-of-range boot failure),
  `fan_out_router_claim_order_test.exs` (a mixed legacy record plus a
  wrapper on one push path, a frontier behind a pushed range re-pushed on
  resume, a buffered range holding the frontier),
  `fan_out_router_claim_order_e2e_test.exs` (real Writer + real Router:
  multi-GSN reverse acks with subscriber order and the frontier staying
  behind the head, the real abandon → nudge → successor push path, and a
  depth-2 release whose successor record is rewritten to the legacy shape
  before the push), plus the gauge additions in `writer_telemetry_test.exs`
  and `commit_pipeline_test.exs`.
- **Coordination with #537:** the two gauges are landed once, here, as
  #534's remaining half names them. #537 should consume
  `ebb.writer.in_flight_batches` / `ebb.writer.oldest_unreleased_gsn` and add
  `queue_depth` / `apply_latency_ms` rather than emitting its own pair.

Deliberately left open:

1. **W1 is documented, not pinned.** Observing the instant between the
   ack-time mark and the post-apply notify needs a test-only seam; the
   invariant is stated in `CommitPipeline` and `WatermarkTracker` instead.
2. **The Writer-crash window (case D)** stays where #550 declared it: a
   durable-but-unapplied range can be skipped live until reconnect. Fixing
   it means replaying from the log after a Writer-only restart, which is a
   separate change.
3. **The durable-hole residual** (§1, bullet 3) is unchanged: a hole
   declared over a GSN whose write actually landed can move the frontier
   past a never-pushed Action. That is the crash-after-write boundary, not
   an ack-ordering defect.

Re-run the §5 list against the final PR; line numbers here will drift from
`ff527d0`.

## 7. Verification

From `ebb_server/`:

```bash
mix format --check-formatted
mix compile --warnings-as-errors
mix credo --strict --files-excluded "test/**"   # matches lefthook/CI

mix test test/ebb_server/storage/commit_pipeline_test.exs \
         test/ebb_server/storage/writer_claim_order_test.exs \
         test/ebb_server/storage/writer_committer_pool_test.exs \
         test/ebb_server/storage/writer_overlay_chain_test.exs \
         test/ebb_server/storage/writer_failure_policy_test.exs \
         test/ebb_server/storage/writer_telemetry_test.exs \
         test/ebb_server/storage/action_format_test.exs \
         test/ebb_server/sync/fan_out_router/plan_test.exs \
         test/ebb_server/sync/fan_out_router_claim_order_test.exs \
         test/ebb_server/sync/fan_out_router_claim_order_e2e_test.exs \
         test/ebb_server/sync/fan_out_router_restart_test.exs \
         test/ebb_server/sync/fan_out_router_integration_test.exs \
         test/ebb_server/sync/catch_up_test.exs

mix test                                        # lefthook pre-push
```

If the PR touches `bench/`, also run the short depth sweep
(`mix bench.actions --tier t0 --concurrency 1 --in-flight 1,2`) and note
that `RESULTS.md`'s depth rows predate #533/#534.
