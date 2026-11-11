# Write-path rewrite: the log-first design under test (#844)

Research note for [#844](https://github.com/ebbjs/ebbjs/issues/844) — "spike(storage):
log-first write path". The issue carries the architectural question, the falsifiable
hypotheses, the gates, the phases and the measurement protocol. **This note carries the
design**: shape, record format, derived indexes, recovery, what the prototype deletes, and
the surfaces each safety property has to keep answering.

Branch: `spike/844-log-first-write-path`. Status: draft — expected to change under P1 and P2,
which is why the detail lives here and not in the issue.

**Sources read.** #844 (body + review comment); #485 (the previous write-path spike and its
measurements), #799 (component existence index), #584 (committed payloads to the fan-out
router), #509 (PR: coalesced fan-out), #549 / #550 / #553 / #574 (commit-pipeline state
machine, committer-pool containment, prepare stage), #815, #840, #841, #113, #123;
`ebb_server/bench/RESULTS.md`, `ebb_server/bench/SPIKE-485.md`,
`docs/research/485-write-path-spike.md`; the storage tree at `0f7292f4` (merge of #818); the
sync tree (`fan_out_router.ex`, `fan_out_frontier.ex`, `group_server.ex`, `catch_up.ex`);
`CONTEXT.md`.

**Provenance.** All `file:line` and line-count references are the working tree at `0f7292f4`.
Numbers quoted here are from `bench/RESULTS.md` and predate #799's per-component entries;
they are a directional prior, and the spike re-baselines in P0.

## 0. What the spike measured (build `497de4fd`)

D3 ran before any prototype: one window record through `pwrite` + `datasync` against one
`write_batch` over the same frames, on `recsy-vps` with `sync: true`. The result changes the
case for the whole design, so it is recorded here rather than only in the issue.

- **The durable floor is the file's block state, not the record shape.** At b100 the matched
  append into a sparse file is 1.982 ms; the same append into a segment whose blocks are
  already written is **0.960 ms** (41,410 Actions/s vs 27,140 for the matched `write_batch`).
  A 64 KB `pwrite`+`datasync` probe splits the difference: 337–381 µs in place, 811–832 µs when
  the write allocates blocks, 809–1,080 µs when it also extends `i_size`. The ext4 metadata for an
  append, not the device flush, was the ~0.7 ms the first pass misread as "fsync".
- **The design's direction is right; the gate is still missed.** One append per window is
  2.0× the current commit at b100 and 1.7× at b1000, but H1 asked for 4.75× (≤0.4 ms per
  100 Actions): 0.406 ms for the append alone, 0.960 ms including assembly. It does not meet
  the gate and does not meet the issue's stop rule either (≥1.27 ms), so H1 survives.
- **Framing the window on RocksDB does not capture the win.** `window_record` (one window as
  one `cf_actions` value) is 2,008 µs, indistinguishable from 100 puts (1,963 µs): RocksDB's
  WAL still allocates and extends its file on every commit, and the binding offers no
  `fallocate`/recycle option. The 2× comes from owning the segment's block state. If the spike
  continues, it continues as a segment log with a stated retention/recycling policy — P2, not
  P1.
- **The host itself is noisy, and it was mistaken for a regression.** Every run now reports
  hypervisor steal: 18–22 % during the append arms and 25–39 % during `t0`, with pauses up to
  456 ms measured in a 20 s busy loop and 50 ms in a 1 ms sleep loop. Throughput tracked the
  steal (39.4 % steal → 8,070 Actions/s; 25.3 % → 10,855), the p99 tail is the same on tmpfs,
  and per-flush cost is unchanged since #485. The "45 % regression since #799" reading is
  withdrawn: interleaved p50 comparisons are the only usable numbers on this box, and any
  cross-build comparison needs a repeat with steal reported.
- **D1 is as simple as §5 reads.** The segment writer's recovery (CRC, torn-tail truncate,
  sparse GSN→offset index) passed a 60-seed kill-point property test on the first shape
  implemented: random stream, random batch sizes, a cut at any byte, retry converges. That
  part of the design can be reused without a new idea.
- **§4's authorizer surface already threads per-Action context, and any resolver must keep
  doing so.** `Authorizer` resolves an entity's model from the committed index _or_ from the
  models the same Action creates (`PermissionHelper.created_models/1`), and folds membership
  against `intra_action` context. A `spread` Action that creates an entity and files it into a
  group authorizes (`u5`), while one that files an entity it never creates is refused
  (`not_authorized`, fail-closed by design, #623/#625). So moving resolution to `as_of:` reads
  is not enough by itself: the resolver must receive the Action's own Updates, exactly the
  "intra-action context" clause in §1. The 100 % rejection seen at `t2 × spread × u2` is a
  benchmark workload shape (ownership Updates emitted first, then truncated), not this rule.

Consequences for this note: §1's pipeline, §4's interval index and §6's deletions describe
the **candidate**, not a plan that has been validated end to end. P2–P5 were not built. The
sections are kept because they are the best statement of the candidate the spike started
from, and D1's code now exists as `storage/log_first/segment.ex`.

## 1. The shape

```
Ingest (request process)  validate + authorize at snapshot as_of=R
   ↓
Stamper (1 proc)          assign GSN range for the window; O(1), no I/O
   ↓
Resolvers (N procs)       RowMutations.fold, per-Update scope resolution
                          as_of: assigned GSNs, intra-action context, frame
   ↓
LogLeader (1 proc)        concat iolists → one append → one fdatasync →
                          publish frontier → ack every waiter in the window
   ↓
Consumers (partitioned)   entity partitions  → materialized rows + SQLite query index
                          group partitions   → per-segment catch-up index + SSE fan-out
                          existence indexer  → model + component entries (cf_component_entities)
                          membership indexer → versioned entity→groups + groupMember rows
                          dedup digest       → action_id digest for the retry fast path
```

Only `Stamper` and `LogLeader` are serial, each doing O(1) work per **record**, not per
Update. Fan-out hangs directly off the group partition — there is no router hop, which is what
#841 describes. Reads are answered at a revision; a caller that needs read-your-writes applies
the log tail between its revision and the frontier.

GSN assignment _is_ the append, so there is no claim to own, abandon or reconcile. That is
what removes the orphan-claim failure class: the abandon/reprepare machinery, the in-flight
ownership guard as a _claim mechanism_, and the startup reconcile go with it.

## 2. Record format

```
segments/00000042.seg
  header : magic | version | base_gsn | created_at | epoch
  record : len::32 | crc32c::32 | kind::8 | gsn::64 | body
  kinds  : :action_batch | :reject | :duplicate | :snapshot_done
```

`:action_batch` body is the existing `ActionFormat` frame (payload ETF + scopes ETF),
unchanged, with an internal length-prefix per Action so a catch-up reader can slice one Action
without decoding the rest. `:reject` and `:duplicate` are first-class records, so **holes are
bytes** and the resolution frontier is the log tail.

Measured (D3): the window header costs 17 bytes and each frame 16 bytes over the stored
`cf_actions` value, 509 B/Action vs 494 B/Action at b100 (+3.2 %). One record per window is
cheap to frame; whether the sidecar exists is still open.

The segment's **block state** is now a first-class decision, not an implementation detail. An
append that allocates blocks or extends the file costs 811–1,080 µs per 64 KB on the spike
host; the same bytes into already-written space cost 337 µs. Two strategies were named and one
measured: zero-fill the segment before use (measured; 0.960 ms per b100 window, at ~1.7 bytes
zeroed per byte logged) or recycle a segment dropped by retention, with an epoch in the header
so recovery can tell old records from new (not measured; removes the double write). D1's
reader already stops at the first invalid record, which is what both strategies need.

The per-segment sidecar `00000042.gix` is the group index (`cf_group_actions` today), batched,
written by the group partitions. A sparse in-memory index every 64th record maps GSN → byte
offset. Whether that sidecar exists at all is decided in P1: the alternative is reading the
segment and filtering the per-Update scope snapshot, which is what `CatchUp` already does
(#473) with a page bounded by index rows (#423).

`gsn` stays inside the hashed bytes so a future verifiable layer's leaf is
`hash(kind ‖ gsn ‖ body)` — no format break, and a dense log means no filler leaves for
abandoned ranges. No verification work is in scope.

## 3. What each column family becomes

| today                   | prototype                                                                        |
| ----------------------- | -------------------------------------------------------------------------------- |
| `cf_actions`            | `:action_batch` records                                                          |
| `cf_group_actions`      | `.gix` sidecar, or nothing (P1 decides)                                          |
| `cf_action_dedup`       | digest rebuilt from the log tail                                                 |
| `cf_entity_actions`     | **gone** — the entity consumer keeps the log position per row                    |
| `cf_component_entities` | **kept, derived** — its own consumer, snapshot and retention answer              |
| `default`               | migration markers only (today `system_cache:component_entities_backfill` = `v2`) |

`cf_component_entities` is the existence index #799 added: model entries
`(model, 0x00, entity_id)` and component entries `(<model>/<field>, 0x00, entity_id)`,
maintained today by `ComponentEntityIndex` and read by `EntityTypeCache.get_type/2` and
`SystemCache.populate_type/6`, plus a mirror into SQLite's `entity_components`. The membership
index cannot answer "which rows are under model X, which carry field Y", so this index does not
fold into it.

The flush writes **five** data column families, not six: `cf_actions`, `cf_entity_actions`,
`cf_component_entities`, `cf_action_dedup`, `cf_group_actions`
(`committer.ex`, `build_batch/3`).

Retention and restore are part of the prototype, not a follow-up. `snapshots/N/` holds
`{entities.sqlite, membership.etf, group_cursors}` plus the log position it covers, so restore
is **load snapshot + replay tail**. A snapshot is a cache, never a source of truth.

## 4. The versioned membership index

The one genuinely new structure, and the replacement for "one process reads and writes the
caches":

```
{entity_id, from_gsn}       → group_set
{relationship_id, from_gsn} → source_id
{member_id, from_gsn}       → group_id
{entity_id, from_gsn}       → committed model
{membership_id, from_gsn}   → {group_id, permissions}    # groupMember rows
```

`membership(entity_id, as_of: gsn)` answers exactly what `EntityIndex.resolve_groups/3`
answers today, for any GSN. Interval rows are appended by the membership consumer, pruned past
retention, rebuildable from the log. Resolution at admission becomes a pure function of
`(action, its own GSN)`; the overlay chain, the Writer's `ready_batch/1` gate and the
abandon/reprepare path have nothing left to protect.

The `groupMember` row shape is not optional. Authorization is not one cache read:

- `Authorizer` resolves through `EntityIndex.resolve_groups/3` (which reaches the committed
  model via `EntityTypeCache.get_type/2`), `GroupCache.get_permissions/3`, and
  `EntityGroupCache.entity_group_entries/2`.
- The read path is `EntityView.for_actor/3` → `PermissionChecker.can_read?/3` →
  `EntityIndex.source_groups/2` + `GroupCache.get_permissions/3`.
- `GroupCache` holds actor→group membership _and_ permissions, and the Writer mutates it.

Versioning entity→group rows alone therefore cannot make authorization fresh; the permission
rows need a version too. This is the scope growth #799 and the current `Authorizer` impose on
P3, and it is why I1 is a submit-time assertion and not only a corpus diff.

## 5. Recovery model

- **Crash before the append** — nothing durable, nobody acked, no GSN consumed; the stamper
  takes its base from the log tail on boot. D1's kill-point test covers the tail side of
  this: a cut at any byte leaves the intact prefix readable and the retry lands on the
  boundary.
- **Torn append** — the last record fails CRC; truncate to the previous boundary and
  republish the frontier. That window's callers were never acked; the outbox retries.
- **Crash after `fdatasync`, before a consumer** — consumers resume from their own positions.
  A consumer behind the log is normal, not an error; every derived store is idempotent
  (GSN-stamped writes, monotonic `last_gsn`).
- **Duplicate committed earlier** — the digest catches it; nothing is appended, the caller
  gets `{0, 0}` (or R1's canonical range).
- **Duplicate while the first copy is in flight** — the case a post-hoc rule cannot fix,
  because an ack cannot be retracted. Today `InFlightActions.claim/2` is what makes the loser
  hear `{0, 0}` before its record exists; the prototype needs an equivalent (a pre-log id set,
  a digest the leader consults, or R1). See I6 in the issue.

## 6. What the prototype deletes

`CommitPipeline` (616), the `Writer` sequencer (2629 → stamper + resolver pool + log leader
~300), `GsnCounter` (127 → the stamper; it is already the claim counter: `:atomics`,
`reconcile/2`, never rewound), `WatermarkTracker` (254 → log-tail `:atomics`),
`InFlightActions` (164 → the stamper's in-flight id set, only once I6 passes), `DirtyTracker`
(356 → read-at-revision), `CacheMutationPlanner.Overlay` (183; planner 404 total → `as_of:`
reads), `Committer` + `CommitterPool` (253 + 404 → the append), `PreparePool` (258) +
`Preparer` (123 → resolver pool), `FanOutRouter` + `FanOutFrontier` (→ direct group-partition
dispatch, #841).

Line counts are the working tree at `0f7292f4`. They are inventory, not a target: the design
moves work off the serial path, and several pieces come back as consumer state.

## 7. Surfaces that must keep answering

Not a list of things that may not change — a list of what has to be true, and where it is
asked. Renegotiable response meanings are R1–R3 in the issue; nothing here forbids
restructuring the code that answers these.

**Contracts, not renegotiable.** Never ack undurable data; monotonic GSNs; the per-Update
scope snapshot is persisted because it cannot be re-derived; `FieldMerge`'s LWW rule, which is
mirrored in `packages/core` and must stay identical on both sides.

**Read APIs whose signature may stay while their source moves** (P3/P4):

| surface                                    | answers                                            | property |
| ------------------------------------------ | -------------------------------------------------- | -------- |
| `EntityIndex.resolve_groups/3`             | scope for an Update                                | I1, I2   |
| `EntityIndex.source_groups/2`              | read permission's groups                           | I1       |
| `GroupCache.get_permissions/3`             | actor → group permissions                          | I1       |
| `EntityGroupCache.entity_group_entries/2`  | membership rows                                    | I1       |
| `EntityTypeCache.get_type/2`               | committed model for an id (monotonic, fail-closed) | I1, I3   |
| `EntityStore.get/3`                        | materialized row + `last_gsn`                      | I3       |
| `ActionLog`                                | GSN-ordered reads (#367 export, later #113)        | I4       |
| `SSEHandler.write_stale_cursor_response/2` | cursor recovery                                    | I2, R2   |

**Decisions the doc leaves to the spike.** Whether the versioned model row keeps
`EntityTypeCache`'s monotonic, fail-closed existence semantics; whether the existence index
stays in RocksDB or moves to the read model; how many entity partitions 4 schedulers need.

## 8. Drift since #485

The issue was drafted before #799 merged. These facts changed underneath it; every section
above already assumes them.

1. **The existence index landed (#799).** `cf_type_entities` no longer exists: it is
   `cf_component_entities`, with model and component key kinds. `CONTEXT.md` calls it an
   _Existence index_ and lists "type index" as the word to avoid.
2. **Five data column families per flush**, not six; `default` holds only migration markers.
3. **Authorization surface is wider than `EntityIndex`** (§4).
4. **Fan-out already receives committed payloads (#584)**, so the tap is not a re-read
   problem; the remaining hop is `FanOutRouter`/`FanOutFrontier`.
5. **The bench harness moved**: `t5` already exists as a Writer-bypass tier; `--ablate`
   renamed `:type_entities` to `:component_entities` and split out `:component_entries`
   (`:entity_index` is now an alias for `entity_actions` + `component_entities`); and
   `--baseline`/guardrails, `--stall-commits`, `--subscriber-socket` already exist. No
   `--engine` flag exists yet.
6. **Two line counts moved**: `Writer` 2546 → 2629, `Committer`+`CommitterPool` 653 → 657
   (253 + 404). The rest of §6 matches main.

## 9. References

- Prior spike: [`ebb_server/bench/SPIKE-485.md`](../../ebb_server/bench/SPIKE-485.md),
  [`docs/research/485-write-path-spike.md`](485-write-path-spike.md),
  [`ebb_server/bench/RESULTS.md`](../../ebb_server/bench/RESULTS.md).
- Concurrent `write_batch`: [`530-concurrent-write-batch.md`](530-concurrent-write-batch.md).
  Durability contract: [`342-durability-contract.md`](342-durability-contract.md).
- Code: `ebb_server/lib/ebb_server/storage/{writer,commit_pipeline,committer,committer_pool,prepare_pool,preparer,watermark_tracker,in_flight_actions,dirty_tracker,entity_index,entity_store,action_format,action_log,gsn_counter,component_entity_index,entity_type_cache,system_cache,authorizer,permission_checker,entity_view}.ex`,
  `ebb_server/lib/ebb_server/sync/{fan_out_router,fan_out_frontier,group_server,catch_up}.ex`.
- Vocabulary: [`CONTEXT.md`](../../CONTEXT.md) — Action, Update, Action log, Revision, Cursor,
  Backfill, Catch-up, Archetype, Existence index, Existence, Row existence, Residency.
- Topology constraints: [`ebb_server/README.md`](../../ebb_server/README.md) — Elixir/OTP only,
  no custom NIFs, `rocksdb` v2.5.0, `sync: true` not configurable.
