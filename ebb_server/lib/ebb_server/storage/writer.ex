defmodule EbbServer.Storage.Writer do
  @moduledoc """
  The single serialization point for the storage layer: every committed
  Action goes through this GenServer and is durably written to RocksDB
  before its GSN is returned to the caller.

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

  ## Hot path

  `flush/1` claims a GSN range for the coalesced burst, builds the
  `cf_group_actions` index via intra-action context (see below), assembles
  the WriteBatch, marks the affected entities provisionally dirty, commits
  with `sync: true`, settles the marks, advances the watermark, and notifies
  `FanOutRouter`. The notification carries the per-Action
  group set this pass resolved, so live fan-out indexes the same
  snapshot `cf_group_actions` was built from rather than re-deriving
  groups after the system caches have moved.

  Redundant index writes are dropped during op construction: the
  `cf_type_entities` key has no GSN component, so it is collected as a
  per-flush set and written once per unique `(subject_type, subject_id)`,
  while `cf_group_actions` is emitted once per Action from the union of
  resolved group ids.

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
  - **Structural resolution.** Claim → build → commit runs inside
    `try/after`, and the `after` marks the range resolved. A raise while
    building ops or an exception out of `commit_fn` abandons the range
    (resolve, log, nudge `FanOutRouter`) and then re-raises, so the
    exception path behaves like the failed-commit path and only a hard
    kill can leave a claim unresolved. A failed commit and a raise
    therefore both leave the frontier advanced before the nudge is sent.
  - **Commit is the point of no return.** Once `commit_fn` returns `:ok`
    the range is marked committed and the frontier advanced before any
    other raise-capable step runs. Every caller in the flush then gets its
    success tuple. Dirty tracking and cache updates follow; if they raise, the
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
  simulation, plus the optional `:after_commit` fun, invoked inside the
  Writer once `commit_fn` returns and before the marks settle, so tests
  can observe the durable-commit window deterministically.

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
    DirtyTracker,
    EntityGroupCache,
    EntityIndex,
    EntityTypeCache,
    Fields,
    GroupCache,
    GsnCounter,
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
          commit_fn: (list(), keyword() -> :ok | {:error, term()}),
          after_commit: (-> any()) | nil,
          batch_max_size: integer(),
          batch_timeout_ms: non_neg_integer(),
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
    :commit_fn,
    :after_commit,
    :batch_max_size,
    :batch_timeout_ms,
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

    dirty_set =
      Keyword.get(
        opts,
        :dirty_set,
        :persistent_term.get({DirtyTracker, :dirty_set}, :ebb_dirty_set)
      )

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
      commit_fn: commit_fn,
      after_commit: after_commit,
      batch_max_size: batch_max_size,
      batch_timeout_ms: batch_timeout_ms,
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
  3. Builds and synchronously commits a single WriteBatch across the written
     column families:
     - cf_actions: GSN → full action, including its Updates (ETF encoded)
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
    state = enqueue(state, from, actions)

    cond do
      state.batch_max_size > 0 and state.pending_count >= state.batch_max_size ->
        {:noreply, flush(state)}

      state.flush_timer != nil ->
        {:noreply, state}

      state.batch_timeout_ms > 0 ->
        {:noreply,
         %{state | flush_timer: Process.send_after(self(), :flush, state.batch_timeout_ms)}}

      true ->
        # Burst-drain: the marker lands at the TAIL of the mailbox, after
        # every write_actions call already queued, so it flushes the current
        # burst and adds only a mailbox hop when nothing else is waiting. One
        # marker per burst is enough; the rest of the burst enqueues behind it.
        unless state.flush_scheduled do
          send(self(), :flush)
        end

        {:noreply, %{state | flush_scheduled: true}}
    end
  end

  @impl true
  def handle_info(:flush, state), do: {:noreply, flush(state)}

  defp enqueue(state, from, actions) do
    %{
      state
      | pending: [{from, actions} | state.pending],
        pending_count: state.pending_count + length(actions)
    }
  end

  # The single place that claims a GSN range, commits, and replies. A
  # stale marker or timer must be a no-op when nothing is pending.
  defp flush(%{pending: []} = state) do
    %{cancel_flush_timer(state) | flush_scheduled: false}
  end

  defp flush(state) do
    state = cancel_flush_timer(state)
    pending = Enum.reverse(state.pending)

    {fresh, fresh_tagged} = plan(pending, state.rocks_name)

    state = %{state | pending: [], pending_count: 0, flush_scheduled: false}

    case fresh do
      [] ->
        reply_all(pending, %{}, :ok)
        state

      _ ->
        batch_size = length(fresh)
        caller_count = length(pending)

        {gsn_start, gsn_end} = GsnCounter.claim_gsn_range(batch_size, state.gsn_counter)
        ranges = caller_ranges(fresh_tagged, caller_count, gsn_start)

        Telemetry.execute(
          [:writer, :batch_size],
          %{count: batch_size},
          %{gsn_start: gsn_start, gsn_end: gsn_end, callers: caller_count}
        )

        case write_batch(fresh, gsn_start, gsn_end, state) do
          :ok ->
            emit_actions_accepted(batch_size)
            reply_all(pending, ranges, :ok)
            state

          {:error, reason} ->
            reply_all(pending, ranges, {:error, reason})
            state

          {:escalate, reason} ->
            # The batch is durable: reply success to every caller first,
            # then escalate, so no caller sees a lost success when the
            # rebuild tears this process down.
            emit_actions_accepted(batch_size)
            reply_all(pending, ranges, :ok)
            escalate_cache_failure(gsn_start, gsn_end, reason)
            state
        end
    end
  end

  defp emit_actions_accepted(count) do
    Telemetry.execute([:writer, :actions_per_sec], %{count: count}, %{})
  end

  # Arrival order is the caller's position in `pending`; a caller's
  # surviving Actions are contiguous in the global fresh list, so one
  # `{first, last}` per caller is exact.
  defp plan(pending, rocks_name) do
    tagged =
      pending
      |> Enum.with_index()
      |> Enum.flat_map(fn {{_from, actions}, caller_idx} ->
        actions
        |> Enum.reject(&(&1.updates == []))
        |> Enum.map(&{caller_idx, &1})
      end)
      |> Enum.uniq_by(fn {_caller_idx, action} -> action.id end)

    fresh_tagged = drop_committed(tagged, rocks_name)
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

  # The `after` is the structural guarantee: however the body exits — a
  # build-time raise, a failed commit, or a cache update that blows up
  # after the commit landed — the claimed range ends up resolved. The
  # rescue/catch abandon (clear the provisional marks, resolve, log,
  # nudge) before re-raising, so the exception path also tells
  # `FanOutRouter` about the hole; the `after` repeats the resolve, which
  # is idempotent.
  #
  # The provisional marks are written before `build_ops` so that no read
  # can observe the entity clean between the commit landing and the
  # settled mark; `abandon` clears them on every failure path. Settling
  # (in `apply_post_commit`) overwrites them, so the success path needs no
  # clear.
  defp write_batch(fresh, gsn_start, gsn_end, state) do
    started_at = System.monotonic_time()
    entity_ids = affected_entity_ids(fresh)
    pending = {entity_ids, DirtyTracker.mark_pending_batch(entity_ids, state.dirty_set)}

    # credo:disable-for-next-line /Check\.Readability\.PreferImplicitTry/
    try do
      {ops, groups_by_gsn} = build_ops(fresh, gsn_start, state)
      commit(fresh, pending, ops, groups_by_gsn, gsn_start, gsn_end, state)
    rescue
      error ->
        abandon(state, pending, gsn_start, gsn_end, error)
        reraise error, __STACKTRACE__
    catch
      kind, value ->
        abandon(state, pending, gsn_start, gsn_end, {kind, value})
        :erlang.raise(kind, value, __STACKTRACE__)
    after
      # Emit before the resolve so a WatermarkTracker failure cannot
      # swallow the latency sample for a batch that failed to commit.
      Telemetry.execute(
        [:writer, :batch_latency_ms],
        %{duration: System.monotonic_time() - started_at},
        %{gsn_start: gsn_start, gsn_end: gsn_end}
      )

      resolve_range(state, gsn_start, gsn_end)
    end
  end

  # A flush resolves every Action against one cache snapshot, so the
  # cache-only part of group resolution is memoized across the whole
  # flush (see `EntityIndex.resolve_groups_cached/3`). Each Action still
  # unions its own intra-action membership on top, so two Actions that
  # move the same entity cannot see each other's membership.
  defp build_ops(fresh, gsn_start, state) do
    resolve_opts = resolve_cache_opts(state)

    {action_ops, {groups_by_gsn, type_entity_keys, _memo}} =
      fresh
      |> Enum.with_index(gsn_start)
      |> Enum.map_reduce({%{}, MapSet.new(), %{}}, fn {action, gsn}, {groups, keys, memo} ->
        {ops, group_ids, action_keys, memo} =
          build_action_ops(action, gsn, state.rocks_name, resolve_opts, memo)

        keys = MapSet.union(keys, MapSet.new(action_keys))
        {ops, {Map.put(groups, gsn, group_ids), keys, memo}}
      end)

    ops = :lists.append(action_ops) ++ type_entity_ops(type_entity_keys, state.rocks_name)
    {ops, groups_by_gsn}
  end

  # No per-GSN component: one put per unique key per flush. Sorted for
  # reproducible batches.
  defp type_entity_ops(keys, rocks_name) do
    keys
    |> Enum.sort()
    |> Enum.map(fn key -> {:put, RocksDB.cf_type_entities(rocks_name), key, <<>>} end)
  end

  defp commit(fresh, pending, ops, groups_by_gsn, gsn_start, gsn_end, state) do
    case state.commit_fn.(ops, name: state.rocks_name) do
      :ok ->
        if state.after_commit, do: state.after_commit.()

        # Point of no return: make the range durable-resolved before any
        # raise-capable cache bookkeeping runs.
        mark_committed(state, gsn_start, gsn_end)

        case apply_post_commit(fresh, state) do
          :ok ->
            notify_batch_committed(state, gsn_start, gsn_end, groups_by_gsn)
            :ok

          {:error, reason} ->
            {:escalate, reason}
        end

      {:error, reason} ->
        Telemetry.execute(
          [:writer, :commit_failed],
          %{count: 1},
          %{gsn_start: gsn_start, gsn_end: gsn_end, reason: reason}
        )

        abandon(state, pending, gsn_start, gsn_end, reason)
        {:error, reason}
    end
  end

  defp apply_post_commit(fresh, state) do
    :ok = DirtyTracker.mark_dirty_batch(affected_entity_ids(fresh), state.dirty_set)

    fresh
    |> plan_cache_mutations(state)
    |> Enum.each(&apply_cache_mutation(&1, state))

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
  # Public so tests can pin the dedup directly; hidden from the docs.
  @doc false
  @spec plan_cache_mutations([validated_action()], t()) :: [cache_mutation()]
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

  defp affected_entity_ids(fresh) do
    fresh
    |> Enum.flat_map(fn action -> action.updates end)
    |> Enum.map(fn update -> update.subject_id end)
    |> Enum.uniq()
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
    clear_pending(state, pending)

    # Resolve before nudging so the router can only observe the advanced
    # frontier. The `after` repeats this, harmlessly.
    resolve_range(state, gsn_start, gsn_end)

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
  defp clear_pending(state, {entity_ids, generation}) do
    DirtyTracker.clear_pending_batch(entity_ids, generation, state.dirty_set)
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

  defp notify_batch_committed(state, gsn_start, gsn_end, groups_by_gsn) do
    notify_router(state, {:batch_committed, gsn_start, gsn_end, groups_by_gsn})
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

  defp build_action_ops(action, gsn, rocks_name, flush_opts, memo) do
    action_with_gsn = to_storage_format(action, gsn)
    action_etf = :erlang.term_to_binary(action_with_gsn)

    resolve_opts =
      Keyword.put(flush_opts, :intra_action, build_intra_action_context(action.updates))

    {update_ops, {group_ids_by_update, type_entity_keys, memo}} =
      Enum.map_reduce(action.updates, {[], [], memo}, fn update, {groups, keys, memo} ->
        {ops, group_ids, type_entity_key, memo} =
          build_update_ops(action.id, update, gsn, rocks_name, resolve_opts, memo)

        {ops, {[group_ids | groups], [type_entity_key | keys], memo}}
      end)

    group_ids =
      group_ids_by_update
      |> Enum.reverse()
      |> :lists.append()
      |> Enum.uniq()

    # The union of resolved groups is indexed once per Action, not once
    # per Update, so repeated memberships cannot write the same
    # `{group_id, gsn}` row twice.
    group_ops =
      Enum.map(group_ids, fn group_id ->
        key = RocksDB.encode_group_action_key(group_id, gsn)
        {:put, RocksDB.cf_group_actions(rocks_name), key, action.id}
      end)

    ops =
      [
        {:put, RocksDB.cf_actions(rocks_name), RocksDB.encode_gsn_key(gsn), action_etf},
        {:put, RocksDB.cf_action_dedup(rocks_name), action.id, RocksDB.encode_gsn_key(gsn)}
      ] ++ group_ops ++ :lists.append(update_ops)

    {ops, group_ids, type_entity_keys, memo}
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

  defp build_intra_action_context(updates) do
    PermissionHelper.build_intra_action_context(updates)
  end

  defp to_storage_format(action, gsn) do
    %{
      "id" => action.id,
      "actor_id" => action.actor_id,
      "hlc" => action.hlc,
      "gsn" => gsn,
      "updates" =>
        Enum.map(action.updates, fn update ->
          method_str =
            if is_atom(update.method), do: Atom.to_string(update.method), else: update.method

          %{
            "id" => update.id,
            "subject_id" => update.subject_id,
            "subject_type" => update.subject_type,
            "method" => method_str,
            "data" => update.data
          }
        end)
    }
  end

  defp build_update_ops(action_id, update, gsn, rocks_name, resolve_opts, memo) do
    {group_ids, memo} = group_ids_for_update(update, resolve_opts, memo)

    type_entity_key = RocksDB.encode_type_entity_key(update.subject_type, update.subject_id)

    # The Update is stored once, inside the `cf_actions` value; there is no
    # separate per-Update row to maintain. The group index and the type
    # index are emitted by the caller, which owns the dedup scope.
    ops = [
      {:put, RocksDB.cf_entity_actions(rocks_name),
       RocksDB.encode_entity_gsn_key(update.subject_id, gsn), action_id}
    ]

    {ops, group_ids, type_entity_key, memo}
  end

  defp group_ids_for_update(update, resolve_opts, memo) do
    case Keyword.get(resolve_opts, :entity_groups) do
      nil -> {[], memo}
      _table -> resolve_update_groups(update, resolve_opts, memo)
    end
  end

  defp resolve_update_groups(update, resolve_opts, memo) do
    case update.subject_type do
      "relationship" ->
        resolve_relationship_groups(update, resolve_opts, memo)

      type when type in ["entityGroup", "groupMember"] ->
        wire_group_or_resolve(update, type, resolve_opts, memo)

      type ->
        resolve_memo_groups(memo, type, update.subject_id, resolve_opts)
    end
  end

  # A relationship resolves through its source: the wire `source_id` when
  # the Update carries it, otherwise the by-id edge's source (the delete
  # wire form drops the data envelope).
  defp resolve_relationship_groups(update, resolve_opts, memo) do
    case Fields.get(update.data, "source_id") do
      nil ->
        resolve_memo(memo, {"relationship", update.subject_id}, resolve_opts, fn ->
          EntityIndex.resolve_groups_cached("relationship", update.subject_id, resolve_opts)
        end)

      source_id ->
        resolve_memo(memo, {:source, source_id}, resolve_opts, fn ->
          {EntityIndex.source_groups_cached(source_id, resolve_opts), source_id}
        end)
    end
  end

  # The by-id cache is empty at write_batch time for a brand-new
  # membership row, so prefer the group on the wire.
  defp wire_group_or_resolve(update, type, resolve_opts, memo) do
    case Fields.get(update.data, "group_id") do
      nil ->
        resolve_memo_groups(memo, type, update.subject_id, resolve_opts)

      group_id ->
        {[group_id], memo}
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
