# SPIKE-485 — write-path architecture: decisions and measured evidence

Decisions artifact for [#485](https://github.com/ebbjs/ebbjs/issues/485),
"spike the highest-ROI architectural write-path changes". Full per-run tables
live in `bench/RESULTS.md`; the `--ablate <phase>` harness used for every
number below landed as commit `2ca55a4`.

## 1. Scope & method

The spike ran the write path on **`recsy-vps`, a 4-scheduler VM** (AMD EPYC
7763, 16 GiB, Elixir 1.17.3 / OTP 27, `rocksdb` `sync: true`) and measured the
canonical flush two ways: an additive ladder that appends the log and adds one
post-append phase at a time, and a subtractive set that ablates one phase from
the full path. All ladder runs are `t0` (direct `Writer.write_actions/1`),
`--batch-size 100 --updates-per-action 2 --distribution hot`, median of 3. The
full command lines, environment and per-run Markdown are in `bench/RESULTS.md`;
the seam that produces them is commit `2ca55a4`. The code map behind these
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

**Headline.** The durable log-append floor is **1.903 ms/flush**. All
non-append work is **~1.978 ms, 51%** of the 3.881 ms full flush. Removing
every non-append phase would cap the canonical `t0` b100 rate at **2.04×**
(52,555 / 25,765). The largest measured pieces are `entity_index` **0.65 ms**
and `watermark` **0.47 ms**; `dirty` is **≈0 at `hot`**. The two full baselines
differ (25,765 additive / 26,587 subtractive) because they are separate median
runs, not because the phases moved.

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
_(subscriber × action)_; the fan-out hoist was attempted, measured and parked
(see #4). No further write-side encode win is available inside `build_ops`.

### #4 — Fan-out shape — **PARK with numbers**

The cliff is the worst remaining problem: **−90% at 100 subscribers** (1,571/s)
and **−96% at 1,000** (619/s) against the improved `t2` b10 baseline of
**15,893/s**. The naive "encode once per group" hoist regressed the official t3
Accepted/sec metric **~10×** (1,000 subs **677 → 67/s**) while _improving_
commit→dispatch p50 (**8.04 s → 4.09 s**), delivery rate (**27k → 39k/s**) and
RSS (**928 → 447 MiB**); `:binary.copy` did not recover it. The t3 Accepted/sec
metric is confounded by the delivery backlog and client starvation — a
subscriber storm can make the metric worse while the fan-out itself gets
cheaper. Park the hoist (reverted in `ee599f8`) and require a dedicated fan-out
harness that measures **deliveries/sec and commit→dispatch at a fixed write
rate** before any shape change is judged.

### #5 — Watermark / ETS bookkeeping — **ADOPT (recommended next prototype)**

Measured **0.47 ms/flush, ~12.5%** of the `t0` flush — the largest single item
after `entity_index` (`watermark_tracker.ex:111-118`), and
`mark_committed`/`resolve_range` call `advance_watermark` twice per flush
(`writer.ex:1046`, `writer.ex:1054`). Direction: represent the frontier as an
interval / `{from, to}` instead of one ETS tuple per GSN, and hoist the
duplicate `advance_watermark` / `affected_entities` computation
(`writer.ex:676`, `writer.ex:753`). It is also groundwork for #287's
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

- **Dedicated fan-out harness** (#4): deliveries/sec + commit→dispatch at a
  fixed write rate, so a fan-out change is not judged by the confounded t3
  Accepted/sec metric.
- **Watermark interval prototype** (#5): `{from, to}` frontier + hoisted
  `advance_watermark`, with before/after on `t0`.
- **Boot-time metric** (#6): restart-to-ready at `--entities 0/10k/100k` to
  falsify or confirm "boot is flat in user entities".
- **Memory/query prototype** (#1/#2): per-entity RSS and in-process `query`
  vs the SQL JOIN, only if in-process materialization is revisited.
- Code map, mechanism inventory and the collapse's keep/delete table:
  `docs/research/485-write-path-spike.md` (§3–§5) and its measured addendum.
