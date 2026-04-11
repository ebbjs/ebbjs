# Writer → FanOut Integration

## Purpose

After the Writer successfully commits a batch to RocksDB, it must update the watermark tracking system and notify the FanOutRouter so that live SSE subscribers receive the new Actions. This integration point is the bridge between the write path and the fan-out path.

## What Changes

The `EbbServer.Storage.Writer.write_actions/2` function currently:

1. Claims GSN range from `GsnCounter`
2. Builds batch operations
3. Writes to RocksDB via `RocksDB.write_batch/2`
4. Marks entities dirty in `DirtyTracker`
5. Updates system entity caches (`GroupCache`, `RelationshipCache`)
6. Returns `{:ok, {gsn_start, gsn_end}, []}`

After this change, steps 5 and 6 are unchanged. The new steps are:

5b. Call `WatermarkTracker.mark_range_committed(gsn_start, gsn_end)`
5c. Call `WatermarkTracker.advance_watermark()`
5d. Send `{:batch_committed, gsn_start, gsn_end}` to `FanOutRouter`

## Changes to Writer

### New Dependencies

The Writer state needs to include the `FanOutRouter` name:

```elixir
alias EbbServer.Sync.FanOutRouter
alias EbbServer.Storage.WatermarkTracker

# Add to defstruct:
:fan_out_router

# Add to init opts:
fan_out_router: Keyword.get(opts, :fan_out_router, FanOutRouter)
```

### handle_call modification

In `write_and_respond/5`, after the `:ok` case and before replying:

```elixir
defp write_and_respond(ops, filtered, gsn_start, gsn_end, state, rocks_name) do
  case RocksDB.write_batch(ops, name: rocks_name) do
    :ok ->
      entity_ids =
        filtered
        |> Enum.flat_map(fn action -> action.updates end)
        |> Enum.map(fn update -> update.subject_id end)
        |> Enum.uniq()

      :ok = DirtyTracker.mark_dirty_batch(entity_ids, state.dirty_set)
      update_system_caches(filtered, state)

      # NEW: Update watermark and notify FanOut
      :ok = WatermarkTracker.mark_range_committed(gsn_start, gsn_end, state.watermark_tracker)
      WatermarkTracker.advance_watermark(state.watermark_tracker)
      send(state.fan_out_router, {:batch_committed, gsn_start, gsn_end})

      {:reply, {:ok, {gsn_start, gsn_end}, []}, state}

    {:error, reason} ->
      {:reply, {:error, {:rocksdb_write_failed, reason}}, state}
  end
end
```

### WatermarkTracker name in state

The Writer currently does not reference `WatermarkTracker` by name. The watermark tracker is started before the Writer in the supervision tree, but the Writer does not hold a reference to it.

Add to Writer state and init:

```elixir
@type t :: %__MODULE__{
  # ... existing fields ...
  watermark_tracker: GenServer.name()
}

# In init/1:
watermark_tracker: Keyword.get(opts, :watermark_tracker, WatermarkTracker)
```

## New Types

No new types are introduced. `{:batch_committed, from_gsn :: non_neg_integer(), to_gsn :: non_neg_integer()}` is the message protocol between Writer and FanOutRouter.

## Dependencies

| Dependency       | What it needs                                   | Reference                                        |
| ---------------- | ----------------------------------------------- | ------------------------------------------------ |
| WatermarkTracker | `mark_range_committed/2`, `advance_watermark/0` | [watermark-design.md](../../watermark-design.md) |
| FanOutRouter     | Process pid (via `send/2`)                      | [fan-out-router.md](02-fan-out-router.md)        |

## Supervision

The `FanOutRouter` must be started **before** the Writer in the supervision tree, since the Writer sends to it on init. However, since `send/2` is asynchronous and the FanOutRouter is a `GenServer`, the startup order matters only that FanOutRouter is running before the first write completes.

In `EbbServer.Storage.Supervisor`:

```elixir
children = [
  {EbbServer.Storage.RocksDB, data_dir: data_dir},
  {EbbServer.Storage.SQLite, data_dir: data_dir},
  {EbbServer.Storage.SystemCache, []},
  {EbbServer.Storage.WatermarkTracker, []},
  # FanOutRouter must start before Writer (for send to succeed)
  EbbServer.Sync.Supervisor,   # Contains FanOutRouter
  {EbbServer.Storage.Writer, []}
]
```

Alternatively, the Writer could use `Process.send_after/3` if FanOutRouter might not be ready, but since this is Slice 3 and both are started at application boot, direct `send/2` is acceptable.

## Testing

### Unit tests

1. **Watermark update on write**: After `Writer.write_actions/2` succeeds, verify `WatermarkTracker.committed_watermark/0` has advanced.
2. **FanOutRouter receives message**: Mock FanOutRouter, write actions, verify `{:batch_committed, from, to}` was sent.
3. **Watermark advances correctly with single Writer**: With one Writer, watermark should always equal max GSN.

### Integration tests

1. Write Actions via HTTP, open SSE connection, verify Action arrives via SSE within 100ms.
2. Write 300 Actions (exceeds 200-page size), verify pagination works on catch-up.

## Open Questions

- **FanOutRouter not started yet**: If the Writer tries to send before FanOutRouter is started (e.g., during early unit tests), the `send/2` will silently deliver to a non-existent process. Consider using `Process.send/3` with `noconnect` option or guarding with a `whereis` check.
