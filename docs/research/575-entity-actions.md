# What `cf_entity_actions` is for (#575)

The entity-actions index is 2 of the 5 `cf_*` puts an Action pays for and the
largest single row in the stored shape. This note decides what it carries and
in what shape, prices the four options the issue names, and settles the two
open sub-questions (row key, value encoding). It is a decision note; the
before/after table is in [Measurements](#measurements).

**Scope note.** Ebb is greenfield. #552 already removed the only compatibility
layer in the read path (`ActionFormat` accepts one value shape and raises on
anything else), so this note inherits no read-through and no rollback story: a
database written by this build is thrown away, not migrated. Whatever is
decided here may change the stored shape freely — and a key or value in any
other shape raises.

## What this decides

1. **Coalesce.** One `cf_entity_actions` row per (subject, flush) instead of
   one per Update. No row is written per Update.
2. **The row key carries the entity's _last_ GSN in the flush**, not the first:

   ```
   key    <<entity_id::binary, last_gsn_in_flush::unsigned-big-integer-size(64)>>
   value  <<gsn::unsigned-big-integer-size(64), ...>>   # ascending, unique, non-empty
   ```

3. **The value is an exact GSN list**, not a min/max range, and it uses the same
   64-bit big-endian integer encoding as the key. A range is neither safe as an
   exact answer nor cheaper as a bounded one, and the shared encoding makes the
   row's invariant — _the key's GSN is the last 8 bytes of the value_ — visible
   in the bytes (§[Value](#value-encoding)).
4. **The reader filters the list** against its own `last_gsn` before the
   `multi_get`. That filter is what makes the seek provably unable to skip an
   unapplied GSN (§[Key design](#key-design)).
5. **The other three options are bounded, not priced.** Each one's read cost is
   a walk whose length is set by log traffic rather than by the entity's delta,
   so none of them can meet the read guard (no worse than +10% p50) at an
   unbounded operating point.
6. **The delivery contract is untouched.** `update_scopes` still come from the
   claim-time snapshot in the `cf_actions` frame; catch-up never reads this
   column family at all.

## Where this fits

Workstream of [epic #529](https://github.com/ebbjs/ebbjs/issues/529). The
index's marginal cost is real. Ablating `entity_index` (both index halves) on
the pre-change build moves the commit leg **87,495 → 109,350 Actions/s
(+25.0%)** at `t5` K=8, **26,585 → 29,815 (+12.2%)** at `t0 c=1`, and
**25,605 → 29,800 (+16.4%)** at `t2 c=8` **[measured]**, single-pass ablations
on `recsy-vps`; the issue's split-ablation comment has the same effect on an
earlier base (**+25.0% / +23.6% / +19.8%**), and the ablation's ladder entry is
`0.65 ms` of a `3.761 ms` flush, `ebb_server/bench/RESULTS.md`. Coalescing
recovers **+16.1% / +10.3% / +11.0%** of the full shape (§[Measurements](#measurements)).

Two constraints come with it:

- **The read guard has to be measured on the fixed path.** Before #630 the
  dirty read walked the entity's whole history; at 20k prior Updates that was
  **115,057 µs p50 / 181,645 µs `entries_scan`**, and after the seek it is
  **343 µs / 29 µs** **[measured]** (`RESULTS.md`, "Entity history vs dirty
  read"). Every candidate below is priced against the post-#630 path,
  otherwise the comparison is measuring the scan.
- **Boot reconcile is one of the priced paths** (acceptance criterion 1). It is
  also where coalescing's read story is thinnest (§[Boot reconcile](#boot-reconcile-564)).

## The four options compared

`M` = measured, already published (issue body/comments, or `RESULTS.md`);
`B` = bounded here by derivation, with the measured anchor named. No new
number in this table.

| Option       | Durable puts, 100-Action `hot` flush                                                                       | Cold materialize                                                                                                                                                                                                   | Dirty materialize                                                      | Query                                       | Catch-up                          | Group listing                         | Boot reconcile                                                                   |
| ------------ | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | ------------------------------------------- | --------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------- |
| **coalesce** | **200 → 2** [B, from the flush shape]; win ≤ the ablation above, which also carries `cf_type_entities` [M] | same `multi_get` of the delta's GSNs; fewer iterator rows (one per flush, not per Update) [B]; `entries_scan` is a few percent of a hot dirty read at N=1000 [M]                                                   | ≤ today: same `multi_get`, fewer iterator rows, plus an int filter [B] | shares materialize [B]                      | **zero** — never reads the CF [B] | shares materialize, per page row [B]  | `N_dirty` × a full dirty read; only the non-empty delta's row count moves [B]    |
| narrow       | no op win: one row per Update still [B]                                                                    | must scan `cf_actions` over `last_gsn+1..latest` and decode every Action to learn _which_ GSNs touched it — unbounded in log traffic [B]; the 115,057 µs walk is the class of cost, over a smaller span [M anchor] | same scan, delta-length [B]                                            | same, per dirty id [B]                      | unchanged                         | same, per page row [B]                | `N_dirty` × (point get + the same unbounded span) [B]                            |
| derive       | **the whole ablation**, `cf_type_entities` priced apart [M]                                                | scan `cf_group_actions` over the group's whole history — a superset of the walk #630 removed, so ≥ 115,057 µs at 20k [M anchor + B]                                                                                | the group's Actions since `last_gsn` [B]                               | unbounded per dirty id × group traffic [B]  | unchanged                         | same                                  | `N_dirty` × group-history scan; the 126.5 s first query at 1M [M] is a floor [B] |
| keep         | 0                                                                                                          | 5,884 µs, hot N=1000 [M, this A/B]                                                                                                                                                                                 | 3,325 µs, hot N=1000 [M, this A/B]                                     | 988 µs at K=10, spread N=1000 [M, this A/B] | unchanged                         | shares materialize [M as materialize] | 120.9 s boot / 126.5 s first query, 1,000,001 materializations at N=1M [M]       |

Read the write column with the distribution held in view: at `hot` the bench's
two Updates per Action land on the same two entities in every Action of a
flush, so 200 per-Update rows collapse to 2. At `spread` every Action mints new
entities, each subject appears **once in the whole log**, and coalescing is one
row per Update — the same op count, with a smaller value (8–15 B of GSN list
instead of a ~20 B action_id). **The write win of this option is a function of
subject repetition within a flush**, and `hot` is where the ablation above was
measured. That is the honest bound, and this note records it rather than
claiming a spread win; the issue's write acceptance is measured on `hot`.

Why the other three are out, in one line each:

- **narrow** (`subject → latest GSN`) cannot answer the only question the
  reader asks — _which_ GSNs touched this entity — so it adds a log scan on
  top of the write cost it keeps.
- **derive** (no index, scan `cf_group_actions`) makes that scan as wide as the
  group, moves materialization in-process, and is #485 candidate 1 against the
  SQLite posture #428 invests in (the issue's own architecture constraint).
- **keep** leaves 2 of 5 puts per Action on the table and is the incumbent, not
  an option.

## Who writes and reads the index

Exhaustive over `ebb_server/lib`, `ebb_server/bench`, `ebb_server/test`. There
is exactly **one production writer** and **one production reader**; everything
else is a bench mirror, a test seed, or a comment that names the shape.

`file:line` is the working tree at `357165e`, before the change.

| Site                                                                                                                                                                                                                | Kind            | What it needs from the row                                                                                              | Under coalescing                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `storage/committer.ex:205-214` `update_ops/3`                                                                                                                                                                       | write           | nothing; emits `(subject_id, gsn) → action.id` per Update                                                               | **replaced** by a flush-scoped emit                                                                                                      |
| `storage/committer.ex:154-169` `build_ops/3`                                                                                                                                                                        | write           | already folds flush-scoped keys (`type_entity_keys`) through `map_reduce`                                               | **the seam**: accumulate `{subject_id, gsn}` here                                                                                        |
| `storage/committer.ex:171-179` `build_action_ops/3`                                                                                                                                                                 | write           | returns `{ops, action.type_entity_keys}`                                                                                | also returns the action's `{subject_id, gsn}` pairs                                                                                      |
| `storage/rocks_db.ex:148-158` `encode/decode_entity_gsn_key`                                                                                                                                                        | codec           | key is `(entity, gsn)` and ordered by gsn                                                                               | gsn component becomes the entity's _last_ GSN in the flush                                                                               |
| `storage/rocks_db.ex:246-265` `entity_gsn_iterator/4`                                                                                                                                                               | seek            | rows for the entity at or after `from_gsn`, ascending                                                                   | seek unchanged; row count per delta falls                                                                                                |
| `storage/entity_store.ex:277-288` `fetch_relevant_entries/3`                                                                                                                                                        | read            | **the GSNs only** — value list, filtered `> last_gsn`, ascending                                                        | **the reader change**                                                                                                                    |
| `storage/entity_store.ex:413-421` `load_actions/2`                                                                                                                                                                  | read            | GSNs only (`encode_gsn_key/1` per entry)                                                                                | entry type loses the dead action_id                                                                                                      |
| `storage/entity_store.ex:423-429` `decode_action/1`                                                                                                                                                                 | read            | pattern-matches the dead `_action_id`                                                                                   | pattern simplifies                                                                                                                       |
| `storage/system_cache.ex:529-548` `populate_type/6`                                                                                                                                                                 | read (indirect) | one `EntityStore.materialize/2` per indexed entity at boot                                                              | unchanged (it is #N_dirty materializes)                                                                                                  |
| `sync/group_listing.ex:314, 354`                                                                                                                                                                                    | read (indirect) | one `EntityStore.materialize/2` per page row                                                                            | unchanged                                                                                                                                |
| `bench/write_batch.ex:174-183` `entity_ops/3`                                                                                                                                                                       | write (bench)   | mirrors the production shape for `t5` and `bench.envelope` (`envelope/runner.ex:308-325` reuses `WriteBatch.build_ops`) | **must** mirror it, or `t5` prices a shape production stopped writing                                                                    |
| `bench/options.ex:62, 128, 138`                                                                                                                                                                                     | ablation        | `:entity_index` drops this CF _and_ `cf_type_entities`                                                                  | split into `:entity_actions` / `:type_entities`, keep `:entity_index` as both so the published `t5` row stays comparable (§Measurements) |
| `test/storage/committer_test.exs:56-96`                                                                                                                                                                             | test            | the exact op list, one entity put per Update                                                                            | rewrite: 2 rows for 3 subjects over 2 GSNs                                                                                               |
| `test/storage/writer_test.exs:159-171`                                                                                                                                                                              | test            | `get(cf, encode(subject, 1)) == action.id`                                                                              | decode the value list instead of the action_id                                                                                           |
| `test/storage/entity_store_test.exs:182-185`                                                                                                                                                                        | seed            | writes one row with the action_id as value, asserts a materialize                                                       | seed a coalesced row (and keep a straddle case)                                                                                          |
| `test/sync/router_materialization_error_test.exs:26-92`                                                                                                                                                             | seed            | three seeds of a per-GSN row with `"fake_action_id"`                                                                    | seed the new value shape                                                                                                                 |
| `test/storage/rocks_db_test.exs:81-142`                                                                                                                                                                             | test            | key codec, `prefix_iterator`, `entity_gsn_iterator` seek                                                                | seek tests stay; add a coalesced-row seek test                                                                                           |
| `test/bench/write_batch_test.exs:110-112, 190-210`                                                                                                                                                                  | test            | counts 20 entity rows per 10-Action batch, one per Update                                                               | counts 10 (`t5` shape) / 2 (`hot`) and decodes values                                                                                    |
| `test/storage/writer_ablation_test.exs:45-51`                                                                                                                                                                       | test            | the ablation writes no row of this CF                                                                                   | unchanged                                                                                                                                |
| `test/bench/options_test.exs:19, 354`                                                                                                                                                                               | test            | the ablate atom list                                                                                                    | follow the atom split                                                                                                                    |
| `test/support/test_helpers.ex:295`                                                                                                                                                                                  | support         | erases the CF's `persistent_term` ref                                                                                   | unchanged                                                                                                                                |
| `storage/writer.ex:746`, `telemetry.ex:132`, `bench/materialize/workload.ex:97`, `bench/materialize/report.ex:165,216`, `test/integration/writing_actions_integration_test.exs:26`, `storage/prepared_action.ex:31` | docs            | state `(subject_id, GSN) → action_id`, "one row per Update"                                                             | restate                                                                                                                                  |

Two facts the inventory settles, both load-bearing:

- **The value's `action_id` is dead.** `fetch_relevant_entries/3` decodes the
  key only, and `load_actions/2` builds `cf_actions` keys from the GSN. The
  stored action_id has never been read. Dropping it costs nothing and is not
  what makes this a schema change.
- **Catch-up is not a reader.** `Sync.CatchUp.fetch_actions_by_gsn/1` and
  `ActionLog.read/3` go through `cf_group_actions` + `cf_actions`; neither
  mentions this column family anywhere in `lib/`. Delivery is structurally
  independent of this decision, not merely "not regressed" by it.

## Key design

### What the materializer promises

`EntityStore.materialize/2` is a **delta** reader
(`storage/entity_store.ex:203-294`):

1. `last_gsn` from the SQLite row, `0` when the row is absent, clamped so
   `last_gsn + 1` cannot wrap;
2. seek `entity_gsn_iterator(E, last_gsn + 1)`;
3. load and apply **every** row the iterator returns, in order, for the entity's
   own Updates;
4. write back `last_gsn = max applied GSN` — monotonically, so a stale writer
   loses;
5. clear the dirty mark it observed (`clear_settled/3`), including on the
   "no rows" path, where it returns the SQLite snapshot it already had.

So the reader's obligation is exactly: **every GSN that touched this entity and
is greater than `last_gsn` must be returned by the seek.** Anything it also
returns below `last_gsn` is harmless.

### Can a coalesced row straddle `last_gsn`?

A row straddles when its GSN set contains one value `<= last_gsn` and one
`> last_gsn`. For a _first_-GSN key the seek starts at `last_gsn + 1` and
therefore **starts above that row** — the row is never returned. The
materializer then applies nothing, sets `last_gsn` to the value it already had,
and `handle_empty_entries/4` clears the dirty mark after returning the stale
snapshot. The skipped GSNs are lost silently and permanently: the next read
seeks to the same point and skips the same row, and once a later flush lands
the entity's `last_gsn` jumps past them, so nothing ever looks back.

For a _last_-GSN key the same row is returned (`max S > last_gsn`), the reader
filters out the applied prefix, and applies the rest.

So the direct answer to the question: under _this_ writer and _this_ reader a
straddle is not normally produced, because a flush's row is written atomically
with the rest of its batch and a materializer applies every GSN in every row it
loads, so `last_gsn` ends up at a row's maximum. That is exactly why the
first-GSN key is tempting — and exactly why it is the wrong choice. It is
correct _only_ while that argument holds unbroken, and the argument spans two
processes and a restart boundary (§[invariant](#the-invariant-the-writer-must-maintain)).
The last-GSN key does not need the argument at all.

The seek proof is three lines: let `S` be a row's GSN set and `k = max S`.
For any `g ∈ S` with `g > last_gsn`, `k >= g > last_gsn`, so `k >= last_gsn + 1`
and the row is inside the iterator's range. **A seek to `last_gsn + 1` on a
last-GSN key cannot skip an unapplied GSN.** The first-GSN key can only offer
the converse, weaker property — "a row is skipped when `min S <= last_gsn`" —
which is precisely the loss above.

### The invariant the writer must maintain

Under `key = min S` the writer would have to guarantee **no reader's persisted
`last_gsn` is ever strictly inside a flush's GSN set for that entity**. That is
a global, cross-process, cross-restart invariant over state the writer does not
own:

- `last_gsn` lives in SQLite, written by whichever process materialized last,
  and survives restarts;
- it is a _reader_'s answer to "how far did I get", and it stays valid only as
  long as nothing else ever writes it — which the same issue's boot-reconcile
  path (and any repair, restore, or `#123` horizon repair) is allowed to do;
- it changes the moment a flush is split into more than one `write_batch`
  (the same batching knob that is `--batch-size` 100 vs 152 today), because the
  split is a writer-side decision taken without knowledge of reader state.

Under `key = max S` the only invariant is local and checkable at assembly
time: **the key's GSN component equals the maximum GSN in the value's list**.
A writer can always enforce that in the function that builds the row; nothing
outside the flush has to be true.

**Recommendation: key by the entity's last GSN in the flush.** Same number of
rows, same seek, and correctness that does not depend on a fact the writer
cannot see.

### Ordering, which the reader must not scramble

Flush GSN ranges are disjoint and increasing (one claim per flush), and each
row's key is its own maximum, so rows arrive in flush order and every GSN in a
row's value is greater than every GSN in the previous row's value. Concatenating
each row's filtered, ascending tail therefore yields a globally ascending GSN
list — the order `replay/3` needs, because a `put` **replaces** the field map
rather than merging into it (`storage/entity_store.ex:431-495`). Two
consequences: the value must be written ascending, and the read path may sort
the concatenation as cheap insurance (`O(n log n)` on a delta that is a handful
to a few hundred GSNs) but does not have to — either way the test that pins the
shape should assert the _order_ of the concatenation, not just its contents.

### Value encoding

Decided: **an exact, ascending, unique GSN list, encoded as raw 8-byte
big-endian integers, concatenated** (`byte_size(value) / 8` is the count; a
length that is not a multiple of 8 raises, because a partial GSN is a corrupt
row and not an empty one). Three reasons, in order of weight:

1. **The key's GSN is literally the value's last 8 bytes.** The encoding makes
   the row's only invariant — _key = max of value_ — self-evident and
   impossible to violate without producing a visibly malformed row. This is
   the invariant the whole seek argument rests on (§[Key design](#key-design)),
   so having it expressed in the bytes is worth more than bytes.
2. **The reader filters while decoding.** `for <<gsn::64-big <- value>>, gsn > last_gsn, do: gsn`
   is the delta filter fused with the decode, which is exactly the shape of
   `fetch_relevant_entries/3`: filter first, `multi_get` second. An ETF list
   needs a term decode and then a second pass.
3. **One integer convention in one module.** The key suffix is already a raw
   64-bit big-endian GSN; the value reuses it instead of introducing a second,
   term-based representation for the same numbers.

Rejected: **ETF list** (`term_to_binary([gsn])`) — ~2 B/GSN smaller (≈6 B
against 8), but it needs a term decoder plus a second filter pass, and it makes
one row carry two different GSN encodings.

Rejected: **min/max range**. A flush of 100 Actions where the entity is touched
at the first and the last GSN has a range spanning all 100 Actions but only 2 of
them belong to it. The reader could not treat the range as the answer (it would
apply nothing, or apply the wrong set), and if it _did_ trust the range it would
over-fetch — 100 `cf_actions` rows into the `multi_get` and decode instead of 2,
which is the exact read cost this option exists to bound. Over-fetching inside a
row's range is behaviourally harmless (`replay/3` filters by `subject_id`) but it
hands back the unbounded read path the write win was supposed to pay for, and it
makes the entity's `last_gsn` advance with unrelated Actions, i.e. it couples the
reader's horizon to the flush rather than to the entity (`#123` owns retention).
A range is also _larger_ in the common sparse case: 16 B against 8–15 B of
list. At the bench shape a `hot` flush writes 2 rows of ~100 GSNs (~0.8 KB
each) instead of 200 rows of (~22 B key + ~20 B action*id); at the issue's
200-GSN figure that is ~1.6 KB of values against ~8 KB of keys and values.
The extra ~2 B/GSN over an ETF list is ~0.4 KB on a row written once per
flush, inside a path whose cost is the \_number of puts* (~0.8 µs serialized,
**[measured]** `RESULTS.md`), not the value bytes.

## The stored shape

```
cf_entity_actions
  key    <<entity_id::binary, last_gsn_in_flush::unsigned-big-integer-size(64)>>
  value  <<gsn::unsigned-big-integer-size(64), ...>>   ascending, unique, non-empty
```

- **A row exists only for a flush in which the entity had at least one
  Update.** No row, no GSNs, no zero-length value; a value whose length is not
  a multiple of 8 raises, and so does an empty one.
- **No key is written twice.** GSNs are unique per Action and a flush's keys are
  its maximum GSNs, so the write stays append-only: no read-modify-write, no
  merge with a previous row.
- **The key's GSN component is a position, not an Action GSN.** Nothing may seek
  `(entity_id, gsn)` expecting one Action any more; the only production seek is
  `last_gsn + 1`.

Write mechanics, all inside the Committer's flush assembly:

1. `build_action_ops/3` returns its `{subject_id, gsn}` pairs alongside the
   existing `type_entity_keys`; `build_ops/3` folds them into a map of
   `subject_id => [gsn]` across the whole flush (the same `map_reduce` that
   already accumulates the flush-scoped type keys). Duplicate `(subject, gsn)`
   pairs — one Action can carry several Updates to one subject — collapse.
2. One `{:put, cf_entity_actions, encode_entity_gsn_key(subject, List.last(gsns)),
encode_gsn_list(gsns)}` per subject, emitted after the per-Action ops and
   sorted by key, exactly like `type_entity_ops/2`, so batches stay
   reproducible.
3. Cost: one pass over the flush's Updates (already happening) plus one
   `iodata`-built value per row, replacing one `batch_put` per Update. The put
   count is what the write path pays for (~0.8 µs serialized per put,
   **[measured]** `RESULTS.md`).

Read mechanics, all inside `fetch_relevant_entries/3`:

1. seek `(entity_id, last_gsn + 1)`;
2. decode each key (entity/position pair) and each value, filtering as it
   decodes;
3. keep only `gsn > last_gsn`, preserving the row order → an ascending list;
4. `multi_get` `cf_actions` over that list; apply; write back the max applied.

The filter is bounded by the flush size (≤ 200 int comparisons at the bench
shape) and happens before the `multi_get`, which is the expensive half.

## Delivery contract

Unchanged, and structurally so:

- `update_scopes` still come from the claim-time snapshot and still live in the
  `cf_actions` frame (`ActionFormat.frame/2`); this note touches no other
  column family.
- Catch-up still returns the same Actions in GSN order: `CatchUp` reads
  `cf_group_actions` → `cf_actions`. It never reads `cf_entity_actions`
  (§[inventory](#who-writes-and-reads-the-index)).
- `cf_group_actions` and the `cf_actions` record are out of scope, per the
  issue.

## Boot reconcile (#564)

**Status.** #564 is closed (2026-10-23) and merged as PR #591 / `bba5cba`,
which is on `origin/main`. What landed is the **boot re-mark**: the
`cf_type_entities` walk that already fills the type cache now also marks every
indexed entity dirty (`storage/system_cache.ex:561-572`), plus the removal of a
redundant second SQLite read in `materialize/2`. **What did not land** is
#564's other candidate — a reconcile of SQLite `last_gsn` against the log — and
the dirty set is still ETS-only, so marks are still lost on a restart and
re-created by that walk. Nothing in `lib/` reads this column family at boot
except the `EntityStore.materialize/2` calls the re-mark and the eager
populators trigger (`system_cache.ex:529-548`).

**What the boot path actually costs.** #564's landed fix re-marks every
`cf_type_entities` row and materializes the system entities through
`EntityStore.materialize/2`, so boot pays `N_dirty ×` a **full dirty read**, not
one seek: SQLite fetch + decode (`fetch_decode`, 42.1% of a hot dirty read at
N=1000), the `cf_entity_actions` seek, the `multi_get`, the merge and the
upsert. That is the issue's bound — `N_dirty ×` the dirty read — and the
measured end-to-end anchor is the #564 restart table: 1,000,001
materializations, **120.9 s boot / 126.5 s first query at N=1M** **[measured]**
(≈121 µs each). An empty delta saves the `multi_get`/merge/upsert and leaves
the seek (**29–32 µs at any history** **[measured]**) plus the SQLite fetch; a
non-empty delta pays the whole path.

**How coalescing changes the bound.** It changes only the row count of a
non-empty delta: rows per flush instead of rows per Update. The empty-delta
case is the dominant one at boot (an entity that was current before the
restart has nothing to replay), and it does not move. So the reconcile is a
scale-out of an existing, measured path, and its constant moves down slightly
for the entities that do have a delta. What would move it materially is a
per-entity horizon (#123) or a durable dirty set, not the row shape.

## Measurements

Method. Rotated A/B on `recsy-vps`, 2026-10-26: five 20 s measured passes per
side per tier, alternating which build ran first within each pair; before is
`origin/main` `357165e`, after is this branch. The table is the median across
the five passes; the ranges live in the raw reports (gitignored, like every
`bench/results/` run). `t5` p50 is the `write_batch` NIF; `t0`/`t2` p50 is the
client request.

Write path, full shape (`hot`, b=100, 2 Updates/Action, `sync`):

| Tier              | Before Actions/s | After Actions/s |          Δ | Before p50 | After p50 |
| ----------------- | ---------------: | --------------: | ---------: | ---------: | --------: |
| `t5` K=8          |           88,525 |         102,775 | **+16.1%** |    7.14 ms |   6.25 ms |
| `t0` c=1, depth 1 |           25,775 |          28,420 | **+10.3%** |    3.53 ms |   3.23 ms |
| `t2` c=8, depth 1 |           25,090 |          27,840 | **+11.0%** |    30.5 ms |   27.1 ms |

Acceptance criterion 2 (write +10% or better at `t0 c=1` and `t2 c=8`, depth 1)
is met, and `t5` lands inside the issue's +15–22% band. The mechanism is the
put count: a 100-Action `hot` flush writes **304** puts instead of **502**
(2 coalesced entity rows instead of 200, the 2 type rows unchanged).

The split, after (medians of three 20 s passes; `:entity_index` is the
combined alias):

| `t5` K=8 op set         | puts / 100-Action batch | Actions/s | vs full |
| ----------------------- | ----------------------: | --------: | ------: |
| full                    |                     304 |   102,775 |       — |
| − `entity_actions`      |                     302 |   102,305 |   −0.5% |
| − `type_entities`       |                     302 |   105,560 |   +2.7% |
| − both (`entity_index`) |                     300 |   106,595 |   +3.7% |

The combined ablation cost **+25.0%** before the change and **+3.7%** after it
— inside the host's run-to-run spread, which is what "the phase drops out of
the ladder" means. At `t0` the same three-run ablations land both above and
below the full-shape median (26,865 / 30,750 / 28,420 Actions/s), i.e. neither
half is resolvable against noise any more. This split is also why the issue's
"+22%" was an `entity_index` number: it bundled the two coalesced rows with
`cf_type_entities`, which was never a per-Action cost.

Read path (`mix bench.materialize --sizes 1000 --runs 5 --reps 50`; history
axis `--runs 2 --reps 20 --history-sizes 0,1000,20000 --scenarios dirty
--distributions hot`), p50 in µs:

| Scenario                   | Before | After |      Δ |
| -------------------------- | -----: | ----: | -----: |
| hot cold                   |  5,884 | 6,214 |  +5.6% |
| hot dirty                  |  3,325 | 3,510 |  +5.6% |
| hot clean                  |  2,453 | 2,387 |  −2.7% |
| spread cold                |    563 |   611 |  +8.5% |
| spread dirty               |    629 |   539 | −14.3% |
| query K=1                  |    548 |   574 |  +4.7% |
| query K=10                 |    988 | 1,013 |  +2.5% |
| query K=50                 |  3,738 | 3,705 |  −0.9% |
| history, 20k prior Updates |    366 |   327 | −10.7% |

Every path is inside the +10% p50 guard, and the largest rise is `spread cold`
(5 samples). The history axis at 1,000 prior Updates measured **316 → 382 µs**,
but its `entries_scan` rose in the same 40 samples, which coalescing cannot
cause: at that shape 1,000 per-Update rows collapse to 10 per-flush rows, and
the 20k row fell. That row is host noise, not a read regression.

Catch-up and group listing read no row of this CF: catch-up goes through
`cf_group_actions` + `cf_actions`, and group listing materializes per page row,
covered by the dirty rows above. Boot reconcile is `N_dirty ×` the dirty read
(§[Boot reconcile](#boot-reconcile-564)); its dominant empty-delta seek is
unchanged. The `spread` write arm is not re-measured because the op count does
not move there (200 → 200); the risk section states the bound.

The write and read tables above are published in `ebb_server/bench/RESULTS.md`;
the `entity_index` phase drops out of the ladder as a meaningful cost
(acceptance criterion 6).

## Risks

- **The write win is distribution-dependent.** `hot` collapses 200 puts to 2;
  `spread` collapses 200 to 200. An implementation that reports the `hot` number
  without saying so overstates the result; this note and `RESULTS.md` both state
  it, and the `spread` write arm is bounded rather than re-measured.
- **Pruning gets more expensive, not less.** `#123`'s horizon will have to
  delete rows below a GSN; a coalesced row can straddle the horizon, so pruning
  becomes a read-modify-write of the row (or must drop the whole row). This note
  does not choose a horizon strategy, but it forecloses the "delete a row per
  GSN" one.
- **The key's GSN component no longer means "an Action at this GSN".** The name
  `encode_entity_gsn_key` stays, its meaning must be documented and pinned by a
  test, and any future code that seeks `(entity, gsn)` for a specific Action is
  wrong.
- **A large flush writes one larger value.** At 200 GSNs one row is ~1.6 KB
  against a ~20 B per-Update value; total bytes fall, but a single `put` value
  grows by ~80×. It stays far below any RocksDB write-batch or block-size
  concern at the bench's 100–152-Action flushes; a flush size in the thousands
  would need a per-subject row-chunking scheme, which would weaken (not break)
  the last-GSN key: chunk keys are still each chunk's own maximum, so the seek
  stays sound.
- **Out-of-order commits are a pre-existing hazard this note inherits.** With
  `writer_max_in_flight > 1` a later range can be durable before an earlier one,
  so a reader can persist a `last_gsn` above GSNs that are not yet written —
  rows below the seek point either way, for per-Update and coalesced rows alike.
  The default is 1. It is flagged here because the read guard would not catch it.

## What this does not settle

- **Whether a per-entity `last_gsn` cache is needed on the hot read path.** No:
  the seek is already flat in history (`343 µs` at 20k prior Updates,
  **[measured]**), and `last_gsn` arrives with the SQLite row whose JSON decode
  (`fetch_decode`, 42.1% of a hot dirty materialize at N=1000, **[measured]**)
  the reader needs regardless. A cache would not remove either.
- **The type-entities split number.** Rows 2–3 are the measurement that lets a
  future note say how much of the `entity_index` ablation was this CF.
- **Retention.** `cf_entity_actions` still grows without bound; that is #123.
