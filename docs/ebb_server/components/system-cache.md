# System Cache

## Purpose

Owns the ETS tables and `:atomics` references that serve the hottest code paths in the system: permission checks, dirty entity tracking, fan-out routing, and GSN/watermark coordination. Populates the permission caches from RocksDB on startup and provides the shared state that Writers, Entity Store, Permission Checker, and Fan-Out all depend on.

## Responsibilities

- Create and own all ETS tables (`dirty_set`, `group_members`, `relationships`, `committed_watermark`)
- Create and own shared `:atomics` references (`gsn_counter`, `committed_watermark`)
- Populate `group_members` and `relationships` from RocksDB on startup (materialize all system entities)
- Provide read/write APIs for each ETS table
- Provide atomic GSN range claiming for Writers
- Provide committed watermark read/advance for Writers and Fan-Out
- Block the supervision tree (and therefore incoming connections) until startup population completes

## Public Interface

### Module: `EbbServer.Storage.SystemCache`

This is a GenServer that creates ETS tables and `:atomics` in `init/1`, then populates from RocksDB before returning `{:ok, state}`. The supervision tree's `rest_for_one` strategy ensures RocksDB Store is running before this starts.

#### Lifecycle

| Name           | Signature                                  | Description                                                                    |
| -------------- | ------------------------------------------ | ------------------------------------------------------------------------------ |
| `start_link/1` | `start_link(opts) :: GenServer.on_start()` | Creates ETS tables, `:atomics`, populates from RocksDB. Blocks until complete. |

#### Dirty Set

| Name                          | Signature                                                       | Description                                                                              |
| ----------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `mark_dirty/1`                | `mark_dirty(entity_id :: String.t()) :: true`                   | Sets `{entity_id, true}` in `dirty_set` ETS. Called by Writer after each batch.          |
| `mark_dirty_batch/1`          | `mark_dirty_batch(entity_ids :: [String.t()]) :: :ok`           | Batch version of `mark_dirty/1`.                                                         |
| `is_dirty?/1`                 | `is_dirty?(entity_id :: String.t()) :: boolean()`               | Checks if entity has unmaterialized updates. Called by Entity Store.                     |
| `clear_dirty/1`               | `clear_dirty(entity_id :: String.t()) :: true`                  | Removes entity from `dirty_set`. Called by Entity Store after materialization.           |
| `dirty_entity_ids_for_type/1` | `dirty_entity_ids_for_type(type :: String.t()) :: [String.t()]` | Returns dirty entity IDs matching a type prefix. Used by Entity Store for `ctx.query()`. |
| `dirty_set_size/0`            | `dirty_set_size() :: non_neg_integer()`                         | Returns count of dirty entities. For monitoring.                                         |

#### Group Members

| Name                    | Signature                                                                                | Description                                                             |
| ----------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `get_actor_groups/1`    | `get_actor_groups(actor_id :: String.t()) :: [group_membership()]`                       | Returns all Groups an actor belongs to, with permissions.               |
| `is_member?/2`          | `is_member?(actor_id :: String.t(), group_id :: String.t()) :: boolean()`                | Checks if actor is a member of a specific Group.                        |
| `get_permissions/2`     | `get_permissions(actor_id :: String.t(), group_id :: String.t()) :: [String.t()] \| nil` | Returns permission list for actor in Group, or nil if not a member.     |
| `put_group_member/1`    | `put_group_member(member :: group_member_entity()) :: :ok`                               | Inserts/updates a GroupMember in the cache. Called by Writer.           |
| `delete_group_member/1` | `delete_group_member(member_id :: String.t()) :: :ok`                                    | Removes a GroupMember (revocation). Called by Writer on DELETE updates. |

#### Relationships

| Name                    | Signature                                                        | Description                                                       |
| ----------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------- |
| `get_entity_group/1`    | `get_entity_group(entity_id :: String.t()) :: String.t() \| nil` | Returns the Group ID an entity belongs to (via its Relationship). |
| `get_group_entities/1`  | `get_group_entities(group_id :: String.t()) :: [String.t()]`     | Returns all entity IDs in a Group. Used by Fan-Out and catch-up.  |
| `put_relationship/1`    | `put_relationship(rel :: relationship_entity()) :: :ok`          | Inserts/updates a Relationship. Called by Writer.                 |
| `delete_relationship/1` | `delete_relationship(rel_id :: String.t()) :: :ok`               | Removes a Relationship. Called by Writer on DELETE updates.       |

#### GSN Counter

| Name                | Signature                                                                                                   | Description                                                                                                 |
| ------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `claim_gsn_range/1` | `claim_gsn_range(count :: pos_integer()) :: {gsn_start :: non_neg_integer(), gsn_end :: non_neg_integer()}` | Atomically claims `count` sequential GSNs. Returns the inclusive range. Lock-free via `:atomics.add_get/3`. |
| `current_gsn/0`     | `current_gsn() :: non_neg_integer()`                                                                        | Returns the highest assigned GSN (not necessarily committed).                                               |

#### Committed Watermark

| Name                     | Signature                                         | Description                                                                                         |
| ------------------------ | ------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `mark_range_committed/2` | `mark_range_committed(gsn_start, gsn_end) :: :ok` | Records that GSNs `gsn_start..gsn_end` are durable. Called by Writer after each batch commit.       |
| `advance_watermark/0`    | `advance_watermark() :: non_neg_integer()`        | CAS loop: advances the watermark past contiguous committed ranges. Returns the new watermark value. |
| `committed_watermark/0`  | `committed_watermark() :: non_neg_integer()`      | Returns the current watermark -- the highest GSN where all prior GSNs are confirmed durable.        |

### Types

```elixir
@type group_membership :: %{
  group_id: String.t(),
  permissions: [String.t()] | :wildcard
}

@type group_member_entity :: %{
  id: String.t(),
  actor_id: String.t(),
  group_id: String.t(),
  permissions: [String.t()] | :wildcard,
  deleted_hlc: non_neg_integer() | nil
}

@type relationship_entity :: %{
  id: String.t(),
  source_id: String.t(),     # entity ID
  target_id: String.t(),     # group ID
  type: String.t(),          # entity type
  field: String.t(),         # relationship field name
  deleted_hlc: non_neg_integer() | nil
}
```

## Dependencies

| Dependency    | What it needs                                                                                                                                                              | Reference                                            |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| RocksDB Store | `cf_type_entities` prefix iterator (`prefix_iterator/3`), `cf_entity_actions` iterator, `cf_updates` point lookups (`get/3`) -- for startup population (uses default name) | [rocksdb-store.md](rocksdb-store.md#read-operations) |

Note: System Cache depends on RocksDB Store only at startup (to populate caches). At runtime, it is a pure ETS/atomics module with no external dependencies.

## Internal Design Notes

**ETS table configuration:**

| Table                    | Type   | Access                                              | Key                                                             |
| ------------------------ | ------ | --------------------------------------------------- | --------------------------------------------------------------- |
| `dirty_set`              | `:set` | `:public` (Writers write, Entity Store reads)       | `entity_id`                                                     |
| `group_members`          | `:bag` | `:public` (Writers write, Permission Checker reads) | `actor_id`                                                      |
| `relationships`          | `:set` | `:public` (Writers write, Fan-Out reads)            | `entity_id` (source)                                            |
| `relationships_by_group` | `:bag` | `:public`                                           | `group_id` (target) -- reverse index for `get_group_entities/1` |

All tables are `:public` because multiple processes need to read and write them. ETS guarantees atomicity for single-key operations, which is sufficient -- system entity cache updates are commutative (each update sets current state, not a delta).

**`:atomics` for GSN counter:**

```elixir
gsn_counter = :atomics.new(1, signed: false)

# claim_gsn_range(count):
gsn_end = :atomics.add_get(gsn_counter, 1, count)
gsn_start = gsn_end - count + 1
{gsn_start, gsn_end}
```

**Committed watermark tracking:** The watermark needs to track which GSN ranges have been committed and find the contiguous frontier. Use an ETS `:ordered_set` of committed ranges, plus an `:atomics` for the current watermark value:

```elixir
# After Writer commits GSNs 1001-2000:
:ets.insert(committed_ranges, {1001, 2000})

# advance_watermark():
# Starting from current watermark, scan committed_ranges for contiguous coverage
# CAS-update the watermark atomics to the new frontier
```

With only 2 writers, the committed_ranges table will have at most 1-2 entries at any time. The advance loop is O(1) in practice.

**Startup population:** Iterate `cf_type_entities` for types `"group"`, `"groupMember"`, `"relationship"`. For each entity ID found, read its Updates from RocksDB and materialize (same merge logic as Entity Store). This is a one-time cost at startup. The server does not accept connections until this completes.

**Dirty set and type filtering:** `dirty_entity_ids_for_type/1` needs to filter dirty entities by type. Entity IDs are prefixed by type (e.g., `todo_abc123`), so a prefix match on the ETS key works. Alternatively, maintain a secondary ETS table `dirty_by_type` keyed by `{type, entity_id}`. The simpler approach (scan `dirty_set` with prefix match) is fine if the dirty set is small; the secondary index is needed if the dirty set grows large.

## Open Questions

- **Dirty set type filtering strategy:** Scan with prefix match vs. secondary `dirty_by_type` ETS table? Start with prefix scan (simpler) and add the secondary index if `ctx.query()` latency on dirty types becomes a problem.
- **Startup population parallelism:** Should system entity materialization during startup be parallelized (e.g., `Task.async_stream`)? For small deployments it doesn't matter. For large deployments with millions of system entities, parallel materialization could significantly reduce startup time.
- **Watermark implementation:** The committed ranges ETS + CAS loop is one approach. An alternative is a simple GenServer that Writers call synchronously after each commit. With only 2 writers, the GenServer approach is simpler and the serialization cost is negligible. The `:atomics` approach avoids the GenServer bottleneck if writer count increases.
