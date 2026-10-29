defmodule EbbServer.Sync.GroupServer do
  @moduledoc """
  Per-Group GenServer that maintains SSE connection subscribers for a Group,
  receives already-encoded SSE frames from the FanOutRouter, and pushes them
  to all subscribers as one concatenated binary. Self-stops when the last
  subscriber leaves.
  """

  use GenServer, restart: :transient

  alias EbbServer.Sync.GroupRegistry
  alias EbbServer.Telemetry

  @type frame_batch :: [binary()]

  @type t :: %__MODULE__{
          group_id: String.t(),
          subscribers: MapSet.t(pid()),
          actors: %{pid() => String.t()}
        }

  defstruct group_id: nil, subscribers: MapSet.new(), actors: %{}

  @spec start_link(String.t()) :: GenServer.on_start()
  def start_link(group_id) do
    GenServer.start_link(__MODULE__, group_id, name: GroupRegistry.name(group_id))
  end

  @default_conn_sample_rate 100

  @spec push_actions(pid(), frame_batch(), map()) :: :ok
  def push_actions(pid, frames, meta \\ %{}) do
    GenServer.cast(pid, {:push_actions, frames, meta})
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
  def init(group_id) do
    Registry.register(GroupRegistry, group_id, :group_server)
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
  def handle_cast({:push_actions, frames, meta}, state) do
    received_at = System.monotonic_time()
    cast_at = Map.get(meta, :cast_at)
    committed_at = Map.get(meta, :committed_at)
    sample_rate = Map.get(meta, :conn_sample_rate, @default_conn_sample_rate)

    Telemetry.fanout_hop(:group_queue, span(cast_at, received_at), state.group_id)

    # One frame per Action, and every subscriber of this group gets the
    # same bytes, so the batch is flattened once and that binary is shared.
    encode_started_at = System.monotonic_time()

    bytes = IO.iodata_to_binary(frames)
    encode_finished_at = System.monotonic_time()

    Telemetry.fanout_hop(
      :group_encode,
      span(encode_started_at, encode_finished_at),
      state.group_id
    )

    offset =
      if is_integer(sample_rate) and sample_rate > 1, do: :rand.uniform(sample_rate) - 1, else: 0

    Enum.each(Enum.with_index(state.subscribers), fn {subscriber, index} ->
      if sample_delivery?(sample_rate, index, offset) do
        SSEConnection.push_data(subscriber, bytes, %{
          cast_at: System.monotonic_time(),
          group_id: state.group_id
        })
      else
        SSEConnection.push_data(subscriber, bytes)
      end
    end)

    Telemetry.fanout_hop(
      :group_cast,
      span(encode_finished_at, System.monotonic_time()),
      state.group_id
    )

    # Observability counter, not a latency: deliveries enqueued for this
    # batch are `count` Actions × the group's subscriber fan-out.
    Telemetry.execute(
      [:fanout, :dispatched_actions],
      %{count: length(frames), subscribers: MapSet.size(state.subscribers)},
      %{group_id: state.group_id}
    )

    # One sample per batch per group. A recovered range has no commit
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

  # One random offset per batch, then a fixed stride: 0 samples nothing,
  # 1 samples every delivery, `K > 1` samples 1 in `K`. Keeping the random
  # draw out of the per-subscriber loop matters at large fan-out.
  defp sample_delivery?(0, _index, _offset), do: false
  defp sample_delivery?(1, _index, _offset), do: true

  defp sample_delivery?(rate, index, offset) when is_integer(rate) and rate > 1 do
    rem(index + offset, rate) == 0
  end

  defp sample_delivery?(_rate, _index, _offset), do: true

  defp span(from, to) when is_integer(from) and is_integer(to), do: max(to - from, 0)
  defp span(_from, _to), do: nil
end
