defmodule EbbServer.Sync.FanOutRouter do
  @moduledoc """
  Routes committed Action batches from the Writer to per-group
  GroupServers, in committed order, gated on the watermark.

  ## What this module does

  The Writer is the only writer of the Action log and notifies
  `FanOutRouter` after each commit. The Router then:

  1. Waits until the committed watermark from `WatermarkTracker` is past
     the batch's end.
  2. Reads the committed Actions from RocksDB.
  3. Takes each Action's group set from the Writer's commit snapshot,
     falling back to `resolve_group_ids/2` (per-Action, via
     `EntityIndex`) only when the notifier did not annotate the GSN.
  4. Dispatches each Action to the right GroupServer pid.

  Using the Writer's snapshot keeps live fan-out in agreement with the
  `cf_group_actions` index catch-up reads: the cache has already moved
  by dispatch time, so re-resolving a `relationship`/`groupMember`
  delete there returns `[]` (its by-id entry is gone and the wire form
  carries no `source_id`).

  ## Resolved holes

  The Writer abandons a claimed range when its commit fails: the range is
  marked resolved (the watermark advances over the hole) and the Writer
  sends `{:range_resolved, from, to}`. That nudge re-reads the watermark
  and re-drains the already-buffered notifications. It never adds, reads,
  or pushes the hole itself — the abandoned GSNs have no durable Actions.

  When multi-Writer pipelining ships (#130 references this path), the
  Router needs ordered-fanout coordination so groups don't see one
  writer's GSN 5 before another's GSN 3. Today, with one Writer, the
  watermark gating is trivially satisfied.

  ## Restart resume

  The in-memory pending buffer is lost if the Router restarts. The
  highest pushed GSN is not: `EbbServer.Sync.FanOutFrontier` persists it
  so `init/1` can resume. On a restart the Router re-derives the
  un-pushed committed ranges from `cf_actions` (and their group sets from
  `cf_group_actions`) between the persisted frontier and the log max, then
  drains them against the watermark. This also recovers commits that
  landed while the Router was down, whose `{:batch_committed, ...}` the
  Writer dropped via its `Process.whereis/1` guard. A cold boot starts
  from the current watermark instead, so it never replays history to
  live subscribers; connecting clients catch up from the log.

  ## SSE out-of-order dispatch is safe

  Even when `process_batch/4` returns disjoint GSN ranges (possible when
  the watermark advances past buffered notifications out of order), the
  Router pushes each range independently. SSE tolerates out-of-order
  events, and clients reconstruct ordered state via `catchUp` before
  consuming the live stream. The FanOutRouter is free to push in arrival
  order; clients converge.

  ## Sibling modules

  - `EbbServer.Sync.GroupServer` — one pid per active group; holds its
    SSE subscribers' senders.
  - `EbbServer.Sync.FanOutFrontier` — persisted last-pushed GSN across a
    Router restart.
  - `EbbServer.Sync.SSEConnection` — one pid per live `GET /sync/live`
    subscription; receives pushes via its GroupServer.

  Started under `EbbServer.Sync.Supervisor`.
  """

  use GenServer

  alias EbbServer.Storage.{
    CacheTables,
    EntityIndex,
    Fields,
    PermissionHelper,
    RocksDB,
    WatermarkTracker
  }

  alias EbbServer.Sync.{FanOutFrontier, GroupDynamicSupervisor, GroupServer}

  @type t :: %__MODULE__{
          pending_notifications: [{non_neg_integer(), non_neg_integer()}],
          pending_groups: %{non_neg_integer() => [String.t()]},
          batch_committed_at: %{{non_neg_integer(), non_neg_integer()} => integer()},
          last_pushed_gsn: non_neg_integer(),
          subscriptions: %{pid() => [String.t()]},
          monitors: %{pid() => reference()}
        }

  defstruct pending_notifications: [],
            pending_groups: %{},
            batch_committed_at: %{},
            last_pushed_gsn: 0,
            subscriptions: %{},
            monitors: %{}

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @spec subscribe([String.t()], pid(), String.t()) :: :ok
  def subscribe(group_ids, connection_pid, actor_id) do
    GenServer.call(__MODULE__, {:subscribe, group_ids, connection_pid, actor_id}, 30_000)
  end

  @spec unsubscribe(pid()) :: :ok
  def unsubscribe(connection_pid) do
    GenServer.call(__MODULE__, {:unsubscribe, connection_pid}, 30_000)
  end

  @spec broadcast_presence([String.t()], String.t(), String.t(), map()) :: :ok
  def broadcast_presence(group_ids, entity_id, actor_id, data) do
    GenServer.cast(__MODULE__, {:broadcast_presence, group_ids, entity_id, actor_id, data})
  end

  @impl true
  def init(_opts) do
    case FanOutFrontier.get() do
      :empty -> {:ok, cold_start()}
      {:ok, last_pushed_gsn} -> {:ok, resume(last_pushed_gsn)}
    end
  end

  # A cold boot must not replay the entire log to live subscribers:
  # connecting clients catch up on connect. Seeding the frontier with the
  # current watermark makes that explicit.
  defp cold_start do
    last_pushed_gsn = committed_watermark()
    FanOutFrontier.put(last_pushed_gsn)
    %__MODULE__{last_pushed_gsn: last_pushed_gsn}
  end

  # Resume after a Router-only restart, or after a commit that landed while
  # the Router was down (the Writer's `Process.whereis/1` guard dropped its
  # `{:batch_committed, ...}`). The in-memory buffer is re-derived from the
  # durable log rather than persisted.
  defp resume(last_pushed_gsn) do
    max_gsn = RocksDB.get_max_gsn()

    {pending_notifications, pending_groups} =
      if max_gsn > last_pushed_gsn do
        {ranges, groups_by_gsn} = recover_committed(last_pushed_gsn + 1, max_gsn)
        {ranges, fill_missing_groups(ranges, groups_by_gsn)}
      else
        {[], %{}}
      end

    state = %__MODULE__{
      pending_notifications: pending_notifications,
      pending_groups: pending_groups,
      last_pushed_gsn: last_pushed_gsn
    }

    {to_push, remaining, new_last} = drain_pending(state, committed_watermark())
    push_and_update(state, to_push, remaining, new_last)
  end

  # Per-Action group resolution falls back to cache-based
  # `resolve_group_ids/2` for GSNs the notifier did not annotate. Recovered
  # Actions have no notifier and the caches may have moved since the
  # commit, so seed an entry for every recovered GSN (`[]` when the Action
  # had no group).
  defp fill_missing_groups(ranges, groups_by_gsn) do
    Enum.reduce(ranges, groups_by_gsn, fn {from, to}, acc ->
      Enum.reduce(from..to, acc, &Map.put_new(&2, &1, []))
    end)
  end

  # The tracker is a sibling under the Storage supervisor and is up before
  # the Sync tree in production, but the Router must still boot if it is not.
  defp committed_watermark do
    if Process.whereis(WatermarkTracker) do
      WatermarkTracker.committed_watermark()
    else
      0
    end
  end

  @impl true
  def handle_info({:batch_committed, from_gsn, to_gsn, groups_by_gsn, committed_at}, state) do
    # Keep the Writer-provided group sets and commit time alongside the
    # buffered ranges, so a range that waits for the watermark still
    # dispatches from the commit snapshot and reports its true latency.
    state = %{
      state
      | pending_groups: Map.merge(state.pending_groups, groups_by_gsn),
        batch_committed_at: Map.put(state.batch_committed_at, {from_gsn, to_gsn}, committed_at)
    }

    {to_push, remaining, new_last} =
      process_batch(state, from_gsn, to_gsn, WatermarkTracker.committed_watermark())

    {:noreply, push_and_update(state, to_push, remaining, new_last)}
  end

  # A resolved hole is not a batch: do not buffer it, read it, or push it.
  # It only means the frontier may have moved past ranges already waiting.
  def handle_info({:range_resolved, _from_gsn, _to_gsn}, state) do
    {to_push, remaining, new_last} = drain_pending(state, WatermarkTracker.committed_watermark())

    {:noreply, push_and_update(state, to_push, remaining, new_last)}
  end

  def handle_info({:DOWN, _ref, :process, pid, _reason}, state) do
    {:noreply, forget_subscriber(state, pid)}
  end

  @impl true
  def handle_call({:subscribe, group_ids, connection_pid, actor_id}, _from, state) do
    for group_id <- group_ids do
      group_pid =
        case DynamicSupervisor.start_child(
               GroupDynamicSupervisor,
               {GroupServer, group_id}
             ) do
          {:ok, pid} ->
            pid

          {:error, {:already_started, pid}} ->
            pid

          {:error, reason} ->
            raise "Failed to start GroupServer for #{group_id}: #{inspect(reason)}"
        end

      # Forward the authenticated actor_id so GroupServer's broadcast_presence
      # guard can filter out self-echoes. (Previously this passed group_id,
      # which made every subscriber look like the group itself.)
      GroupServer.add_subscriber(group_pid, connection_pid, actor_id)
    end

    new_subscriptions =
      Map.update(state.subscriptions, connection_pid, group_ids, fn existing ->
        Enum.uniq(existing ++ group_ids)
      end)

    # Monitor on the first subscribe only; a re-subscribe from the same
    # connection would otherwise stack monitor refs and DOWN messages.
    monitors =
      case Map.fetch(state.monitors, connection_pid) do
        {:ok, _ref} -> state.monitors
        :error -> Map.put(state.monitors, connection_pid, Process.monitor(connection_pid))
      end

    {:reply, :ok, %{state | subscriptions: new_subscriptions, monitors: monitors}}
  end

  @impl true
  def handle_call({:unsubscribe, connection_pid}, _from, state) do
    group_ids = Map.get(state.subscriptions, connection_pid, [])

    for group_id <- group_ids do
      case Registry.lookup(EbbServer.Sync.GroupRegistry, group_id) do
        [{pid, _}] -> GroupServer.remove_subscriber(pid, connection_pid)
        [] -> :ok
      end
    end

    {:reply, :ok, forget_subscriber(state, connection_pid)}
  end

  @impl true
  def handle_cast({:broadcast_presence, group_ids, entity_id, actor_id, data}, state) do
    for group_id <- group_ids do
      case Registry.lookup(EbbServer.Sync.GroupRegistry, group_id) do
        [{pid, _}] -> GroupServer.broadcast_presence(pid, entity_id, actor_id, data)
        [] -> :ok
      end
    end

    {:noreply, state}
  end

  @doc """
  Splits pending notifications into pushable vs waiting for watermark.

  A notification is pushable when:
  - Its from_gsn is at most last_pushed + 1 (contiguous with last pushed)
  - Its to_gsn is at most the watermark (committed)

  Returns {to_push, remaining} where to_push is the contiguous prefix.
  """
  @spec split_pushable(
          pending :: [{non_neg_integer(), non_neg_integer()}],
          last_pushed :: non_neg_integer(),
          watermark :: non_neg_integer()
        ) ::
          {to_push :: [{non_neg_integer(), non_neg_integer()}],
           remaining :: [{non_neg_integer(), non_neg_integer()}]}
  def split_pushable(pending, _last_pushed, watermark) do
    # Only the watermark check matters: an action is pushable when
    # its GSN has been committed. The contiguity check against
    # `last_pushed_gsn` is removed — it blocked the very first action
    # committed after a fresh start (last_pushed_gsn=0 but actions
    # have GSN > 1) and also blocked actions when an SSE subscribed
    # with cursor=0 but other writes had already advanced
    # last_pushed_gsn. SSE connections tolerate out-of-order events;
    # the client uses `catchUp` for ordered backfill of past actions.
    {pushable, remaining} = do_split_pushable(pending, watermark, [])

    {Enum.reverse(pushable), remaining}
  end

  defp do_split_pushable([], _watermark, acc) do
    {acc, []}
  end

  defp do_split_pushable([{from, to} | rest], watermark, acc) do
    if to <= watermark do
      do_split_pushable(rest, watermark, [{from, to} | acc])
    else
      {Enum.reverse(acc), [{from, to} | rest]}
    end
  end

  @doc """
  Pure state transition for processing a batch_committed event.

  Given the current state, a from/to GSN range, and the current watermark,
  returns {to_push, remaining, new_last_pushed_gsn}.

  - to_push: ranges that should be dispatched to GroupServers
  - remaining: pending notifications still waiting for watermark advancement
  - new_last_pushed_gsn: updated last pushed GSN (or unchanged if nothing pushed)
  """
  @spec process_batch(
          state :: t,
          from_gsn :: non_neg_integer(),
          to_gsn :: non_neg_integer(),
          watermark :: non_neg_integer()
        ) :: {
          to_push :: [{non_neg_integer(), non_neg_integer()}],
          remaining :: [{non_neg_integer(), non_neg_integer()}],
          new_last_pushed_gsn :: non_neg_integer()
        }
  def process_batch(state, from_gsn, to_gsn, watermark) do
    pending =
      [{from_gsn, to_gsn} | state.pending_notifications]
      |> Enum.sort_by(&elem(&1, 0))

    split_and_advance(pending, state.last_pushed_gsn, watermark)
  end

  # Re-run the drain over already-buffered notifications only; used by the
  # `{:range_resolved, ...}` nudge, which must not add a range of its own.
  defp drain_pending(state, watermark) do
    pending = Enum.sort_by(state.pending_notifications, &elem(&1, 0))
    split_and_advance(pending, state.last_pushed_gsn, watermark)
  end

  defp split_and_advance(pending, last_pushed_gsn, watermark) do
    {to_push, remaining} = split_pushable(pending, last_pushed_gsn, watermark)

    new_last =
      case List.last(to_push) do
        nil -> last_pushed_gsn
        {_, last} -> last
      end

    {to_push, remaining, new_last}
  end

  @doc """
  Re-derives the un-pushed committed GSN ranges in `[from, to]` and the
  group set each recovered Action belongs to, straight from the durable
  log.

  Called only by `init/1` when the persisted pushed frontier is behind the
  log (a Router restart or a commit that landed while the Router was
  down). Keys alone drive the range folding; `push_gsn_range/4` re-reads
  the Actions when it drains. The group scan is a full
  `cf_group_actions` pass so a group that gains a subscriber after the
  restart still receives the pending Action live.

  Public for unit testing; not part of the GenServer contract.
  """
  @spec recover_committed(non_neg_integer(), non_neg_integer()) ::
          {[{non_neg_integer(), non_neg_integer()}], %{non_neg_integer() => [String.t()]}}
  def recover_committed(from, to) when from <= to do
    {committed_ranges(from, to), groups_by_gsn(from, to)}
  end

  defp committed_ranges(from, to) do
    cf = RocksDB.cf_actions()
    from_key = RocksDB.encode_gsn_key(from)
    to_key = RocksDB.encode_gsn_key(to + 1)

    RocksDB.range_iterator(cf, from_key, to_key)
    |> Stream.map(fn {key, _value} -> RocksDB.decode_gsn_key(key) end)
    |> Enum.reduce([], &fold_gsn_into_range/2)
    |> Enum.reverse()
  end

  # Present GSNs arrive in ascending order, so the range being built is
  # always at the head: extend it when the next GSN is contiguous, start
  # a new one across a hole.
  defp fold_gsn_into_range(gsn, [{range_from, range_to} | rest]) when gsn == range_to + 1 do
    [{range_from, gsn} | rest]
  end

  defp fold_gsn_into_range(gsn, acc), do: [{gsn, gsn} | acc]

  defp groups_by_gsn(from, to) do
    RocksDB.full_iterator(RocksDB.cf_group_actions())
    |> Stream.flat_map(fn {key, _value} ->
      case RocksDB.decode_group_action_key(key) do
        {group_id, gsn} when gsn >= from and gsn <= to -> [{group_id, gsn}]
        _ -> []
      end
    end)
    |> Enum.reduce(%{}, fn {group_id, gsn}, acc ->
      Map.update(acc, gsn, [group_id], &[group_id | &1])
    end)
    |> Map.new(fn {gsn, group_ids} ->
      {gsn, group_ids |> Enum.uniq() |> Enum.sort()}
    end)
  end

  defp push_and_update(state, to_push, remaining, new_last) do
    # A duplicate or overlapping sub-frontier range can return a `new_last`
    # below the current frontier; the GSN invariant is never rewind, so
    # clamp before it reaches memory or the persisted frontier.
    new_last = max(new_last, state.last_pushed_gsn)
    pushed_gsns = Enum.flat_map(to_push, fn {from, to} -> Enum.to_list(from..to) end)

    for {from, to} <- to_push do
      # Recovered ranges have no entry and pass `nil`, which suppresses
      # the latency sample for historical pushes.
      push_gsn_range(
        from,
        to,
        state.pending_groups,
        Map.get(state.batch_committed_at, {from, to})
      )
    end

    # Persist after pushing: at-least-once. A crash between the push and
    # the persist re-pushes the range on resume, which SSE tolerates.
    FanOutFrontier.put(new_last)

    %{
      state
      | pending_notifications: remaining,
        pending_groups: Map.drop(state.pending_groups, pushed_gsns),
        batch_committed_at: Map.drop(state.batch_committed_at, to_push),
        last_pushed_gsn: new_last
    }
  end

  @doc """
  Resolves the set of group ids an Action should fan out to.

  Dispatches each Update through `EntityIndex`, folding in the
  membership rows carried by the Action itself so that a create and
  its `entityGroup` rows land in the same groups. See `EntityIndex`
  for the per-type resolution rules. Updates whose entity is missing
  from the index are silently dropped; the client catches them up via
  `/sync/groups/:id?offset=` instead.

  This is the **fallback** path: the Writer normally hands the Router
  the group set it used to build `cf_group_actions`, from the commit
  snapshot. Resolution here re-reads the caches, which have already
  moved for deletes, so it is only used for GSNs a notifier did not
  annotate.

  Public for unit testing; not part of the GenServer contract.
  """
  @spec resolve_group_ids(map(), keyword()) :: [String.t()]
  def resolve_group_ids(action, opts) do
    intra_action = PermissionHelper.build_intra_action_context(action["updates"] || [])
    opts = Keyword.put(opts, :intra_action, intra_action)

    action["updates"]
    |> Enum.flat_map(&resolve_update_group_ids(&1, opts))
    |> Enum.uniq()
  end

  # A relationship belongs to its source's groups, never its own target.
  defp resolve_update_group_ids(%{"subject_type" => "relationship"} = update, opts) do
    EntityIndex.relationship_groups(
      Fields.get(update["data"], "source_id"),
      update["subject_id"],
      opts
    )
  end

  defp resolve_update_group_ids(update, opts) do
    EntityIndex.resolve_groups(update["subject_type"], update["subject_id"], opts)
  end

  # GroupServers monitor their own subscribers and drop them on exit, so
  # the router only has to forget the connection and its monitor ref.
  defp forget_subscriber(state, pid) do
    {ref, monitors} = Map.pop(state.monitors, pid)

    if ref, do: Process.demonitor(ref, [:flush])

    %{state | subscriptions: Map.delete(state.subscriptions, pid), monitors: monitors}
  end

  defp push_gsn_range(from_gsn, to_gsn, groups_by_gsn, committed_at) do
    cf = RocksDB.cf_actions()
    from_key = RocksDB.encode_gsn_key(from_gsn)
    to_key = RocksDB.encode_gsn_key(to_gsn + 1)

    resolve_opts = [
      entity_groups: CacheTables.entity_groups(),
      entity_groups_by_id: CacheTables.entity_groups_by_id(),
      relationships_by_id: CacheTables.relationships_by_id(),
      group_members_by_id: CacheTables.group_members_by_id()
    ]

    RocksDB.range_iterator(cf, from_key, to_key)
    |> Stream.map(fn {_key, value} -> :erlang.binary_to_term(value, [:safe]) end)
    |> Stream.flat_map(&group_memberships(&1, groups_by_gsn, resolve_opts))
    |> Enum.group_by(fn {group_id, _action} -> group_id end, fn {_group_id, action} -> action end)
    |> Enum.each(fn {group_id, actions} -> push_to_group(group_id, actions, committed_at) end)
  end

  # One push per group per committed range, so a batch that fans out to a
  # group is dispatched — and sampled — once, not once per Action.
  defp group_memberships(action, groups_by_gsn, resolve_opts) do
    group_ids =
      case Map.fetch(groups_by_gsn, action["gsn"]) do
        {:ok, group_ids} -> group_ids
        :error -> resolve_group_ids(action, resolve_opts)
      end

    Enum.map(group_ids, &{&1, action})
  end

  defp push_to_group(group_id, actions, committed_at) do
    case Registry.lookup(EbbServer.Sync.GroupRegistry, group_id) do
      [{pid, _}] -> GroupServer.push_actions(pid, actions, committed_at)
      [] -> :ok
    end
  end
end
