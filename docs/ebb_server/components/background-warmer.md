# Background Warmer

## Purpose

An optional, tunable GenServer that pre-materializes dirty entities during idle periods. This is an escape hatch for workloads where `ctx.query()` frequently scans large numbers of dirty entities, causing read latency spikes. By default it is disabled -- the system runs in pure on-demand mode.

## Responsibilities

- Periodically poll the dirty set for entities to pre-materialize
- Rate-limit materialization to avoid competing with real reads
- Respect configurable tuning knobs: enabled/disabled, interval, batch size
- Emit telemetry for warmer activity (entities materialized, latency)

## Public Interface

### Module: `EbbServer.Storage.BackgroundWarmer`

| Name           | Signature                                                                                                     | Description                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `start_link/1` | `start_link(opts) :: GenServer.on_start()`                                                                    | `opts`: `[enabled: boolean(), interval_ms: pos_integer(), batch_size: pos_integer()]` |
| `status/0`     | `status() :: %{enabled: boolean(), entities_materialized: non_neg_integer(), last_run_ms: non_neg_integer()}` | Returns warmer status and stats.                                                      |
| `enable/0`     | `enable() :: :ok`                                                                                             | Enables the warmer at runtime.                                                        |
| `disable/0`    | `disable() :: :ok`                                                                                            | Disables the warmer at runtime.                                                       |

### Configuration

| Key                   | Description                           | Default |
| --------------------- | ------------------------------------- | ------- |
| `:warmer_enabled`     | Whether the warmer runs               | `false` |
| `:warmer_interval_ms` | Milliseconds between warmer cycles    | `1000`  |
| `:warmer_batch_size`  | Max entities to materialize per cycle | `100`   |

## Dependencies

| Dependency   | What it needs                                       | Reference                                                                |
| ------------ | --------------------------------------------------- | ------------------------------------------------------------------------ |
| Entity Store | `materialize_batch/1` to materialize dirty entities | [entity-store.md](entity-store.md#materialization-internal-but-testable) |
| System Cache | `dirty_set_size/0` to check if there's work to do   | [system-cache.md](system-cache.md#dirty-set)                             |

## Internal Design Notes

**Warmer loop:**

```elixir
def handle_info(:tick, %{enabled: false} = state) do
  schedule_tick(state.interval_ms)
  {:noreply, state}
end

def handle_info(:tick, state) do
  dirty_count = SystemCache.dirty_set_size()

  if dirty_count > 0 do
    # Pop up to batch_size entity IDs from the dirty set
    # (Implementation: ETS first/next traversal, take batch_size)
    entity_ids = SystemCache.pop_dirty_batch(state.batch_size)

    if entity_ids != [] do
      start = System.monotonic_time(:millisecond)
      EntityStore.materialize_batch(entity_ids)
      elapsed = System.monotonic_time(:millisecond) - start

      :telemetry.execute([:ebb, :warmer, :cycle], %{
        count: length(entity_ids),
        latency_ms: elapsed,
        remaining: dirty_count - length(entity_ids)
      })
    end
  end

  schedule_tick(state.interval_ms)
  {:noreply, state}
end
```

**Rate limiting:** The warmer is naturally rate-limited by its interval and batch size. At defaults (1s interval, 100 entities), it materializes at most 100 entities/second. Under heavy write load, the dirty set grows faster than the warmer drains it -- this is by design. The warmer is a best-effort optimization, not a guarantee.

**Priority:** The warmer should yield to real reads. Since Entity Store is a GenServer, warmer materializations and real reads are serialized. If the Entity Store mailbox has pending read requests, the warmer's `materialize_batch` call will queue behind them. This is the desired behavior -- real reads always take priority.

**Tuning guidance:**

- **Off** (default): Pure on-demand. Maximum write throughput. Read latency depends on dirty set size.
- **Moderate** (interval: 500ms, batch: 50): Good for mixed read/write workloads. Keeps dirty set small without impacting write throughput.
- **Aggressive** (interval: 100ms, batch: 500): Approaches eager materialization. `ctx.query()` rarely hits dirty entities. Higher CPU usage.

## Open Questions

- **Pop vs. peek for dirty set:** Should the warmer "pop" entities from the dirty set (remove before materializing) or "peek" (leave in place, let Entity Store clear after materialization)? Peek is safer -- if materialization fails, the entity stays dirty. Pop risks losing the dirty bit on failure. Use peek: the warmer calls `EntityStore.materialize_batch/1`, which internally clears the dirty bit on success.
- **Type-prioritized warming:** Should the warmer prioritize certain entity types (e.g., types frequently queried via `ctx.query()`)? This would require tracking query patterns. Start with FIFO (oldest dirty first) and add type prioritization if needed.
- **Interaction with Entity Store GenServer:** If Entity Store is a GenServer, the warmer's `materialize_batch` call goes through the GenServer mailbox. Under high read load, warmer requests queue behind real reads. This is correct behavior but means the warmer may not keep up during read spikes. If this becomes a problem, consider a separate SQLite connection for warmer writes.
