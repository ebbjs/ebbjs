# FanOutRouter

## Purpose

A GenServer that receives `{:batch_committed, from_gsn, to_gsn}` notifications from Writers, gates delivery on the committed watermark to ensure ordering despite concurrent writers, reads committed Actions from RocksDB, resolves affected Groups, and dispatches to per-Group GenServers.

## Responsibilities

- Receive batch-committed notifications from Writers (via `send/2`, not `GenServer.call`)
- Gate delivery on `WatermarkTracker.committed_watermark/0` to handle concurrent writer out-of-order commits
- Buffer pending notifications and push only contiguous GSN ranges up to the watermark
- Read committed Action payloads from RocksDB via `range_iterator`
- Determine affected Groups for each Action via `RelationshipCache.get_entity_group/1`
- Dispatch Actions to the appropriate GroupServer via `Registry.lookup/2`
- Handle `subscribe/2`, `unsubscribe/1`, and `broadcast_presence/3` calls

## Public Interface

### Module: `EbbServer.Sync.FanOutRouter`

| Name                   | Signature                                                                                   | Description                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `start_link/1`         | `start_link(opts :: keyword()) :: GenServer.on_start()`                                     | Starts the router GenServer                                                          |
| `subscribe/2`          | `subscribe(group_ids :: [String.t()], connection_pid :: pid()) :: :ok`                      | Registers an SSE connection for the given Groups. Starts Group GenServers if needed. |
| `unsubscribe/1`        | `unsubscribe(connection_pid :: pid()) :: :ok`                                               | Removes an SSE connection from all Groups. Stops empty Group GenServers.             |
| `broadcast_presence/3` | `broadcast_presence(entity_id :: String.t(), actor_id :: String.t(), data :: map()) :: :ok` | Routes presence to the entity's Group GenServer for broadcast.                       |

## State

```elixir
@type t :: %__MODULE__{
  pending_notifications: [{non_neg_integer(), non_neg_integer()}],
  last_pushed_gsn: non_neg_integer()
}

defstruct pending_notifications: [], last_pushed_gsn: 0
```

- `pending_notifications`: Sorted list of `{from_gsn, to_gsn}` tuples received from Writers but not yet pushed (waiting for watermark advancement)
- `last_pushed_gsn`: The highest GSN successfully pushed to GroupServers

## Internal Design

### Handling batch_committed

```elixir
@impl true
def handle_info({:batch_committed, from_gsn, to_gsn}, state) do
  # Add to pending list
  pending = [{from_gsn, to_gsn} | state.pending_notifications]
    |> Enum.sort_by(&elem(&1, 0))

  # Check current watermark
  watermark = WatermarkTracker.committed_watermark()

  # Push all contiguous ranges up to watermark
  {to_push, remaining} = split_pushable(pending, state.last_pushed_gsn, watermark)

  for {from, to} <- to_push do
    push_gsn_range(from, to)
  end

  new_last = case List.last(to_push) do
    nil -> state.last_pushed_gsn
    {_, last} -> last
  end

  {:noreply, %{state | pending_notifications: remaining, last_pushed_gsn: new_last}}
end

# Split pending notifications into pushable vs. waiting for watermark
defp split_pushable(pending, last_pushed, watermark) do
  Enum.split_while(pending, fn {from, to} ->
    from <= last_pushed + 1 and to <= watermark
  end)
end
```

### push_gsn_range

```elixir
defp push_gsn_range(from_gsn, to_gsn) do
  cf = RocksDB.cf_actions()
  from_key = RocksDB.encode_gsn_key(from_gsn)
  to_key = RocksDB.encode_gsn_key(to_gsn + 1)

  actions = RocksDB.range_iterator(cf, from_key, to_key)
    |> Enum.map(fn {_key, value} -> :erlang.binary_to_term(value, [:safe]) end)

  for action <- actions do
    dispatch_to_groups(action)
  end
end

defp dispatch_to_groups(action) do
  action.updates
  |> Enum.map(& &1["subject_id"])
  |> Enum.map(&RelationshipCache.get_entity_group/1)
  |> Enum.reject(&is_nil/1)
  |> Enum.uniq()
  |> Enum.each(fn group_id ->
    case Registry.lookup(GroupRegistry, group_id) do
      [{pid, _}] -> GroupServer.push_actions(pid, [action])
      [] -> :ok
    end
  end)
end
```

### Subscribe

```elixir
@impl true
def handle_call({:subscribe, group_ids, connection_pid}, _from, state) do
  for group_id <- group_ids do
    {:ok, group_pid} = DynamicSupervisor.start_child(
      GroupDynamicSupervisor,
      {GroupServer, group_id}
    )
    GroupServer.add_subscriber(group_pid, connection_pid)
  end

  {:reply, :ok, state}
end
```

### Registry

Use `Registry` with `keys: :unique` for looking up Group GenServers by `group_id`. The Registry name should be `GroupRegistry`.

## Dependencies

| Dependency        | What it needs                                          | Reference                                                       |
| ----------------- | ------------------------------------------------------ | --------------------------------------------------------------- |
| WatermarkTracker  | `committed_watermark/0`                                | [watermark_tracker.ex](../../components/watermark-design.md)    |
| RelationshipCache | `get_entity_group/1`                                   | [relationship_cache.ex](../../components/relationship-cache.md) |
| RocksDB           | `range_iterator/3`, `cf_actions/1`, `encode_gsn_key/1` | [rocksdb-store.md](../../components/rocksdb-store.md)           |
| GroupServer       | `start_link/1`, `add_subscriber/2`, `push_actions/2`   | [group-server.md](03-group-server.md)                           |
| DynamicSupervisor | Start/stop GroupServer children                        | OTP built-in                                                    |

## Supervision

The FanOutRouter should be started under `EbbServer.Sync.Supervisor` (a new supervisor that also owns the GroupDynamicSupervisor and SSEConnectionSupervisor).

## Open Questions

- **Registry vs ETS**: `Registry` is the idiomatic OTP choice. Confirm it's sufficient for the lookup pattern (group_id → pid). No cleanup needed since GroupServers are transient.
