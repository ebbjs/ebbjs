defmodule EbbServer.Sync.GroupServer do
  @moduledoc """
  Per-Group GenServer that maintains SSE connection subscribers for a Group,
  receives Action batches from the FanOutRouter, and pushes those Actions to
  all subscribers. Self-stops when the last subscriber leaves.
  """

  use GenServer, restart: :transient

  @type action :: %{
          id: String.t(),
          actor_id: String.t(),
          hlc: non_neg_integer(),
          gsn: non_neg_integer(),
          updates: [map()]
        }

  @type t :: %__MODULE__{
          group_id: String.t(),
          subscribers: MapSet.t(pid()),
          actors: %{pid() => String.t()}
        }

  defstruct group_id: nil, subscribers: MapSet.new(), actors: %{}

  @spec start_link(String.t()) :: GenServer.on_start()
  def start_link(group_id) do
    name = {:via, Registry, {EbbServer.Sync.GroupRegistry, group_id}}
    GenServer.start_link(__MODULE__, group_id, name: name)
  end

  @spec push_actions(pid(), [action()]) :: :ok
  def push_actions(pid, actions) do
    GenServer.cast(pid, {:push_actions, actions})
  end

  @spec add_subscriber(pid(), pid(), String.t()) :: :ok
  def add_subscriber(pid, connection_pid, actor_id) do
    GenServer.call(pid, {:add_subscriber, connection_pid, actor_id})
  end

  @spec remove_subscriber(pid(), pid()) :: :ok
  def remove_subscriber(pid, connection_pid) do
    GenServer.cast(pid, {:remove_subscriber, connection_pid})
  end

  @spec broadcast_presence(pid(), String.t(), map()) :: :ok
  def broadcast_presence(pid, actor_id, data) do
    GenServer.cast(pid, {:broadcast_presence, actor_id, data})
  end

  @impl true
  def init(group_id) do
    Registry.register(EbbServer.Sync.GroupRegistry, group_id, :group_server)
    {:ok, %__MODULE__{group_id: group_id}}
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
  def handle_cast({:push_actions, actions}, state) do
    for subscriber <- state.subscribers do
      for action <- actions do
        SSEConnection.push_action(subscriber, action)
      end
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
  def handle_cast({:broadcast_presence, actor_id, data}, state) do
    for {subscriber_pid, subscriber_actor} <- state.actors do
      if subscriber_actor != actor_id do
        SSEConnection.push_presence(subscriber_pid, %{
          "actor_id" => actor_id,
          "entity_id" => state.group_id,
          "data" => data
        })
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
