# SPIKE-485 — write-path architecture: decisions and measured evidence

Decisions artifact for [#485](https://github.com/ebbjs/ebbjs/issues/485),
"spike the highest-ROI architectural write-path changes". Full per-run tables
live in `bench/RESULTS.md`; the `--ablate <phase>` harness used for the flush
cost breakdown below landed as commit `2ca55a4`, and the `t4` fixed-rate
fan-out tier as `eacd296`.

## 1. Scope & method

The spike ran the write path on **`recsy-vps`, a 4-scheduler VM** (AMD EPYC
7763, 16 GiB, Elixir 1.17.3 / OTP 27, `rocksdb` `sync: true`) and measured the
canonical flush two ways: an additive ladder that appends the log and adds one
post-append phase at a time, and a subtractive set that ablates one phase from
the full path. All ladder runs are `t0` (direct `Writer.write_actions/1`),
`--batch-size 100 --updates-per-action 2 --distribution hot`, median of 3. The
full command lines, environment and published tables are in `bench/RESULTS.md`
(raw per-run Markdown is gitignored under `bench/results/`); the seam that
produces them is commit `2ca55a4`. The code map behind these
verdicts is `docs/research/485-write-path-spike.md`; every `file:line` pointer
below resolves there.

## 2. Measured cost breakdown

Additive ladder (`t0`, b100, c=1, hot, u2, 20 s, median of 3):

| step                                                 |   rate | µs/Action | ms/flush |
| ---------------------------------------------------- | -----: | --------: | -------: |
| log-only                                             | 52,555 |     19.03 |    1.903 |
| +dedup                                               | 49,110 |     20.36 |    2.036 |
| +index (group_resolution, entity_index, group_index) | 32,950 |     30.35 |    3.035 |
| +dirty                                               | 33,365 |     29.97 |    2.997 |
| +cache                                               | 31,580 |     31.67 |    3.167 |
| +watermark                                           | 26,415 |     37.86 |    3.786 |
| full                                                 | 25,765 |     38.81 |    3.881 |

Marginal from full (`t0` 15 s, median of 3, full baseline 26,586.7/s):

| phase ablated    |   rate | ms/flush |                marginal ms |
| ---------------- | -----: | -------: | -------------------------: |
| (full)           | 26,587 |    3.761 |                          — |
| dedup            | 26,727 |    3.741 |                       0.02 |
| group_resolution | 28,173 |    3.550 |                       0.21 |
| entity_index     | 32,173 |    3.108 |                       0.65 |
| group_index      | 28,467 |    3.513 |                       0.25 |
| dirty            | 26,613 |    3.758 |                      ~0.00 |
| cache            | 27,840 |    3.592 |                       0.17 |
| watermark        | 30,360 |    3.294 |                       0.47 |
| fanout           | 25,393 |    3.938 | not resolvable (±5% noise) |

`fanout` is the one phase whose marginal sits inside this VM's ±5%
run-to-run spread (removing it measured _slower_, 25,393/s vs the 26,587/s
full); the additive ladder bounds it at ~0.09 ms/flush
(3.786 → 3.881 ms). Scheduler utilization across the ladder runs from
**4.5% (log-only) to ~10% (full)** on the 4-scheduler VM.

**Headline.** The durable log-append floor is **1.903 ms/flush**. All
non-append work is **~1.978 ms, 51%** of the 3.881 ms full flush. Removing
every non-append phase would cap the canonical `t0` b100 rate at **2.04×**
(52,555 / 25,765). The largest measured pieces are `entity_index` **0.65 ms**
and `watermark` **0.47 ms**; `dirty` is **≈0 at `hot`**. The two full baselines
differ (25,765 additive / 26,587 subtractive) because they are separate median
runs, not because the phases moved.

### Fan-out ceiling under a fixed write rate (t4, #485)

The `t4` tier (commit `eacd296`) removes the write client as a variable by
driving `Writer.write_actions/1` at a fixed `--rate R` and reporting delivered
Actions/sec plus **commit → broadcast complete** p50 per 10s bucket
(`need = R × N`; the telemetry fires at the end of
`GroupServer.handle_cast({:push_actions, ...})`, after the cast loop). It shows
the fan-out ceiling is independent of the writer:

|     R |    N | need | delivered/s | % need | p50 buckets (µs)                    | verdict                       |
| ----: | ---: | ---: | ----------: | -----: | ----------------------------------- | ----------------------------- |
| 10000 |    1 |  10k |       9,524 |    95% | 29,069 / 6,615 / 24,787             | keeps up                      |
|  7000 |   10 |  70k |      69,959 |   100% | 4,737 / 4,829 / 4,752               | keeps up                      |
|   500 |  100 |  50k |      50,194 |   100% | 42,620 / 42,874 / 46,273            | keeps up                      |
|  1000 |  100 | 100k |     100,003 |   100% | 43,391 / 47,190 / 51,080            | keeps up                      |
|    50 | 1000 |  50k |      50,697 |   101% | 537,301 / 636,850 / 648,571         | keeps up (~0.6s)              |
|   100 | 1000 | 100k |      98,765 |    99% | 580,151 / 774,715 / 903,755         | at the edge                   |
|   300 | 1000 | 300k |     117,992 |    39% | 2,318,603 / 8,337,306 / 13,286,676  | diverges                      |
|   500 | 1000 | 500k |     116,457 |    23% | 2,964,171 / 10,483,715 / 17,388,314 | diverges                      |
|  2000 |  100 | 200k |     116,008 |    58% | 1,106,037 / 4,977,938 / 9,060,987   | diverges                      |
|  8000 |   10 |  80k |      72,733 |    91% | 4,544 / 7,081 / 947,764             | diverges late                 |
|  2000 | 1000 |   2M |     113,697 |     6% | 4,540,025 / 13,610,517 / 20,616,455 | diverges                      |
| 20000 |   10 | 200k |      68,554 |    34% | —                                   | **write-limited** (13.5k<20k) |

**The shared-harness table above is capped by the bench subscriber, not the
server (`2ad8514`).** `EbbServer.Bench.Subscriber` shared one `:counters` ref
and one `:bag` ETS lag table across all subscribers, which serialized at high
subscriber counts and capped measured delivery at ~140k/s. `--subscriber-lean`
gives every subscriber its own counters and skips the shared lag table; the
server-side `ebb.fanout.dispatched_actions` counter added in the same commit
(plus `b998d5b` counting pre-coalescing `{:sse_chunk, "data", …}` as a
delivery) shows `dispatched/s` equals `delivered/s`. Corrected t4 ceilings with
lean subscribers:

| config         | need | achieved | dispatched/s | delivered/s |  util |
| -------------- | ---: | -------: | -----------: | ----------: | ----: |
| n=1000, r=300  | 300k |      300 |      300,000 |     302,756 |  7.5% |
| n=1000, r=1000 |   1M |    1,000 |    1,000,000 |   1,000,705 | 24.2% |
| n=1000, r=3000 |   3M |    2,220 |    1,616,000 |   1,616,299 | 40.1% |
| n=100, r=2000  | 200k |    2,004 |      200,000 |     200,158 |  5.8% |
| n=100, r=3000  | 300k |    3,000 |      300,000 |     300,032 |  8.7% |
| n=100, r=10000 |   1M |    9,908 |      977,600 |     977,731 | 31.2% |

- **Aggregate delivery keeps up past 1M deliveries/s; the real ceiling is
  ~1–1.6M/s, not ~100–140k.** With lean subscribers the server holds 100% of
  need at 1,000,705 delivered/s (n=1000, r=1000, 24% CPU) and reaches
  1,616,299/s (n=1000, r=3000, 40% CPU). Above it, commit → broadcast complete
  p50 grows without bound (n=1000, r=3000: 2,220 of 3,000 write/s achieved).
- **Per-batch latency is O(N).** At the _same_ ~100k deliveries/s, n=100 costs
  ~45–51 ms while n=1000 costs ~0.6–0.9 s: a single `GroupServer` serially
  casts one message per **(subscriber × action)** (`group_server.ex:76-80`),
  so per-batch cost grows with subscribers.
- **Only `n=10 R=20000` was write-limited** (achieved 13,476 < 20,000); the
  other rows held `achieved ≈ target`, so their divergence is fan-out, not
  Writer saturation.
- **Coalescing is merged (`a292f58`) and is a much bigger win than first
  published.** One binary per group per batch, one cast per subscriber, one
  `chunk/2` (wire bytes identical). With lean subscribers the A/B is
  delivered/s **177,778 → 302,756** at r=300 and **170,408 → 1,000,705** at
  r=1000, utilization **43.8% → 7.5%** and **43.8% → 24.2%**, and commit →
  broadcast complete p50 falling from multi-second
  (2,244,930/6,258,054/9,488,254 and 4,110,325/12,180,802/18,527,554 µs) to
  **~30 ms** (32,430/31,634/27,522 and 31,720/25,787/27,375 µs) — a **~6×
  delivered-throughput win and up to ~6× less CPU**. The earlier "+2–22% delivered,
  ceiling not removed" was artifact-capped on both arms: the shared harness
  capped them at ~140k, hiding the real pre-coalescing cap (~175k/s, the
  `GroupServer`'s N×A loop) and the coalesced one (≥1M). The coalesced n=1000
  knee is now **~1M deliveries/s** (r=1000 keeps up; r=3000 1,616,299/s = 54%
  of need). The coalesced arm still splits each chunk into per-Action frames
  to count deliveries, so the CPU win is if anything conservative.
- **Group sharding tested and ruled out (`fe5f25f` → revert `e5b1e19`).**
  Sharding one group's fan-out across K `GroupServer` processes (subscribers
  hashed across `{group_id, shard}` registry keys) left delivered/s **flat**
  across K=1/2/4/8 at n=1000 r=300 (140,563 / 139,534 / 139,866 / 137,747 at
  ~40% utilization) and flat at r=100 (100,607 vs 100,347) and r=150 (129,767 vs
  126,977), so the `GroupServer` is **not** the post-coalescing bottleneck.
  That sweep was measured on the **coalesced** code, where the N×A loop was
  already gone (_pre_-coalescing it was the real cap at ~175k/s), and with the
  shared subscriber, so its flat values sit on the ~140k harness cap. The
  ceiling that remains is **non-CPU** — ~1.6M deliveries/s at ~40% CPU — so the
  next step is a **lean-harness re-probe with profiling**, not treating any
  ~140k figure as a server limit.
- The t3 Accepted/sec metric is **confounded** (and the t3 sweep was also
  **harness-capped**): the hoist run's client-side latency window is 87s for a
  15s run (the worker loop checks the deadline only before each iteration and
  `Writer.write_actions/1` blocks past it), so `delivered_total` counts
  post-deadline Actions that `Accepted/sec` (0–15s) never windows. With
  `--subscriber-lean` the real t3 tax is **−50% at 100 subscribers (8,038/s,
  was 1,319/s) and −87% at 1000 (2,167/s, was 155/s)**, not the published
  −92%/−99%. Measured under t4, the hoist was instead a commit → broadcast
  complete win (p50 ~3–4× lower) that did not remove the O(N) limit; it is now
  **superseded by coalesced delivery** (`a292f58`).

## 3. Candidate verdicts

### #1 — On-write in-process materialization — **PARK**

The collapse's _ceiling_ is exactly the measured **2.04×**, and it reaches even
that only by deleting _all_ post-append work. From `docs/research/485-write-path-spike.md`
§3 it removes only the dirty marks (**≈0** at `hot`), cache mutations
(**0.17 ms**) and part of `entity_index` (its `cf_entity_actions` half);
`cf_group_actions`, `cf_action_dedup`, group resolution (**0.21 ms**) and the
watermark (**0.47 ms**) survive, because they are the group/log index and the
idempotency marker, not materialization. It also _adds_ an in-process apply plus
a replacement for the SQL JOIN query layer (`sqlite.ex:329-372`), which has no
in-process equivalent. So it cannot reach 2× and is the highest-effort /
highest-risk change. It needs its own prototype and the memory/read-path work
(`docs/research/485-write-path-spike.md` §3), not this spike.

### #2 — Read-path posture / side-car interface — **DECIDE (see Decision 2)**

Not a throughput number; it is the shape decision underneath #1, recorded as
Decision 2 below.

### #3 — Encode once — **PARK**

The write-side ETF encode is already **once per Action** (`writer.ex:1103`;
#338/#340). The remaining redundancy is the fan-out JSON encode per
_(subscriber × action)_; the fan-out hoist was attempted and, under the t4
metric, is a commit → broadcast complete p50 win (~3–4×) that is now
**superseded by coalesced delivery** (`a292f58`, see #4). No further
write-side encode win is available inside `build_ops`.

### #4 — Fan-out shape — **PROTOTYPED + MERGED (coalesced delivery, `a292f58`)**

The cliff is the worst remaining problem, though smaller than first published:
with lean subscribers it is **−50% at 100 subscribers** (8,038/s) and **−87%
at 1,000** (2,167/s) against the `t2` b10 baseline of ~16,129/s (the pre-lean
sweep's −90%/−96% was harness-capped). The t4 tier (`eacd296`) measures the
mechanism at a fixed write rate: a single `GroupServer` serially cast one
message per (subscriber × action) (`group_server.ex:76-80`), so per-batch
latency was O(N)
— at the _same_ ~100k deliveries/s, n=100 was ~45–51 ms while n=1000 was
~0.6–0.9 s. The pre-lean t4 sweep read total delivery saturating at
**~100–120k/s** once behind (n=1000: R=300 delivered 117,992/s = 39% of need;
R=500 116,457/s = 23%; R=2000 113,697/s = 6%), but that saturation was the
shared bench subscriber; with lean subscribers the server keeps up past 1M/s
(see §2).

**Coalesced delivery — MERGED (`a292f58`) — and a much bigger win than first
published.** `GroupServer` now encodes **one `data` frame per Action once**,
concatenates a committed range's frames into **one binary**, and `push_data/2`s
that same reference-counted binary to every subscriber (N casts per batch, one
parent message per subscriber per batch); `SSEHandler` writes the bytes in one
`chunk/2`. **Wire bytes are identical**, so there is no protocol or client
change. Back-to-back t4 A/B **with lean subscribers** (n=1000, batch 100,
`hot`, 2-Update, `--duration 25 --warmup 5 --concurrency 1`; before =
pre-coalescing, after = coalesced):

| config            |  delivered/s pre → coal |   util pre → coal | commit→broadcast p50 pre → coal (µs)                               |
| ----------------- | ----------------------: | ----------------: | ------------------------------------------------------------------ |
| r=300 (need 300k) |   177,778 → **302,756** |  43.8% → **7.5%** | 2,244,930 / 6,258,054 / 9,488,254 → **32,430 / 31,634 / 27,522**   |
| r=1000 (need 1M)  | 170,408 → **1,000,705** | 43.8% → **24.2%** | 4,110,325 / 12,180,802 / 18,527,554 → **31,720 / 25,787 / 27,375** |

That is a **~6× delivered-throughput win and up to ~6× less CPU**, and commit →
broadcast complete p50 falls from **multi-second to ~30 ms**. The earlier
"+2–22% delivered, ceiling not removed" was **artifact-capped on both arms**:
the shared bench subscriber capped pre-coalescing and coalesced at ~140k,
hiding the real pre-coalescing cap (~175k/s, the `GroupServer`'s N×A loop) and
the coalesced one (≥1M). The coalesced n=1000 knee is now **~1M deliveries/s**
(r=1000 keeps up at 1,000,705/s; r=3000 reaches 1,616,299/s = 54% of need).
The coalesced arm still splits each chunk into per-Action frames to count
deliveries, so the CPU win is if anything conservative.

- **Harness artifact retraction.** The pre-lean t4 sweep's ~140k ceiling came
  from the bench subscriber sharing one `:counters` ref and one `:bag` ETS lag
  table across all subscribers, fixed by `--subscriber-lean` (`2ad8514`). The
  server-side `ebb.fanout.dispatched_actions` counter equals delivered on both
  modes, so the server was enqueueing everything. The real ceiling is
  **~1–1.6M deliveries/s** (n=1000, r=1000: 1,000,705/s at 24% CPU; r=3000:
  1,616,299/s at 40% CPU), still **non-CPU**, and re-probing it needs the lean
  harness.
- **T3 subscriber sweep re-run (candidate #4's own check).** The t3
  Accepted/sec metric is confounded — t3 drives writes flat out while a
  subscriber storm exists, so a faster-draining fan-out starves the in-process
  `:httpc` clients — and the sweep was also harness-capped. The corrected t3
  tax with lean subscribers is **−50% at 100 subscribers (8,038/s, was
  1,319/s) and −87% at 1000 (2,167/s, was 155/s)**, not −92%/−99%. `t4` is the
  valid metric.

- **Encode-once hoist — superseded.** The hoist was a measured t4
  commit → broadcast complete p50 win (~3–4×: n=1000, r=50:
  567,252/642,303/2,146,301 µs → 167,232/374,096/494,278 µs; n=100, r=1000:
  46,235/51,171/153,332 µs → 16,814/25,986/31,628 µs), but it shaved only the
  per-subscriber encode and still sent N×A messages. Coalescing encodes once
  per group **and** collapses the message count, so the hoist is **superseded**
  (`a292f58`) and kept as history, not as the next step. The original park
  cited the t3 Accepted/sec regression (1,000 subs **677 → 67/s**) alongside
  improvements in commit → broadcast complete p50
  (**8.04 s → 4.09 s**), delivery rate (**27k → 39k/s**) and RSS
  (**928 → 447 MiB**), plus `:binary.copy` failing to recover it; that
  regression is **confounded** — the hoist run's client-side latency window is
  87s for a 15s run and `delivered_total` counts post-deadline Actions — so it
  is not a fan-out verdict.

### #5 — Watermark / ETS bookkeeping — **ADOPT (recommended next prototype)**

Measured **0.47 ms/flush, ~12.5%** of the `t0` flush — the largest single item
after `entity_index` (`watermark_tracker.ex:111-118`), and
`mark_committed`/`resolve_range` call `advance_watermark` twice per flush
(`writer.ex:1046`, `writer.ex:1054`). Direction: represent the frontier as an
interval / `{from, to}` instead of one ETS tuple per GSN, and hoist the
duplicate `advance_watermark` / `affected_entities` computation
(`writer.ex:677`, `writer.ex:754`). It is also groundwork for #287's
claim/abandon ownership semantics.

### #6 — Startup snapshot — **PARK**

`SystemCache.populate_type/6` (`system_cache.ex:493`) only prefix-scans the
three system types (`groupMember`, `entityGroup`, `relationship`), so
user-entity count does not drive boot; `--entities` preloads through the Writer
_after_ boot, and the harness has no restart-to-ready metric. Falsify with a
boot-time metric first.

### #7 — Canonical wire/log encoding — **PARK / DECIDE (Decision 4)**

The write-side encode is already once per Action; keep **ETF on disk** and
**MessagePack on the wire** (Decision 4). Record the shared canonical-form
requirement for #113 (replication) and #343 (bulk write).

**ROI-per-effort ranking:** **#4** (needs a new harness) **> #5** (measured,
contained) **> #1/#2 > #7 > #3 > #6**.

## 4. Decisions

**Decision 1 — Materialization model: keep the on-disk projection.**
SQLite materialization via `EntityStore` stays the read source of truth; **do
not adopt in-process materialization now**. Rationale: the measured 2.04×
ceiling is consumed by pieces the collapse keeps (group index, dedup, group
resolution, watermark), and the SQL/JOIN query layer (`sqlite.ex:329-372`) has
no in-process equivalent.

**Decision 2 — Read-path / side-car interface: the log + group index +
idempotency marker.**
`cf_actions` (committed log) + `cf_group_actions` (group index) +
`cf_action_dedup` (idempotency marker) is the integration interface for
replicas, export and external readers. A standalone read path is a log-fed
materializer with its own projection — not a shared database file. Rationale:
`cf_entity_actions` has a single reader (`entity_store.ex:191`) and is not part
of that interface. `ActionLog.read/3` (`action_log.ex:38-56`) and
`ActionExport` (`action_export.ex:141-190`) already implement the reader side.

**Decision 3 — Elixir-only / no-NIF constraint: keep it.**
#111's rule is "no _custom_ NIFs / no _authored_ native code — the storage
engine must be a dependency" (`ebb_server/README.md:577`, #111 "Hard
Constraints"); the server already depends on `rocksdb` and `exqlite`
(`mix.exs:36-37`). Candidates #1–#7 are all reachable in pure Elixir, so a
native core is not required by any measured gap. #343's vendored-`rocksdb` bulk
`batch_put` is a gray area to decide on its own issue, not a general license.

**Decision 4 — Log format / encoding: ETF on disk, MessagePack on the wire.**
Do not change the on-disk record now (`writer.ex:1103`;
`action_log.ex:56`). Share the chosen canonical form with #113 (replication)
and #343 (bulk write); any on-disk change is a migration, using the existing
marker pattern (`system_cache.ex:70-75`).

## 5. The ≥2× goal, answered

The measured ceiling for any change that keeps a durable log append is **2.04×**
(`t0`, batch 100), because the append floor is **~51%** of the flush. ≥2× is
therefore reachable only by removing essentially _all_ non-append work — and
the dual-store collapse does not, since it keeps the group index, dedup, group
resolution and the watermark. The goal is bounded: no candidate in #485 reaches
2× on the canonical flush without also changing the append itself.

## 6. Open questions / next steps

- **Fan-out follow-ups** (#4): the dedicated harness is **done** (`eacd296`,
  the `t4` tier — deliveries/sec + commit → broadcast complete at a fixed
  write rate). **Coalesced delivery is merged** (`a292f58`): one binary per
  group per batch, one cast per subscriber, one `chunk/2`. With lean
  subscribers it is a **~6× delivered-throughput win and up to ~6× less CPU**
  (177,778 → 302,756 at r=300; 170,408 → 1,000,705 at r=1000), with commit →
  broadcast complete p50 **~30 ms versus multi-second** and identical wire
  bytes. The earlier "+2–22%, ceiling not removed" was artifact-capped on both
  arms. **The ~140k ceiling was a harness artifact**, fixed by
  `--subscriber-lean` (`2ad8514`): the bench subscriber shared one `:counters`
  ref and one `:bag` ETS lag table across all subscribers; the server-side
  `dispatched/s` equals `delivered/s`, so the server was enqueueing everything.
  **The real ceiling is ~1–1.6M deliveries/s** (n=1000, r=1000: 1,000,705/s at
  24% CPU; r=3000: 1,616,299/s at 40% CPU) and is still **non-CPU**; the next
  step is to **re-probe it with the lean harness and profiling** (candidates:
  the single `FanOutRouter`, the per-subscriber `SSEConnection` → parent hop)
  rather than treating any ~140k figure as a server limit. **(b) group sharding
  is tested and ruled out** (`fe5f25f`, reverted in `e5b1e19`): hashing one
  group's subscribers across K `GroupServer` processes left delivered/s flat
  across K=1/2/4/8 at n=1000 r=300 (140,563 / 139,534 / 139,866 / 137,747 at
  ~40% util) and flat at r=100 and r=150, so the `GroupServer` is **not** the
  post-coalescing bottleneck; that sweep ran on the coalesced code (the N×A
  loop was already gone) and with the shared subscriber, so its flat values sit
  on the harness cap. The encode-once hoist is **superseded** by coalescing;
  the original park cited the t3 Accepted/sec regression, which is confounded
  (and the t3 sweep was also harness-capped — the corrected tax is −50%/−87%).
  Note the t4 subscriber-split limitation: the bench splits a coalesced chunk
  into per-Action frames to count deliveries, so the coalesced arm carries
  client-side work the baseline arm did not; the utilization figures are
  therefore not a perfectly clean server-only measurement, though the extra
  client work only makes the ~6× CPU win at r=300 conservative. The production-shaped
  (real SSE socket) measurement was **not** performed — both t3 and t4 use
  in-process subscribers — and remains the outstanding gate before treating
  these fan-out numbers as production-representative.
- **Watermark interval prototype** (#5): `{from, to}` frontier + hoisted
  `advance_watermark`, with before/after on `t0`.
- **Boot-time metric** (#6): restart-to-ready at `--entities 0/10k/100k` to
  falsify or confirm "boot is flat in user entities".
- **Memory/query prototype** (#1/#2): per-entity RSS and in-process `query`
  vs the SQL JOIN, only if in-process materialization is revisited.
- Code map, mechanism inventory and the collapse's keep/delete table:
  `docs/research/485-write-path-spike.md` (§3–§5) and its measured addendum.
