# Prerequisite: Group Actions Index

## Purpose

Adds a new RocksDB column family `cf_group_actions` that indexes `(group_id, gsn) → action_id` at write time. This pre-index enables O(1) group-scoped catch-up reads regardless of how many entities a group contains. It is a prerequisite for the Catch-Up endpoint and is built before it.

## Changes to RocksDB

### Column family descriptor

Add `cf_group_actions` to the column family list in `RocksDB`:

```elixir
@cf_descriptors [
  {~c"default", []},
  {~c"cf_actions", []},
  {~c"cf_updates", []},
  {~c"cf_entity_actions", []},
  {~c"cf_type_entities", []},
  {~c"cf_action_dedup", []},
  {~c"cf_group_actions", []}   # NEW
]
```

The column family is opened alongside all others during `RocksDB.init/1`. A new persistent_term key `:ebb_cf_group_actions` is set for the handle, and erased on terminate.

### Key and value schema

- **Key:** `<<group_id::binary, gsn::unsigned-big-integer-size(64)>>` — 8-byte big-endian GSN suffix ensures lexicographic sort by group first, then by GSN within the group
- **Value:** `action_id` binary

## Changes to Writer

During `Writer.build_action_ops`, for each update in an action, resolve the entity's group via `RelationshipCache.get_entity_group/1` and write an extra index entry to `cf_group_actions`:

```elixir
defp build_group_action_index(action_id, gsn, update, rocks_name) do
  group_id = RelationshipCache.get_entity_group(update.subject_id)
  if group_id do
    key = <<group_id::binary, gsn::unsigned-big-integer-size(64)>>
    [{:put, RocksDB.cf_group_actions(rocks_name), key, action_id}]
  else
    []
  end
end
```

This function is called per-update inside the `Enum.flat_map` that builds `entity_index_ops`. The entry is written in the same RocksDB batch as all other indexes — no new failure modes are introduced. The cost is one additional write per update per group the entity belongs to; most updates target exactly one group.

## State

No new persistent state. The column family is opened at startup and closed at shutdown alongside all other column families.

## Verification

- Existing tests pass with no behavior change — the index is write-only at this stage
- A unit test can confirm the index entry is written by reading from `cf_group_actions` after a write and finding the expected `(group_id, gsn) → action_id` mapping
