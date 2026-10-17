defmodule EbbServer.Sync.GroupServer do
  @moduledoc """
  Per-Group GenServer that maintains SSE connection subscribers for a Group,
  receives Action batches from the FanOutRouter, and pushes those Actions to
  all subscribers. Self-stops when the last subscriber leaves.

  A group may run as K shards (`:fanout_group_shards`), each a separate
  `{group_id, shard}` process holding the subscribers that hash to it. A
  batch is pushed to every shard; each subscriber lives on exactly one.
  """

  use GenServer, restart: :transient

  alias EbbServer.Telemetry

  @type action :: %{
          id: String.t(),
          actor_id: String.t(),
          hlc: non_neg_integer(),
          gsn: non_neg_integer(),
          updates: [map()]
        }

  @type t :: %__MODULE__{
          group_id: String.t(),
          shard: non_neg_integer(),
          subscribers: MapSet.t(pid()),
          actors: %{pid() => String.t()}
        }

  defstruct group_id: nil, shard: 0, subscribers: MapSet.new(), actors: %{}

  @spec start_link(String.t() | {String.t(), non_neg_integer()}) :: GenServer.on_start()
  def start_link(group_id) when is_binary(group_id), do: start_link({group_id, 0})

  def start_link({group_id, shard}) do
    name = {:via, Registry, {EbbServer.Sync.GroupRegistry, {group_id, shard}}}
    GenServer.start_link(__MODULE__, {group_id, shard}, name: name)
  end

  @spec push_actions(pid(), [action()], integer() | nil) :: :ok
  def push_actions(pid, actions, committed_at \\ nil) do
    GenServer.cast(pid, {:push_actions, actions, committed_at})
  end

  @spec add_subscriber(pid(), pid(), String.t()) :: :ok
  def add_subscriber(pid, connection_pid, actor_id) do
    GenServer.call(pid, {:add_subscriber, connection_pid, actor_id}, 5_000)
  end

  @spec remove_subscriber(pid(), pid()) :: :ok
  def remove_subscriber(pid, connection_pid) do
    GenServer.cast(pid, {:remove_subscriber, connection_pid})
  end

  @spec broadcast_presence(pid(), String.t(), String.t(), map()) :: :ok
  def broadcast_presence(pid, entity_id, actor_id, data) do
    GenServer.cast(pid, {:broadcast_presence, entity_id, actor_id, data})
  end

  @impl true
  def init({group_id, shard}) do
    Registry.register(EbbServer.Sync.GroupRegistry, {group_id, shard}, :group_server)
    {:ok, %__MODULE__{group_id: group_id, shard: shard}}
  end

  @impl true
  def handle_call({:add_subscriber, connection_pid, actor_id}, _from, state) do
    Process.monitor(connection_pid)

    new_state = %{
      state
      | subscribers: MapSet.put(state.subscribers, connection_pid),
        actors: Map.put(state.actors, connection_pid, actor_id)
    }

    {:reply, :ok, new_state}
  end

  alias EbbServer.Sync.SSEConnection

  @impl true
  def handle_cast({:push_actions, actions, committed_at}, state) do
    # The payload is identical for every subscriber of this group, so the
    # frames are encoded once per batch and the resulting binary is shared
    # with every subscriber instead of encoding N×A small maps.
    bytes = actions |> Enum.map(&SSEConnection.data_frame/1) |> IO.iodata_to_binary()

    for subscriber <- state.subscribers, do: SSEConnection.push_data(subscriber, bytes)

    # One sample per batch per shard. A recovered range has no commit
    # time, so it must not be reported as a latency sample.
    if is_integer(committed_at) do
      Telemetry.execute(
        [:fanout, :push_latency_ms],
        %{duration: System.monotonic_time() - committed_at},
        %{group_id: state.group_id}
      )
    end

    {:noreply, state}
  end

  @impl true
  def handle_cast({:remove_subscriber, connection_pid}, state) do
    new_subscribers = MapSet.delete(state.subscribers, connection_pid)
    new_actors = Map.delete(state.actors, connection_pid)

    if MapSet.size(new_subscribers) == 0 do
      {:stop, :normal, %{state | subscribers: new_subscribers, actors: new_actors}}
    else
      {:noreply, %{state | subscribers: new_subscribers, actors: new_actors}}
    end
  end

  @impl true
  def handle_cast({:broadcast_presence, entity_id, actor_id, data}, state) do
    # `entity_id` is the original entity_id from POST /sync/presence
    # (e.g., "doc_demo"). We forward it on the wire event so subscribers
    # can filter by document — not just by group ("grp_demo").

    for {subscriber_pid, subscriber_actor} <- state.actors do
      if subscriber_actor != actor_id do
        try do
          SSEConnection.push_presence(subscriber_pid, %{
            "actor_id" => actor_id,
            "entity_id" => entity_id,
            "data" => data
          })
        catch
          _, _ -> :ok
        end
      end
    end

    {:noreply, state}
  end

  @impl true
  def handle_info({:DOWN, _ref, :process, pid, _reason}, state) do
    new_subscribers = MapSet.delete(state.subscribers, pid)
    new_actors = Map.delete(state.actors, pid)

    if MapSet.size(new_subscribers) == 0 do
      {:stop, :normal, %{state | subscribers: new_subscribers, actors: new_actors}}
    else
      {:noreply, %{state | subscribers: new_subscribers, actors: new_actors}}
    end
  end
end
