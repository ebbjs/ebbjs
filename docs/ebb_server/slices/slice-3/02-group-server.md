# GroupServer

## Build Order Position

**Step 2 of 4** -- Depends on SSEConnection. GroupServer wraps SSEConnection for a specific Group, adding subscriber management.

## Purpose

A per-Group GenServer that maintains the set of SSE connection subscribers for a Group, receives Action batches from the FanOutRouter, and pushes those Actions to all subscribers. It self-stops when the last subscriber leaves.

## Responsibilities

- Maintain a subscriber set (`MapSet<pid()>`) for this Group
- Accept subscriber registration/unregistration
- Monitor subscriber pids and remove them on `{:DOWN, ...}`
- Push Actions to all subscribers via `SSEConnection.push_action/2`
- Broadcast presence messages to all subscribers except the sender
- Stop itself (transient strategy) when subscriber set becomes empty

## Public Interface

### Module: `EbbServer.Sync.GroupServer`

| Name                   | Signature                                                                        | Description                                                           |
| ---------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `start_link/1`         | `start_link(group_id :: String.t()) :: GenServer.on_start()`                     | Starts a Group GenServer for the given group_id                       |
| `push_actions/2`       | `push_actions(pid :: pid(), actions :: [action()]) :: :ok`                       | Sends Actions to all subscribers. Cast (async).                       |
| `add_subscriber/2`     | `add_subscriber(pid :: pid(), connection_pid :: pid()) :: :ok`                   | Adds an SSE connection to this Group's subscriber set                 |
| `remove_subscriber/2`  | `remove_subscriber(pid :: pid(), connection_pid :: pid()) :: :ok`                | Removes an SSE connection. Returns `:empty` if no subscribers remain. |
| `broadcast_presence/3` | `broadcast_presence(pid :: pid(), actor_id :: String.t(), data :: map()) :: :ok` | Sends presence to all subscribers except the originating actor        |

### Types

```elixir
@type action :: %{
  "id" => String.t(),
  "actor_id" => String.t(),
  "hlc" => non_neg_integer(),
  "gsn" => non_neg_integer(),
  "updates" => [map()]
}
```

## State

```elixir
@type t :: %__MODULE__{
  group_id: String.t(),
  subscribers: MapSet.t(pid()),
  actors: %{pid() => String.t()}
}

defstruct group_id: nil, subscribers: MapSet.new(), actors: %{}
```

- `group_id`: The Group this server manages
- `subscribers`: Set of SSE connection pids subscribed to this Group
- `actors`: Map from connection pid to actor_id (for presence exclusion)

## Internal Design

### Subscriber monitoring

```elixir
@impl true
def handle_info({:DOWN, _ref, :process, pid, _reason}, state) do
  new_subscribers = MapSet.delete(state.subscribers, pid)
  new_actors = Map.delete(state.actors, pid)

  if MapSet.size(new_subscribers) == 0 do
    {:stop, :normal, state}
  else
    {:noreply, %{state | subscribers: new_subscribers, actors: new_actors}}
  end
end
```

### push_actions (cast)

```elixir
@impl true
def handle_cast({:push_actions, actions}, state) do
  for subscriber <- state.subscribers do
    for action <- actions do
      SSEConnection.push_action(subscriber, action)
    end
  end
  {:noreply, state}
end
```

### add_subscriber

```elixir
@impl true
def handle_call({:add_subscriber, connection_pid, actor_id}, _from, state) do
  # Monitor the connection process
  Process.monitor(connection_pid)

  new_state = %{
    state
    | subscribers: MapSet.put(state.subscribers, connection_pid),
      actors: Map.put(state.actors, connection_pid, actor_id)
  }

  {:reply, :ok, new_state}
end
```

### broadcast_presence

```elixir
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
```

### Stop condition

The GenServer stops with `:normal` reason when the last subscriber leaves. Because it is started as a `transient` child under `DynamicSupervisor`, it will not be restarted.

## Registry

Group GenServers register themselves under `GroupRegistry` with key `group_id` so the FanOutRouter can look them up:

```elixir
Registry.register(GroupRegistry, group_id, :group_server)
```

## Dependencies

| Dependency    | What it needs                      | Reference                                 |
| ------------- | ---------------------------------- | ----------------------------------------- |
| SSEConnection | `push_action/2`, `push_presence/2` | [sse-connection.md](01-sse-connection.md) |
| Registry      | `register/3` for group_id lookup   | OTP built-in                              |

## Supervision

Started dynamically by `FanOutRouter` under `GroupDynamicSupervisor`:

```elixir
DynamicSupervisor.start_child(GroupDynamicSupervisor, {GroupServer, group_id})
```

The `GroupDynamicSupervisor` should use `strategy: :one_for_one` with `max_restarts: 100, max_seconds: 1` to handle frequent Group creation/destruction.

## Open Questions

None identified.
