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

  ## Sequencer and Committer pool

  The flush is split across processes. This GenServer is the
  **sequencer**: it owns everything that needs the live caches or the
  resolution frontier — coalescing, dedup, the pre-claim payload build and
  ETF encode, the GSN claim, group resolution and `update_scopes`, the
  provisional dirty marks, apply, the watermark, the fan-out notification,
  and every reply. The linked `EbbServer.Storage.CommitterPool` owns the
  parts that only need immutable input: wrapper encode, `cf_*` op
  assembly, and the durable `write_batch/2`.

  The hand-off is one `EbbServer.Storage.PreparedAction` per Action plus
  the claimed range. The sequencer sends it asynchronously and the pool
  answers with `{:committer_assigned, ref, worker}` followed by
  `{:committer_result, ref, result}`. The Writer keeps exactly one range in
  flight by default, so V0's semantics are unchanged until #533's cache
  overlay lands. The `:max_in_flight` Writer option is an internal test
  seam for the multi-range failure paths; it is not a runtime configuration
  key, because a successor prepared before #533 can resolve stale group
  scopes.

  The pool is not shared across Writer restarts. It is linked to the
  Writer and monitors it, so a Writer death sends shutdown to the pool.
  That shutdown is best-effort: a worker already inside `write_batch` can
  finish after its owner exits. Any claim still unresolved when the
  replacement Writer boots is therefore treated as orphaned and resolved
  as a hole. GSNs are never reused, so a late durable write can only fill a
  range the new Writer already reported resolved; readers still see it in
  the log, but live fan-out can miss it until a later catch-up. The
  `InFlightActions.clear/1` call in `init/1` is safe for the same reason:
  no old worker can claim a *new* GSN after its Writer is gone.

  ## Commit pipeline state machine

  The Writer is now only the imperative shell. The pending calls, claimed
  ranges, in-flight action-id guard, resolution order, and coalescing
  flags live in `EbbServer.Storage.CommitPipeline`, a pure state machine
  with explicit `claimed -> prepared -> committing -> committed ->
  applying -> released` transitions and an `abandoned` terminal path.
  `Batch.owner` records the Committer worker that owns the range, while
  `ref` remains the failure identity. The Writer owns the live caches,
  timers, pool, and durable side effects; every ordering decision comes
  from the pipeline. The issue's `durable` lifecycle step is the pipeline's
  `:committed`, and its `released` step is reached after the ordered apply.
  That is what makes the transitions testable without a Writer, isolated
  caches, or RocksDB.

  The pipeline's `claim_order` is the reorder buffer: commit acks may
  arrive in any order, but `drain_releasable/1` applies and notifies only
  the committed prefix. An abandoned range is pruned, which lets the
  healthy range behind it drain. The `Batch` struct is also where the
  cross-flush cache overlay (#533) will attach; depth stays at one by
  default until that overlay exists.

  While an ack is outstanding the sequencer keeps accepting
  `write_actions/2` calls, so the next burst drains and coalesces behind
  the durable write instead of queueing in the caller. Those calls are
  enqueued and their payloads built and ETF-encoded — work that needs no
  GSN, so it overlaps the in-flight commit. At the ack the sequencer
  captures the commit time, runs the `:after_commit` seam, marks the range
  committed, then drains every releasable range in claim order: settle the
  dirty marks and cache mutations, notify `FanOutRouter`, reply to each
  caller, and release. It then starts the next flush by the same rules as
  a fresh call.

  ## Hot path

  Each call's payload is built and ETF-encoded as it arrives, before any
  GSN is claimed. `flush/1` then claims a GSN range for the coalesced
  burst, resolves the `cf_group_actions` index via intra-action context
  (see below), marks the affected entities provisionally dirty, and hands
  the prepared batch to the Committer. Once the ack lands the sequencer
  settles the marks, advances the watermark, and notifies `FanOutRouter`.
  The notification carries the per-Action group set this pass resolved, so
  live fan-out indexes the same snapshot `cf_group_actions` was built from
  rather than re-deriving groups after the system caches have moved.

  Redundant index writes are dropped during op construction: the
  `cf_type_entities` key has no GSN component, so it is collected as a
  per-flush set and written once per unique `(subject_type, subject_id)`,
  while `cf_group_actions` is emitted once per Action from the union of
  resolved group ids.

  Every resolved per-Update scope is also persisted as the outer scopes
  of the stored `cf_actions` wrapper: one group list per Update,
  index-aligned with the payload's Updates. Fan-out and catch-up filter
  an Action by those scopes so each Update is delivered only to the groups
  it belongs to. The scopes cannot be re-derived later (a
  `relationship`/`entityGroup` delete's by-id cache entry is gone by
  then), so this snapshot is the delivery contract.

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

  `cf_action_dedup` only marks a durable Action, so it cannot stop a
  retry planned while its first copy is still in flight.
  `EbbServer.Storage.InFlightActions` closes that window: `plan/2`
  atomically claims the surviving ids before the GSN range is claimed and
  drops any id another batch already owns. An in-flight duplicate replies
  the same `{:ok, {0, 0}, []}` as a committed one; the tuple means "no
  GSN assigned to this caller", not "durable". At the default depth of
  one the Writer cannot plan a duplicate mid-flight yet; the guard becomes
  load-bearing when the internal `:max_in_flight` test seam is raised or
  concurrent sub-batches (#536) land, where a failed owner would leave the
  duplicate already acked empty.

  ## Failure and recovery policy

  A GSN range is claimed before the commit attempt, and a claim that is
  never resolved stalls the watermark permanently. The Writer therefore
  guarantees the claim is always resolved:

  - **One commit attempt, no retry.** A commit failure abandons the
    range: it is marked resolved (the watermark advances over the hole),
    `FanOutRouter` is nudged with `{:range_resolved, from, to}` so it can
    drain anything the hole was gating, and every caller in the flush
    gets `{:error, {:rocksdb_write_failed, reason}}` (`503 write_failed`).
    The client outbox is the only retry; the server never acks a GSN
    range for undurable data and never rewinds or reuses the GSNs.
  - **Structural resolution.** Every pre-commit failure path abandons
    before the failure surfaces: clear the provisional marks, resolve the
    range, log, nudge `FanOutRouter`, emit telemetry. A `{:error, reason}`
    from the Committer is replied as a failed write. A raise/throw/exit
    out of the Committer — from op assembly or from `commit_fn` — and a
    real worker death reported by the pool as `{:crashed, reason}` are
    contained: they abandon only that range and reply
    `{:error, {:rocksdb_write_failed, reason}}`. The Writer and every
    other in-flight range keep running. A Writer death between claim and
    resolve can still leave the claim unresolved — including a death that
    arrives after the Committer has already written, because the write is
    now in another process. The pool dies with the Writer, so the restart
    reconcile resolves the whole tail; a write that landed first stays
    durable even though the range is reported as resolved rather than
    committed, so live fan-out can miss it until a later catch-up.
  - **Commit is the point of no return.** Once the Committer reports
    `:ok` the range is marked committed and the frontier advanced before
    any other raise-capable step runs. Every caller in the flush then gets
    its success tuple. Dirty tracking, `after_commit`, and cache updates
    follow; if they raise, the data is already durable, so the range is
    not abandoned or re-reported as a hole, the Writer logs, abnormally
    terminates `EbbServer.Storage.SystemCache`, and relies on
    `Storage.Supervisor`'s `rest_for_one` to rebuild the caches, the
    watermark, and this Writer. The success replies for a cache-apply
    failure are sent before that escalation so a durable batch is never
    reported as lost; a post-commit raise leaves the provisional marks
    for `init/1` to settle. A failed or raised commit instead has its
    provisional marks compare-and-cleared before the range is resolved.
  - **Startup reconcile.** `init/1` raises the counter to the durable log
    max and resolves any remaining tail, healing a Writer-only restart
    that crashed between claim and resolve. It also clears
    `EbbServer.Storage.InFlightActions`: the replacement Writer treats every
    surviving id as orphaned because its old pool is gone. A worker that
    was already inside `write_batch` may still land; GSNs are never reused,
    so that write can only fill a range already reported as a hole, never
    collide with a newly claimed range. It also settles any provisional
    mark a crashed Writer left behind: settling is conservative — the
    entity re-materializes and, if nothing was committed, finds no new
    Action and clears.

  A commit that never returns is not handled here: the pool contains
  crashes and returned errors, but no commit watchdog. Admission control and
  the hung-commit policy are tracked separately (#538).

  The test seam is the optional `:commit_fn` (default
  `&RocksDB.write_batch/2`), used for both error injection and crash
  simulation. It runs in the Committer, which reports a raised value back
  instead of crashing, so the pool can report it as a failed range. The optional
  `:after_commit` fun still runs inside the Writer once the Committer
  reports the durable write and before the marks settle, so tests can
  observe the durable-commit window deterministically.

  A bench-only `:ablate` option (default `[]`) skips named phases of the
  write path — `:dedup`, `:group_resolution`, `:build`, `:encode`,
  `:entity_index`, `:group_index`, `:dirty`, `:cache`, `:watermark`,
  `:fanout` — so `mix bench.actions --ablate` can price each one. `:dedup`
  also skips the in-flight claim, which is dedup work. It is never set in
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
    ActionFormat,
    CacheTables,
    CommitPipeline,
    CommitterPool,
    DirtyTracker,
    EntityGroupCache,
    EntityIndex,
    EntityTypeCache,
    Fields,
    GroupCache,
    GsnCounter,
    InFlightActions,
    PreparedAction,
    RelationshipCache,
    RocksDB
  }

  alias EbbServer.Storage.CommitPipeline.Batch

  @type validated_action :: PermissionChecker.validated_action()
  @type validated_update :: PermissionChecker.validated_update()

  # The `:encode` ablation skips the payload encode but must still store a
  # structurally valid record: live readers may run against an ablated bench DB.
  @ablated_payload_etf ActionFormat.encode(
                         ActionFormat.build(%{
                           id: "ablated",
                           actor_id: "ablated",
                           hlc: 0,
                           updates: []
                         })
                       )

  @type cache_mutation ::
          {:entity_type, String.t(), String.t()}
          | {:group_member_put, map()}
          | {:group_member_delete, String.t()}
          | {:entity_group_put, map()}
          | {:entity_group_delete, String.t()}
          | {:relationship_put, map()}
          | {:relationship_delete, String.t()}

  @type pending_marks :: CommitPipeline.pending_marks()

  # A caller's surviving Action plus its position in the coalesced burst. The
  # position is what makes each caller's reply sub-range contiguous.
  @type tagged_action ::
          {caller_idx :: non_neg_integer(), validated_action(), payload_etf :: binary()}

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
          committer_pool: pid() | nil,
          pipeline: CommitPipeline.t(),
          after_commit: (-> any()) | nil,
          batch_max_size: integer(),
          batch_timeout_ms: non_neg_integer(),
          ablate: [atom()],
          flush_timer_ref: reference() | nil,
          fan_out_router: GenServer.name() | nil,
          watermark_tracker: GenServer.name() | nil,
          in_flight_actions: GenServer.name() | nil
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
    :committer_pool,
    :pipeline,
    :after_commit,
    :batch_max_size,
    :batch_timeout_ms,
    :ablate,
    :flush_timer_ref,
    :fan_out_router,
    :watermark_tracker,
    :in_flight_actions
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
    in_flight_actions = Keyword.get(opts, :in_flight_actions, nil)

    # Internal test seam until #533's overlay and #534's full ordered
    # frontier make concurrent claims safe to expose as configuration.
    max_in_flight = Keyword.get(opts, :max_in_flight, 1)

    unless is_integer(max_in_flight) and max_in_flight > 0 do
      raise ArgumentError,
            "Writer max_in_flight must be a positive integer, got: #{inspect(max_in_flight)}"
    end

    pool_size = Keyword.get(opts, :committer_pool_size, max_in_flight)

    # The pool is linked to the Writer and monitors it. An individual
    # Committer death is contained by the pool; a Writer death stops the
    # pool, and any claim still unresolved at the replacement's init is
    # treated as orphaned.
    {:ok, committer_pool} =
      CommitterPool.start_link(
        owner: self(),
        size: pool_size,
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
      committer_pool: committer_pool,
      pipeline: CommitPipeline.new(max_in_flight: max_in_flight),
      after_commit: after_commit,
      batch_max_size: batch_max_size,
      batch_timeout_ms: batch_timeout_ms,
      ablate: ablate,
      flush_timer_ref: nil,
      fan_out_router: fan_out_router,
      watermark_tracker: watermark_tracker,
      in_flight_actions: in_flight_actions
    }

    # Every surviving id is orphaned: the old pool is gone, and a worker
    # still finishing a write cannot claim a new GSN. See the startup
    # reconcile note in the moduledoc.
    if in_flight_actions, do: InFlightActions.clear(in_flight_actions)

    DirtyTracker.settle_all_pending(state.dirty_set)
    reconcile_resolution_frontier(state)

    {:ok, state}
  end

  # A Writer-only restart can leave the counter ahead of the durable log:
  # the crashed writer claimed a range it never committed, and the claim
  # is still counted. The pool is gone by then, so every surviving claim
  # is orphaned; no commit can still be in flight. Reuse of those GSNs is
  # exactly what the resolution frontier prevents, so raise the counter to
  # the durable max and resolve the abandoned tail. Idempotent on a clean
  # boot, where the counter and the frontier already agree.
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
  Writer, and each Action's GSN-free payload is built and ETF-encoded as
  the call arrives, before any GSN is claimed. A flush:
  1. Filters out actions with empty updates, drops duplicate `action_id`s
     (first occurrence wins across the whole coalesced burst), and drops
     ids already committed (`cf_action_dedup`) or still in flight
     (`EbbServer.Storage.InFlightActions`).
  2. Claims one GSN range for the remaining fresh actions.
  3. Prepares one `PreparedAction` per fresh Action (group resolution and
     `update_scopes`), hands the batch to the Committer, and once the
     Committer reports the durable write builds a single WriteBatch across
     the written column families:
     - cf_actions: GSN → ETF wrapper of the pre-encoded payload and its
       per-Update group scopes
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
  # At a pipeline depth above one a marker may still be actionable while
  # another range is committing, so only the depth cap blocks the flush.
  @impl true
  def handle_info(:flush, state) do
    pipeline = CommitPipeline.clear_flush_marker(state.pipeline)
    state = %{state | pipeline: pipeline}

    if CommitPipeline.at_capacity?(pipeline) do
      {:noreply, cancel_flush_timer(state)}
    else
      {:noreply, flush(state)}
    end
  end

  def handle_info({:committer_assigned, ref, worker}, state) do
    case CommitPipeline.assign_owner(state.pipeline, ref, worker) do
      {:ok, _batch, pipeline} ->
        {:noreply, %{state | pipeline: pipeline}}

      {:error, reason} ->
        Logger.warning(
          "Writer ignored committer assignment for #{inspect(ref)}: #{inspect(reason)}"
        )

        {:noreply, state}
    end
  end

  def handle_info({:committer_result, ref, result}, state) do
    if CommitPipeline.committing?(state.pipeline, ref) do
      {:noreply, handle_commit_result(result, ref, state)}
    else
      {:noreply, state}
    end
  end

  defp enqueue(state, from, actions) do
    encoded = Enum.map(actions, &enqueue_action(&1, state))

    %{state | pipeline: CommitPipeline.enqueue(state.pipeline, from, encoded)}
  end

  # The payload is GSN-free, so it is built and ETF-encoded as the call
  # arrives — while the previous commit is still in flight — and never
  # again on the flush proper. `update_scopes` are cache-dependent and are
  # attached after the claim.
  defp enqueue_action(action, state) do
    {action, action |> build_payload(state) |> encode_payload(state)}
  end

  defp build_payload(action, state) do
    if ablate?(:build, state), do: %{}, else: ActionFormat.build(action)
  end

  defp encode_payload(payload, state) do
    if ablate?(:encode, state), do: @ablated_payload_etf, else: ActionFormat.encode(payload)
  end

  # The only place a flush is scheduled. The pipeline depth blocks it;
  # at the V0 depth of one this is the old single-in-flight rule, and at a
  # higher depth calls accumulate only until the next free slot reschedules.
  defp schedule_flush(state) do
    case CommitPipeline.schedule(
           state.pipeline,
           state.batch_max_size,
           state.batch_timeout_ms
         ) do
      {:flush, pipeline} ->
        flush(%{state | pipeline: pipeline})

      {:send_flush, pipeline} ->
        # Burst-drain: the marker lands at the TAIL of the mailbox, after
        # every write_actions call already queued, so it flushes the current
        # burst and adds only a mailbox hop when nothing else is waiting. One
        # marker per burst is enough; the rest of the burst enqueues behind it.
        send(self(), :flush)
        %{state | pipeline: pipeline}

      {:schedule_timer, pipeline} ->
        timer = Process.send_after(self(), :flush, state.batch_timeout_ms)
        %{state | pipeline: pipeline, flush_timer_ref: timer}

      {status, pipeline} when status in [:wait, :idle] ->
        %{state | pipeline: pipeline}
    end
  end

  # The single place that claims a GSN range and hands it to the
  # Committer. A stale marker or timer must be a no-op when nothing is
  # pending; the replies wait for the ack.
  defp flush(state) do
    state = cancel_flush_timer(state)
    {pipeline, pending} = CommitPipeline.take_pending(state.pipeline)
    state = %{state | pipeline: pipeline}

    {fresh, fresh_tagged} = plan(pending, state)

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
    ref = make_ref()

    batch = %Batch{
      ref: ref,
      gsn_start: gsn_start,
      gsn_end: gsn_end,
      action_ids: action_ids(fresh),
      pending: pending,
      ranges: ranges,
      started_at: started_at,
      batch_size: length(fresh)
    }

    {:ok, _batch, pipeline} = CommitPipeline.claim(state.pipeline, batch)
    state = %{state | pipeline: pipeline}

    {prepared, groups_by_gsn} =
      prepare_or_abandon(fresh, ref, gsn_start, gsn_end, started_at, state)

    pending_marks = pending_marks(prepared, state)

    {:ok, _batch, pipeline} =
      CommitPipeline.prepared(
        state.pipeline,
        ref,
        prepared,
        groups_by_gsn,
        pending_marks
      )

    {:ok, _batch, pipeline} = CommitPipeline.committing(pipeline, ref)
    state = %{state | pipeline: pipeline}

    CommitterPool.commit(state.committer_pool, ref, prepared, gsn_start, gsn_end)
    state
  end

  # Group resolution reads the system caches, so it stays on the
  # sequencer. A raise here is still a claimed-but-uncommitted range: the
  # abandon (release the ids, clear marks, resolve, log, nudge) runs before
  # the re-raise, exactly like the failure paths after the ack.
  defp prepare_or_abandon(fresh, ref, gsn_start, gsn_end, started_at, state) do
    # credo:disable-for-next-line /Check\.Readability\.PreferImplicitTry/
    try do
      prepare(fresh, gsn_start, state)
    rescue
      error ->
        emit_batch_latency(gsn_start, gsn_end, started_at)
        abandon(state, ref, error)
        reraise error, __STACKTRACE__
    catch
      kind, value ->
        emit_batch_latency(gsn_start, gsn_end, started_at)
        abandon(state, ref, {kind, value})
        :erlang.raise(kind, value, __STACKTRACE__)
    end
  end

  defp action_ids(actions), do: Enum.map(actions, &action_id/1)

  defp action_id({action, _payload_etf}), do: action.id
  defp action_id(action), do: action.id

  defp emit_actions_accepted(count) do
    Telemetry.execute([:writer, :actions_per_sec], %{count: count}, %{})
  end

  defp emit_batch_latency(%Batch{} = batch) do
    emit_batch_latency(batch.gsn_start, batch.gsn_end, batch.started_at)
  end

  defp emit_batch_latency(gsn_start, gsn_end, started_at) do
    Telemetry.execute(
      [:writer, :batch_latency_ms],
      %{duration: System.monotonic_time() - started_at},
      %{gsn_start: gsn_start, gsn_end: gsn_end}
    )
  end

  defp handle_commit_result(:ok, ref, state) do
    {:ok, batch, pipeline} = CommitPipeline.committed(state.pipeline, ref)
    state = %{state | pipeline: pipeline}

    # The durable dedup row now exists for every Action in the batch, so
    # the commit marker takes over from the concurrency guard.
    release_in_flight(state, batch.action_ids)

    case mark_committed_result(batch, state) do
      :ok ->
        case drain_releasable(state) do
          {:ok, state} -> schedule_flush(state)
          {:escalated, state} -> state
        end

      {:raised, kind, value, stacktrace} ->
        emit_batch_latency(batch)

        abandon(state, ref, raised_reason(kind, value))

        :erlang.raise(kind, value, stacktrace)
    end
  end

  defp handle_commit_result({:error, reason}, ref, state) do
    fail_range(ref, reason, state)
  end

  # A Committer-side raise or crash is a failed range, not a reason to
  # take the Writer (and every other in-flight range) down. The pool turns
  # a process death into `{:crashed, reason}`; a `commit_fn` raise arrives
  # as `{:raised, ...}`. Both abandon only their own range and reply the
  # same `503 write_failed` contract as a returned error.
  defp handle_commit_result({:raised, kind, value, stacktrace}, ref, state) do
    reason = {:committer_raised, raised_reason(kind, value)}

    case CommitPipeline.get(state.pipeline, ref) do
      %Batch{} = batch ->
        Logger.error(
          "Committer raised for GSN range #{batch.gsn_start}..#{batch.gsn_end}: " <>
            Exception.format(kind, value, stacktrace)
        )

      nil ->
        :ok
    end

    fail_range(ref, reason, state)
  end

  defp handle_commit_result({:crashed, reason}, ref, state) do
    fail_range(ref, {:committer_crashed, reason}, state)
  end

  defp fail_range(ref, reason, state) do
    batch = CommitPipeline.get(state.pipeline, ref)

    Telemetry.execute(
      [:writer, :commit_failed],
      %{count: 1},
      %{gsn_start: batch.gsn_start, gsn_end: batch.gsn_end, reason: reason}
    )

    state = abandon(state, ref, reason)

    emit_batch_latency(batch)
    reply_all(batch.pending, batch.ranges, {:error, reason})

    case drain_releasable(state) do
      {:ok, state} -> schedule_flush(state)
      {:escalated, state} -> state
    end
  end

  # The ordered apply/notify stage. Commit acks may arrive in any order,
  # but `CommitPipeline.releasable/1` only returns the committed prefix, so
  # a later range never overtakes an earlier one. Abandoned ranges were
  # pruned, which is what lets the healthy range behind a failed one drain.
  defp drain_releasable(state) do
    case CommitPipeline.releasable(state.pipeline) do
      [] ->
        {:ok, state}

      [batch | _] ->
        apply_one(batch, state)
    end
  end

  defp apply_one(batch, state) do
    committed_at = System.monotonic_time()
    {:ok, _batch, pipeline} = CommitPipeline.applying(state.pipeline, batch.ref)
    state = %{state | pipeline: pipeline}

    case settle_after_commit(batch, state, committed_at) do
      :ok ->
        {:ok, _batch, pipeline} = CommitPipeline.release(state.pipeline, batch.ref)
        drain_releasable(%{state | pipeline: pipeline})

      # The cache apply failed and the fan-out range was never pushed. Leave
      # the batch unreleased so a rebuilt Writer cannot let a later range
      # overtake it; the escalation restarts the storage tree and init/1
      # reconciles the durable frontier.
      :escalated ->
        {:escalated, state}
    end
  end

  defp raised_reason(:error, value), do: value
  defp raised_reason(kind, value), do: {kind, value}

  # Marking the range committed is the point of no return: it must run
  # before `after_commit`, apply, or notify, so a later raise cannot be
  # mistaken for a failed commit. A failure here still leaves the range
  # unresolved, so it takes the abandon path.
  defp mark_committed_result(batch, state) do
    unless ablate?(:watermark, state),
      do: mark_committed(state, batch.gsn_start, batch.gsn_end)

    :ok
  catch
    kind, value -> {:raised, kind, value, __STACKTRACE__}
  end

  # Everything after the durable mark: any raise here is a post-commit
  # failure. The range stays committed and its provisional marks are left
  # for the restarted Writer to settle, so the batch is never reported as
  # abandoned. Latency is emitted before the re-raise so the sample is not
  # swallowed.
  defp settle_after_commit(batch, state, committed_at) do
    # credo:disable-for-next-line /Check\.Readability\.PreferImplicitTry/
    try do
      if state.after_commit, do: state.after_commit.()

      case apply_post_commit(batch.prepared, batch.pending_marks, state) do
        :ok ->
          notify_fanout(
            state,
            batch.gsn_start,
            batch.gsn_end,
            batch.groups_by_gsn,
            committed_at
          )

          emit_batch_latency(batch)
          emit_actions_accepted(batch.batch_size)
          reply_all(batch.pending, batch.ranges, :ok)
          :ok

        {:error, reason} ->
          # The batch is durable: reply success to every caller first,
          # then escalate, so no caller sees a lost success when the
          # rebuild tears this process down.
          emit_batch_latency(batch)
          emit_actions_accepted(batch.batch_size)
          reply_all(batch.pending, batch.ranges, :ok)
          escalate_cache_failure(batch.gsn_start, batch.gsn_end, reason)
          :escalated
      end
    rescue
      error ->
        emit_batch_latency(batch)
        log_post_commit_failure(batch, error)
        reraise error, __STACKTRACE__
    catch
      kind, value ->
        emit_batch_latency(batch)
        log_post_commit_failure(batch, {kind, value})
        :erlang.raise(kind, value, __STACKTRACE__)
    end
  end

  defp log_post_commit_failure(batch, reason) do
    Logger.error(
      "Writer committed GSN range #{batch.gsn_start}..#{batch.gsn_end} " <>
        "but a post-commit step failed (#{inspect(reason)}); the range stays committed"
    )
  end

  # Arrival order is the caller's position in `pending`; a caller's
  # surviving Actions are contiguous in the global fresh list, so one
  # `{first, last}` per caller is exact.
  @spec plan([CommitPipeline.pending_call()], t()) ::
          {[CommitPipeline.enqueued_action()], [tagged_action()]}
  defp plan(pending, state) do
    tagged =
      pending
      |> Enum.with_index()
      |> Enum.flat_map(fn {{_from, actions}, caller_idx} ->
        actions
        |> Enum.reject(fn {action, _payload_etf} -> action.updates == [] end)
        |> Enum.map(fn {action, payload_etf} -> {caller_idx, action, payload_etf} end)
      end)
      |> Enum.uniq_by(fn {_caller_idx, action, _payload_etf} -> action.id end)

    fresh_tagged =
      if ablate?(:dedup, state) do
        tagged
      else
        tagged
        |> drop_committed(state.rocks_name)
        |> claim_in_flight(state)
      end

    fresh =
      Enum.map(fresh_tagged, fn {_caller_idx, action, payload_etf} ->
        {action, payload_etf}
      end)

    {fresh, fresh_tagged}
  end

  # Claims the burst's ids before `flush/1` claims a GSN range, so a retry
  # that arrives while its first copy is still in flight is dropped instead
  # of committing a second copy. The losers are the ids another in-flight
  # batch owns; their callers get the empty success tuple, not a rejection.
  @spec claim_in_flight([tagged_action()], t()) :: [tagged_action()]
  defp claim_in_flight(tagged, %{in_flight_actions: nil}), do: tagged

  defp claim_in_flight(tagged, state) do
    ids = tagged |> Enum.map(&elem(&1, 1)) |> action_ids()
    {claimed, _in_flight} = InFlightActions.claim(ids, state.in_flight_actions)
    claimed = MapSet.new(claimed)

    Enum.filter(tagged, fn {_caller_idx, action, _payload_etf} ->
      MapSet.member?(claimed, action.id)
    end)
  end

  @spec caller_ranges([tagged_action()], non_neg_integer(), non_neg_integer()) ::
          %{optional(non_neg_integer()) => CommitPipeline.gsn_range()}
  defp caller_ranges(fresh_tagged, caller_count, gsn_start) do
    ranges =
      fresh_tagged
      |> Enum.with_index()
      |> Enum.reduce(%{}, fn {{caller_idx, _action, _payload_etf}, i}, acc ->
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

  defp cancel_flush_timer(state) do
    if state.flush_timer_ref, do: Process.cancel_timer(state.flush_timer_ref)

    %{state | flush_timer_ref: nil, pipeline: CommitPipeline.clear_timer(state.pipeline)}
  end

  # `cf_action_dedup` doubles as the commit marker: the index entry and
  # the `cf_actions` record land in the same atomic `write_batch`, so an
  # entry can only exist for a durable Action. A retried Action that
  # already has one must not claim a GSN or append a second log record.
  # Pairing results with ids (not actions) means a short `multi_get`
  # reply keeps the unmatched Actions rather than dropping them.
  @spec drop_committed([tagged_action()], GenServer.name()) :: [tagged_action()]
  defp drop_committed([], _rocks_name), do: []

  defp drop_committed(tagged, rocks_name) do
    ids = Enum.map(tagged, fn {_caller_idx, action, _payload_etf} -> action.id end)

    committed =
      RocksDB.multi_get(RocksDB.cf_action_dedup(rocks_name), ids, name: rocks_name)
      |> Enum.zip(ids)
      |> Enum.flat_map(fn
        {{:ok, _gsn}, id} -> [id]
        {:not_found, _id} -> []
      end)
      |> MapSet.new()

    Enum.reject(tagged, fn {_caller_idx, action, _payload_etf} ->
      MapSet.member?(committed, action.id)
    end)
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
      |> Enum.map_reduce({%{}, %{}}, fn {{action, payload_etf}, gsn}, {groups, memo} ->
        {prepared_action, memo} =
          prepare_action(action, payload_etf, state, resolve_opts, memo)

        {prepared_action, {Map.put(groups, gsn, prepared_action.groups), memo}}
      end)

    {prepared, groups_by_gsn}
  end

  defp prepare_action(action, payload_etf, state, resolve_opts, memo) do
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
      payload_etf: payload_etf,
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

  defp abandon(state, ref, reason) do
    case CommitPipeline.abandon(state.pipeline, ref, reason) do
      {:ok, batch, pipeline} ->
        state = %{state | pipeline: pipeline}

        release_in_flight(state, batch.action_ids)

        unless ablate?(:dirty, state), do: clear_pending(state, batch.pending_marks)

        # Resolve before nudging so the router can only observe the advanced
        # frontier.
        unless ablate?(:watermark, state),
          do: resolve_range(state, batch.gsn_start, batch.gsn_end)

        Telemetry.execute(
          [:writer, :range_resolved],
          %{count: 1},
          %{gsn_start: batch.gsn_start, gsn_end: batch.gsn_end, reason: reason}
        )

        Logger.error(
          "Writer abandoned GSN range #{batch.gsn_start}..#{batch.gsn_end} " <>
            "without committing it: " <> inspect(reason)
        )

        notify_range_resolved(state, batch.gsn_start, batch.gsn_end)

        state

      {:error, _reason} ->
        # A stale result for a batch this Writer already abandoned must not
        # resolve or reply twice.
        state
    end
  end

  # Idempotent: a failed commit and a post-ack raise can both reach the
  # abandon path, and releasing an id twice must not reopen another
  # batch's claim.
  defp release_in_flight(%{in_flight_actions: nil}, _claimed_ids), do: :ok

  defp release_in_flight(state, claimed_ids) do
    InFlightActions.release(claimed_ids, state.in_flight_actions)
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
