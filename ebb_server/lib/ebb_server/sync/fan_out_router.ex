defmodule EbbServer.Sync.FanOutRouter do
  @moduledoc """
  Routes committed action batches to subscribed GroupServers.

  Receives `{:batch_committed, from_gsn, to_gsn}` notifications from Writers,
  gates delivery on the committed watermark to ensure ordering despite
  concurrent writers, reads committed Actions from RocksDB, resolves affected
  Groups, and dispatches to per-Group GenServers.

  ## Watermark Gating

  Writer batches may arrive out-of-order due to concurrent writes. The
  FanOutRouter buffers notifications and only pushes contiguous GSN ranges
  up to the committed watermark from WatermarkTracker.

  ## Supervision

  Started under `EbbServer.Sync.Supervisor`.
  """

  use GenServer

  alias EbbServer.Storage.{RelationshipCache, RocksDB, WatermarkTracker}
  alias EbbServer.Sync.{GroupDynamicSupervisor, GroupServer}

  @type t :: %__MODULE__{
          pending_notifications: [{non_neg_integer(), non_neg_integer()}],
          last_pushed_gsn: non_neg_integer(),
          subscriptions: %{pid() => [String.t()]}
        }

  defstruct pending_notifications: [], last_pushed_gsn: 0, subscriptions: %{}

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @spec subscribe([String.t()], pid()) :: :ok
  def subscribe(group_ids, connection_pid) do
    GenServer.call(__MODULE__, {:subscribe, group_ids, connection_pid}, 30_000)
  end

  @spec unsubscribe(pid()) :: :ok
  def unsubscribe(connection_pid) do
    GenServer.call(__MODULE__, {:unsubscribe, connection_pid}, 30_000)
  end

  @spec broadcast_presence(String.t(), String.t(), map()) :: :ok
  def broadcast_presence(entity_id, actor_id, data) do
    GenServer.cast(__MODULE__, {:broadcast_presence, entity_id, actor_id, data})
  end

  @impl true
  def init(_opts) do
    {:ok, %__MODULE__{}}
  end

  @impl true
  def handle_info({:batch_committed, from_gsn, to_gsn}, state) do
    watermark = WatermarkTracker.committed_watermark()

    {to_push, remaining, new_last} =
      process_batch(state, from_gsn, to_gsn, watermark)

    for {from, to} <- to_push do
      push_gsn_range(from, to)
    end

    {:noreply, %{state | pending_notifications: remaining, last_pushed_gsn: new_last}}
  end

  @impl true
  def handle_call({:subscribe, group_ids, connection_pid}, _from, state) do
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

      GroupServer.add_subscriber(group_pid, connection_pid, group_id)
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
  def handle_cast({:broadcast_presence, entity_id, actor_id, data}, state) do
    case RelationshipCache.get_entity_group(entity_id) do
      nil ->
        :ok

      group_id ->
        case Registry.lookup(EbbServer.Sync.GroupRegistry, group_id) do
          [{pid, _}] -> GroupServer.broadcast_presence(pid, actor_id, data)
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
  def split_pushable(pending, last_pushed, watermark) do
    {pushable, remaining} =
      do_split_pushable(pending, last_pushed, watermark, [])

    {Enum.reverse(pushable), remaining}
  end

  defp do_split_pushable([], _running_last, _watermark, acc) do
    {acc, []}
  end

  defp do_split_pushable([{from, to} | rest], running_last, watermark, acc) do
    if from <= running_last + 1 and to <= watermark do
      do_split_pushable(rest, to, watermark, [{from, to} | acc])
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

  defp push_gsn_range(from_gsn, to_gsn) do
    cf = RocksDB.cf_actions()
    from_key = RocksDB.encode_gsn_key(from_gsn)
    to_key = RocksDB.encode_gsn_key(to_gsn + 1)

    RocksDB.range_iterator(cf, from_key, to_key)
    |> Stream.map(fn {_key, value} -> :erlang.binary_to_term(value, [:safe]) end)
    |> Stream.each(&dispatch_to_groups/1)
    |> Stream.run()
  end

  defp dispatch_to_groups(action) do
    group_ids =
      action["updates"]
      |> Enum.map(& &1["subject_id"])
      |> Enum.map(&RelationshipCache.get_entity_group/1)
      |> Enum.reject(&is_nil/1)
      |> Enum.uniq()

    for group_id <- group_ids do
      case Registry.lookup(EbbServer.Sync.GroupRegistry, group_id) do
        [{pid, _}] -> GroupServer.push_actions(pid, [action])
        [] -> :ok
      end
    end
  end
end
