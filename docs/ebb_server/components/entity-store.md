# Entity Store

## Purpose

Provides the read interface for entity state with zero-staleness guarantee. When an entity is requested, the Entity Store checks if it has unmaterialized updates (dirty), and if so, reads the delta from RocksDB, applies per-field typed merges, upserts the result into SQLite, and clears the dirty bit -- all before returning the entity. Callers never see stale data.

## Responsibilities

- Implement `get/2` -- point lookup with on-demand materialization
- Implement `query/3` -- type-scoped filtered query with batch materialization of dirty entities
- Read delta Updates from RocksDB (`cf_entity_actions` + `cf_updates`) for dirty entities
- Apply per-field typed merge logic (LWW, Counter, CRDT)
- UPSERT materialized state into SQLite
- Clear dirty bits in ETS after successful materialization
- Track `last_gsn` per entity for incremental merge (never replay full history)

## Public Interface

### Module: `EbbServer.Storage.EntityStore`

#### Read API

| Name          | Signature                                                                                                            | Description                                                                                                                  |
| ------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `get/2`       | `get(entity_id :: String.t(), actor_id :: String.t()) :: {:ok, entity()} \| :not_found \| {:error, term()}`          | Point lookup. Materializes if dirty. Permission check is the caller's responsibility (HTTP API layer).                       |
| `query/3`     | `query(type :: String.t(), filter :: map() \| nil, actor_id :: String.t()) :: {:ok, [entity()]} \| {:error, term()}` | Type-scoped query. Batch materializes dirty entities of this type first, then queries SQLite with filter + permission JOINs. |
| `get_batch/2` | `get_batch(entity_ids :: [String.t()], actor_id :: String.t()) :: {:ok, [entity()]} \| {:error, term()}`             | Batch point lookup. Materializes all dirty entities in the list, then returns all. For `ctx.getBatch()`.                     |

#### Materialization (internal, but testable)

| Name                  | Signature                                                                                | Description                                                                                                         |
| --------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `materialize/1`       | `materialize(entity_id :: String.t()) :: {:ok, entity()} \| {:error, term()}`            | Reads delta from RocksDB, merges, upserts SQLite, clears dirty. Used by `get/2` and by System Cache during startup. |
| `materialize_batch/1` | `materialize_batch(entity_ids :: [String.t()]) :: {:ok, [entity()]} \| {:error, term()}` | Batch version. Used by `query/3`.                                                                                   |

### Types

```elixir
@type entity :: %{
  id: String.t(),
  type: String.t(),
  data: map(),                # Parsed JSON: %{"fields" => %{"title" => %{"type" => "lww", ...}, ...}}
  created_hlc: non_neg_integer(),
  updated_hlc: non_neg_integer(),
  deleted_hlc: non_neg_integer() | nil,
  deleted_by: String.t() | nil,
  last_gsn: non_neg_integer()
}

@type field_value :: lww_field() | counter_field() | crdt_field()

@type lww_field :: %{
  "type" => "lww",
  "value" => term(),
  "hlc" => non_neg_integer()
}

@type counter_field :: %{
  "type" => "counter",
  "value" => %{String.t() => non_neg_integer()}   # actor_id => count
}

@type crdt_field :: %{
  "type" => "crdt",
  "value" => binary()   # base64-encoded Yjs state
}
```

## Dependencies

| Dependency    | What it needs                                                                                                  | Reference                                            |
| ------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| System Cache  | `is_dirty?/1`, `clear_dirty/1`, `dirty_entity_ids_for_type/1`                                                  | [system-cache.md](system-cache.md#dirty-set)         |
| RocksDB Store | `prefix_iterator/3` on `cf_entity_actions` (to find Updates for an entity since `last_gsn`; uses default name) | [rocksdb-store.md](rocksdb-store.md#read-operations) |
| RocksDB Store | `get/3` on `cf_updates` (to fetch full Update payloads; uses default name)                                     | [rocksdb-store.md](rocksdb-store.md#read-operations) |
| SQLite Store  | `get_entity/1`, `get_entity_last_gsn/1`, `upsert_entity/1`, `upsert_entities/1`, `query_entities/1`            | [sqlite-store.md](sqlite-store.md#entity-operations) |

## Internal Design Notes

**Materialization flow for a single entity:**

```elixir
def materialize(entity_id) do
  # 1. Get current state from SQLite (may be :not_found for first materialization)
  {current_data, last_gsn} = case SQLite.get_entity(entity_id) do
    {:ok, row} -> {Jason.decode!(row.data), row.last_gsn}
    :not_found -> {%{"fields" => %{}}, 0}
  end

  # 2. Read delta Updates from RocksDB
  #    Scan cf_entity_actions with prefix entity_id, where GSN > last_gsn
  start_key = RocksDB.encode_entity_gsn_key(entity_id, last_gsn + 1)
  updates_with_gsns =
    RocksDB.prefix_iterator(cf_entity_actions(), entity_id)
    |> Stream.filter(fn {key, _} -> decode_gsn(key) > last_gsn end)
    |> Stream.map(fn {key, action_id} ->
      gsn = decode_gsn(key)
      # Read all Updates for this Action that touch this entity
      {gsn, fetch_updates_for_entity(action_id, entity_id)}
    end)
    |> Enum.to_list()

  if updates_with_gsns == [] do
    # No new updates -- entity was marked dirty but already materialized
    # (race condition with concurrent materialization). Clear dirty and return.
    SystemCache.clear_dirty(entity_id)
    SQLite.get_entity(entity_id)
  else
    # 3. Merge updates into current state
    {merged_data, max_gsn, metadata} =
      Enum.reduce(updates_with_gsns, {current_data, last_gsn, %{}}, fn {gsn, updates}, acc ->
        Enum.reduce(updates, acc, &apply_update/2)
      end)

    # 4. Upsert into SQLite
    entity_row = build_entity_row(entity_id, merged_data, max_gsn, metadata)
    SQLite.upsert_entity(entity_row)

    # 5. Clear dirty bit
    SystemCache.clear_dirty(entity_id)

    {:ok, entity_row}
  end
end
```

**Per-field typed merge (`merge_field/3`):**

For each field in the Update's `data.fields`, the merge function receives the existing field value, the incoming field value, and the `update_id` of the Update that produced the incoming value. The `update_id` is stored on LWW fields as a tiebreaker for deterministic convergence when HLCs are equal.

```elixir
def merge_field(existing, incoming, update_id) do
  case incoming["type"] do
    "lww" ->
      # Tag the incoming field with the update_id that produced it
      incoming_tagged = Map.put(incoming, "update_id", update_id)
      existing_hlc = existing["hlc"] || 0
      incoming_hlc = incoming["hlc"]

      cond do
        incoming_hlc > existing_hlc ->
          incoming_tagged
        incoming_hlc < existing_hlc ->
          existing
        true ->
          # HLC tie: lexicographic comparison of update IDs breaks the tie.
          # This is deterministic regardless of processing order, ensuring
          # all nodes converge to the same value.
          existing_uid = existing["update_id"] || ""
          if update_id > existing_uid, do: incoming_tagged, else: existing
      end

    "counter" ->
      # G-Counter: per-actor max
      merged_counts = Map.merge(
        existing["value"] || %{},
        incoming["value"],
        fn _actor, a, b -> max(a, b) end
      )
      %{existing | "value" => merged_counts}

    "crdt" ->
      # Yjs merge via y_ex NIF
      merged_state = YEx.merge(existing["value"], incoming["value"])
      %{existing | "value" => merged_state}
  end
end
```

**Note on `update_id` storage:** LWW field values in the materialized entity include an `"update_id"` key (e.g., `%{"type" => "lww", "value" => "Buy milk", "hlc" => 1710000000000, "update_id" => "upd_abc123"}`). This is required for deterministic tiebreaking — without it, two servers processing the same updates in different order could diverge when HLCs are equal. The `update_id` is not exposed in API responses; it is an internal materialization detail stored in the entity's `data` JSON.

**PUT vs. PATCH vs. DELETE handling:**

- **PUT** (`method: :put`): Replace the entire entity data. The Update's `data` becomes the new `fields` map. `created_hlc` is set from the Action's HLC.
- **PATCH** (`method: :patch`): Merge the Update's `data.fields` into the existing `fields` map, field by field, using the typed merge above.
- **DELETE** (`method: :delete`): Set `deleted_hlc` from the Action's HLC, `deleted_by` from the Action's `actor_id`. The `data` field is preserved (soft delete / tombstone).

**Batch materialization for `query/3`:**

```elixir
def query(type, filter, actor_id) do
  # 1. Find dirty entities of this type
  dirty_ids = SystemCache.dirty_entity_ids_for_type(type)

  # 2. Materialize all dirty ones
  if dirty_ids != [] do
    materialize_batch(dirty_ids)
  end

  # 3. Query SQLite (all entities of this type are now clean)
  SQLite.query_entities(%{type: type, filter: filter, actor_id: actor_id})
end
```

**Concurrency:** The Entity Store is a GenServer to serialize SQLite writes (only one connection). However, materialization reads from RocksDB can be parallelized. For batch materialization, consider using `Task.async_stream` for the RocksDB read + merge step, then serialize the SQLite upserts.

**Incremental merge correctness:** The `last_gsn` on the entity row ensures we never replay old Updates. After materialization, `last_gsn` is set to the max GSN seen in the delta. If the entity is dirtied again (new writes arrive), the next materialization starts from the new `last_gsn`.

## Open Questions

- **GenServer vs. module:** Should Entity Store be a GenServer (serializing all materializations) or a stateless module (callers materialize in their own process)? GenServer simplifies SQLite write serialization. Module approach allows parallel materialization but needs SQLite write coordination. Start with GenServer; consider a pool or module approach if materialization latency under concurrent reads becomes a bottleneck.
- **Yjs merge dependency:** The spec mentions `y_ex` (Elixir Yjs NIF) for CRDT field merges. This dependency is not in the current `mix.exs` deps list. It needs to be added, or CRDT field support can be deferred to a later slice.
- **Materialization under concurrent writes:** If a Writer marks entity X dirty while Entity Store is materializing entity X, the Entity Store may miss the latest Updates. The dirty bit should NOT be cleared if new writes arrived during materialization. One approach: compare the `last_gsn` of the materialized result against the current max GSN for that entity in RocksDB. If they differ, leave the dirty bit set.
