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

  ## Hot path

  `write_actions/2` claims a GSN range, runs permission validation,
  resolves FieldValue-wrapped data, builds the `cf_group_actions` index
  via intra-action context (see below), assembles the WriteBatch, marks
  the affected entities provisionally dirty, commits with `sync: true`,
  settles the marks, advances the watermark, and notifies `FanOutRouter`.
  The notification carries the per-Action
  group set this pass resolved, so live fan-out indexes the same
  snapshot `cf_group_actions` was built from rather than re-deriving
  groups after the system caches have moved.

  Provisionally dirty marks close the gap between the durable commit
  returning and the entity being marked dirty: a read that starts after
  the commit cannot observe a clean entity whose SQLite row predates the
  Action. `DirtyTracker.mark_pending_batch/2` stamps the marks before the
  commit attempt, `mark_dirty_batch/2` settles them once it returns, and
  `clear_pending_batch/3` removes them on the abandon paths. Materializers
  treat a provisional mark as dirty but never clear it (see
  `EbbServer.Storage.EntityStore`).

  ## Failure and recovery policy

  A GSN range is claimed before the commit attempt, and a claim that is
  never resolved stalls the watermark permanently. The Writer therefore
  guarantees the claim is always resolved:

  - **One commit attempt, no retry.** A commit failure abandons the
    range: it is marked resolved (the watermark advances over the hole),
    `FanOutRouter` is nudged with `{:range_resolved, from, to}` so it can
    drain anything the hole was gating, and the caller gets
    `{:error, {:rocksdb_write_failed, reason}}` (`503 write_failed`).
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
    other raise-capable step runs. The caller then gets the success
    tuple. Dirty tracking and cache updates follow; if they raise, the
    data is already durable, so the Writer logs, abnormally terminates
    `EbbServer.Storage.SystemCache`, and relies on
    `Storage.Supervisor`'s `rest_for_one` to rebuild the caches, the
    watermark, and this Writer. The success reply is sent before that
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
    :fan_out_router,
    :watermark_tracker
  ]

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, opts, name: name)
  end

  @type rejected_action :: %{action: validated_action(), reason: String.t()}
  @type write_result :: {:ok, {pos_integer(), pos_integer()}, [rejected_action()]}

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
  Validates, assigns GSNs, and persists actions to RocksDB.

  Actions are already validated by PermissionChecker before reaching the Writer.
  Pipeline:
  1. Filter out actions with empty updates (safety check)
  2. Claim a GSN range from GsnCounter for the batch
  3. Build a batch of puts across all 6 column families:
     - cf_actions: GSN → full action (ETF encoded)
     - cf_action_dedup: action_id → GSN (duplicate detection)
     - cf_updates: (action_id, update_id) → update (ETF encoded)
     - cf_entity_actions: (subject_id, GSN) → action_id (materialization index)
     - cf_type_entities: (subject_type, subject_id) → <<>> (type index)
     - cf_group_actions: (group_id, GSN) → action_id (group catch-up index)
  4. Write batch synchronously to RocksDB (single attempt, no retry)
  5. Mark affected entities dirty in DirtyTracker

  Returns `{:ok, {gsn_start, gsn_end}, rejected_actions}` on success.

  On a commit failure the claimed range is abandoned (resolved) and the
  caller gets `{:error, {:rocksdb_write_failed, reason}}`. See the
  moduledoc for the full failure/recovery policy.
  """
  @impl true
  def handle_call({:write_actions, actions}, from, state) when is_list(actions) do
    filtered = Enum.reject(actions, &(&1.updates == []))

    case filtered do
      [] ->
        {:reply, {:ok, {0, 0}, []}, state}

      _ ->
        {gsn_start, gsn_end} = GsnCounter.claim_gsn_range(length(filtered), state.gsn_counter)

        case write_batch(filtered, gsn_start, gsn_end, state) do
          {:ok, reply} ->
            {:reply, reply, state}

          {:escalate, reply, reason} ->
            # The batch is durable: reply first, then escalate, so the
            # caller never sees a lost success when the rebuild tears this
            # process down.
            GenServer.reply(from, reply)
            escalate_cache_failure(gsn_start, gsn_end, reason)
            {:noreply, state}
        end
    end
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
  defp write_batch(filtered, gsn_start, gsn_end, state) do
    entity_ids = affected_entity_ids(filtered)
    pending = {entity_ids, DirtyTracker.mark_pending_batch(entity_ids, state.dirty_set)}

    # credo:disable-for-next-line /Check\.Readability\.PreferImplicitTry/
    try do
      {ops, groups_by_gsn} = build_ops(filtered, gsn_start, state)
      commit(filtered, pending, ops, groups_by_gsn, gsn_start, gsn_end, state)
    rescue
      error ->
        abandon(state, pending, gsn_start, gsn_end, error)
        reraise error, __STACKTRACE__
    catch
      kind, value ->
        abandon(state, pending, gsn_start, gsn_end, {kind, value})
        :erlang.raise(kind, value, __STACKTRACE__)
    after
      resolve_range(state, gsn_start, gsn_end)
    end
  end

  defp build_ops(filtered, gsn_start, state) do
    resolve_opts = resolve_cache_opts(state)

    {ops, groups_by_gsn} =
      filtered
      |> Enum.with_index(gsn_start)
      |> Enum.map_reduce(%{}, fn {action, gsn}, acc ->
        {action_ops, group_ids} =
          build_action_ops(action, gsn, state.rocks_name, resolve_opts)

        {action_ops, Map.put(acc, gsn, group_ids)}
      end)

    {List.flatten(ops), groups_by_gsn}
  end

  defp commit(filtered, pending, ops, groups_by_gsn, gsn_start, gsn_end, state) do
    case state.commit_fn.(ops, name: state.rocks_name) do
      :ok ->
        if state.after_commit, do: state.after_commit.()

        # Point of no return: make the range durable-resolved before any
        # raise-capable cache bookkeeping runs.
        mark_committed(state, gsn_start, gsn_end)

        case apply_post_commit(filtered, state) do
          :ok ->
            notify_batch_committed(state, gsn_start, gsn_end, groups_by_gsn)
            {:ok, {:ok, {gsn_start, gsn_end}, []}}

          {:error, reason} ->
            {:escalate, {:ok, {gsn_start, gsn_end}, []}, reason}
        end

      {:error, reason} ->
        abandon(state, pending, gsn_start, gsn_end, reason)
        {:ok, {:error, {:rocksdb_write_failed, reason}}}
    end
  end

  defp apply_post_commit(filtered, state) do
    :ok = DirtyTracker.mark_dirty_batch(affected_entity_ids(filtered), state.dirty_set)
    update_system_caches(filtered, state)
    :ok
  rescue
    error -> {:error, error}
  end

  defp affected_entity_ids(filtered) do
    filtered
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

  defp update_system_caches(actions, state) do
    for action <- actions, update <- action.updates do
      # The entity-type index mirrors `cf_type_entities`, which the Writer
      # writes for every Update (including deletes, whose entry stays).
      EntityTypeCache.put_type(update.subject_id, update.subject_type,
        entity_types: state.entity_types
      )

      case update.subject_type do
        "groupMember" -> handle_group_member_update(update, state)
        "entityGroup" -> handle_entity_group_update(update, state)
        "relationship" -> handle_relationship_update(update, state)
        _ -> :ok
      end
    end
  end

  # A patch carries only the changed fields, so merge them over the
  # cached by-id entry before writing. Skipping a row whose required
  # fields still resolve to nil keeps the cache and the persisted
  # Update from diverging (the cache never stores a partial row).
  defp handle_group_member_update(update, state) do
    case update.method do
      method when method in [:put, :patch] ->
        data = update.data || %{}
        existing = existing_group_member(update, state)

        actor_id = Fields.get(data, "actor_id") || existing[:actor_id]
        group_id = Fields.get(data, "group_id") || existing[:group_id]
        permissions = Fields.get(data, "permissions") || existing[:permissions]

        if is_nil(actor_id) or is_nil(group_id) do
          :ok
        else
          GroupCache.put_group_member(
            %{
              id: update.subject_id,
              actor_id: actor_id,
              group_id: group_id,
              permissions: permissions
            },
            state.group_members
          )
        end

      :delete ->
        GroupCache.delete_group_member(update.subject_id, state.group_members)
    end
  end

  defp existing_group_member(%{method: :patch} = update, state) do
    GroupCache.get_group_member(update.subject_id, state.group_members_by_id) || %{}
  end

  defp existing_group_member(_update, _state), do: %{}

  defp handle_entity_group_update(update, state) do
    case update.method do
      method when method in [:put, :patch] ->
        data = update.data || %{}
        existing = existing_entity_group(update, state)

        entity_id = Fields.get(data, "entity_id") || existing[:entity_id]
        group_id = Fields.get(data, "group_id") || existing[:group_id]

        if is_nil(entity_id) or is_nil(group_id) do
          :ok
        else
          EntityGroupCache.put_entity_group(
            %{id: update.subject_id, entity_id: entity_id, group_id: group_id},
            entity_groups: state.entity_groups,
            entity_groups_by_id: state.entity_groups_by_id,
            entity_groups_by_group: state.entity_groups_by_group
          )
        end

      :delete ->
        EntityGroupCache.delete_entity_group(update.subject_id,
          entity_groups: state.entity_groups,
          entity_groups_by_id: state.entity_groups_by_id,
          entity_groups_by_group: state.entity_groups_by_group
        )
    end
  end

  defp existing_entity_group(%{method: :patch} = update, state) do
    EntityGroupCache.get_entity_group(update.subject_id, state.entity_groups_by_id) || %{}
  end

  defp existing_entity_group(_update, _state), do: %{}

  defp handle_relationship_update(update, state) do
    case update.method do
      method when method in [:put, :patch] ->
        data = update.data || %{}

        source_id = Fields.get(data, "source_id")
        target_id = Fields.get(data, "target_id")
        type = Fields.get(data, "type")
        field = Fields.get(data, "field")

        RelationshipCache.put_relationship(
          %{
            id: update.subject_id,
            source_id: source_id,
            target_id: target_id,
            type: type,
            field: field
          },
          relationships: state.relationships,
          relationships_by_id: state.relationships_by_id
        )

      :delete ->
        RelationshipCache.delete_relationship(
          update.subject_id,
          relationships: state.relationships,
          relationships_by_id: state.relationships_by_id
        )
    end
  end

  defp build_action_ops(action, gsn, rocks_name, resolve_opts) do
    action_with_gsn = to_storage_format(action, gsn)
    action_etf = :erlang.term_to_binary(action_with_gsn)

    intra_ctx = build_intra_action_context(action.updates)

    {update_ops, group_ids_by_update} =
      Enum.map_reduce(action.updates, [], fn update, acc ->
        {ops, group_ids} =
          build_update_ops(action.id, update, gsn, rocks_name, resolve_opts, intra_ctx)

        {ops, [group_ids | acc]}
      end)

    group_ids =
      group_ids_by_update
      |> Enum.reverse()
      |> List.flatten()
      |> Enum.uniq()

    ops =
      [
        {:put, RocksDB.cf_actions(rocks_name), RocksDB.encode_gsn_key(gsn), action_etf},
        {:put, RocksDB.cf_action_dedup(rocks_name), action.id, RocksDB.encode_gsn_key(gsn)}
      ] ++ List.flatten(update_ops)

    {ops, group_ids}
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

  defp build_update_ops(action_id, update, gsn, rocks_name, resolve_opts, intra_ctx) do
    update_etf = :erlang.term_to_binary(update)

    group_ids = group_ids_for_update(update, resolve_opts, intra_ctx)

    index_ops =
      Enum.map(group_ids, fn group_id ->
        key = RocksDB.encode_group_action_key(group_id, gsn)
        {:put, RocksDB.cf_group_actions(rocks_name), key, action_id}
      end)

    ops =
      [
        {:put, RocksDB.cf_updates(rocks_name), RocksDB.encode_update_key(action_id, update.id),
         update_etf},
        {:put, RocksDB.cf_entity_actions(rocks_name),
         RocksDB.encode_entity_gsn_key(update.subject_id, gsn), action_id},
        {:put, RocksDB.cf_type_entities(rocks_name),
         RocksDB.encode_type_entity_key(
           update.subject_type,
           update.subject_id
         ), <<>>}
      ] ++ index_ops

    {ops, group_ids}
  end

  defp group_ids_for_update(update, resolve_opts, intra_ctx) do
    case Keyword.get(resolve_opts, :entity_groups) do
      nil -> []
      _table -> resolve_update_groups(update, resolve_opts, intra_ctx)
    end
  end

  defp resolve_update_groups(update, resolve_opts, intra_ctx) do
    opts = Keyword.put(resolve_opts, :intra_action, intra_ctx)

    case update.subject_type do
      "relationship" ->
        EntityIndex.relationship_groups(
          Fields.get(update.data, "source_id"),
          update.subject_id,
          opts
        )

      type when type in ["entityGroup", "groupMember"] ->
        wire_group_or_resolve(update, type, opts)

      type ->
        EntityIndex.resolve_groups(type, update.subject_id, opts)
    end
  end

  # The by-id cache is empty at write_batch time for a brand-new
  # membership row, so prefer the group on the wire.
  defp wire_group_or_resolve(update, type, opts) do
    case Fields.get(update.data, "group_id") do
      nil -> EntityIndex.resolve_groups(type, update.subject_id, opts)
      group_id -> [group_id]
    end
  end
end
