defmodule EbbServer.Sync.FanOutRouter do
  @moduledoc """
  Routes committed Action batches from the Writer to per-group
  GroupServers, in claim order, gated on the watermark.

  ## SSE out-of-order dispatch is safe

  Even when the Plan releases disjoint GSN ranges (possible across a
  resolved hole), the Router pushes each range independently. SSE
  tolerates out-of-order events, and clients reconstruct ordered state via
  `catchUp` before consuming the live stream. The FanOutRouter is free to
  push ranges in release order; clients converge.

  ## groups_changed control events

  A committed, applied range that changes an actor's group view pushes
  `event: control` with `{"groups_changed": true, "reason":
  "membership"}` to every live connection of every affected actor. The
  Writer decides which actors were affected while it applies its planned
  cache mutations, so the push happens on the post-apply path, never at
  commit time. A client that reacts immediately therefore cannot
  handshake into the pre-apply state.

  ## Group registry outage

  GroupServers are found through `EbbServer.Sync.GroupRegistry`, a sibling
  of this tree. While the registry is unregistered a push has no
  destination — no GroupServer can outlive the registry it registers in —
  so the push is dropped. Crashing instead restarts this process into the
  same push (`init/1` re-derives the un-pushed ranges), and that restart
  loop consumes `Sync.Supervisor`'s restart intensity, which takes the tree
  and any process linked to it down with it (#653).
  """

  use GenServer

  require Logger

  alias EbbServer.Storage.{ActionFormat, ActionScope, CacheTables, RocksDB, WatermarkTracker}

  alias EbbServer.Sync.{FanOutFrontier, GroupDynamicSupervisor, GroupRegistry, GroupServer}
  alias EbbServer.Sync.FanOutRouter.{Frames, GroupResolution, Plan, Recovery}
  alias EbbServer.Sync.SSEConnection
  alias EbbServer.Telemetry

  @default_conn_sample_rate 100
  @groups_changed %{"groups_changed" => true, "reason" => "membership"}

  @type t :: %__MODULE__{
          plan: Plan.t(),
          pending_groups: %{non_neg_integer() => [String.t()]},
          batch_meta: %{
            {non_neg_integer(), non_neg_integer()} => %{
              committed_at: integer() | nil,
              received_at: integer() | nil,
              payloads: [ActionFormat.carried_payload()] | nil,
              affected_actors: [String.t()] | nil
            }
          },
          conn_sample_rate: non_neg_integer(),
          subscriptions: %{pid() => [String.t()]},
          monitors: %{pid() => reference()},
          actor_connections: %{String.t() => MapSet.t(pid())},
          connection_actors: %{pid() => String.t()}
        }

  defstruct plan: %Plan{},
            pending_groups: %{},
            batch_meta: %{},
            conn_sample_rate: 1,
            subscriptions: %{},
            monitors: %{},
            actor_connections: %{},
            connection_actors: %{}

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
    conn_sample_rate =
      Application.get_env(:ebb_server, :fanout_conn_sample_rate, @default_conn_sample_rate)

    case FanOutFrontier.get() do
      :empty -> {:ok, cold_start(conn_sample_rate)}
      {:ok, last_pushed_gsn} -> {:ok, resume(last_pushed_gsn, conn_sample_rate)}
    end
  end

  # A cold boot must not replay the entire log to live subscribers:
  # connecting clients catch up on connect. Seeding the frontier with the
  # current watermark makes that explicit.
  defp cold_start(conn_sample_rate) do
    last_pushed_gsn = committed_watermark()
    FanOutFrontier.put(last_pushed_gsn)

    %__MODULE__{
      plan: Plan.new(last_pushed_gsn: last_pushed_gsn),
      conn_sample_rate: conn_sample_rate
    }
  end

  # Resume after a Router-only restart, or after a commit that landed while
  # the Router was down (the Writer's `Process.whereis/1` guard dropped its
  # `{:batch_committed, ...}`). The in-memory buffer is re-derived from the
  # durable log rather than persisted.
  defp resume(last_pushed_gsn, conn_sample_rate) do
    max_gsn = RocksDB.get_max_gsn()

    {pending_notifications, pending_groups} =
      if max_gsn > last_pushed_gsn do
        {ranges, groups_by_gsn} = Recovery.recover_committed(last_pushed_gsn + 1, max_gsn)
        {ranges, fill_missing_groups(ranges, groups_by_gsn)}
      else
        {[], %{}}
      end

    state = %__MODULE__{
      pending_groups: pending_groups,
      conn_sample_rate: conn_sample_rate,
      plan:
        Plan.new(pending_notifications: pending_notifications, last_pushed_gsn: last_pushed_gsn)
    }

    {to_push, plan} = Plan.split_pushable(state.plan, committed_watermark())
    push_and_update(%{state | plan: plan}, to_push, nil)
  end

  # Per-Action group resolution falls back to cache-based
  # `GroupResolution.resolve_group_ids/2` for GSNs the notifier did not
  # annotate. Recovered Actions have no notifier and the caches may have
  # moved since the commit, so seed an entry for every recovered GSN (`[]`
  # when the Action had no group).
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
  # The pre-#534 notification carries no actor set, so it can name no
  # connection to wake; it still dispatches its Actions.
  def handle_info(
        {:batch_committed, from_gsn, to_gsn, groups_by_gsn, committed_at, payloads},
        state
      ) do
    handle_committed_range(from_gsn, to_gsn, groups_by_gsn, committed_at, payloads, [], state)
  end

  def handle_info(
        {:batch_committed, from_gsn, to_gsn, groups_by_gsn, committed_at, payloads,
         affected_actors},
        state
      ) do
    handle_committed_range(
      from_gsn,
      to_gsn,
      groups_by_gsn,
      committed_at,
      payloads,
      affected_actors,
      state
    )
  end

  # A resolved hole is not a batch: do not buffer it, read it, or push it.
  # Dropping its claim lets the next acknowledged range become releasable
  # once the watermark passes the hole.
  def handle_info({:range_resolved, from_gsn, to_gsn}, state) do
    range = {from_gsn, to_gsn}

    {to_push, plan} =
      state.plan
      |> Plan.resolve(range)
      |> Plan.split_pushable(WatermarkTracker.committed_watermark())

    # A resolved hole is never pushed, so this is only defensive: no
    # payloads or group sets should outlive their claim. Dropping the group
    # set too keeps a permanent hole from leaving a permanent entry.
    state = %{
      state
      | plan: plan,
        batch_meta: Map.drop(state.batch_meta, [range]),
        pending_groups: drop_groups(state.pending_groups, range)
    }

    {:noreply, push_and_update(state, to_push, nil)}
  end

  def handle_info({:DOWN, _ref, :process, pid, _reason}, state) do
    {:noreply, forget_subscriber(state, pid)}
  end

  defp handle_committed_range(
         from_gsn,
         to_gsn,
         groups_by_gsn,
         committed_at,
         payloads,
         affected_actors,
         state
       ) do
    received_at = System.monotonic_time()
    range = {from_gsn, to_gsn}

    meta = %{
      committed_at: committed_at,
      received_at: received_at,
      payloads: payloads,
      affected_actors: affected_actors
    }

    state = %{
      state
      | pending_groups: Map.merge(state.pending_groups, groups_by_gsn),
        batch_meta: Map.put(state.batch_meta, range, meta)
    }

    {to_push, plan} =
      Plan.process_batch(
        state.plan,
        from_gsn,
        to_gsn,
        WatermarkTracker.committed_watermark()
      )

    {:noreply, push_and_update(%{state | plan: plan}, to_push, range)}
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
      # guard can filter out self-echoes.
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

    state = put_actor_connection(state, connection_pid, actor_id)

    {:reply, :ok, %{state | subscriptions: new_subscriptions, monitors: monitors}}
  end

  @impl true
  def handle_call({:unsubscribe, connection_pid}, _from, state) do
    group_ids = Map.get(state.subscriptions, connection_pid, [])

    for_each_group(group_ids, &GroupServer.remove_subscriber(&1, connection_pid))

    {:reply, :ok, forget_subscriber(state, connection_pid)}
  end

  @impl true
  def handle_cast({:broadcast_presence, group_ids, entity_id, actor_id, data}, state) do
    for_each_group(group_ids, fn pid ->
      GroupServer.broadcast_presence(pid, entity_id, actor_id, data)
    end)

    {:noreply, state}
  end

  defp push_and_update(state, to_push, just_received) do
    pushed_gsns = Enum.flat_map(to_push, fn {from, to} -> Enum.to_list(from..to) end)
    released_at = System.monotonic_time()

    for {from, to} = range <- to_push do
      meta = Map.get(state.batch_meta, range, %{})
      committed_at = Map.get(meta, :committed_at)
      received_at = Map.get(meta, :received_at)

      # A recovered range has no commit time and no receive time, so it
      # emits neither the queue nor the dwell hop.
      Telemetry.fanout_hop(:router_queue, span(committed_at, received_at), nil)
      emit_dwell(received_at, released_at, range, just_received)

      push_gsn_range(from, to, state.pending_groups, state.actor_connections, %{
        affected_actors: Map.get(meta, :affected_actors) || [],
        committed_at: committed_at,
        conn_sample_rate: state.conn_sample_rate,
        payloads: Map.get(meta, :payloads)
      })
    end

    # Persist after pushing: at-least-once. A crash between the push and
    # the persist re-pushes the range on resume, which SSE tolerates.
    FanOutFrontier.put(state.plan.last_pushed_gsn)

    %{
      state
      | pending_groups: Map.drop(state.pending_groups, pushed_gsns),
        batch_meta: Map.drop(state.batch_meta, to_push)
    }
  end

  # The buffered wait is only real for a range released by a later event;
  # the immediate path would report a ~0 sample for the same `handle_info`.
  defp emit_dwell(received_at, released_at, range, just_received)
       when range != just_received do
    case span(received_at, released_at) do
      duration when is_integer(duration) and duration > 0 ->
        Telemetry.fanout_hop(:router_dwell, duration, nil)

      _ ->
        :ok
    end
  end

  defp emit_dwell(_received_at, _released_at, _range, _just_received), do: :ok

  defp span(from, to) when is_integer(from) and is_integer(to), do: max(to - from, 0)
  defp span(_from, _to), do: nil

  defp drop_groups(pending_groups, {from_gsn, to_gsn}) do
    Enum.reduce(from_gsn..to_gsn, pending_groups, &Map.delete(&2, &1))
  end

  # GroupServers monitor their own subscribers and drop them on exit, so
  # the router only has to forget the connection, its monitor ref, and its
  # entry in the actor index.
  defp forget_subscriber(state, pid) do
    {ref, monitors} = Map.pop(state.monitors, pid)

    if ref, do: Process.demonitor(ref, [:flush])

    state
    |> forget_actor_connection(pid)
    |> Map.put(:subscriptions, Map.delete(state.subscriptions, pid))
    |> Map.put(:monitors, monitors)
  end

  # One connection belongs to one authenticated actor, so the reverse map
  # turns unsubscribe and DOWN into a single lookup.
  defp put_actor_connection(state, connection_pid, actor_id) do
    state = forget_actor_connection(state, connection_pid)

    %{
      state
      | connection_actors: Map.put(state.connection_actors, connection_pid, actor_id),
        actor_connections:
          Map.update(
            state.actor_connections,
            actor_id,
            MapSet.new([connection_pid]),
            &MapSet.put(&1, connection_pid)
          )
    }
  end

  defp forget_actor_connection(state, pid) do
    case Map.pop(state.connection_actors, pid) do
      {nil, _connection_actors} ->
        state

      {actor_id, connection_actors} ->
        %{
          state
          | connection_actors: connection_actors,
            actor_connections: drop_actor_connection(state.actor_connections, actor_id, pid)
        }
    end
  end

  defp drop_actor_connection(actor_connections, actor_id, pid) do
    case Map.fetch(actor_connections, actor_id) do
      :error ->
        actor_connections

      {:ok, pids} ->
        remaining = MapSet.delete(pids, pid)

        if MapSet.size(remaining) == 0,
          do: Map.delete(actor_connections, actor_id),
          else: Map.put(actor_connections, actor_id, remaining)
    end
  end

  defp push_gsn_range(from_gsn, to_gsn, groups_by_gsn, actor_connections, meta) do
    decode_started_at = System.monotonic_time()

    # All registered caches, so a delete naming no component still resolves
    # its row's kind, and so its scope.
    resolve_opts = [
      memberships: CacheTables.memberships(),
      memberships_by_id: CacheTables.memberships_by_id(),
      entity_models: CacheTables.entity_models(),
      relationships_by_id: CacheTables.relationships_by_id(),
      grants_by_id: CacheTables.grants_by_id(),
      group_apps: CacheTables.group_apps()
    ]

    actions =
      case carried_actions(meta, from_gsn, to_gsn) do
        {:ok, actions} -> actions
        :read_log -> read_log_actions(from_gsn, to_gsn)
      end

    memberships =
      actions
      |> Stream.flat_map(&grantships(&1, groups_by_gsn, resolve_opts))
      |> Enum.to_list()

    Telemetry.fanout_hop(:router_decode, System.monotonic_time() - decode_started_at, nil)

    encode_started_at = System.monotonic_time()
    live_groups = live_group_pids(memberships)

    live_memberships =
      Enum.filter(memberships, fn {group_id, _action} -> Map.has_key?(live_groups, group_id) end)

    frames_by_group = Frames.build(live_memberships)
    Telemetry.fanout_hop(:router_encode, System.monotonic_time() - encode_started_at, nil)

    Enum.each(frames_by_group, fn {group_id, frames} ->
      GroupServer.push_actions(Map.fetch!(live_groups, group_id), frames, %{
        committed_at: meta.committed_at,
        cast_at: System.monotonic_time(),
        conn_sample_rate: meta.conn_sample_rate
      })
    end)

    # The actor index, not the frame fan-out, decides who is woken: a
    # membership row is scoped to the group it grants, so an actor added to
    # a group nobody subscribes to can still be live on another one.
    push_groups_changed(actor_connections, meta.affected_actors)
  end

  defp push_groups_changed(actor_connections, affected_actors) do
    Enum.each(affected_actors, fn actor_id ->
      for pid <- Map.get(actor_connections, actor_id, []) do
        SSEConnection.push_control(pid, @groups_changed)
      end
    end)
  end

  # Only groups with a live GroupServer can receive a push. Resolving them
  # before the encode keeps an unsubscribed group's Actions out of the frame
  # build.
  defp live_group_pids(memberships) do
    memberships
    |> Enum.map(&elem(&1, 0))
    |> Enum.uniq()
    |> Enum.reduce(%{}, fn group_id, live ->
      case GroupRegistry.lookup(group_id) do
        nil -> live
        pid -> Map.put(live, group_id, pid)
      end
    end)
  end

  # The Writer sends the payload and scopes for every GSN in the range, in
  # claim order, so position supplies the key's GSN. A length mismatch means
  # the notification is not a complete live hand-off: fall back to the log
  # rather than let a shifted list attach a GSN to the wrong payload.
  defp carried_actions(%{payloads: payloads}, from_gsn, to_gsn) when is_list(payloads) do
    expected = to_gsn - from_gsn + 1

    case length(payloads) do
      ^expected ->
        {:ok,
         payloads
         |> Enum.with_index(from_gsn)
         |> Enum.map(fn {{payload_etf, subject_scopes}, gsn} ->
           ActionFormat.decode_carried(payload_etf, subject_scopes, gsn)
         end)}

      actual ->
        Logger.error(
          "fan-out range #{from_gsn}..#{to_gsn} carried #{actual} payloads, " <>
            "expected #{expected}; reading cf_actions"
        )

        :read_log
    end
  end

  defp carried_actions(_meta, _from_gsn, _to_gsn), do: :read_log

  defp read_log_actions(from_gsn, to_gsn) do
    cf = RocksDB.cf_actions()
    from_key = RocksDB.encode_gsn_key(from_gsn)
    to_key = RocksDB.encode_gsn_key(to_gsn + 1)

    RocksDB.range_iterator(cf, from_key, to_key)
    |> Stream.map(fn {key, value} -> ActionFormat.decode(value, RocksDB.decode_gsn_key(key)) end)
  end

  # One push per group per committed range, so a batch that fans out to a
  # group is dispatched — and sampled — once, not once per Action.
  defp grantships(action, groups_by_gsn, resolve_opts) do
    group_ids =
      case Map.fetch(groups_by_gsn, action["gsn"]) do
        {:ok, group_ids} -> group_ids
        :error -> GroupResolution.resolve_group_ids(action, resolve_opts)
      end

    Enum.flat_map(group_ids, fn group_id ->
      case ActionScope.updates_for_group(action, group_id) do
        [] -> []
        updates -> [{group_id, Map.put(action, "updates", updates)}]
      end
    end)
  end

  defp for_each_group(group_ids, fun) do
    Enum.each(group_ids, fn group_id ->
      case GroupRegistry.lookup(group_id) do
        nil -> :ok
        pid -> fun.(pid)
      end
    end)
  end
end
