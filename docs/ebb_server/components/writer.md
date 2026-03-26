# Writer

## Purpose

Serializes Action writes to RocksDB. Two Writer GenServer instances run concurrently, each independently batching incoming Actions, claiming GSN ranges atomically, encoding terms to ETF, building WriteBatches across all 5 column families, committing with `sync: true`, updating ETS caches, advancing the committed watermark, and notifying fan-out. This is the write hot path -- the component most critical to throughput.

## Responsibilities

- Receive Action write requests from HTTP handlers (routed round-robin or by Group)
- Batch Actions: 10ms timer or 1000 Actions, whichever fires first; immediate commit under low load
- Claim GSN ranges atomically from the shared `:atomics` counter
- Encode Actions and Updates to ETF via `:erlang.term_to_binary/1`
- Construct RocksDB WriteBatch entries across all 5 column families
- Commit WriteBatch with `sync: true` (durable)
- Mark touched entity IDs dirty in ETS `dirty_set`
- Extract system entity state from Action payloads and update ETS permission caches inline
- Advance the committed GSN watermark
- Notify fan-out: `{:batch_committed, from_gsn, to_gsn}`
- Reply `{:ok, gsn}` to each waiting HTTP handler process (unblocks HTTP response)

## Public Interface

### Module: `EbbServer.Storage.Writer`

Each Writer is a GenServer. Two instances are started by the supervision tree with distinct names (e.g., `Writer1`, `Writer2`).

#### Lifecycle

| Name | Signature | Description |
|------|-----------|-------------|
| `start_link/1` | `start_link(opts) :: GenServer.on_start()` | `opts`: `[name: atom(), writer_id: 1 \| 2]` |

#### Write API

| Name | Signature | Description |
|------|-----------|-------------|
| `write_actions/2` | `write_actions(writer, actions :: [validated_action()]) :: {:ok, gsn_range()} \| {:error, term()}` | Synchronous call. Blocks until the batch containing these Actions is committed to disk. Returns the GSN range assigned. |

The caller (HTTP handler) calls `write_actions/2` on one of the two Writers. The Writer buffers the Actions and replies only after the batch is flushed and durable.

### Module: `EbbServer.Storage.WriterRouter`

Routes incoming write requests to one of the 2 Writer GenServers.

| Name | Signature | Description |
|------|-----------|-------------|
| `route_write/1` | `route_write(actions :: [validated_action()]) :: {:ok, gsn_range()} \| {:error, term()}` | Selects a Writer (round-robin) and delegates. |

### Types

```elixir
@type validated_action :: %{
  id: String.t(),
  actor_id: String.t(),
  hlc: non_neg_integer(),
  updates: [validated_update()]
}

@type validated_update :: %{
  id: String.t(),
  subject_id: String.t(),
  subject_type: String.t(),
  method: :put | :patch | :delete,
  data: map() | nil
}

@type gsn_range :: {gsn_start :: non_neg_integer(), gsn_end :: non_neg_integer()}
```

## Dependencies

| Dependency | What it needs | Reference |
|------------|---------------|-----------|
| RocksDB Store | `write_batch/1` for committing WriteBatches | [rocksdb-store.md](rocksdb-store.md#write-operations) |
| RocksDB Store | Key encoding functions | [rocksdb-store.md](rocksdb-store.md#key-encoding) |
| System Cache | `claim_gsn_range/1` for GSN assignment | [system-cache.md](system-cache.md#gsn-counter) |
| System Cache | `mark_dirty_batch/1` for dirty set updates | [system-cache.md](system-cache.md#dirty-set) |
| System Cache | `put_group_member/1`, `delete_group_member/1`, `put_relationship/1`, `delete_relationship/1` for system entity cache updates | [system-cache.md](system-cache.md#group-members) |
| System Cache | `mark_range_committed/2`, `advance_watermark/0` for watermark | [system-cache.md](system-cache.md#committed-watermark) |
| Fan-Out | `{:batch_committed, from_gsn, to_gsn}` notification (message send, not function call) | [fan-out.md](fan-out.md) |

## Internal Design Notes

**Batching state machine (per Writer GenServer):**

```
State: %{
  buffer: [%{actions: [validated_action()], from: pid()}],
  timer_ref: reference() | nil,
  writer_id: 1 | 2
}

handle_call({:write_actions, actions}, from, state):
  new_buffer = [{actions, from} | state.buffer]
  if length(new_buffer) >= @max_batch_size do
    flush(new_buffer)  # immediate flush
    {:noreply, %{state | buffer: [], timer_ref: nil}}
  else
    timer = state.timer_ref || Process.send_after(self(), :flush, @batch_timeout_ms)
    {:noreply, %{state | buffer: new_buffer, timer_ref: timer}}
  end

handle_info(:flush, state):
  flush(state.buffer)
  {:noreply, %{state | buffer: [], timer_ref: nil}}
```

Under low load (single Action, no pending buffer), the timer fires after 10ms and flushes a batch of 1. This adds 10ms latency. An optimization: if the buffer was empty before this Action arrived, flush immediately (skip batching). This gives sub-millisecond latency for isolated writes.

**Flush procedure (the critical path):**

```elixir
def flush(buffer) do
  # 1. Flatten all Actions from all callers in the buffer
  all_actions = Enum.flat_map(buffer, fn {actions, _from} -> actions end)
  batch_size = length(all_actions)

  # 2. Claim GSN range
  {gsn_start, gsn_end} = SystemCache.claim_gsn_range(batch_size)

  # 3. Assign GSNs and build WriteBatch operations
  ops = all_actions
    |> Enum.with_index(gsn_start)
    |> Enum.flat_map(fn {action, gsn} ->
      action_with_gsn = Map.put(action, :gsn, gsn)
      action_etf = :erlang.term_to_binary(action_with_gsn)

      [
        {:put, cf_actions(), encode_gsn_key(gsn), action_etf},
        {:put, cf_action_dedup(), action.id, encode_gsn_key(gsn)}
      ] ++
      Enum.flat_map(action.updates, fn update ->
        update_etf = :erlang.term_to_binary(update)
        [
          {:put, cf_updates(), encode_update_key(action.id, update.id), update_etf},
          {:put, cf_entity_actions(), encode_entity_gsn_key(update.subject_id, gsn), action.id},
          {:put, cf_type_entities(), encode_type_entity_key(update.subject_type, update.subject_id), <<>>}
        ]
      end)
    end)

  # 4. Commit (durable)
  :ok = RocksDB.write_batch(ops)

  # 5. Mark entities dirty
  entity_ids = all_actions |> Enum.flat_map(& &1.updates) |> Enum.map(& &1.subject_id) |> Enum.uniq()
  SystemCache.mark_dirty_batch(entity_ids)

  # 6. Update system entity caches (inline, before replying)
  update_system_caches(all_actions)

  # 7. Advance watermark
  SystemCache.mark_range_committed(gsn_start, gsn_end)
  SystemCache.advance_watermark()

  # 8. Notify fan-out
  send(FanOutRouter, {:batch_committed, gsn_start, gsn_end})

  # 9. Reply to all waiting callers
  reply_to_callers(buffer, gsn_start)
end
```

**System entity cache updates:** After each batch, scan the Actions for Updates where `subject_type` is `"group"`, `"groupMember"`, or `"relationship"`. For each:
- `method: :put` or `method: :patch` → call `SystemCache.put_group_member/1` (or `put_relationship/1`)
- `method: :delete` → call `SystemCache.delete_group_member/1` (or `delete_relationship/1`)

This happens inline (step 6) before replying to callers, ensuring permission changes take effect immediately.

**Two-writer concurrency:** Both Writers run steps 1-9 concurrently on separate BEAM schedulers. The only shared mutable state is:
- `:atomics` GSN counter (lock-free)
- `:atomics` + ETS committed watermark (lock-free + atomic single-key writes)
- ETS `dirty_set` (atomic single-key writes)
- ETS permission caches (atomic single-key writes, commutative updates)
- RocksDB (handles concurrent WriteBatch commits internally with pipelined writes)

No locks, no mutexes, no GenServer serialization between the two Writers.

## Open Questions

- **Low-load optimization:** Should a single Action arriving to an empty buffer flush immediately (skip the 10ms timer)? This reduces latency for isolated writes from ~10ms to <1ms. The trade-off is losing batching efficiency if a burst arrives right after. Recommendation: flush immediately if buffer was empty; the batching timer only matters under sustained load.
- **Writer routing strategy:** Round-robin is simplest. Group-based routing (hash Group ID to Writer 1 or 2) could improve cache locality for system entity updates. Start with round-robin; measure before optimizing.
- **Batch size limit:** 1000 Actions per batch is the spec default. At ~1μs ETF encoding per term, a 1000-Action batch takes ~1ms to encode. The WriteBatch commit (fsync) takes ~5-15ms. The batch size limit prevents any single batch from holding the Writer too long. Tune based on observed latency distribution.
