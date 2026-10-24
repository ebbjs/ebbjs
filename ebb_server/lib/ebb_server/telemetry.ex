defmodule EbbServer.Telemetry do
  @writer_flush_phases [:queue, :prepare, :resolve, :commit_wait, :apply, :notify]

  @moduledoc """
  Server-side telemetry: the single place that fixes event names and payload
  conventions for every `:telemetry` event Ebb emits.

  Every subsystem routes emissions through `execute/3` or `span/3` so that the
  `[:ebb, ...]` root and the measurement/metadata split are defined once here
  instead of being re-invented per call site.

  ## Event catalogue

  Event names are `[:ebb, subsystem, event]`, written `ebb.<subsystem>.<event>`.
  The reserved catalogue is:

  | Event                                     | Measurements                          | Metadata                                            |
  | ----------------------------------------- | ------------------------------------- | --------------------------------------------------- |
  | `ebb.writer.batch_size`                   | `count`                               | `gsn_start`, `gsn_end`, `callers`                   |
  | `ebb.writer.batch_latency_ms`             | `duration` (native)                   | `gsn_start`, `gsn_end`                              |
  | `ebb.writer.commit_latency_ms`            | `duration` (native)                   | `gsn_start`, `gsn_end`                              |
  | `ebb.writer.actions_per_sec`              | `count`                               | —                                                   |
  | `ebb.writer.range_resolved`               | `count`                               | `gsn_start`, `gsn_end`, `reason`                    |
  | `ebb.writer.commit_failed`                | `count`                               | `gsn_start`, `gsn_end`, `reason`                    |
  | `ebb.writer.in_flight_batches`            | `count`                               | —                                                   |
  | `ebb.writer.oldest_unreleased_gsn`        | `gsn`                                 | —                                                   |
  | `ebb.writer.flush_phase_ms`               | one native measurement per phase (`writer_flush_phases/0`) | `gsn_start`, `gsn_end`, `outcome` (`:ok` / `:abandoned`), `reason` (abandoned only) |
  | `ebb.system_cache.populated`              | `duration` (native), `entity_types`, `group_members`, `entity_groups`, `relationships`, `backfilled` | `outcome` (`:ok` / `:error`), `reason` |
  | `ebb.watermark.lag`                       | `lag` (durability: max GSN − committed watermark) | —                                                   |
  | `ebb.dirty_set.size`                      | `size`                                | —                                                   |
  | `ebb.writer.in_flight_action_ids`         | `size`                                | —                                                   |
  | `ebb.entity_store.materialize_latency_ms` | `duration` (native), `byte_size`      | `subject_id`, `subject_type`, `path` (`:dirty_materialize`) |
  | `ebb.entity_store.materialize_phase_ms`   | `duration` (native)                   | `phase` (`:fetch_decode` / `:entries_scan` / `:actions_load` / `:merge` / `:encode` / `:upsert` / `:format`) |
  | `ebb.entity_store.read_latency_ms`        | `duration` (native), `byte_size`, `row_count` | `path` (`:clean_hit` / `:query`), `subject_id`      |
  | `ebb.entity_store.cache_hit_rate`         | `count`                               | `result` (`:hit` / `:miss`), `path` (`:dirty_materialize` / `:clean_hit` / `:query`) |
  | `ebb.fanout.push_latency_ms`              | `duration` (native)                   | `group_id`                                          |
  | `ebb.fanout.dispatched_actions`           | `count`, `subscribers`                | `group_id`                                          |
  | `ebb.fanout.active_connections`           | `count`                               | —                                                   |
  | `ebb.fanout.active_groups`                | `count`                               | —                                                   |
  | `ebb.http.request_latency_ms`             | `duration` (native)                   | `method`, `route`, `status`                         |
  | `ebb.sync.catch_up`                       | `count`                               | `group_id`, `from_offset`, `returned`, `up_to_date` |
  | `ebb.sync.catch_up_read`                  | `index_rows`, `actions_fetched`       | `group_id`, `from_offset`                           |
  | `ebb.action_export.batch`                 | `count`                               | `from_gsn`, `to_gsn`                                |
  | `ebb.action_export.failed`                | `count`                               | `gsn`, `reason`                                     |
  | `ebb.action_export.filtered`              | `count`                               | —                                                   |
  | `ebb.action_export.lag`                   | `lag` (watermark − cursor)            | `cursor`                                            |

  Start/stop pairs use `span/3`; they emit `<event>.start` and `<event>.stop`
  (and `<event>.exception` on failure) with the measurements `:telemetry.span/3`
  adds (`monotonic_time`, `system_time`, `duration`).

  `ebb.writer.batch_latency_ms` covers one coalesced flush from its GSN claim
  through the post-commit bookkeeping (dirty settle, cache mutations, and the
  fan-out notification) and is measured on the Writer, which sequences the
  flush. `ebb.writer.commit_latency_ms` is the sub-span the Committer owns —
  frame encode, `cf_*` op assembly, and the durable `write_batch/2` — so
  the pair separates sequencer work from durable-write work for the same GSN
  range; the expensive payload build and ETF encode already happened on the
  sequencer before the claim. `commit_latency_ms` is emitted for every
  outcome (`:ok`, `{:error, reason}`, or a raise), so a failing commit stays
  visible in the same series as a successful one.

  `ebb.writer.in_flight_batches` and `ebb.writer.oldest_unreleased_gsn`
  are emitted whenever a claim enters or leaves the Writer's reorder
  buffer. `in_flight_batches` counts every open claim, including one
  applying; `oldest_unreleased_gsn` is the head of `claim_order`, or `0`
  when the buffer is empty. They are emitted from the Writer rather than
  sampled because the buffer only exists in its state. A reporter can
  graph the pair to see the pipeline depth and the GSN holding release
  back.

  The `cf_actions` value those op lists carry is a frame (#552,
  `EbbServer.Storage.ActionFormat`), chosen on a 5–10% cheaper export read for
  0.05–0.10 µs/Action more encode — a share of a flush that sits below this
  event's noise band. The shapes are priced per Action by `mix bench.envelope`
  and in `docs/research/552-action-envelope.md`.

  `ebb.watermark.lag` is a **durability** lag, not a notification lag:
  the resolution frontier may cover a durable range before its apply.
  `EbbServer.Sync.FanOutRouter.Plan` is the real notification gate.

  `ebb.writer.flush_phase_ms` splits one claimed range's wall time into the
  phases that decide whether pipeline depth trades throughput for latency.
  It fires once per range, keeps every phase as a separate measurement so a
  reporter can aggregate them independently, and the six sum to the range's
  lifetime from the oldest coalesced call's `write_actions/2` send to the end
  of its `notify` phase (the fan-out nudge and the caller replies). The phase
  vocabulary is `#{inspect(@writer_flush_phases)}` (also returned by
  `writer_flush_phases/0`) and is defined here so every reporter and
  follow-up issue measures the same terms:

  - `queue` — the oldest coalesced call's mailbox wait, plus the wait from
    its payload being ready to the flush dequeue (the coalescing window).
  - `prepare` — payload build and ETF encode, inline on the Writer or on the
    prepare pool. A pooled call's pool queueing lands here, not in `queue`.
  - `resolve` — the flush dequeue through dedup/in-flight filtering, the GSN
    claim, group resolution and `update_scopes`, and the cache mutation plan,
    ending where the range is ready for a Committer.
  - `commit_wait` — the hand-off to a Committer through the durable ack,
    including waiting behind an earlier range for the resolution gate and a
    Committer worker.
  - `apply` — from the durable ack through the durable mark and the ordered
    apply: waiting behind an earlier range in claim order, cache mutations,
    and the dirty settle.
  - `notify` — the fan-out nudge and the callers' replies.

  A phase that did not run for a range is `0`, so the sum stays the range's
  wall time: a range abandoned during resolve reports `commit_wait`,
  `apply`, and `notify` as `0`; a range abandoned by a failed commit reports
  `apply` and `notify` as `0`. A post-commit raise still emits, because the
  range is durable: `outcome` stays `:ok` and `notify` is `0`. `outcome` is
  `:ok` for a durable range and `:abandoned` otherwise, and `reason` is
  present only on `:abandoned`. `ebb.writer.batch_latency_ms` remains the
  total from just before the GSN claim to the end of `notify`, so history
  stays comparable; `queue`, `prepare`, and the burst filter/dedup part of
  `resolve` happen before its timer starts.

  `ebb.fanout.push_latency_ms` is measured from the Writer's durable commit to
  the GroupServer dispatching the batch to the group's subscribers: one sample
  per dispatched batch per group. Ranges recovered after a Router restart
  carry no commit time and are not sampled.

  `ebb.entity_store.*` attributes the read path by size and phase. `byte_size`
  is the JSON blob (`row.data`) before it is decoded: the pre-existing blob on
  a dirty materialize, the returned blob on a clean hit, and the summed blob
  size of the rows a query decoded. It is a measurement, not metadata, so a
  reporter records `duration` and `byte_size` together and can bucket one by
  the other. Counting the `content` field's map keys would be a second O(N)
  walk of the decoded value, so the catalogue does not promise it; byte size is
  the size proxy. `ebb.entity_store.materialize_phase_ms` breaks one dirty
  materialize into `:fetch_decode` (SQLite SELECT + `Jason.decode!`),
  `:entries_scan` (the `cf_entity_actions` prefix scan), `:actions_load` (RocksDB
  `multi_get` + ETF decode), `:merge` (replay), and the `:encode` → `:upsert` →
  `:format` tail, so the JSON written back, the SQLite write, and the merge are
  separable. `:encode` is the JSON the write needs — the whole blob when the
  write replaces it, the touched keys when it is a per-key patch. `:upsert`
  includes the eight STORED
  `json_extract` generated columns SQLite recomputes; the phase sample is the
  only place that cost is visible. Phases fire once per dirty materialize and
  only on success; a phase that raises is left to the surrounding rescue and
  reported as `:materialization_failed`. `ebb.entity_store.read_latency_ms`
  covers the two decode-only reads — a clean `get` (`:clean_hit`) and the
  `Enum.map` over a query's rows (`:query`, one sample per query, never per
  row) — so the decode cost is visible without adding per-row spans to
  `query/4`.

  `ebb.fanout.dispatched_actions` is an observability counter, not a latency: it
  fires once per dispatched batch with the number of Actions in the batch
  (`count`) and the size of the group's subscriber set (`subscribers`), so the
  deliveries the server enqueued are `count * subscribers`. A reporter can
  compare that against what subscribers actually received to tell a server-side
  fan-out limit apart from a consumer-side limit.

  `ebb.sync.catch_up` is emitted once per successful catch-up. A `from_offset`
  of 0 marks a full resync; a non-zero offset is an incremental catch-up, so a
  reporter can compute the resync ratio from the metadata alone. Peer
  replication does not exist yet, so peer cursor/lag metrics are out of scope.

  `ebb.sync.catch_up_read` is emitted once per successful page and describes
  what that page had to read: `index_rows` is how many `cf_group_actions` rows
  it consumed and `actions_fetched` how many `cf_actions` rows it decoded. A
  page consumes at most the caller's `limit` index rows (#423), so a stable
  `index_rows` while the backlog grows is the bound holding;
  `actions_fetched` below `index_rows` counts index rows whose `cf_actions` row
  is missing, which is expected because the resolution frontier is sparse.

  `ebb.action_export.*` describes the opt-in Action exporter. `lag` is
  `committed watermark − durable cursor`, so a stalled or failing sink shows up
  as a lag that never drains. `batch` counts the Actions delivered in one
  drained range (after system-row filtering) and `filtered` counts the Updates
  that filtering stripped; a permanently failing handler emits `failed` and
  leaves the cursor where it was.

  `ebb.system_cache.populated` describes the startup cache rebuild. Counts are
  the entities materialized into each cache plus the `cf_type_entities` keys
  repaired by the one-time backfill migration (0 once the marker is written),
  and `duration` is native. `outcome` is `:ok` on a clean rebuild and `:error`
  when a phase raised; on failure the counts reached so far are still reported,
  so a half-populated cache is observable even though the node refuses to start
  serving. `reason` is the failure class — an exception module or the atom an
  exit/throw carried — never the raised value, so metadata cannot carry entity
  content.

  ## Conventions

  - **Names** are `ebb.<subsystem>.<event>`, lower snake case, past tense for
    things that happened (`range_resolved`, `commit_failed`) and a noun for
    gauges (`lag`, `size`).
  - **Measurements carry numbers only** — counts, durations, sizes, ratios.
    Durations are native time units (`System.monotonic_time/0` deltas, as
    `span/3` emits them); the `_ms` in a latency event name marks it as a
    latency metric, and reporters convert with `unit: {:native, :millisecond}`.
  - **Metadata carries identifiers and status** — `gsn`, `group_id`,
    `actor_id`, `subject_id`, `status`, `reason`. It never carries Action
    payloads or entity field values: telemetry is not a second data plane and
    must not leak user content to reporters.
  """

  @prefix :ebb

  @doc """
  The phase measurements `ebb.writer.flush_phase_ms` carries, in pipeline
  order.

  Reports and follow-up issues reference this list instead of repeating the
  phase names, so the published tables stay comparable between issues.
  """
  @spec writer_flush_phases() :: [atom()]
  def writer_flush_phases, do: @writer_flush_phases

  @doc """
  Emits `[:ebb | event]` with `measurements` and `metadata`.

  `event` is the subsystem-qualified suffix, for example
  `execute([:writer, :batch_size], %{count: 10}, %{gsn_start: 1, gsn_end: 10})`
  emits `[:ebb, :writer, :batch_size]`. It must not repeat the `:ebb` root.

  Safe to call with no handlers attached: it returns `:ok` and does nothing.
  """
  @spec execute([atom()], map(), map()) :: :ok
  def execute([head | _] = event, measurements, metadata) when head != :ebb do
    :telemetry.execute([@prefix | event], measurements, metadata)
  end

  @doc """
  Wraps `:telemetry.span/3` for start/stop (and exception) pairs.

  `fun` must return `{result, stop_metadata}` (or
  `{result, extra_measurements, stop_metadata}`); the result is passed through.
  `start_metadata` is attached to the `.start` event (and to `.exception`
  metadata on failure); `stop_metadata` is attached to the `.stop` event.

  ## Example

      EbbServer.Telemetry.span([:entity_store, :materialize], %{subject_id: id}, fn ->
        result = do_materialize(id)
        {result, %{subject_type: "todo"}}
      end)
  """
  @spec span([atom()], map(), (-> {term(), map()} | {term(), map(), map()})) :: term()
  def span([head | _] = event, start_metadata, fun)
      when head != :ebb and is_function(fun, 0) do
    :telemetry.span([@prefix | event], start_metadata, fun)
  end
end
