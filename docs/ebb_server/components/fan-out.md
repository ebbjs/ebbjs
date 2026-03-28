# Fan-Out

## Purpose

Delivers committed Actions to live SSE subscribers in GSN order. The Fan-Out Router receives batch-committed notifications from Writers, gates delivery on the committed GSN watermark to ensure ordering despite concurrent writers, resolves which Groups are affected, and dispatches to per-Group GenServers that maintain subscriber lists and push to SSE connections.

## Responsibilities

- Receive `{:batch_committed, from_gsn, to_gsn}` notifications from Writers
- Gate delivery on the committed GSN watermark (buffer out-of-order commits)
- Read committed Actions from RocksDB
- Determine affected Groups for each Action (via ETS relationships cache)
- Dispatch Actions to per-Group GenServers
- Per-Group GenServers: maintain subscriber sets, push Actions to SSE connection processes
- SSE connection processes: write SSE events to the client stream
- Handle presence broadcasting (fire-and-forget, no persistence)
- Handle subscriber registration/unregistration
- Send reconnect control events when Group membership changes

## Public Interface

### Module: `EbbServer.Sync.FanOutRouter`

A GenServer that receives batch notifications and coordinates ordered delivery.

| Name                   | Signature                                                                                   | Description                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `start_link/1`         | `start_link(opts) :: GenServer.on_start()`                                                  | Starts the router.                                                                   |
| `subscribe/2`          | `subscribe(group_ids :: [String.t()], connection_pid :: pid()) :: :ok`                      | Registers an SSE connection for the given Groups. Starts Group GenServers if needed. |
| `unsubscribe/1`        | `unsubscribe(connection_pid :: pid()) :: :ok`                                               | Removes an SSE connection from all Groups. Stops empty Group GenServers.             |
| `broadcast_presence/3` | `broadcast_presence(entity_id :: String.t(), actor_id :: String.t(), data :: map()) :: :ok` | Routes presence to the entity's Group GenServer for broadcast.                       |

### Module: `EbbServer.Sync.GroupServer`

A GenServer per active Group. Started dynamically when the first client subscribes, stopped when the last client leaves.

| Name                   | Signature                                                                     | Description                                                           |
| ---------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `start_link/1`         | `start_link(group_id :: String.t()) :: GenServer.on_start()`                  | Starts a Group GenServer.                                             |
| `push_actions/2`       | `push_actions(group_pid, actions :: [action()]) :: :ok`                       | Sends Actions to all subscribers of this Group. Cast (async).         |
| `add_subscriber/2`     | `add_subscriber(group_pid, connection_pid :: pid()) :: :ok`                   | Adds an SSE connection to this Group's subscriber set.                |
| `remove_subscriber/2`  | `remove_subscriber(group_pid, connection_pid :: pid()) :: :ok`                | Removes an SSE connection. Returns `:empty` if no subscribers remain. |
| `broadcast_presence/3` | `broadcast_presence(group_pid, actor_id :: String.t(), data :: map()) :: :ok` | Sends presence to all subscribers except the originating actor.       |

### Module: `EbbServer.Sync.SSEConnection`

A process per connected client. Receives messages from multiple Group GenServers and writes to the SSE stream.

| Name              | Signature                                                   | Description                                    |
| ----------------- | ----------------------------------------------------------- | ---------------------------------------------- |
| `start_link/1`    | `start_link(conn :: Plug.Conn.t()) :: GenServer.on_start()` | Starts an SSE connection process.              |
| `push_action/2`   | `push_action(pid, action :: action()) :: :ok`               | Sends an Action event to the client.           |
| `push_control/2`  | `push_control(pid, control :: map()) :: :ok`                | Sends a control event (nextOffset, reconnect). |
| `push_presence/2` | `push_presence(pid, presence :: map()) :: :ok`              | Sends a presence event.                        |

### SSE Event Format

```
event: data
data: {"id":"act_abc","gsn":501,"actor_id":"a_user1","hlc":1711036800000,"updates":[...]}

event: control
data: {"group":"group_a","nextOffset":"502"}

event: presence
data: {"actor_id":"a_user1","entity_id":"doc_1","data":{"cursor":{"line":5,"col":12}}}

event: control
data: {"reconnect":true,"reason":"membership_changed"}

: keepalive
```

## Dependencies

| Dependency    | What it needs                                                                                 | Reference                                              |
| ------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| System Cache  | `committed_watermark/0` for delivery gating                                                   | [system-cache.md](system-cache.md#committed-watermark) |
| System Cache  | `get_entity_group/1` and `get_group_entities/1` for routing Actions to Groups                 | [system-cache.md](system-cache.md#relationships)       |
| RocksDB Store | `range_iterator/4` on `cf_actions` to read committed Actions by GSN range (uses default name) | [rocksdb-store.md](rocksdb-store.md#read-operations)   |

Note: Fan-Out receives `{:batch_committed, from_gsn, to_gsn}` messages from Writer via `send/2` (not a function call). This is a message-based dependency, not a module dependency.

## Internal Design Notes

**Watermark-gated delivery in the Fan-Out Router:**

```elixir
# State: %{pending_notifications: [{from_gsn, to_gsn}], last_pushed_gsn: non_neg_integer()}

handle_info({:batch_committed, from_gsn, to_gsn}, state) do
  # Add to pending
  pending = [{from_gsn, to_gsn} | state.pending_notifications]
    |> Enum.sort_by(&elem(&1, 0))

  # Check watermark
  watermark = SystemCache.committed_watermark()

  # Push all contiguous ranges up to watermark
  {to_push, remaining} = split_pushable(pending, state.last_pushed_gsn, watermark)

  for {from, to} <- to_push do
    push_gsn_range(from, to)
  end

  new_last = case to_push do
    [] -> state.last_pushed_gsn
    _ -> to_push |> List.last() |> elem(1)
  end

  {:noreply, %{state | pending_notifications: remaining, last_pushed_gsn: new_last}}
end
```

**Routing Actions to Groups:**

```elixir
def push_gsn_range(from_gsn, to_gsn) do
  # Read Actions from RocksDB
  actions = RocksDB.range_iterator(cf_actions(), encode_gsn_key(from_gsn), encode_gsn_key(to_gsn + 1))
    |> Enum.map(fn {_key, value} -> :erlang.binary_to_term(value, [:safe]) end)

  # For each Action, find affected Groups
  for action <- actions do
    affected_groups = action.updates
      |> Enum.map(& &1.subject_id)
      |> Enum.map(&SystemCache.get_entity_group/1)
      |> Enum.reject(&is_nil/1)
      |> Enum.uniq()

    for group_id <- affected_groups do
      case Registry.lookup(GroupRegistry, group_id) do
        [{pid, _}] -> GroupServer.push_actions(pid, [action])
        [] -> :ok  # No subscribers for this Group
      end
    end
  end
end
```

**Group GenServer subscriber management:**

```elixir
# State: %{group_id: String.t(), subscribers: MapSet.t(pid())}

def init(group_id) do
  {:ok, %{group_id: group_id, subscribers: MapSet.new()}}
end

def handle_cast({:push_actions, actions}, state) do
  for subscriber <- state.subscribers do
    for action <- actions do
      SSEConnection.push_action(subscriber, action)
    end
  end
  {:noreply, state}
end
```

**Process monitoring:** Group GenServers monitor their subscriber pids. When an SSE connection dies, the Group GenServer receives `{:DOWN, ...}` and removes the subscriber. If the subscriber set becomes empty, the Group GenServer stops itself (transient restart strategy means it won't be restarted).

**Presence throttling:** The Fan-Out Router throttles presence broadcasts per `{actor_id, entity_id}` pair -- at most one broadcast per 50ms. This is a safety net; the client SDK also debounces at 50ms.

**Reconnect triggers:** When the Writer updates the system entity cache (GroupMember added/removed), it can notify the Fan-Out Router. The Router checks if any active SSE connections are affected and sends a `reconnect` control event to those connections.

## Open Questions

- **Group GenServer registry:** Use `Registry` (built-in) or a named ETS table for looking up Group GenServers by group_id? `Registry` is the idiomatic OTP choice and handles process lifecycle automatically.
- **Action deduplication at the client:** An Action that touches entities in multiple Groups subscribed by the same client will be pushed once per Group. The client deduplicates by GSN. The server could deduplicate at the SSE connection level (track last-pushed GSN per connection), but this adds state. Start without server-side dedup; the client handles it.
- **Backpressure:** If an SSE connection is slow (client not reading), the Group GenServer's mailbox will grow. Consider monitoring mailbox size and disconnecting slow clients. Cowboy has built-in flow control for chunked responses, but the GenServer mailbox is the bottleneck.
