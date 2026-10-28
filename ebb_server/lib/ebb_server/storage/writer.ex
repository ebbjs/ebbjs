defmodule EbbServer.Storage.Writer do
  @moduledoc """
  The single serialization point for the storage layer: every committed
  Action goes through this GenServer, which sequences its durable write to
  RocksDB before its GSN is returned to the caller.

  ## Why a single Writer

  The Writer serializes claims and keeps each Writer's GSNs monotonic.
  GSN ranges are claimed atomically from `GsnCounter` via `:atomics`,
  but the final commit only happens here, so the order the log is
  written and the order `FanOutRouter` is notified are the same.

  1. **Serialized claims.** Every committed batch is assigned its GSN
     range in one process, so concurrent writers cannot interleave
     claims and their fan-out in different orders.
  2. **Per-Writer GSN-monotonicity.** Multi-Writer pipelining is possible
     (the benchmark hit ~108k/s — see #130), but a second claim owner is
     parked, not scheduled: #287 records the claim-ownership and
     orphan-vs-in-flight reconcile it would need, and epic #529 keeps one
     claim owner as a fixed constraint. At the default
     `:writer_max_in_flight` of 1 the Writer never issues two batches
     concurrently, so `enable_pipelined_write: true` is dormant.

  The on-disk Action log is **not** gap-free. The watermark is a
  *resolution frontier* — committed ∪ deliberately abandoned — so a
  failed commit leaves a permanent hole in the log. Catch-up and fan-out
  gate on that frontier, not on gap-free density: `FanOutRouter` pushes a
  buffered range once the frontier has passed its end, and an abandoned
  GSN simply has no durable Action to read. Permanent holes are fine;
  liveness is the hard invariant.

  ## Batch coalescing

  `write_actions/2` does not commit inline. `handle_call/3` hands the
  caller's Actions to the Prepare pool; when their payloads are ready and
  every earlier call has resolved, the call enters the pipeline and either
  flushes immediately (once the pending Action count reaches
  `:writer_batch_max_size`) or schedules a flush. With the default
  `:writer_batch_timeout_ms` of 0 the Writer burst-drains:
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

  ## Sequencer, Prepare pool, and Committer pool

  The flush is split across processes. This GenServer is the
  **sequencer**: it owns everything that needs the live caches or the
  resolution frontier — coalescing, dedup, the GSN claim, group resolution
  and `update_scopes`, the provisional dirty marks, apply, the watermark,
  the fan-out notification, and every reply. The linked
  `EbbServer.Storage.PreparePool` owns the GSN-free, cache-free payload
  build and ETF encode, so that work runs as calls arrive without blocking
  the sequencer. The linked `EbbServer.Storage.CommitterPool` owns the
  parts that only need immutable input: frame encode, `cf_*` op
  assembly, and the durable `write_batch/2`.

  A call's payloads are prepared before it enters the pipeline. Arrival
  order is fixed when the call reaches this process; a call is only
  enqueued once every earlier call has been prepared or failed, so the
  Prepare pool can finish later calls early without reordering claims.

  The prepare queue is bounded by calls, not Actions. A full queue replies
  `{:error, {:prepare_queue_full, max}}`; a job that exceeds its timeout
  replies `{:error, {:prepare_failed, {:timeout, ms}}}`. Neither claims a
  GSN, so an uncommitted call is never acked and the client outbox retries
  it. The pool size, queue bound, and timeout are the
  `:prepare_pool_size`, `:prepare_queue_max`, and `:prepare_timeout_ms`
  Writer options; `:writer_prepare_pool_size`,
  `:writer_prepare_queue_max`, and `:writer_prepare_timeout_ms` are the
  matching application env keys.

  The hand-off is one `EbbServer.Storage.PreparedAction` per Action plus
  the claimed range. The sequencer sends it asynchronously and the pool
  answers with `{:committer_assigned, ref, worker}` followed by
  `{:committer_result, ref, result}`. The Writer keeps one range in
  flight by default. Raising `:max_in_flight` (or `:writer_max_in_flight`)
  lets a successor be resolved against the predecessor's planned cache
  overlay while that predecessor commits. A predecessor that planned a
  membership or relationship move holds the successor at the gate until it
  is durable, so its abandon rebuilds the chain instead of letting stale
  scopes reach a durable range. Fan-out still follows claim order at any
  depth because the release stage notifies only the committed prefix.

  The pool is not shared across Writer restarts. The Prepare and
  Committer pools are linked to the Writer and monitor it, so a Writer
  death sends shutdown to both. That shutdown is best-effort: a worker
  already inside `write_batch` can finish after its owner exits. Any claim
  still unresolved when the replacement Writer boots is therefore treated
  as orphaned and resolved as a hole. GSNs are never reused, so a late
  durable write can only fill a range the new Writer already reported
  resolved; readers still see it in the log, but live fan-out can miss it
  until a later catch-up. The `InFlightActions.clear/1` call in `init/1` is
  safe for the same reason:
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
  healthy range behind it drain. The buffer is emitted as
  `[:ebb, :writer, :in_flight_batches]` and
  `[:ebb, :writer, :oldest_unreleased_gsn]` whenever a claim enters or
  leaves it. Each prepared `Batch` carries the slice
  of the cross-flush cache overlay it planned; the Writer merges the open
  slices to resolve the next batch, and an abandon rebuilds every successor
  that resolved against the failed slice.

  While an ack is outstanding the sequencer keeps accepting
  `write_actions/2` calls, so the next burst drains and coalesces behind
  the durable write instead of queueing in the caller. Those calls are
  enqueued and their payloads built and ETF-encoded — work that needs no
  GSN, so it overlaps the in-flight commit. At the ack the sequencer
  runs the `:after_commit` seam, marks the range committed, then drains
  every releasable range in claim order: settle the dirty marks and cache
  mutations, stamp the commit time at the end of that apply, notify
  `FanOutRouter`, reply to each caller, and release. It then starts the
  next flush by the same rules as
  a fresh call.

  ## Hot path

  Each call's payload is built and ETF-encoded in the Prepare pool as it
  arrives, before any GSN is claimed. `flush/1` then claims a GSN range for
  the prepared prefix of the coalesced burst, resolves the
  `cf_group_actions` index via intra-action context (see below), marks the
  affected entities provisionally dirty, and hands the prepared batch to
  the Committer. Once the ack lands the sequencer
  settles the marks, advances the watermark, and notifies `FanOutRouter`.
  The notification carries the per-Action group set this pass resolved and
  the batch's already-encoded payload plus scopes pairs in claim order, so
  live fan-out indexes the same snapshot `cf_group_actions` was built from
  rather than re-deriving groups after the system caches have moved, and it
  dispatches without re-reading `cf_actions`. The payload binaries are
  refc-shared across processes, so the hand-off adds a list, not a copy.

  Redundant index writes are dropped during op construction: the
  `cf_type_entities` key has no GSN component, so it is collected as a
  per-flush set and written once per unique `(subject_type, subject_id)`.
  `cf_entity_actions` is coalesced per subject across the whole flush: one
  row keyed at the subject's highest GSN, holding that subject's sorted GSN
  list, however many Updates or Actions touched it. `cf_group_actions` is
  emitted once per Action from the union of resolved group ids.

  Every resolved per-Update scope is also persisted as the scopes half of
  the stored `cf_actions` frame: one group list per Update,
  index-aligned with the payload's Updates. Fan-out and catch-up filter
  an Action by those scopes so each Update is delivered only to the groups
  it belongs to. The scopes cannot be re-derived later (a
  `relationship`/`entityGroup` delete's by-id cache entry is gone by
  then), so this snapshot is the delivery contract.

  System-cache writes are deduplicated the same way. The pre-commit pass
  hands the flush's flattened Updates to
  `EbbServer.Storage.CacheMutationPlanner`, which drops a mutation
  identical to the previous one for the same `{cache, key}` and returns
  the survivors alongside an overlay of the rows the flush itself has
  computed, so a later patch merges over an earlier put — or sees an
  earlier delete — instead of reading the pre-flush cache. The planner is
  pure and writes no cache; this Writer applies its mutations once the
  range is durable. The batch keeps only its own slice of that overlay, so
  releasing it drops exactly its effects from the chain.

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
  load-bearing when `:max_in_flight` is raised (a prepared successor or the
  bench) or concurrent sub-batches (#536) land, where a failed owner would
  leave the duplicate already acked empty.

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
  instead of crashing, so the pool can report it as a failed range. The
  optional `:prepare_fn` seam replaces the default build and encode in a
  prepare worker, for slow, dead, or raising prepare paths. The optional
  `:after_commit` fun still runs inside the Writer once the Committer
  reports the durable write and before the marks settle, so tests can
  observe the durable-commit window deterministically.

  A bench-only `:ablate` option (default `[]`) skips named phases of the
  write path — `:dedup`, `:group_resolution`, `:build`, `:encode`,
  `:entity_actions`, `:type_entities`, `:group_index`, `:dirty`, `:cache`,
  `:watermark`, `:fanout` — so `mix bench.actions --ablate` can price each
  one. `:entity_index` remains the combined alias that drops both entity
  index halves. `:dedup` also skips the in-flight claim, which is dedup work.
  It is never set in production, and an empty list emits exactly the same ops
  as before. See `EbbServer.Bench.Options`.

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
    CacheMutationPlanner,
    CacheTables,
    CommitPipeline,
    Committer,
    CommitterPool,
    DirtyTracker,
    EntityGroupCache,
    EntityIndex,
    EntityTypeCache,
    GroupCache,
    GsnCounter,
    InFlightActions,
    PreparedAction,
    PreparePool,
    Preparer,
    RelationshipCache,
    RocksDB
  }

  alias EbbServer.Storage.CommitPipeline.Batch

  @type validated_action :: PermissionChecker.validated_action()
  @type validated_update :: PermissionChecker.validated_update()

  @type pending_marks :: CommitPipeline.pending_marks()

  # A prepare job waits for the pool, then for every earlier call to
  # resolve. The queue bound is calls, not Actions, so a burst of large
  # batched calls cannot grow the Writer's held state without limit.
  @type prepare :: %{
          pool: pid() | nil,
          fn: (map() -> binary()) | nil,
          timeout_ms: pos_integer(),
          queue_max: pos_integer()
        }

  @default_prepare_pool_size 2
  @default_prepare_queue_max 1_024
  @default_prepare_timeout_ms 2_000

  # The overlay chain is bounded to keep its memory and rebuild cost small.
  @max_overlay_chain 4

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
          prepare: prepare(),
          next_call_seq: non_neg_integer(),
          next_enqueue_seq: non_neg_integer(),
          burst_max_seq: non_neg_integer() | nil,
          prepare_flush_scheduled: boolean(),
          prepare_timer_ref: reference() | nil,
          preparing: map(),
          prepared: map(),
          timings: %{
            arrivals: %{optional(GenServer.from()) => arrival()},
            ranges: %{optional(reference()) => range_timing()}
          },
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
    :prepare,
    :next_call_seq,
    :next_enqueue_seq,
    :burst_max_seq,
    :prepare_flush_scheduled,
    :prepare_timer_ref,
    :preparing,
    :prepared,
    :committer_pool,
    :commit_opts,
    :pipeline,
    :after_commit,
    :batch_max_size,
    :batch_timeout_ms,
    :ablate,
    :flush_timer_ref,
    :fan_out_router,
    :watermark_tracker,
    :in_flight_actions,
    timings: %{arrivals: %{}, ranges: %{}}
  ]

  # A call's arrival stamps, keyed by its `GenServer.from()`, so the flush can
  # attribute one range's queue and prepare phases to its oldest call. Dropped
  # when the call is flushed or fails its prepare.
  @type arrival :: %{
          sent_at: integer(),
          dequeued_at: integer(),
          ready_at: integer() | nil
        }

  # One claimed range's phase boundaries. Every field after `gsn_end` is a
  # `System.monotonic_time()` stamp, `nil` until the phase is reached; a phase
  # whose end stamp is `nil` is emitted as `0`.
  @type range_timing :: %{
          gsn_start: non_neg_integer(),
          gsn_end: non_neg_integer(),
          sent_at: integer() | nil,
          dequeued_at: integer() | nil,
          ready_at: integer() | nil,
          flush_at: integer(),
          resolve_at: integer() | nil,
          ack_at: integer() | nil,
          apply_at: integer() | nil,
          notify_at: integer() | nil
        }

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, opts, name: name)
  end

  @type rejected_action :: %{action: validated_action(), reason: String.t()}
  @type write_result :: {:ok, {non_neg_integer(), non_neg_integer()}, [rejected_action()]}

  @spec write_actions([validated_action()], GenServer.name()) :: write_result() | {:error, term()}
  def write_actions(actions, name \\ __MODULE__) do
    # The queue phase starts here, before the message reaches the mailbox.
    sent_at = System.monotonic_time()
    GenServer.call(name, {:write_actions, actions, sent_at})
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

    # A successor may be prepared ahead of its predecessor's durable commit,
    # so the chain is capped to keep the overlay bounded. The ordered release
    # stage keeps fan-out in claim order at any depth.
    max_in_flight =
      Keyword.get(
        opts,
        :max_in_flight,
        Application.get_env(:ebb_server, :writer_max_in_flight, 1)
      )

    unless is_integer(max_in_flight) and max_in_flight in 1..@max_overlay_chain do
      raise ArgumentError,
            "Writer max_in_flight must be an integer in 1..#{@max_overlay_chain}, " <>
              "got: #{inspect(max_in_flight)}"
    end

    pool_size = Keyword.get(opts, :committer_pool_size, max_in_flight)

    prepare_pool_size =
      Keyword.get(
        opts,
        :prepare_pool_size,
        Application.get_env(
          :ebb_server,
          :writer_prepare_pool_size,
          @default_prepare_pool_size
        )
      )

    prepare_queue_max =
      Keyword.get(
        opts,
        :prepare_queue_max,
        Application.get_env(
          :ebb_server,
          :writer_prepare_queue_max,
          @default_prepare_queue_max
        )
      )

    prepare_timeout_ms =
      Keyword.get(
        opts,
        :prepare_timeout_ms,
        Application.get_env(
          :ebb_server,
          :writer_prepare_timeout_ms,
          @default_prepare_timeout_ms
        )
      )

    prepare_fn = Keyword.get(opts, :prepare_fn)

    validate_prepare_opts!(prepare_pool_size, prepare_queue_max, prepare_timeout_ms)

    # The prepare pool is linked to the Writer and monitors it, so a Writer
    # restart takes the workers with it. It owns no ordering state: the
    # Writer fixes arrival order before dispatching a job.
    {:ok, prepare_pool} =
      PreparePool.start_link(
        owner: self(),
        size: prepare_pool_size,
        ablate: ablate,
        prepare_fn: prepare_fn
      )

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
      prepare: %{
        pool: prepare_pool,
        fn: prepare_fn,
        timeout_ms: prepare_timeout_ms,
        queue_max: prepare_queue_max
      },
      next_call_seq: 0,
      next_enqueue_seq: 0,
      burst_max_seq: nil,
      prepare_flush_scheduled: false,
      prepare_timer_ref: nil,
      preparing: %{},
      prepared: %{},
      committer_pool: committer_pool,
      commit_opts: [rocks_name: rocks_name, commit_fn: commit_fn, ablate: ablate],
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
  Writer. Each call's GSN-free, cache-free payloads are built and
  ETF-encoded in the Prepare pool as the call arrives, before any GSN is
  claimed; the call enters the pipeline in arrival order once its payloads
  are ready. A flush:
  1. Filters out actions with empty updates, drops duplicate `action_id`s
     (first occurrence wins across the whole coalesced burst), and drops
     ids already committed (`cf_action_dedup`) or still in flight
     (`EbbServer.Storage.InFlightActions`).
  2. Claims one GSN range for the remaining fresh actions.
  3. Prepares one `PreparedAction` per fresh Action (group resolution and
     `update_scopes`), hands the batch to the Committer, and once the
     Committer reports the durable write builds a single WriteBatch across
     the written column families:
     - cf_actions: GSN → frame of the pre-encoded payload and its
       per-Update group scopes
     - cf_action_dedup: action_id → GSN (duplicate detection)
     - cf_entity_actions: (subject_id, max GSN in this flush) → the
       subject's sorted GSN list for the flush (materialization index)
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
  def handle_call({:write_actions, actions, sent_at}, from, state)
      when is_list(actions) and is_integer(sent_at) do
    handle_write_actions(actions, from, sent_at, state)
  end

  defp handle_write_actions([], _from, _sent_at, state) do
    {:reply, {:ok, {0, 0}, []}, state}
  end

  defp handle_write_actions(actions, from, sent_at, state) do
    cond do
      prepare_queue_full?(state) ->
        {:reply, {:error, {:prepare_queue_full, state.prepare.queue_max}}, state}

      inline_prepare?(state) ->
        {:noreply, prepare_inline(record_arrival(state, from, sent_at), from, actions)}

      true ->
        state = state |> record_arrival(from, sent_at) |> dispatch_prepare(from, actions)
        {:noreply, maybe_schedule_prepare_flush(state)}
    end
  end

  # A result for a timed-out job is stale: the caller already has its
  # error and the slot is free, so it must not enqueue or reply twice.
  def handle_info({:prepare_result, ref, result}, state) do
    case Map.pop(state.preparing, ref) do
      {nil, _preparing} ->
        {:noreply, state}

      {job, preparing} ->
        cancel_prepare_timer(job.timer)
        state = %{state | preparing: preparing}
        {:noreply, complete_prepare(state, job, result)}
    end
  end

  def handle_info({:prepare_timeout, ref}, state) do
    case Map.pop(state.preparing, ref) do
      {nil, _preparing} ->
        {:noreply, state}

      {job, preparing} ->
        state = %{state | preparing: preparing}
        PreparePool.abandon(state.prepare.pool, ref)

        # The slow call never claimed a GSN, so its seq is a hole the
        # pipeline skips rather than a range to resolve.
        {:noreply, fail_prepare(state, job, {:timeout, state.prepare.timeout_ms})}
    end
  end

  # The marker is the prepare-stage burst boundary. It lands after every
  # `write_actions` call already in the mailbox, so the snapshot below is
  # exactly the set of calls the pre-prepare Writer would have coalesced.
  # Calls that arrive later get a higher seq and wait for the next burst.
  def handle_info(:prepare_flush, state) do
    state = clear_prepare_flush(state)

    cond do
      state.burst_max_seq != nil ->
        # A burst is still draining; the next marker is scheduled when it
        # finishes, so this one has nothing to snapshot.
        {:noreply, state}

      state.next_call_seq == 0 ->
        {:noreply, state}

      true ->
        state = %{state | burst_max_seq: state.next_call_seq - 1}
        {:noreply, advance_burst(state)}
    end
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

  # With nothing else in flight there is no work for the pool to overlap, so
  # the round trip is pure latency on the caller's key path. Preparing here
  # keeps the guarantee that matters (no GSN is claimed before the payload
  # exists) and costs nothing when the Writer is busy.
  defp inline_prepare?(state) do
    map_size(state.preparing) == 0 and
      map_size(state.prepared) == 0 and
      state.burst_max_seq == nil and
      CommitPipeline.pending_count(state.pipeline) == 0 and
      CommitPipeline.idle?(state.pipeline)
  end

  # The payload is built here, but arrival order and the coalescing window are
  # unchanged: the result lands in `prepared` and the marker drains it like a
  # pooled result would. A burst that arrives on an idle Writer therefore
  # still coalesces into one flush.
  defp prepare_inline(state, from, actions) do
    seq = state.next_call_seq
    started_at = System.monotonic_time(:microsecond)

    payload_etfs =
      actions
      |> Enum.map(&prepare_input/1)
      |> Preparer.build(prepare_fn: state.prepare.fn, ablate: state.ablate)

    ready_at = System.monotonic_time()
    state = %{state | next_call_seq: seq + 1}

    cond do
      length(payload_etfs) != length(actions) ->
        fail_inline_prepare(
          state,
          from,
          seq,
          {:payload_count_mismatch, length(actions), length(payload_etfs)}
        )

      prepare_elapsed_ms(started_at) > state.prepare.timeout_ms ->
        fail_inline_prepare(state, from, seq, {:timeout, state.prepare.timeout_ms})

      true ->
        encoded = Enum.zip(actions, payload_etfs)

        state
        |> mark_payload_ready(from, ready_at)
        |> Map.put(:prepared, Map.put(state.prepared, seq, {:ready, from, encoded}))
        |> maybe_schedule_prepare_flush()
    end
  end

  defp fail_inline_prepare(state, from, seq, reason) do
    GenServer.reply(from, {:error, {:prepare_failed, reason}})

    # A failed call never claimed a GSN, so its seq is a hole to skip and its
    # arrival stamps are no longer attributable to any range.
    state
    |> drop_arrival(from)
    |> Map.put(:prepared, Map.put(state.prepared, seq, :skipped))
    |> maybe_schedule_prepare_flush()
  end

  defp prepare_elapsed_ms(started_at) do
    System.convert_time_unit(
      System.monotonic_time(:microsecond) - started_at,
      :microsecond,
      :millisecond
    )
  end

  # Arrival order is fixed here, before the pool sees the Actions. The
  # pool may finish a later call first; only the snapshot burst prefix is
  # drained, so it cannot reorder claims.
  defp dispatch_prepare(state, from, actions) do
    seq = state.next_call_seq
    ref = make_ref()
    timer = Process.send_after(self(), {:prepare_timeout, ref}, state.prepare.timeout_ms)

    PreparePool.prepare(state.prepare.pool, ref, Enum.map(actions, &prepare_input/1))

    %{
      state
      | next_call_seq: seq + 1,
        preparing:
          Map.put(state.preparing, ref, %{
            seq: seq,
            from: from,
            actions: actions,
            timer: timer
          })
    }
  end

  # The prepare contract is GSN-free and cache-free, so only the payload
  # fields cross the process boundary.
  defp prepare_input(action) do
    %{id: action.id, actor_id: action.actor_id, hlc: action.hlc, updates: action.updates}
  end

  defp complete_prepare(state, job, {:ok, payload_etfs}) when is_list(payload_etfs) do
    if length(payload_etfs) == length(job.actions) do
      encoded = Enum.zip(job.actions, payload_etfs)

      state
      |> mark_payload_ready(job.from)
      |> Map.put(:prepared, Map.put(state.prepared, job.seq, {:ready, job.from, encoded}))
      |> advance_burst()
    else
      fail_prepare(
        state,
        job,
        {:payload_count_mismatch, length(job.actions), length(payload_etfs)}
      )
    end
  end

  # A payload build raise was a Writer crash before the prepare stage and
  # stays one: it is invalid input that validation should have rejected,
  # not a worker failure. Worker deaths arrive as `{:crashed, reason}` and
  # are failed per call instead.
  defp complete_prepare(_state, _job, {:error, {:raised, error, stacktrace}}) do
    :erlang.raise(:error, error, stacktrace)
  end

  defp complete_prepare(state, job, {:error, reason}), do: fail_prepare(state, job, reason)

  defp complete_prepare(state, job, other),
    do: fail_prepare(state, job, {:unexpected_result, other})

  defp fail_prepare(state, job, reason) do
    GenServer.reply(job.from, {:error, {:prepare_failed, reason}})

    # A failed call never claimed a GSN, so its seq is a hole to skip, not
    # a range to resolve.
    state
    |> drop_arrival(job.from)
    |> Map.put(:prepared, Map.put(state.prepared, job.seq, :skipped))
    |> advance_burst()
  end

  # Only the snapshot burst may enter the pipeline. A call that arrived
  # after the marker stays in `prepared` for the next burst, even if its
  # payload is ready, so the prepare pool finishing early cannot grow the
  # current flush.
  defp advance_burst(%{burst_max_seq: nil} = state), do: state

  defp advance_burst(state) do
    state = take_burst(state)

    cond do
      state.next_enqueue_seq > state.burst_max_seq ->
        state = %{state | burst_max_seq: nil}
        state = schedule_flush_now(state)
        maybe_schedule_prepare_flush(state)

      cap_reached?(state) ->
        # Stop at the cap and flush; the rest of this burst resumes after
        # the range is released.
        schedule_flush_now(state)

      true ->
        state
    end
  end

  defp take_burst(state) do
    cond do
      state.next_enqueue_seq > state.burst_max_seq ->
        state

      cap_reached?(state) ->
        state

      true ->
        case Map.pop(state.prepared, state.next_enqueue_seq) do
          {nil, _prepared} ->
            state

          {:skipped, prepared} ->
            take_burst(%{
              state
              | prepared: prepared,
                next_enqueue_seq: state.next_enqueue_seq + 1
            })

          {{:ready, from, encoded}, prepared} ->
            take_burst(%{
              state
              | prepared: prepared,
                next_enqueue_seq: state.next_enqueue_seq + 1,
                pipeline: CommitPipeline.enqueue(state.pipeline, from, encoded)
            })
        end
    end
  end

  # One marker per burst. A marker that arrives while a burst is draining
  # is dropped; that drain schedules the next one when it finishes.
  defp maybe_schedule_prepare_flush(state) do
    cond do
      state.prepare_flush_scheduled ->
        state

      state.burst_max_seq != nil ->
        state

      map_size(state.preparing) + map_size(state.prepared) == 0 ->
        state

      state.batch_timeout_ms > 0 ->
        timer = Process.send_after(self(), :prepare_flush, state.batch_timeout_ms)
        %{state | prepare_flush_scheduled: true, prepare_timer_ref: timer}

      true ->
        send(self(), :prepare_flush)
        %{state | prepare_flush_scheduled: true}
    end
  end

  defp clear_prepare_flush(state) do
    if state.prepare_timer_ref, do: Process.cancel_timer(state.prepare_timer_ref)

    %{state | prepare_flush_scheduled: false, prepare_timer_ref: nil}
  end

  defp cap_reached?(state) do
    state.batch_max_size > 0 and
      CommitPipeline.pending_count(state.pipeline) >= state.batch_max_size
  end

  defp cancel_prepare_timer(timer), do: Process.cancel_timer(timer)

  defp prepare_queue_full?(state) do
    map_size(state.preparing) + map_size(state.prepared) >= state.prepare.queue_max
  end

  defp validate_prepare_opts!(pool_size, queue_max, timeout_ms) do
    unless is_integer(pool_size) and pool_size > 0 do
      raise ArgumentError,
            "Writer prepare_pool_size must be a positive integer, got: #{inspect(pool_size)}"
    end

    unless is_integer(queue_max) and queue_max > 0 do
      raise ArgumentError,
            "Writer prepare_queue_max must be a positive integer, got: #{inspect(queue_max)}"
    end

    unless is_integer(timeout_ms) and timeout_ms > 0 do
      raise ArgumentError,
            "Writer prepare_timeout_ms must be a positive integer, got: #{inspect(timeout_ms)}"
    end
  end

  # The only place a flush is scheduled. The pipeline depth blocks it;
  # at the V0 depth of one this is the old single-in-flight rule, and at a
  # higher depth calls accumulate only until the next free slot reschedules.
  defp schedule_flush(state, timeout_ms) do
    case CommitPipeline.schedule(
           state.pipeline,
           state.batch_max_size,
           timeout_ms
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
        timer = Process.send_after(self(), :flush, timeout_ms)
        %{state | pipeline: pipeline, flush_timer_ref: timer}

      {status, pipeline} when status in [:wait, :idle] ->
        %{state | pipeline: pipeline}
    end
  end

  # A visible prepare burst already waited out `batch_timeout_ms`; the
  # pipeline flush must not defer it a second time.
  defp schedule_flush_now(state), do: schedule_flush(state, 0)

  # The single place that claims a GSN range and hands it to the
  # Committer. A stale marker or timer must be a no-op when nothing is
  # pending; the replies wait for the ack.
  defp flush(state) do
    flush_at = System.monotonic_time()
    state = cancel_flush_timer(state)
    {pipeline, pending} = CommitPipeline.take_pending(state.pipeline)
    {oldest_arrival, state} = take_flush_arrivals(%{state | pipeline: pipeline}, pending)

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

        timing = range_timing(oldest_arrival, gsn_start, gsn_end, flush_at)

        dispatch(pending, ranges, fresh, gsn_start, gsn_end, started_at, timing, state)
    end
  end

  defp dispatch(pending, ranges, fresh, gsn_start, gsn_end, started_at, timing, state) do
    ref = make_ref()
    incoming_overlay = current_overlay(state)

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
    state = put_range_timing(state, ref, timing)
    emit_pipeline_gauges(state)

    {prepared, groups_by_gsn, cache_plan} =
      prepare_or_abandon(
        fresh,
        ref,
        gsn_start,
        gsn_end,
        started_at,
        state,
        incoming_overlay
      )

    pending_marks = pending_marks(prepared, state)

    {:ok, _batch, pipeline} =
      CommitPipeline.prepared(
        state.pipeline,
        ref,
        prepared,
        groups_by_gsn,
        pending_marks,
        cache_plan
      )

    # The resolve phase ends here, where the range is ready for a Committer
    # and the hand-off itself belongs to `commit_wait`.
    state = %{state | pipeline: pipeline}
    state = update_range_timing(state, ref, &%{&1 | resolve_at: System.monotonic_time()})

    start_next_commit(state)
  end

  # Group resolution reads the system caches, so it stays on the
  # sequencer. A raise here is still a claimed-but-uncommitted range: the
  # abandon (release the ids, clear marks, resolve, log, nudge) runs before
  # the re-raise, exactly like the failure paths after the ack.
  defp prepare_or_abandon(
         fresh,
         ref,
         gsn_start,
         gsn_end,
         started_at,
         state,
         incoming_overlay
       ) do
    # credo:disable-for-next-line /Check\.Readability\.PreferImplicitTry/
    try do
      prepare(fresh, gsn_start, state, incoming_overlay)
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

  # The buffer size and the head GSN are only known to the Writer, so emit
  # them here instead of asking the sampler to read the sequencer's state.
  defp emit_pipeline_gauges(state) do
    %{in_flight_batches: batches, oldest_unreleased_gsn: gsn} =
      CommitPipeline.buffer_stats(state.pipeline)

    Telemetry.execute([:writer, :in_flight_batches], %{count: batches}, %{})
    Telemetry.execute([:writer, :oldest_unreleased_gsn], %{gsn: gsn}, %{})
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

  # Arrival stamps belong to the calls the flush just took, so every one of
  # them is consumed here. A call that failed its prepare dropped its own
  # record, and the oldest surviving call is the range's queue/prepare anchor.
  defp take_flush_arrivals(state, pending) do
    arrivals = state.timings.arrivals
    oldest = Enum.find_value(pending, fn {from, _actions} -> Map.get(arrivals, from) end)
    arrivals = Map.drop(arrivals, Enum.map(pending, fn {from, _actions} -> from end))

    {oldest, put_arrivals(state, arrivals)}
  end

  defp range_timing(oldest, gsn_start, gsn_end, flush_at) do
    %{
      gsn_start: gsn_start,
      gsn_end: gsn_end,
      sent_at: oldest && oldest.sent_at,
      dequeued_at: oldest && oldest.dequeued_at,
      ready_at: oldest && oldest.ready_at,
      flush_at: flush_at,
      resolve_at: nil,
      ack_at: nil,
      apply_at: nil,
      notify_at: nil
    }
  end

  defp mark_apply_done(state, ref) do
    update_range_timing(state, ref, &%{&1 | apply_at: System.monotonic_time()})
  end

  defp mark_notify_done(state, ref) do
    update_range_timing(state, ref, &%{&1 | notify_at: System.monotonic_time()})
  end

  # An abandon that never finished its resolve reports the time it did spend
  # there; the phases after it stay `0`.
  defp emit_abandoned_phases(state, ref, reason, abandoned_at) do
    state =
      update_range_timing(state, ref, fn timing ->
        %{timing | resolve_at: timing.resolve_at || abandoned_at}
      end)

    emit_flush_phases(state, ref, :abandoned, reason)
  end

  defp emit_flush_phases(state, ref, outcome, reason \\ nil) do
    case Map.pop(state.timings.ranges, ref) do
      {nil, _ranges} ->
        state

      {timing, ranges} ->
        metadata = %{gsn_start: timing.gsn_start, gsn_end: timing.gsn_end, outcome: outcome}

        metadata =
          case reason do
            nil -> metadata
            reason -> Map.put(metadata, :reason, reason)
          end

        Telemetry.execute(
          [:writer, :flush_phase_ms],
          flush_phase_measurements(timing),
          metadata
        )

        put_ranges(state, ranges)
    end
  end

  defp flush_phase_measurements(timing) do
    %{
      queue:
        phase_span(timing.sent_at, timing.dequeued_at) +
          phase_span(timing.ready_at, timing.flush_at),
      prepare: phase_span(timing.dequeued_at, timing.ready_at),
      resolve: phase_span(timing.flush_at, timing.resolve_at),
      commit_wait: phase_span(timing.resolve_at, timing.ack_at),
      apply: phase_span(timing.ack_at, timing.apply_at),
      notify: phase_span(timing.apply_at, timing.notify_at)
    }
  end

  defp phase_span(from, to) when is_integer(from) and is_integer(to), do: max(to - from, 0)
  defp phase_span(_from, _to), do: 0

  defp put_range_timing(state, ref, timing) do
    put_ranges(state, Map.put(state.timings.ranges, ref, timing))
  end

  defp update_range_timing(state, ref, update) do
    case Map.fetch(state.timings.ranges, ref) do
      {:ok, timing} -> put_range_timing(state, ref, update.(timing))
      :error -> state
    end
  end

  defp record_arrival(state, from, sent_at) do
    dequeued_at = System.monotonic_time()

    arrival = %{sent_at: sent_at, dequeued_at: dequeued_at, ready_at: nil}

    put_arrivals(state, Map.put(state.timings.arrivals, from, arrival))
  end

  defp mark_payload_ready(state, from, ready_at \\ System.monotonic_time()) do
    case Map.fetch(state.timings.arrivals, from) do
      {:ok, arrival} ->
        put_arrivals(
          state,
          Map.put(state.timings.arrivals, from, %{arrival | ready_at: ready_at})
        )

      :error ->
        state
    end
  end

  defp drop_arrival(state, from) do
    put_arrivals(state, Map.delete(state.timings.arrivals, from))
  end

  defp put_arrivals(state, arrivals) do
    %{state | timings: %{state.timings | arrivals: arrivals}}
  end

  defp put_ranges(state, ranges) do
    %{state | timings: %{state.timings | ranges: ranges}}
  end

  # The durable ack closes `commit_wait` for every outcome, including a
  # raised or crashed Committer, before the abandon or apply work runs.
  defp handle_commit_result(result, ref, state) do
    state = update_range_timing(state, ref, &%{&1 | ack_at: System.monotonic_time()})
    do_handle_commit_result(result, ref, state)
  end

  defp do_handle_commit_result(:ok, ref, state) do
    {:ok, batch, pipeline} = CommitPipeline.committed(state.pipeline, ref)
    state = %{state | pipeline: pipeline}

    # The durable dedup row now exists for every Action in the batch, so
    # the commit marker takes over from the concurrency guard.
    release_in_flight(state, batch.action_ids)

    case mark_committed_result(batch, state) do
      :ok ->
        advance_pipeline(state)

      {:raised, kind, value, stacktrace} ->
        emit_batch_latency(batch)

        abandon(state, ref, raised_reason(kind, value))

        :erlang.raise(kind, value, stacktrace)
    end
  end

  defp do_handle_commit_result({:error, reason}, ref, state) do
    fail_range(ref, reason, state)
  end

  # A Committer-side raise or crash is a failed range, not a reason to
  # take the Writer (and every other in-flight range) down. The pool turns
  # a process death into `{:crashed, reason}`; a `commit_fn` raise arrives
  # as `{:raised, ...}`. Both abandon only their own range and reply the
  # same `503 write_failed` contract as a returned error.
  defp do_handle_commit_result({:raised, kind, value, stacktrace}, ref, state) do
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

  defp do_handle_commit_result({:crashed, reason}, ref, state) do
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

    advance_pipeline(state)
  end

  # Apply and notify every committed prefix, then hand the next prepared
  # successor to a Committer. Commit acks may arrive in any order, but
  # `CommitPipeline.releasable/1` only returns the committed prefix, so a
  # later range never overtakes an earlier one. Abandoned ranges were
  # pruned, which is what lets the healthy range behind a failed one drain.
  defp advance_pipeline(state) do
    case drain_releasable(state) do
      {:ok, state} ->
        state = advance_burst(state)
        state = start_next_commit(state)

        # A prepare still in flight must not share this flush; it belongs
        # to the next snapshot burst. The prepare marker already provided
        # the coalescing window, so the pipeline does not wait again.
        state =
          if state.burst_max_seq == nil, do: schedule_flush_now(state), else: state

        maybe_schedule_prepare_flush(state)

      {:escalated, state} ->
        state
    end
  end

  defp start_next_commit(state) do
    case ready_batch(state.pipeline) do
      %Batch{ref: ref, prepared: prepared, gsn_start: gsn_start, gsn_end: gsn_end} ->
        {:ok, _batch, pipeline} = CommitPipeline.committing(state.pipeline, ref)
        state = %{state | pipeline: pipeline}

        # One committer slot means no batch can overlap this one, so the
        # hand-off buys nothing and costs a copy plus three hops.
        if state.pipeline.max_in_flight == 1 do
          result = Committer.commit_now(prepared, gsn_start, gsn_end, state.commit_opts)
          handle_commit_result(result, ref, state)
        else
          CommitterPool.commit(state.committer_pool, ref, prepared, gsn_start, gsn_end)
          state
        end

      nil ->
        state
    end
  end

  # A prepared batch may commit while an earlier range is still in flight
  # only when that range planned no membership or relationship move: then
  # its eventual abandon cannot invalidate the successor's scopes. A
  # resolution-affecting predecessor holds the gate until it is durable.
  defp ready_batch(pipeline) do
    case first_prepared(pipeline) do
      nil ->
        nil

      batch ->
        pending = CommitPipeline.unresolved_cache_overlay_before(pipeline, batch.ref)

        if CacheMutationPlanner.Overlay.group_resolution_affected?(pending),
          do: nil,
          else: batch
    end
  end

  defp first_prepared(pipeline) do
    pipeline
    |> CommitPipeline.open_batches()
    |> Enum.find(&(&1.phase == :prepared))
  end

  defp drain_releasable(state) do
    case CommitPipeline.releasable(state.pipeline) do
      [] ->
        {:ok, state}

      [batch | _] ->
        apply_one(batch, state)
    end
  end

  defp apply_one(batch, state) do
    {:ok, _batch, pipeline} = CommitPipeline.applying(state.pipeline, batch.ref)
    state = %{state | pipeline: pipeline}

    case settle_after_commit(batch, state) do
      {:ok, state} ->
        {:ok, _batch, pipeline} = CommitPipeline.release(state.pipeline, batch.ref)
        state = %{state | pipeline: pipeline}
        emit_pipeline_gauges(state)
        drain_releasable(state)

      # The cache apply failed and the fan-out range was never pushed. Leave
      # the batch unreleased so a rebuilt Writer cannot let a later range
      # overtake it; the escalation restarts the storage tree and init/1
      # reconciles the durable frontier.
      {:escalated, state} ->
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
  defp settle_after_commit(batch, state) do
    # credo:disable-for-next-line /Check\.Readability\.PreferImplicitTry/
    try do
      if state.after_commit, do: state.after_commit.()

      case apply_post_commit(batch, state) do
        :ok ->
          state = mark_apply_done(state, batch.ref)

          # The fan-out sample starts at the notify send boundary, after the
          # write-side apply, so `router_queue` can be subtracted from it.
          committed_at = System.monotonic_time()

          notify_fanout(state, batch, committed_at)

          emit_batch_latency(batch)
          emit_actions_accepted(batch.batch_size)
          reply_all(batch.pending, batch.ranges, :ok)
          state = mark_notify_done(state, batch.ref)

          {:ok, emit_flush_phases(state, batch.ref, :ok)}

        {:error, reason} ->
          # The batch is durable: reply success to every caller first,
          # then escalate, so no caller sees a lost success when the
          # rebuild tears this process down.
          state = mark_apply_done(state, batch.ref)

          emit_batch_latency(batch)
          emit_actions_accepted(batch.batch_size)
          reply_all(batch.pending, batch.ranges, :ok)
          state = mark_notify_done(state, batch.ref)
          state = emit_flush_phases(state, batch.ref, :ok)
          escalate_cache_failure(batch.gsn_start, batch.gsn_end, reason)
          {:escalated, state}
      end
    rescue
      error ->
        emit_batch_latency(batch)
        emit_flush_phases(state, batch.ref, :ok)
        log_post_commit_failure(batch, error)
        reraise error, __STACKTRACE__
    catch
      kind, value ->
        emit_batch_latency(batch)
        emit_flush_phases(state, batch.ref, :ok)
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

  # One flush resolves every Action against one cache snapshot plus the
  # unapplied slices of the batches ahead of it, so the cache-only part of
  # group resolution is memoized across the whole flush (see
  # `EntityIndex.resolve_groups_cached/3`). Each Action still unions its own
  # intra-action membership on top, so two Actions that move the same entity
  # cannot see each other's membership.
  defp prepare(fresh, gsn_start, state, incoming_overlay) do
    resolve_opts =
      state
      |> resolve_cache_opts()
      |> Keyword.put(:overlay, incoming_overlay)

    {prepared, {groups_by_gsn, _memo}} =
      fresh
      |> Enum.with_index(gsn_start)
      |> Enum.map_reduce({%{}, %{}}, fn {{action, payload_etf}, gsn}, {groups, memo} ->
        {prepared_action, memo} =
          prepare_action(action, payload_etf, state, resolve_opts, memo)

        {prepared_action, {Map.put(groups, gsn, prepared_action.groups), memo}}
      end)

    {prepared, groups_by_gsn, plan_cache_mutations(fresh, state, incoming_overlay)}
  end

  # Plan before the commit so a successor can resolve against this batch's
  # rows while it is still unapplied. The batch keeps its own slice; the
  # cumulative overlay is only an intermediate for the next plan.
  defp plan_cache_mutations(fresh, state, incoming_overlay) do
    if ablate?(:cache, state) do
      {[], nil}
    else
      {mutations, cumulative} =
        fresh
        |> Enum.flat_map(fn {action, _payload_etf} -> action.updates end)
        |> CacheMutationPlanner.plan(plan_tables(state), incoming_overlay)

      {mutations, CacheMutationPlanner.slice(cumulative, mutations)}
    end
  end

  defp current_overlay(state), do: CommitPipeline.cache_overlay(state.pipeline)

  defp overlay_before(state, ref),
    do: CommitPipeline.cache_overlay_before(state.pipeline, ref)

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
          if type_entities_ablated?(state),
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

  defp apply_post_commit(%Batch{} = batch, state) do
    {entities, _generation} = batch.pending_marks

    unless ablate?(:dirty, state) do
      :ok = DirtyTracker.mark_dirty_batch(entities, state.dirty_set)
    end

    unless ablate?(:cache, state) do
      Enum.each(batch.cache_mutations, &apply_cache_mutation(&1, state))
    end

    :ok
  rescue
    error -> {:error, error}
  end

  # The only two caches a patch merge reads. The planner resolves their
  # writes itself; this Writer only applies the result.
  defp plan_tables(state) do
    %{
      group_members_by_id: state.group_members_by_id,
      entity_groups_by_id: state.entity_groups_by_id
    }
  end

  @spec apply_cache_mutation(CacheMutationPlanner.mutation(), t()) :: any()
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
    case abandon_batch(state, ref, reason) do
      {state, nil} -> state
      {state, batch} -> rebuild_successors(state, batch)
    end
  end

  defp abandon_batch(state, ref, reason) do
    abandoned_at = System.monotonic_time()

    case CommitPipeline.abandon(state.pipeline, ref, reason) do
      {:ok, batch, pipeline} ->
        state = %{state | pipeline: pipeline}
        state = emit_abandoned_phases(state, ref, reason, abandoned_at)
        emit_pipeline_gauges(state)

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

        {state, batch}

      {:error, _reason} ->
        # A stale result for a batch this Writer already abandoned must not
        # resolve or reply twice.
        {state, nil}
    end
  end

  # A successor prepared against the abandoned batch's overlay resolved
  # scopes that will never exist. None of them has reached a Committer yet
  # (a Committer is only handed the durable prefix), so rebuilding each one
  # against the surviving chain is safe and keeps its claim.
  defp rebuild_successors(state, abandoned) do
    state.pipeline
    |> CommitPipeline.open_batches()
    |> Enum.filter(&(&1.phase == :prepared and &1.gsn_start > abandoned.gsn_start))
    |> Enum.reduce(state, fn batch, state ->
      if CommitPipeline.get(state.pipeline, batch.ref),
        do: rebuild_prepared(state, batch),
        else: state
    end)
  end

  defp rebuild_prepared(state, %Batch{} = batch) do
    incoming_overlay = overlay_before(state, batch.ref)

    fresh =
      Enum.map(batch.prepared, fn %PreparedAction{} = prepared ->
        action = %{
          id: prepared.id,
          actor_id: prepared.actor_id,
          hlc: prepared.hlc,
          updates: prepared.updates
        }

        {action, prepared.payload_etf}
      end)

    {prepared, groups_by_gsn, cache_plan} =
      prepare(fresh, batch.gsn_start, state, incoming_overlay)

    unless ablate?(:dirty, state), do: clear_pending(state, batch.pending_marks)
    marks = pending_marks(prepared, state)

    {:ok, _batch, pipeline} =
      CommitPipeline.reprepared(
        state.pipeline,
        batch.ref,
        prepared,
        groups_by_gsn,
        marks,
        cache_plan
      )

    %{state | pipeline: pipeline}
  rescue
    error ->
      {state, _batch} = abandon_batch(state, batch.ref, {:rebuild_failed, error})
      state
  catch
    kind, value ->
      {state, _batch} =
        abandon_batch(state, batch.ref, {:rebuild_failed, raised_reason(kind, value)})

      state
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

  defp notify_fanout(state, batch, committed_at) do
    unless ablate?(:fanout, state) do
      notify_batch_committed(state, batch, committed_at)
    end
  end

  defp notify_batch_committed(state, batch, committed_at) do
    notify_router(
      state,
      {:batch_committed, batch.gsn_start, batch.gsn_end, batch.groups_by_gsn, committed_at,
       carried_payloads(batch.prepared)}
    )
  end

  # The range supplies each GSN by position, so the list is in claim order:
  # index 0 is `gsn_start`.
  defp carried_payloads(prepared) do
    Enum.map(prepared, &{&1.payload_etf, &1.update_scopes})
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

  # `:entity_index` is the combined alias the published bench commands use.
  defp type_entities_ablated?(state),
    do: ablate?(:type_entities, state) or ablate?(:entity_index, state)

  defp group_ids_for_update(update, resolve_opts, memo) do
    case Keyword.get(resolve_opts, :entity_groups) do
      nil -> {[], memo}
      _table -> resolve_update_groups(update, resolve_opts, memo)
    end
  end

  defp resolve_update_groups(update, resolve_opts, memo) do
    case EntityIndex.fan_out_preference(update, resolve_opts) do
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
