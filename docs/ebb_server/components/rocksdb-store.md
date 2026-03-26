# RocksDB Store

## Purpose

Manages the RocksDB embedded database instance -- opening the database, creating and referencing column families, encoding/decoding keys, and providing low-level read/write primitives that other components build on. This is the only module that interacts with the `rocksdb` hex package directly.

## Responsibilities

- Open the RocksDB database at the configured `data_dir` path with the correct options (`enable_pipelined_write`, `max_background_jobs`, etc.)
- Create and hold references to all 5 column families
- Encode keys in big-endian byte format for correct lexicographic ordering
- Provide `WriteBatch` construction and commit (with `sync: true`)
- Provide iterator-based reads (prefix scan, range scan)
- Provide point lookups by key
- Expose RocksDB statistics for monitoring
- Handle database close on shutdown

## Public Interface

### Module: `EbbServer.Storage.RocksDB`

This is a GenServer that owns the database handle and column family references. Other components receive these references at startup (via the supervision tree) and use the functional API below.

#### Lifecycle

| Name | Signature | Description |
|------|-----------|-------------|
| `start_link/1` | `start_link(opts) :: GenServer.on_start()` | Opens RocksDB, creates column families. `opts`: `[data_dir: String.t()]` |
| `stop/1` | `stop(pid) :: :ok` | Closes the database cleanly |

#### References

| Name | Signature | Description |
|------|-----------|-------------|
| `db_ref/0` | `db_ref() :: reference()` | Returns the RocksDB database handle |
| `cf_actions/0` | `cf_actions() :: reference()` | Column family: `cf_actions` |
| `cf_updates/0` | `cf_updates() :: reference()` | Column family: `cf_updates` |
| `cf_entity_actions/0` | `cf_entity_actions() :: reference()` | Column family: `cf_entity_actions` |
| `cf_type_entities/0` | `cf_type_entities() :: reference()` | Column family: `cf_type_entities` |
| `cf_action_dedup/0` | `cf_action_dedup() :: reference()` | Column family: `cf_action_dedup` |

These are stored in a named ETS table (or persistent_term) at startup so any process can look them up without message passing.

#### Key Encoding

| Name | Signature | Description |
|------|-----------|-------------|
| `encode_gsn_key/1` | `encode_gsn_key(gsn :: non_neg_integer()) :: binary()` | `<<gsn::64-big>>` |
| `encode_entity_gsn_key/2` | `encode_entity_gsn_key(entity_id :: binary(), gsn :: non_neg_integer()) :: binary()` | `<<entity_id::binary, gsn::64-big>>` |
| `encode_update_key/2` | `encode_update_key(action_id :: binary(), update_id :: binary()) :: binary()` | `<<action_id::binary, update_id::binary>>` |
| `encode_type_entity_key/2` | `encode_type_entity_key(type :: binary(), entity_id :: binary()) :: binary()` | `<<type::binary, entity_id::binary>>` |
| `decode_gsn_key/1` | `decode_gsn_key(binary()) :: non_neg_integer()` | Extracts GSN from a `<<gsn::64-big>>` key |
| `decode_entity_gsn_key/1` | `decode_entity_gsn_key(binary()) :: {binary(), non_neg_integer()}` | Extracts `{entity_id, gsn}` from composite key |

#### Write Operations

| Name | Signature | Description |
|------|-----------|-------------|
| `write_batch/1` | `write_batch(operations :: [batch_op()]) :: :ok \| {:error, term()}` | Builds a WriteBatch from a list of `{cf_ref, key, value}` tuples and commits with `sync: true` |

The `batch_op` type:

```elixir
@type batch_op :: {:put, cf_ref :: reference(), key :: binary(), value :: binary()}
```

#### Read Operations

| Name | Signature | Description |
|------|-----------|-------------|
| `get/2` | `get(cf_ref, key) :: {:ok, binary()} \| :not_found` | Point lookup in a column family |
| `prefix_iterator/2` | `prefix_iterator(cf_ref, prefix) :: Enumerable.t()` | Returns a lazy stream of `{key, value}` pairs matching the prefix |
| `range_iterator/3` | `range_iterator(cf_ref, from_key, to_key) :: Enumerable.t()` | Returns a lazy stream of `{key, value}` pairs in `[from_key, to_key)` |

### Types

```elixir
@type db_handle :: reference()
@type cf_handle :: reference()
@type batch_op :: {:put, cf_handle(), binary(), binary()}
```

## Dependencies

None. This is a leaf component -- it depends only on the `rocksdb` hex package.

## Internal Design Notes

**GenServer vs. module-only:** The GenServer exists solely to own the database handle lifecycle (open on init, close on terminate). All read/write functions are stateless -- they take the db/cf references as arguments (or look them up from `:persistent_term`). This means reads and writes can happen from any process without going through the GenServer's mailbox.

**`:persistent_term` for references:** After opening the database and column families in `init/1`, store the references in `:persistent_term` keyed by atom names (e.g., `:ebb_rocksdb_db`, `:ebb_cf_actions`). This gives O(1) access from any process without ETS lookup overhead. The references are stable for the lifetime of the database.

**Iterator resource management:** The `rocksdb` hex package provides `iterator/3` which returns an iterator resource. Wrap this in a `Stream.resource/3` that calls `:rocksdb.iterator_move/2` on each step and `:rocksdb.iterator_close/1` on cleanup. This ensures iterators are always closed, even if the caller stops consuming early.

**Key encoding for composite keys:** Entity IDs are variable-length strings. For `cf_entity_actions`, the key is `<<entity_id::binary, gsn::64-big>>`. Since GSN is always the last 8 bytes, decoding is: `entity_id = binary_part(key, 0, byte_size(key) - 8)`, `gsn = binary_part(key, byte_size(key) - 8, 8)`. Prefix iteration with just the `entity_id` bytes correctly scans all GSNs for that entity.

**RocksDB options:**

```elixir
db_opts = [
  create_if_missing: true,
  create_missing_column_families: true,
  max_background_jobs: 4,
  enable_pipelined_write: true
]
```

**Column family creation:** On first open, create all 5 column families. On subsequent opens, open with the existing column family list. The `rocksdb` hex package requires listing all existing column families when opening.

## Open Questions

- **Compression per column family:** Should `cf_actions` and `cf_updates` use Snappy (fast, moderate compression) or LZ4 (faster, less compression)? ETF binaries are ~20-40% larger than MessagePack, so compression matters. The default (Snappy) is likely fine. Revisit if disk usage becomes a concern.
- **Block cache size:** The default RocksDB block cache is 8MB. For a server handling 10k connections, a larger cache (64-256MB) may be warranted. This should be configurable and tuned based on observed read patterns.
- **TTL on `cf_action_dedup`:** Dedup entries are only needed for the replication window. A compaction filter or TTL could prune old entries. Not needed for single-node operation (Slices 1-5).
