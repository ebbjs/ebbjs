# RocksDB range_iterator

## Purpose

Provides a lazy stream of `{key, value}` pairs from a RocksDB column family for a half-open key range `[from_key, to_key)`. This is needed for two Slice 3 operations:

1. **Catch-up reads**: When a client requests `GET /sync/groups/:group_id?offset=N`, the server must read Actions from `cf_actions` where GSN ∈ [N, N+200).
2. **Fan-Out delivery**: FanOutRouter reads committed Actions from `cf_actions` by GSN range to push to SSE subscribers.

## Responsibilities

- Wrap RocksDB's iterator API in a `Stream.resource/3` for lazy, bounded range iteration
- Handle iterator cleanup via the resource cleanup function
- Provide a function signature compatible with existing `prefix_iterator/3`

## Public Interface

### Module: `EbbServer.Storage.RocksDB`

Add to existing functions:

| Name               | Signature                                                                                        | Description                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `range_iterator/3` | `range_iterator(cf_ref, from_key :: binary(), to_key :: binary(), opts \\ []) :: Enumerable.t()` | Returns a lazy stream of `{key, value}` pairs in `[from_key, to_key)` |

## Implementation

### range_iterator/3

```elixir
@spec range_iterator(:rocksdb.cf_handle(), binary(), binary(), keyword()) :: Enumerable.t()
def range_iterator(cf_ref, from_key, to_key, opts \\ []) do
  name = Keyword.get(opts, :name, __MODULE__)

  Stream.resource(
    fn ->
      {:ok, iter} = :rocksdb.iterator(db_ref(name), cf_ref, [])
      seek_result = :rocksdb.iterator_move(iter, {:seek, from_key})
      {iter, seek_result}
    end,
    fn
      {iter, {:ok, key, _value}} when key >= to_key ->
        {:halt, iter}

      {iter, {:ok, key, value}} ->
        {[{key, value}], {iter, :rocksdb.iterator_move(iter, :next)}}

      {iter, {:error, :invalid_iterator}} ->
        {:halt, iter}

      {iter, {:error, _reason}} ->
        {:halt, iter}
    end,
    fn iter ->
      :rocksdb.iterator_close(iter)
    end
  )
end
```

### Usage for GSN range reads

```elixir
# Read Actions with GSN 10 through 15 (inclusive of 10, exclusive of 16)
from_key = RocksDB.encode_gsn_key(10)
to_key = RocksDB.encode_gsn_key(16)

actions =
  RocksDB.range_iterator(RocksDB.cf_actions(), from_key, to_key)
  |> Enum.map(fn {_key, value} -> :erlang.binary_to_term(value, [:safe]) end)
```

## Dependencies

None -- this is a pure extension to the existing RocksDB module.

## Testing

- [ ] Iterator returns correct key-value pairs within range
- [ ] Iterator returns nothing when `from_key >= to_key`
- [ ] Iterator returns nothing when no keys exist in range
- [ ] Iterator closes cleanly even if stream is partially consumed
- [ ] Works with GSN-encoded keys (8-byte big-endian)
