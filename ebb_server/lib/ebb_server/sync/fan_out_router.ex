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

  When multi-Writer pipelining ships (#130 references this path), the
  Router needs ordered-fanout coordination so groups don't see one
  writer's GSN 5 before another's GSN 3. Today, with one Writer, the
  watermark gating is trivially satisfied.

  ## SSE out-of-order dispatch is safe

  Even when `process_batch/4` returns disjoint GSN ranges (possible when
  the watermark advances past buffered notifications out of order),
  `dispatch_to_groups/3` writes each Action independently to its group.
  SSE tolerates out-of-order events, and clients reconstruct ordered
  state via `catchUp` before consuming the live stream. The FanOutRouter
  is free to push in arrival order; clients converge.

  ## Sibling modules

  - `EbbServer.Sync.GroupServer` — one pid per active group; holds its
    SSE subscribers' senders.
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

  alias EbbServer.Sync.{GroupDynamicSupervisor, GroupServer}

  @type t :: %__MODULE__{
          pending_notifications: [{non_neg_integer(), non_neg_integer()}],
          pending_groups: %{non_neg_integer() => [String.t()]},
          last_pushed_gsn: non_neg_integer(),
          subscriptions: %{pid() => [String.t()]}
        }

  defstruct pending_notifications: [], pending_groups: %{}, last_pushed_gsn: 0, subscriptions: %{}

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
    {:ok, %__MODULE__{}}
  end

  @impl true
  def handle_info({:batch_committed, from_gsn, to_gsn, groups_by_gsn}, state) do
    watermark = WatermarkTracker.committed_watermark()

    # Keep the Writer-provided group sets alongside the buffered ranges,
    # so a range that waits for the watermark still dispatches from the
    # commit snapshot instead of the by-then-mutated caches.
    pending_groups = Map.merge(state.pending_groups, groups_by_gsn)
    state = %{state | pending_groups: pending_groups}

    {to_push, remaining, new_last} = process_batch(state, from_gsn, to_gsn, watermark)

    pushed_gsns = Enum.flat_map(to_push, fn {from, to} -> Enum.to_list(from..to) end)

    for {from, to} <- to_push do
      push_gsn_range(from, to, pending_groups)
    end

    {:noreply,
     %{
       state
       | pending_notifications: remaining,
         pending_groups: Map.drop(pending_groups, pushed_gsns),
         last_pushed_gsn: new_last
     }}
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

    {:reply, :ok, %{state | subscriptions: new_subscriptions}}
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

    new_subscriptions = Map.delete(state.subscriptions, connection_pid)
    {:reply, :ok, %{state | subscriptions: new_subscriptions}}
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

    {to_push, remaining} = split_pushable(pending, state.last_pushed_gsn, watermark)

    new_last =
      case List.last(to_push) do
        nil -> state.last_pushed_gsn
        {_, last} -> last
      end

    {to_push, remaining, new_last}
  end

  @doc """
  Resolves the set of group ids an Action should fan out to.

  Dispatches each Update through `EntityIndex`, folding in the
  membership edges carried by the Action itself so that a create and
  its `kind: "member"` edges land in the same groups. See
  `EntityIndex` for the per-type resolution rules. Updates whose entity
  is missing from the index are silently dropped; the client catches
  them up via `/sync/groups/:id?offset=` instead.

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

  defp push_gsn_range(from_gsn, to_gsn, groups_by_gsn) do
    cf = RocksDB.cf_actions()
    from_key = RocksDB.encode_gsn_key(from_gsn)
    to_key = RocksDB.encode_gsn_key(to_gsn + 1)

    resolve_opts = [
      relationships: CacheTables.relationships(),
      relationships_by_id: CacheTables.relationships_by_id(),
      group_members_by_id: CacheTables.group_members_by_id()
    ]

    RocksDB.range_iterator(cf, from_key, to_key)
    |> Stream.map(fn {_key, value} -> :erlang.binary_to_term(value, [:safe]) end)
    |> Stream.each(&dispatch_to_groups(&1, resolve_opts, groups_by_gsn))
    |> Stream.run()
  end

  defp dispatch_to_groups(action, resolve_opts, groups_by_gsn) do
    group_ids =
      case Map.fetch(groups_by_gsn, action["gsn"]) do
        {:ok, group_ids} -> group_ids
        :error -> resolve_group_ids(action, resolve_opts)
      end

    for group_id <- group_ids do
      case Registry.lookup(EbbServer.Sync.GroupRegistry, group_id) do
        [{pid, _}] -> GroupServer.push_actions(pid, [action])
        [] -> :ok
      end
    end
  end
end
