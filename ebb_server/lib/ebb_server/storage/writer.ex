defmodule EbbServer.Storage.Writer do
  @moduledoc """
  The single serialization point for the storage layer: every committed
  Action goes through this GenServer, which sequences its durable write to
  RocksDB before its GSN is returned to the caller.

  ## Why a single Writer

  The Writer serializes claims and keeps each Writer's GSNs monotonic.
  GSN ranges are claimed atomically from `GSNCounter` via `:atomics`,
  but the final commit only happens here, so the order the log is
  written and the order `FanOutRouter` is notified are the same.

  1. **Serialized claims.** Every committed batch is assigned its GSN
     range in one process, so concurrent writers cannot interleave
     claims and their fan-out in different orders.
  2. **Per-Writer GSN-monotonicity.** Multi-Writer pipelining is possible
     (the benchmark hit ~108k/s — see #130) but requires committed-watermark
     and ordered fan-out coordination not yet built. We keep one Writer in
     production; the architecture supports more.

  The on-disk Action log is **not** gap-free. The watermark is a
  *resolution frontier* — committed ∪ deliberately abandoned — so a
  failed commit leaves a permanent hole in the log. Catch-up and fan-out
  gate on that frontier, not on gap-free density: `FanOutRouter` pushes a
  buffered range once the frontier has passed its end, and an abandoned
  GSN simply has no durable Action to read. Permanent holes are fine;
  liveness is the hard invariant.

  ## Batch coalescing

  `write_actions/2` does not commit inline. `handle_call/3` enqueues the
  caller and its Actions, then either flushes immediately (once the pending
  Action count reaches `:writer_batch_max_size`) or schedules a flush. With
  the default `:writer_batch_timeout_ms` of 0 the Writer burst-drains:
  `handle_call/3` sends itself a `:flush` marker that lands at the tail of
  the mailbox, after every `write_actions` call already queued, so a single
  flush commits the whole burst and adds only a mailbox hop when nothing
  else is waiting. A positive timeout instead sets a `send_after` timer, trading a
  small uncontended delay for a wider coalescing window.

  Each flush claims one ordered GSN range for the merged burst and replies
  to every caller with its own contiguous sub-range in arrival order. Callers
  whose Actions were all empty or already committed get `{:ok, {0, 0}, []}`.
  Provisional marks, the durable commit, the watermark advance, and the
  fan-out notification are all once-per-flush.

  ## Sequencer and Committer

  The flush is split across two processes. This GenServer is the
  **sequencer**: it owns everything that needs the live caches or the
  resolution frontier — coalescing, dedup, the GSN claim, group
  resolution and `update_scopes`, the provisional dirty marks, apply, the
  watermark, the fan-out notification, and every reply. The linked
  `EbbServer.Storage.Committer` owns the parts that only need immutable
  input: `to_storage_format`, ETF encoding, `cf_*` op assembly, and the
  durable `write_batch/2`.

  The hand-off is one `EbbServer.Storage.PreparedAction` per Action plus
  the claimed range. The sequencer sends it asynchronously and the
  Committer answers with `{:committer_result, ref, result}`. **V0 allows
  exactly one in-flight commit** (`inflight` in the state): it is a seam
  and a measurement split, not yet a concurrency change, so apply,
  notify, and reply still wait for the ack.

  While the ack is outstanding the sequencer keeps accepting
  `write_actions/2` calls, so the next burst drains and coalesces behind
  the durable write instead of queueing in the caller. Those calls are
  only enqueued — no second claim, flush, or timer starts until the ack
  arrives. At the ack the sequencer captures the commit time, runs the
  `:after_commit` seam, marks the range committed, settles the dirty
  marks and cache mutations, notifies `FanOutRouter`, replies to every
  caller, and then starts the next flush by the same rules as a fresh
  call.

  ## Hot path

  `flush/1` claims a GSN range for the coalesced burst, resolves the
  `cf_group_actions` index via intra-action context (see below), marks the
  affected entities provisionally dirty, and hands the prepared batch to
  the Committer. Once the ack lands the sequencer settles the marks,
  advances the watermark, and notifies `FanOutRouter`. The notification
  carries the per-Action group set this pass resolved, so live fan-out
  indexes the same snapshot `cf_group_actions` was built from rather than
  re-deriving groups after the system caches have moved.

  Redundant index writes are dropped during op construction: the
  `cf_type_entities` key has no GSN component, so it is collected as a
  per-flush set and written once per unique `(subject_type, subject_id)`,
  while `cf_group_actions` is emitted once per Action from the union of
  resolved group ids.

  Every resolved per-Update scope is also persisted with the Action, as
  `"update_scopes"`: one group list per Update, index-aligned with
  `"updates"`. Fan-out and catch-up filter an Action by those scopes so
  each Update is delivered only to the groups it belongs to. The scopes
  cannot be re-derived later (a `relationship`/`entityGroup` delete's
  by-id cache entry is gone by then), so this snapshot is the delivery
  contract.

  System-cache writes are deduplicated the same way. The post-commit
  pass flattens the flush's Updates once, drops a mutation identical to
  the previous one for the same `{cache, key}`, and applies each survivor
  once. It carries an overlay of the rows the flush itself has computed,
  so a later patch merges over an earlier put — or sees an earlier
  delete — instead of reading the pre-flush cache.

  Provisionally dirty marks close the gap between the durable commit
  returning and the entity being marked dirty: a read that starts after
  the commit cannot observe a clean entity whose SQLite row predates the
  Action. `DirtyTracker.mark_pending_batch/2` stamps the marks before the
  commit attempt, `mark_dirty_batch/2` settles them once it returns, and
  `clear_pending_batch/3` removes them on the abandon paths. Materializers
  treat a provisional mark as dirty but never clear it (see
  `EbbServer.Storage.EntityStore`).

  ## Idempotent retries

  A client outbox that loses the ack for a committed batch re-flushes
  the same Actions. The dedup index makes that replay a no-op: an
  incoming `action_id` already present in `cf_action_dedup` is skipped
  before any GSN is claimed, so a retry never consumes a GSN, appends a
  second Action, or shows up in `rejected[]`. A batch whose Actions are
  all already committed replies `{:ok, {0, 0}, []}` — silent idempotent
  success.

  ## Failure and recovery policy

  A GSN range is claimed before the commit attempt, and a claim that is
  never resolved stalls the watermark permanently. The Writer therefore
  guarantees the claim is always resolved:

  - **One commit attempt, no retry.** A commit failure abandons the
    range: it is marked resolved (the watermark advances over the hole),
    `FanOutRouter` is nudged with `{:range_resolved, from, to}` so it can
    drain anything the hole was gating, and the caller gets
    every caller in the flush gets `{:error, {:rocksdb_write_failed, reason}}`
    (`503 write_failed`).
    The client outbox is the only retry; the server never acks undurable
    data and never rewinds or reuses the GSNs.
  - **Structural resolution.** Every failure path abandons before the
    failure surfaces: clear the provisional marks, resolve the range,
    log, nudge `FanOutRouter`, emit telemetry. A `{:error, reason}` from
    the Committer is replied as a failed write. A raise/throw/exit out of
    the Committer — from op assembly or from `commit_fn` — is re-raised
    in the sequencer after the abandon, so callers see the same exit the
    in-process flush produced. A failed commit and a raise therefore both
    leave the frontier advanced before the nudge is sent, and only a hard
    kill can leave a claim unresolved.
  - **Commit is the point of no return.** Once the Committer reports
    `:ok` the range is marked committed and the frontier advanced before
    any other raise-capable step runs. Every caller in the flush then gets
    its success tuple. Dirty tracking and cache updates follow; if they raise, the
    data is already durable, so the Writer logs, abnormally terminates
    `EbbServer.Storage.SystemCache`, and relies on
    `Storage.Supervisor`'s `rest_for_one` to rebuild the caches, the
    watermark, and this Writer. The success replies are sent before that
    escalation so a durable batch is never reported as lost. A failed or
    raised commit instead has its provisional marks compare-and-cleared
    before the range is resolved.
  - **Startup reconcile.** `init/1` raises the counter to the durable log
    max and resolves any remaining tail, healing a Writer-only restart
    that crashed between claim and resolve. It also settles any
    provisional mark a crashed Writer left behind: no commit is in flight
    at startup, so settling is conservative — the entity re-materializes
    and, if nothing was committed, finds no new Action and clears.

  The test seam is the optional `:commit_fn` (default
  `&RocksDB.write_batch/2`), used for both error injection and crash
  simulation. It runs in the Committer, which reports a raised value back
  instead of crashing, so the sequencer can abandon first. The optional
  `:after_commit` fun still runs inside the Writer once the Committer
  reports the durable write and before the marks settle, so tests can
  observe the durable-commit window deterministically.

  A bench-only `:ablate` option (default `[]`) skips named phases of the
  flush critical path — `:dedup`, `:group_resolution`, `:entity_index`,
  `:group_index`, `:dirty`, `:cache`, `:watermark`, `:fanout` — so
  `mix bench.actions --ablate` can price each one. It is never set in
  production, and an empty list emits exactly the same ops as before.
  See `EbbServer.Bench.Options`.

  ## cf_group_actions index and intra-action context

  When building the `cf_group_actions` index entry for an update, the
  Writer resolves the group **set** the update belongs to. This is
  straightforward when the entity already exists — look it up in
  `EntityGroupCache`. When the membership row is being created in the
  same action (e.g. a "create todo" update paired with an `entityGroup`
  update), the cache has no entry yet.

  To handle that, the Writer builds an **intra-action context** before
  processing updates: it maps each `entity_id` to the group ids carried
  by its `entityGroup` updates. `EntityIndex` unions that with the
  cached membership set, so an update is indexed once per group in the
  set.

  Example: an action with two updates:
  1. Create entity `todo_123` inside group `g_1` and `g_2`
  2. Add memberships `eg_a` (`todo_123` → `g_1`) and `eg_b`
     (`todo_123` → `g_2`)

  The intra-action context becomes
  `%{"todo_123" => ["g_1", "g_2"]}`. The Writer indexes the create
  and both membership rows into `g_1` and `g_2`. Domain relationship
  edges do not move an entity between groups.
  """

  use GenServer

  require Logger

  alias EbbServer.Storage.PermissionChecker
  alias EbbServer.Storage.PermissionHelper
  alias EbbServer.Storage.WatermarkTracker
  alias EbbServer.Telemetry

  alias EbbServer.Storage.{
    CacheTables,
    Committer,
    DirtyTracker,
    EntityGroupCache,
    EntityIndex,
    EntityTypeCache,
    Fields,
    GroupCache,
    GsnCounter,
    PreparedAction,
    RelationshipCache,
    RocksDB
  }

  @type validated_action :: PermissionChecker.validated_action()
  @type validated_update :: PermissionChecker.validated_update()

  @type cache_mutation ::
          {:entity_type, String.t(), String.t()}
          | {:group_member_put, map()}
          | {:group_member_delete, String.t()}
          | {:entity_group_put, map()}
          | {:entity_group_delete, String.t()}
          | {:relationship_put, map()}
          | {:relationship_delete, String.t()}

  @type inflight :: %{
          ref: reference(),
          pending: [{GenServer.from(), [validated_action()]}],
          ranges: %{
            optional(non_neg_integer()) => {non_neg_integer(), non_neg_integer()} | :empty
          },
          gsn_start: non_neg_integer(),
          gsn_end: non_neg_integer(),
          prepared: [PreparedAction.t()],
          groups_by_gsn: %{optional(non_neg_integer()) => [String.t()]},
          started_at: integer(),
          pending_marks: {[PreparedAction.entity_mark()], non_neg_integer() | nil},
          batch_size: non_neg_integer()
        }

  @type t :: %__MODULE__{
          rocks_name: GenServer.name(),
          dirty_set: atom(),
          gsn_counter: :atomics.atomics(),
          group_members: atom(),
          group_members_by_id: atom(),
          entity_groups: atom(),
          entity_groups_by_id: atom(),
          entity_groups_by_group: atom(),
          entity_types: atom(),
          relationships: atom(),
          relationships_by_id: atom(),
          committer: pid() | nil,
          inflight: inflight() | nil,
          after_commit: (-> any()) | nil,
          batch_max_size: integer(),
          batch_timeout_ms: non_neg_integer(),
          ablate: [atom()],
          pending: [{GenServer.from(), [validated_action()]}],
          pending_count: non_neg_integer(),
          flush_timer: reference() | nil,
          flush_scheduled: boolean(),
          fan_out_router: GenServer.name() | nil,
          watermark_tracker: GenServer.name() | nil
        }
  defstruct [
    :rocks_name,
    :dirty_set,
    :gsn_counter,
    :group_members,
    :group_members_by_id,
    :entity_groups,
    :entity_groups_by_id,
    :entity_groups_by_group,
    :entity_types,
    :relationships,
    :relationships_by_id,
    :committer,
    :inflight,
    :after_commit,
    :batch_max_size,
    :batch_timeout_ms,
    :ablate,
    :pending,
    :pending_count,
    :flush_timer,
    :flush_scheduled,
    :fan_out_router,
    :watermark_tracker
  ]

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, opts, name: name)
  end

  @type rejected_action :: %{action: validated_action(), reason: String.t()}
  @type write_result :: {:ok, {non_neg_integer(), non_neg_integer()}, [rejected_action()]}

  @spec write_actions([validated_action()], GenServer.name()) :: write_result() | {:error, term()}
  def write_actions(actions, name \\ __MODULE__) do
    GenServer.call(name, {:write_actions, actions})
  end

  @impl true
  @spec init(keyword()) :: {:ok, t()}
  def init(opts) do
    rocks_name = Keyword.get(opts, :rocks_name, EbbServer.Storage.RocksDB)

    dirty_set = Keyword.get(opts, :dirty_set, DirtyTracker.dirty_set_name())

    gsn_counter = Keyword.get(opts, :gsn_counter, GsnCounter.get_resources().gsn_counter)

    group_members =
      Keyword.get(
        opts,
        :group_members,
        CacheTables.group_members()
      )

    group_members_by_id =
      Keyword.get(
        opts,
        :group_members_by_id,
        CacheTables.group_members_by_id()
      )

    entity_groups =
      Keyword.get(
        opts,
        :entity_groups,
        CacheTables.entity_groups()
      )

    entity_groups_by_id =
      Keyword.get(
        opts,
        :entity_groups_by_id,
        CacheTables.entity_groups_by_id()
      )

    entity_groups_by_group =
      Keyword.get(
        opts,
        :entity_groups_by_group,
        CacheTables.entity_groups_by_group()
      )

    entity_types =
      Keyword.get(
        opts,
        :entity_types,
        CacheTables.entity_types()
      )

    relationships =
      Keyword.get(
        opts,
        :relationships,
        CacheTables.relationships()
      )

    relationships_by_id =
      Keyword.get(
        opts,
        :relationships_by_id,
        CacheTables.relationships_by_id()
      )

    commit_fn = Keyword.get(opts, :commit_fn) || (&RocksDB.write_batch/2)
    after_commit = Keyword.get(opts, :after_commit)

    # Bench-only ablation seam (see `--ablate` in `EbbServer.Bench.Options`).
    # Production passes nothing, so every phase runs.
    ablate = Keyword.get(opts, :ablate, [])

    batch_max_size =
      Keyword.get(
        opts,
        :batch_max_size,
        Application.get_env(:ebb_server, :writer_batch_max_size, 1000)
      )

    batch_timeout_ms =
      Keyword.get(
        opts,
        :batch_timeout_ms,
        Application.get_env(:ebb_server, :writer_batch_timeout_ms, 0)
      )

    fan_out_router = Keyword.get(opts, :fan_out_router, nil)
    watermark_tracker = Keyword.get(opts, :watermark_tracker, nil)

    # One Committer per Writer, linked so an unexpected Committer death
    # takes this Writer down and the supervisor's restart path (with its
    # `init/1` reconcile) heals the claim.
    {:ok, committer} =
      Committer.start_link(
        owner: self(),
        rocks_name: rocks_name,
        commit_fn: commit_fn,
        ablate: ablate
      )

    state = %__MODULE__{
      rocks_name: rocks_name,
      dirty_set: dirty_set,
      gsn_counter: gsn_counter,
      group_members: group_members,
      group_members_by_id: group_members_by_id,
      entity_groups: entity_groups,
      entity_groups_by_id: entity_groups_by_id,
      entity_groups_by_group: entity_groups_by_group,
      entity_types: entity_types,
      relationships: relationships,
      relationships_by_id: relationships_by_id,
      committer: committer,
      inflight: nil,
      after_commit: after_commit,
      batch_max_size: batch_max_size,
      batch_timeout_ms: batch_timeout_ms,
      ablate: ablate,
      pending: [],
      pending_count: 0,
      flush_timer: nil,
      flush_scheduled: false,
      fan_out_router: fan_out_router,
      watermark_tracker: watermark_tracker
    }

    DirtyTracker.settle_all_pending(state.dirty_set)
    reconcile_resolution_frontier(state)

    {:ok, state}
  end

  # A Writer-only restart can leave the counter ahead of the durable log:
  # the crashed writer claimed a range it never committed, and the claim
  # is still counted. Reuse of those GSNs is exactly what the resolution
  # frontier prevents, so raise the counter to the durable max and resolve
  # the abandoned tail. Idempotent on a clean boot, where the counter and
  # the frontier already agree.
  defp reconcile_resolution_frontier(%{watermark_tracker: nil}), do: :ok

  defp reconcile_resolution_frontier(state) do
    counter = GsnCounter.reconcile(state.gsn_counter, RocksDB.get_max_gsn(state.rocks_name))
    watermark = WatermarkTracker.committed_watermark(state.watermark_tracker)

    if counter > watermark do
      Logger.warning(
        "Writer reconciling abandoned GSN range #{watermark + 1}..#{counter} on startup"
      )

      Telemetry.execute(
        [:writer, :range_resolved],
        %{count: 1},
        %{gsn_start: watermark + 1, gsn_end: counter, reason: :reconciled_on_startup}
      )

      WatermarkTracker.mark_range_resolved(watermark + 1, counter, state.watermark_tracker)
      WatermarkTracker.advance_watermark(state.watermark_tracker)
    end

    :ok
  end

  @doc """
  Enqueues a write call and triggers a flush.

  Actions are already validated by PermissionChecker before reaching the
  Writer. A flush:
  1. Filters out actions with empty updates, drops duplicate `action_id`s
     (first occurrence wins across the whole coalesced burst), and drops
     ids already in `cf_action_dedup`.
  2. Claims one GSN range for the remaining fresh actions.
  3. Prepares one `PreparedAction` per fresh Action (group resolution and
     `update_scopes`), hands the batch to the Committer, and once the
     Committer reports the durable write builds a single WriteBatch across
     the written column families:
     - cf_actions: GSN → full action, including its Updates and their
       per-Update group scopes (ETF encoded)
     - cf_action_dedup: action_id → GSN (duplicate detection)
     - cf_entity_actions: (subject_id, GSN) → action_id (materialization index)
     - cf_type_entities: (subject_type, subject_id) → <<>> (type index)
     - cf_group_actions: (group_id, GSN) → action_id (group catch-up index)

     Updates are stored once, inside the `cf_actions` value.
  4. Marks affected entities dirty and replies to each caller with its
     contiguous sub-range.

  A flush with no fresh actions replies `{:ok, {0, 0}, []}` to every
  caller. A commit failure abandons the whole claimed range and every
  caller in the flush sees `{:error, {:rocksdb_write_failed, reason}}`.
  """
  @impl true
  def handle_call({:write_actions, actions}, from, state) when is_list(actions) do
    {:noreply, state |> enqueue(from, actions) |> schedule_flush()}
  end

  # A marker queued before the dispatch only means the burst is already
  # being committed; the ack path reschedules if calls piled up behind it.
  @impl true
  def handle_info(:flush, %{inflight: %{}} = state) do
    {:noreply, %{state | flush_scheduled: false}}
  end

  def handle_info(:flush, state), do: {:noreply, flush(state)}

  def handle_info({:committer_result, ref, result}, %{inflight: %{ref: ref}} = state) do
    {:noreply, handle_commit_result(result, state)}
  end

  # A result for an attempt this Writer has already abandoned (it only
  # happens after the sequencer re-raised) must not reply twice.
  def handle_info({:committer_result, _stale_ref, _result}, state), do: {:noreply, state}

  defp enqueue(state, from, actions) do
    %{
      state
      | pending: [{from, actions} | state.pending],
        pending_count: state.pending_count + length(actions)
    }
  end

  # The only place a flush is scheduled. A commit in flight blocks it —
  # V0 keeps one claim — and calls accumulate until the ack reschedules.
  defp schedule_flush(%{inflight: %{}} = state), do: state

  defp schedule_flush(%{pending: []} = state), do: %{state | flush_scheduled: false}

  defp schedule_flush(state) do
    cond do
      state.batch_max_size > 0 and state.pending_count >= state.batch_max_size ->
        flush(state)

      state.flush_timer != nil ->
        state

      state.batch_timeout_ms > 0 ->
        %{state | flush_timer: Process.send_after(self(), :flush, state.batch_timeout_ms)}

      true ->
        # Burst-drain: the marker lands at the TAIL of the mailbox, after
        # every write_actions call already queued, so it flushes the current
        # burst and adds only a mailbox hop when nothing else is waiting. One
        # marker per burst is enough; the rest of the burst enqueues behind it.
        unless state.flush_scheduled do
          send(self(), :flush)
        end

        %{state | flush_scheduled: true}
    end
  end

  # The single place that claims a GSN range and hands it to the
  # Committer. A stale marker or timer must be a no-op when nothing is
  # pending; the replies wait for the ack.
  defp flush(%{pending: []} = state) do
    %{cancel_flush_timer(state) | flush_scheduled: false}
  end

  defp flush(state) do
    state = cancel_flush_timer(state)
    pending = Enum.reverse(state.pending)

    {fresh, fresh_tagged} = plan(pending, state)

    state = %{state | pending: [], pending_count: 0, flush_scheduled: false}

    case fresh do
      [] ->
        reply_all(pending, %{}, :ok)
        state

      _ ->
        started_at = System.monotonic_time()
        batch_size = length(fresh)
        caller_count = length(pending)

        {gsn_start, gsn_end} = GsnCounter.claim_gsn_range(batch_size, state.gsn_counter)
        ranges = caller_ranges(fresh_tagged, caller_count, gsn_start)

        Telemetry.execute(
          [:writer, :batch_size],
          %{count: batch_size},
          %{gsn_start: gsn_start, gsn_end: gsn_end, callers: caller_count}
        )

        dispatch(pending, ranges, fresh, gsn_start, gsn_end, started_at, state)
    end
  end

  defp dispatch(pending, ranges, fresh, gsn_start, gsn_end, started_at, state) do
    {prepared, groups_by_gsn} =
      prepare_or_abandon(fresh, gsn_start, gsn_end, started_at, state)

    pending_marks = pending_marks(prepared, state)
    ref = make_ref()
    Committer.commit(state.committer, ref, prepared, gsn_start, gsn_end)

    %{
      state
      | inflight: %{
          ref: ref,
          pending: pending,
          ranges: ranges,
          gsn_start: gsn_start,
          gsn_end: gsn_end,
          prepared: prepared,
          groups_by_gsn: groups_by_gsn,
          started_at: started_at,
          pending_marks: pending_marks,
          batch_size: length(prepared)
        }
    }
  end

  # Group resolution reads the system caches, so it stays on the
  # sequencer. A raise here is still a claimed-but-uncommitted range: the
  # abandon (clear marks, resolve, log, nudge) runs before the re-raise,
  # exactly like the failure paths after the ack.
  defp prepare_or_abandon(fresh, gsn_start, gsn_end, started_at, state) do
    # credo:disable-for-next-line /Check\.Readability\.PreferImplicitTry/
    try do
      prepare(fresh, gsn_start, state)
    rescue
      error ->
        emit_batch_latency(gsn_start, gsn_end, started_at)
        abandon(state, {[], nil}, gsn_start, gsn_end, error)
        reraise error, __STACKTRACE__
    catch
      kind, value ->
        emit_batch_latency(gsn_start, gsn_end, started_at)
        abandon(state, {[], nil}, gsn_start, gsn_end, {kind, value})
        :erlang.raise(kind, value, __STACKTRACE__)
    end
  end

  defp emit_actions_accepted(count) do
    Telemetry.execute([:writer, :actions_per_sec], %{count: count}, %{})
  end

  defp emit_batch_latency(gsn_start, gsn_end, started_at) do
    Telemetry.execute(
      [:writer, :batch_latency_ms],
      %{duration: System.monotonic_time() - started_at},
      %{gsn_start: gsn_start, gsn_end: gsn_end}
    )
  end

  defp handle_commit_result(:ok, state) do
    inflight = state.inflight

    # credo:disable-for-next-line /Check\.Readability\.PreferImplicitTry/
    try do
      settle_committed(inflight, state)
    rescue
      error ->
        abandon(state, inflight.pending_marks, inflight.gsn_start, inflight.gsn_end, error)
        reraise error, __STACKTRACE__
    catch
      kind, value ->
        abandon(
          state,
          inflight.pending_marks,
          inflight.gsn_start,
          inflight.gsn_end,
          {kind, value}
        )

        :erlang.raise(kind, value, __STACKTRACE__)
    end
  end

  defp handle_commit_result({:error, reason}, state) do
    inflight = state.inflight
    state = %{state | inflight: nil}

    Telemetry.execute(
      [:writer, :commit_failed],
      %{count: 1},
      %{gsn_start: inflight.gsn_start, gsn_end: inflight.gsn_end, reason: reason}
    )

    abandon(state, inflight.pending_marks, inflight.gsn_start, inflight.gsn_end, reason)
    emit_batch_latency(inflight.gsn_start, inflight.gsn_end, inflight.started_at)
    reply_all(inflight.pending, inflight.ranges, {:error, reason})

    schedule_flush(state)
  end

  # The Committer reports the crash instead of taking the write down with
  # it, so the claim is abandoned here before the same exit reaches the
  # caller.
  defp handle_commit_result({:raised, kind, value, stacktrace}, state) do
    inflight = state.inflight
    state = %{state | inflight: nil}

    abandon(
      state,
      inflight.pending_marks,
      inflight.gsn_start,
      inflight.gsn_end,
      raised_reason(kind, value)
    )

    emit_batch_latency(inflight.gsn_start, inflight.gsn_end, inflight.started_at)
    :erlang.raise(kind, value, stacktrace)
  end

  defp raised_reason(:error, value), do: value
  defp raised_reason(kind, value), do: {kind, value}

  # The Committer has already returned `:ok`, so everything from here on
  # is post-commit bookkeeping. A raise abandons the range and re-raises:
  # the data is durable but the caller sees the same crash the in-process
  # flush produced.
  defp settle_committed(inflight, state) do
    state = %{state | inflight: nil}

    # Captured immediately after the durable write: the fan-out push
    # latency is measured from here, not from batch arrival.
    committed_at = System.monotonic_time()

    if state.after_commit, do: state.after_commit.()

    unless ablate?(:watermark, state),
      do: mark_committed(state, inflight.gsn_start, inflight.gsn_end)

    case apply_post_commit(inflight.prepared, inflight.pending_marks, state) do
      :ok ->
        notify_fanout(
          state,
          inflight.gsn_start,
          inflight.gsn_end,
          inflight.groups_by_gsn,
          committed_at
        )

        emit_batch_latency(inflight.gsn_start, inflight.gsn_end, inflight.started_at)
        emit_actions_accepted(inflight.batch_size)
        reply_all(inflight.pending, inflight.ranges, :ok)
        schedule_flush(state)

      {:error, reason} ->
        # The batch is durable: reply success to every caller first,
        # then escalate, so no caller sees a lost success when the
        # rebuild tears this process down.
        emit_batch_latency(inflight.gsn_start, inflight.gsn_end, inflight.started_at)
        emit_actions_accepted(inflight.batch_size)
        reply_all(inflight.pending, inflight.ranges, :ok)
        escalate_cache_failure(inflight.gsn_start, inflight.gsn_end, reason)
        state
    end
  end

  # Arrival order is the caller's position in `pending`; a caller's
  # surviving Actions are contiguous in the global fresh list, so one
  # `{first, last}` per caller is exact.
  defp plan(pending, state) do
    tagged =
      pending
      |> Enum.with_index()
      |> Enum.flat_map(fn {{_from, actions}, caller_idx} ->
        actions
        |> Enum.reject(&(&1.updates == []))
        |> Enum.map(&{caller_idx, &1})
      end)
      |> Enum.uniq_by(fn {_caller_idx, action} -> action.id end)

    fresh_tagged =
      if ablate?(:dedup, state), do: tagged, else: drop_committed(tagged, state.rocks_name)

    fresh = Enum.map(fresh_tagged, &elem(&1, 1))

    {fresh, fresh_tagged}
  end

  defp caller_ranges(fresh_tagged, caller_count, gsn_start) do
    ranges =
      fresh_tagged
      |> Enum.with_index()
      |> Enum.reduce(%{}, fn {{caller_idx, _action}, i}, acc ->
        gsn = gsn_start + i

        case Map.get(acc, caller_idx) do
          nil -> Map.put(acc, caller_idx, {gsn, gsn})
          {first, _last} -> Map.put(acc, caller_idx, {first, gsn})
        end
      end)

    for idx <- 0..(caller_count - 1), into: %{} do
      {idx, Map.get(ranges, idx, :empty)}
    end
  end

  defp reply_all(pending, ranges, outcome) do
    pending
    |> Enum.with_index()
    |> Enum.each(fn {{from, _actions}, caller_idx} ->
      GenServer.reply(from, build_reply(outcome, Map.get(ranges, caller_idx, :empty)))
    end)
  end

  defp build_reply(:ok, {first, last}), do: {:ok, {first, last}, []}
  defp build_reply(:ok, :empty), do: {:ok, {0, 0}, []}
  defp build_reply({:error, reason}, _range), do: {:error, {:rocksdb_write_failed, reason}}

  defp cancel_flush_timer(%{flush_timer: nil} = state), do: state

  defp cancel_flush_timer(state) do
    Process.cancel_timer(state.flush_timer)
    %{state | flush_timer: nil}
  end

  # `cf_action_dedup` doubles as the commit marker: the index entry and
  # the `cf_actions` record land in the same atomic `write_batch`, so an
  # entry can only exist for a durable Action. A retried Action that
  # already has one must not claim a GSN or append a second log record.
  # Pairing results with ids (not actions) means a short `multi_get`
  # reply keeps the unmatched Actions rather than dropping them.
  defp drop_committed([], _rocks_name), do: []

  defp drop_committed(tagged, rocks_name) do
    ids = Enum.map(tagged, fn {_caller_idx, action} -> action.id end)

    committed =
      RocksDB.multi_get(RocksDB.cf_action_dedup(rocks_name), ids, name: rocks_name)
      |> Enum.zip(ids)
      |> Enum.flat_map(fn
        {{:ok, _gsn}, id} -> [id]
        {:not_found, _id} -> []
      end)
      |> MapSet.new()

    Enum.reject(tagged, fn {_caller_idx, action} -> MapSet.member?(committed, action.id) end)
  end

  # One flush resolves every Action against one cache snapshot, so the
  # cache-only part of group resolution is memoized across the whole
  # flush (see `EntityIndex.resolve_groups_cached/3`). Each Action still
  # unions its own intra-action membership on top, so two Actions that
  # move the same entity cannot see each other's membership.
  defp prepare(fresh, gsn_start, state) do
    resolve_opts = resolve_cache_opts(state)

    {prepared, {groups_by_gsn, _memo}} =
      fresh
      |> Enum.with_index(gsn_start)
      |> Enum.map_reduce({%{}, %{}}, fn {action, gsn}, {groups, memo} ->
        {prepared_action, memo} = prepare_action(action, state, resolve_opts, memo)

        {prepared_action, {Map.put(groups, gsn, prepared_action.groups), memo}}
      end)

    {prepared, groups_by_gsn}
  end

  defp prepare_action(action, state, resolve_opts, memo) do
    intra_action_context = PermissionHelper.build_intra_action_context(action.updates)

    resolve_opts =
      Keyword.put(resolve_opts, :intra_action, intra_action_context)

    {_group_ids, {scopes, type_entity_keys, memo}} =
      Enum.map_reduce(action.updates, {[], [], memo}, fn update, {scopes, keys, memo} ->
        {group_ids, memo} =
          if ablate?(:group_resolution, state) do
            {[], memo}
          else
            group_ids_for_update(update, resolve_opts, memo)
          end

        key =
          if ablate?(:entity_index, state),
            do: nil,
            else: RocksDB.encode_type_entity_key(update.subject_type, update.subject_id)

        {group_ids, {[group_ids | scopes], [key | keys], memo}}
      end)

    # Index-aligned with `action.updates`: the durable record of which
    # groups each Update is delivered to. Computed here, from the same
    # snapshot `cf_group_actions` is built from, because the by-id caches
    # for a relationship/entityGroup delete are gone by fan-out time.
    update_scopes = Enum.reverse(scopes)
    type_entity_keys = type_entity_keys |> Enum.reverse() |> Enum.reject(&is_nil/1)

    prepared = %PreparedAction{
      id: action.id,
      actor_id: action.actor_id,
      hlc: action.hlc,
      updates: action.updates,
      intra_action_context: intra_action_context,
      update_scopes: update_scopes,
      # The union of resolved groups is indexed once per Action, not once
      # per Update, so repeated memberships cannot write the same
      # `{group_id, gsn}` row twice.
      groups: update_scopes |> :lists.append() |> Enum.uniq(),
      type_entity_keys: type_entity_keys,
      affected_entities: affected_entities(action.updates)
    }

    {prepared, memo}
  end

  # The provisional marks are placed before the batch leaves for the
  # Committer so that no read can observe the entity clean between the
  # commit landing and the settled mark; `abandon` clears them on every
  # failure path. Settling (in `apply_post_commit`) overwrites them, so the
  # success path needs no clear.
  #
  # With `:dirty` ablated there is no mark to place and nothing to settle
  # or clear, so the pending tuple is inert.
  defp pending_marks(prepared, state) do
    if ablate?(:dirty, state) do
      {[], nil}
    else
      entities = prepared_entities(prepared)
      {entities, DirtyTracker.mark_pending_batch(entities, state.dirty_set)}
    end
  end

  defp prepared_entities(prepared) do
    prepared
    |> Enum.flat_map(& &1.affected_entities)
    |> Enum.uniq_by(&elem(&1, 0))
  end

  defp apply_post_commit(prepared, {entities, _generation}, state) do
    unless ablate?(:dirty, state) do
      :ok = DirtyTracker.mark_dirty_batch(entities, state.dirty_set)
    end

    unless ablate?(:cache, state) do
      prepared
      |> plan_cache_mutations(state)
      |> Enum.each(&apply_cache_mutation(&1, state))
    end

    :ok
  rescue
    error -> {:error, error}
  end

  # One pass over the flush's Updates computes the cache mutation each
  # one would apply and the row it would leave behind. The overlay carries
  # the flush's own prior effects, so a later Update sees an earlier put's
  # merged row or an earlier delete without reading a cache this flush has
  # not written yet.
  #
  # Takes either validated Actions or their `PreparedAction`s: only the
  # `updates` field matters. Public so tests can pin the dedup directly;
  # hidden from the docs.
  @doc false
  @spec plan_cache_mutations([validated_action() | PreparedAction.t()], t()) ::
          [cache_mutation()]
  def plan_cache_mutations(fresh, state) do
    {mutations, _overlay} =
      fresh
      |> Enum.flat_map(& &1.updates)
      |> Enum.reduce({[], %{}}, fn update, acc -> plan_update(update, state, acc) end)

    mutations
    |> Enum.reverse()
    |> drop_repeats()
  end

  # A repeat is dropped only when it is identical to the previous mutation
  # for the same key. Two identical applications in a row are idempotent
  # for every cache here, so this preserves the final state sequential
  # per-Update application would produce. It also keeps `GroupCache`'s
  # actor-keyed cleanup honest: collapsing two *different* rows for one
  # membership id would strand the first one's primary row.
  defp drop_repeats(mutations) do
    {kept, _last} =
      Enum.reduce(mutations, {[], %{}}, fn mutation, {kept, last} ->
        key = mutation_key(mutation)
        value = mutation_value(mutation)

        case Map.fetch(last, key) do
          {:ok, ^value} -> {kept, last}
          _ -> {[mutation | kept], Map.put(last, key, value)}
        end
      end)

    Enum.reverse(kept)
  end

  # The entity-type index mirrors `cf_type_entities`, which the Writer
  # writes for every Update (including deletes, whose entry stays).
  defp plan_update(update, state, {mutations, overlay}) do
    mutations = [{:entity_type, update.subject_id, update.subject_type} | mutations]
    plan_system_mutation(update, state, mutations, overlay)
  end

  defp plan_system_mutation(%{subject_type: "groupMember"} = update, state, mutations, overlay) do
    key = {:group_members_by_id, update.subject_id}

    case update.method do
      method when method in [:put, :patch] ->
        data = update.data || %{}

        existing =
          patch_existing(
            update,
            overlay,
            key,
            state.group_members_by_id,
            &GroupCache.get_group_member/2
          )

        actor_id = Fields.get(data, "actor_id") || existing[:actor_id]
        group_id = Fields.get(data, "group_id") || existing[:group_id]

        if is_nil(actor_id) or is_nil(group_id) do
          {mutations, overlay}
        else
          row = %{
            id: update.subject_id,
            actor_id: actor_id,
            group_id: group_id,
            permissions: Fields.get(data, "permissions") || existing[:permissions]
          }

          {[{:group_member_put, row} | mutations], Map.put(overlay, key, row)}
        end

      :delete ->
        {[{:group_member_delete, update.subject_id} | mutations], Map.put(overlay, key, :deleted)}
    end
  end

  defp plan_system_mutation(%{subject_type: "entityGroup"} = update, state, mutations, overlay) do
    key = {:entity_groups_by_id, update.subject_id}

    case update.method do
      method when method in [:put, :patch] ->
        data = update.data || %{}

        existing =
          patch_existing(
            update,
            overlay,
            key,
            state.entity_groups_by_id,
            &EntityGroupCache.get_entity_group/2
          )

        entity_id = Fields.get(data, "entity_id") || existing[:entity_id]
        group_id = Fields.get(data, "group_id") || existing[:group_id]

        if is_nil(entity_id) or is_nil(group_id) do
          {mutations, overlay}
        else
          row = %{id: update.subject_id, entity_id: entity_id, group_id: group_id}
          {[{:entity_group_put, row} | mutations], Map.put(overlay, key, row)}
        end

      :delete ->
        {[{:entity_group_delete, update.subject_id} | mutations], Map.put(overlay, key, :deleted)}
    end
  end

  # Relationship rows never merge with the cached row: the wire fields are
  # authoritative, as in the pre-dedup handler.
  defp plan_system_mutation(%{subject_type: "relationship"} = update, _state, mutations, overlay) do
    key = {:relationships_by_id, update.subject_id}

    case update.method do
      method when method in [:put, :patch] ->
        data = update.data || %{}
        source_id = Fields.get(data, "source_id")
        target_id = Fields.get(data, "target_id")

        if is_nil(source_id) or is_nil(target_id) do
          {mutations, overlay}
        else
          row = %{
            id: update.subject_id,
            source_id: source_id,
            target_id: target_id,
            type: Fields.get(data, "type"),
            field: Fields.get(data, "field")
          }

          {[{:relationship_put, row} | mutations], Map.put(overlay, key, row)}
        end

      :delete ->
        {[{:relationship_delete, update.subject_id} | mutations], Map.put(overlay, key, :deleted)}
    end
  end

  defp plan_system_mutation(_update, _state, mutations, overlay), do: {mutations, overlay}

  # Only a patch consults a pre-existing row. The overlay is the flush's
  # own prior effect, so a delete in the same flush means there is nothing
  # left to merge over and the patch cannot resurrect a pre-flush row.
  defp patch_existing(%{method: :patch} = update, overlay, key, table, fetch) do
    case Map.fetch(overlay, key) do
      {:ok, :deleted} -> %{}
      {:ok, row} -> row
      :error -> fetch.(update.subject_id, table) || %{}
    end
  end

  defp patch_existing(_update, _overlay, _key, _table, _fetch), do: %{}

  defp mutation_value({:entity_type, _id, type}), do: type
  defp mutation_value({:group_member_put, row}), do: row
  defp mutation_value({:group_member_delete, _id}), do: :deleted
  defp mutation_value({:entity_group_put, row}), do: row
  defp mutation_value({:entity_group_delete, _id}), do: :deleted
  defp mutation_value({:relationship_put, row}), do: row
  defp mutation_value({:relationship_delete, _id}), do: :deleted

  defp mutation_key({:entity_type, id, _type}), do: {:entity_type, id}
  defp mutation_key({:group_member_put, %{id: id}}), do: {:group_members_by_id, id}
  defp mutation_key({:group_member_delete, id}), do: {:group_members_by_id, id}
  defp mutation_key({:entity_group_put, %{id: id}}), do: {:entity_groups_by_id, id}
  defp mutation_key({:entity_group_delete, id}), do: {:entity_groups_by_id, id}
  defp mutation_key({:relationship_put, %{id: id}}), do: {:relationships_by_id, id}
  defp mutation_key({:relationship_delete, id}), do: {:relationships_by_id, id}

  defp apply_cache_mutation({:entity_type, id, type}, state) do
    EntityTypeCache.put_type(id, type, entity_types: state.entity_types)
  end

  defp apply_cache_mutation({:group_member_put, row}, state) do
    GroupCache.put_group_member(row, state.group_members)
  end

  defp apply_cache_mutation({:group_member_delete, id}, state) do
    GroupCache.delete_group_member(id, state.group_members)
  end

  defp apply_cache_mutation({:entity_group_put, row}, state) do
    EntityGroupCache.put_entity_group(row,
      entity_groups: state.entity_groups,
      entity_groups_by_id: state.entity_groups_by_id,
      entity_groups_by_group: state.entity_groups_by_group
    )
  end

  defp apply_cache_mutation({:entity_group_delete, id}, state) do
    EntityGroupCache.delete_entity_group(id,
      entity_groups: state.entity_groups,
      entity_groups_by_id: state.entity_groups_by_id,
      entity_groups_by_group: state.entity_groups_by_group
    )
  end

  defp apply_cache_mutation({:relationship_put, row}, state) do
    RelationshipCache.put_relationship(row,
      relationships: state.relationships,
      relationships_by_id: state.relationships_by_id
    )
  end

  defp apply_cache_mutation({:relationship_delete, id}, state) do
    RelationshipCache.delete_relationship(id,
      relationships: state.relationships,
      relationships_by_id: state.relationships_by_id
    )
  end

  # The dirty mark records the subject type so a query can find the dirty
  # entities of a type without inferring the type from the ID. The first
  # update for an ID wins: all updates in a flush for one entity carry the
  # same type.
  defp affected_entities(updates) do
    updates
    |> Enum.map(&{&1.subject_id, &1.subject_type})
    |> Enum.uniq_by(&elem(&1, 0))
  end

  # The batch is durable, so the reply contract is success; the caches are
  # now suspect, so the only safe move is to rebuild the storage tree from
  # the log. `rest_for_one` tears down the caches, the watermark, and this
  # Writer, and the new Writer reconciles on init.
  defp escalate_cache_failure(gsn_start, gsn_end, reason) do
    Logger.error(
      "Writer committed GSN range #{gsn_start}..#{gsn_end} but a cache update failed " <>
        "(#{inspect(reason)}); terminating SystemCache to rebuild the storage tree"
    )

    case Process.whereis(EbbServer.Storage.SystemCache) do
      nil -> :ok
      pid -> Process.exit(pid, :cache_update_failed)
    end
  end

  defp abandon(state, pending, gsn_start, gsn_end, reason) do
    unless ablate?(:dirty, state), do: clear_pending(state, pending)

    # Resolve before nudging so the router can only observe the advanced
    # frontier.
    unless ablate?(:watermark, state), do: resolve_range(state, gsn_start, gsn_end)

    Telemetry.execute(
      [:writer, :range_resolved],
      %{count: 1},
      %{gsn_start: gsn_start, gsn_end: gsn_end, reason: reason}
    )

    Logger.error(
      "Writer abandoned GSN range #{gsn_start}..#{gsn_end} without committing it: " <>
        inspect(reason)
    )

    notify_range_resolved(state, gsn_start, gsn_end)
  end

  # A failed or raised commit wrote nothing, so the provisional marks it
  # placed must go. Compare-and-clear by generation keeps a settled mark, or
  # a newer batch's provisional mark, in place.
  defp clear_pending(state, {entities, generation}) do
    DirtyTracker.clear_pending_batch(entities, generation, state.dirty_set)
  end

  defp mark_committed(%{watermark_tracker: nil}, _gsn_start, _gsn_end), do: :ok

  defp mark_committed(state, gsn_start, gsn_end) do
    :ok = WatermarkTracker.mark_range_committed(gsn_start, gsn_end, state.watermark_tracker)
    WatermarkTracker.advance_watermark(state.watermark_tracker)
    :ok
  end

  defp resolve_range(%{watermark_tracker: nil}, _gsn_start, _gsn_end), do: :ok

  defp resolve_range(state, gsn_start, gsn_end) do
    WatermarkTracker.mark_range_resolved(gsn_start, gsn_end, state.watermark_tracker)
    WatermarkTracker.advance_watermark(state.watermark_tracker)
    :ok
  end

  defp notify_fanout(state, gsn_start, gsn_end, groups_by_gsn, committed_at) do
    unless ablate?(:fanout, state) do
      notify_batch_committed(state, gsn_start, gsn_end, groups_by_gsn, committed_at)
    end
  end

  defp notify_batch_committed(state, gsn_start, gsn_end, groups_by_gsn, committed_at) do
    notify_router(state, {:batch_committed, gsn_start, gsn_end, groups_by_gsn, committed_at})
  end

  defp notify_range_resolved(state, gsn_start, gsn_end) do
    notify_router(state, {:range_resolved, gsn_start, gsn_end})
  end

  # The Router is a sibling under the Sync supervisor, so it can be down
  # during a rebuild; a `nil` `fan_out_router` (Writer unit tests) or a
  # dead process is not an error.
  defp notify_router(state, message) do
    if state.fan_out_router && Process.whereis(state.fan_out_router) do
      send(state.fan_out_router, message)
    end

    :ok
  end

  defp resolve_cache_opts(state) do
    [
      entity_groups: state.entity_groups,
      entity_groups_by_id: state.entity_groups_by_id,
      entity_types: state.entity_types,
      relationships_by_id: state.relationships_by_id,
      group_members_by_id: state.group_members_by_id
    ]
  end

  defp ablate?(phase, state), do: phase in state.ablate

  defp group_ids_for_update(update, resolve_opts, memo) do
    case Keyword.get(resolve_opts, :entity_groups) do
      nil -> {[], memo}
      _table -> resolve_update_groups(update, resolve_opts, memo)
    end
  end

  defp resolve_update_groups(update, resolve_opts, memo) do
    case EntityIndex.fan_out_preference(update) do
      {:wire, group_ids} ->
        {group_ids, memo}

      {:source, source_id} ->
        resolve_memo(memo, {:source, source_id}, resolve_opts, fn ->
          {EntityIndex.source_groups_cached(source_id, resolve_opts), source_id}
        end)

      {:by_id, subject_type} ->
        resolve_memo_groups(memo, subject_type, update.subject_id, resolve_opts)
    end
  end

  defp resolve_memo_groups(memo, subject_type, subject_id, resolve_opts) do
    resolve_memo(memo, {subject_type, subject_id}, resolve_opts, fn ->
      EntityIndex.resolve_groups_cached(subject_type, subject_id, resolve_opts)
    end)
  end

  defp resolve_memo(memo, key, opts, resolve) do
    {{groups, source_id}, memo} = memo_fetch(memo, key, resolve)
    {EntityIndex.apply_intra_action(groups, source_id, opts), memo}
  end

  defp memo_fetch(memo, key, resolve) do
    case memo do
      %{^key => value} ->
        {value, memo}

      _ ->
        value = resolve.()
        {value, Map.put(memo, key, value)}
    end
  end
end
