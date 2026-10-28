defmodule EbbServer.Storage.RocksDB do
  @moduledoc """
  Owns the RocksDB database lifecycle and exposes the column-family
  handles the rest of the storage layer reads from and writes to.

  ## Why this exists

  RocksDB is the write path: every committed Action goes into
  `cf_actions` and is the source of truth for the rest of the system.
  SQLite only sees materialized entities and is rebuildable from
  `cf_actions` + `cf_group_actions`; RocksDB is not. This module is
  the only place that talks to the `rocksdb` hex package — every
  other storage module goes through this one.

  ## Lifecycle

  The GenServer exists only to open the database on init and close it
  on terminate. All accessor and I/O functions look up handles from
  `:persistent_term` and can be called from any process; the GenServer
  mailbox is never used at runtime. This keeps the hot path free of
  serialized message passing.

  Because the handles live in `:persistent_term`, they outlive this
  process unless `terminate/2` erases them — and a surviving `db_ref`
  keeps the RocksDB LOCK file held, so the replacement instance cannot
  open the same directory. `init/1` therefore traps exits (so a
  supervisor shutdown reaches `terminate/2`) and releases any handles
  left by a dead predecessor before it opens, then retries a bounded
  number of times while a lock is still being released.

  The DB opens with `enable_pipelined_write: true`, which lets multiple
  Writer batches commit concurrently without serializing through a single
  WAL. A 2-writer pipelined benchmark hit ~108k Actions/sec with full
  durability; production currently runs a single Writer. Throughput
  numbers are documented in GitHub issue #130 (see Epic #111 for the
  storage architecture).

  ## Column families

    default           - RocksDB default; holds internal metadata (migration markers)
    cf_actions        - GSN (64-bit big-endian) -> frame of {payload_etf,
                        update_scopes} (see `EbbServer.Storage.ActionFormat`)
    cf_entity_actions - (entity_id, max_gsn_in_flush) -> the subject's GSNs
                        in that flush, sorted ascending and unique, each as
                        an 8-byte big-endian integer (see `encode_gsn_list/1`)
    cf_type_entities  - (type, 0x00, entity_id) -> <<>> (presence index)
    cf_action_dedup   - action_id -> GSN (duplicate detection)
    cf_group_actions  - (group_id, GSN) -> action_id binary

  Composite keys use a `0x00` byte as a separator. Callers must never
  include null bytes in their `type` or `entity_id` components (enforced
  by `encode_type_entity_key/2`).

  ## Isolated instances

  Every accessor takes an optional `name` (default `__MODULE__`) so
  concurrent tests can run multiple isolated DBs with disjoint
  `:persistent_term` keys and disjoint supervision tree registrations.
  """

  use GenServer
  require Logger

  # ---------------------------------------------------------------------------
  # Types
  # ---------------------------------------------------------------------------

  @type cf_ref :: :rocksdb.cf_handle()
  @type gsn :: non_neg_integer()
  @type name :: GenServer.name()

  # ---------------------------------------------------------------------------
  # Column family descriptors (charlists for the Erlang NIF)
  # ---------------------------------------------------------------------------

  @cf_descriptors [
    {~c"default", []},
    {~c"cf_actions", []},
    {~c"cf_entity_actions", []},
    {~c"cf_type_entities", []},
    {~c"cf_action_dedup", []},
    {~c"cf_group_actions", []}
  ]

  # The tuning that ships in production, held fixed across benchmark runs.
  # `EbbServer.Bench.Report` reads `tuning/0` so the published environment
  # block cannot drift from what `open_database/2` actually opens.
  @tuning [max_background_jobs: 4, enable_pipelined_write: true]

  # Every handle the database publishes, keyed by the accessor that reads it.
  # One table drives publishing, releasing, and stale-handle cleanup so a new
  # column family cannot be added to one path and forgotten in another.
  @handle_keys %{
    db: :ebb_rocksdb_db,
    default: :ebb_cf_default,
    actions: :ebb_cf_actions,
    entity_actions: :ebb_cf_entity_actions,
    type_entities: :ebb_cf_type_entities,
    action_dedup: :ebb_cf_action_dedup,
    group_actions: :ebb_cf_group_actions
  }

  # The process that published `@handle_keys`. A handle outlives the process
  # that opened it when that process is killed without running `terminate/2`,
  # and a surviving `db_ref` keeps the RocksDB LOCK file held.
  @owner_key :ebb_rocksdb_owner

  # Retrying only pays off against a handle that is still being released: a
  # predecessor's `db_ref` copied by a reader outside the storage tree, or the
  # lock file's last descriptor closing. Anything longer-lived than this is
  # taken to be a second instance on the same `data_dir`, which must fail.
  @open_retry_delays_ms [50, 100, 200, 400, 800, 1600]

  # RocksDB renders a `LOCK` conflict as a plain IO error, so the state of the
  # data is indistinguishable from the state of the lock by error tag alone.
  @lock_contention_fragments [
    "lock hold by current process",
    "While lock file",
    "No locks available",
    "Resource temporarily unavailable"
  ]

  @doc """
  Returns the RocksDB tuning options that ship.
  """
  @spec tuning() :: keyword()
  def tuning, do: @tuning

  # ---------------------------------------------------------------------------
  # Public API — start / stop
  # ---------------------------------------------------------------------------

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts) do
    name = Keyword.get(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, opts, name: name)
  end

  @doc false
  @spec forget(name()) :: :ok
  # Test and tooling hook: drop every handle published for `name` without
  # touching the database. Cleans up after a database whose owner was killed
  # before `terminate/2` could run.
  def forget(name), do: erase_handles(name)

  # ---------------------------------------------------------------------------
  # Public API — persistent_term accessors
  # ---------------------------------------------------------------------------

  @spec db_ref(name()) :: :rocksdb.db_handle()
  def db_ref(name \\ __MODULE__), do: handle(:db, name)

  @spec cf_actions(name()) :: cf_ref()
  def cf_actions(name \\ __MODULE__), do: handle(:actions, name)

  @spec cf_entity_actions(name()) :: cf_ref()
  def cf_entity_actions(name \\ __MODULE__), do: handle(:entity_actions, name)

  @spec cf_type_entities(name()) :: cf_ref()
  def cf_type_entities(name \\ __MODULE__), do: handle(:type_entities, name)

  @spec cf_action_dedup(name()) :: cf_ref()
  def cf_action_dedup(name \\ __MODULE__), do: handle(:action_dedup, name)

  @spec cf_group_actions(name()) :: cf_ref()
  def cf_group_actions(name \\ __MODULE__), do: handle(:group_actions, name)

  @doc """
  The RocksDB default column family. Reserved for internal metadata:
  it is never scanned, so a small key like a one-shot migration marker
  costs nothing on the hot path and adds no column family to the schema.
  """
  @spec cf_default(name()) :: cf_ref()
  def cf_default(name \\ __MODULE__), do: handle(:default, name)

  defp handle(key, name), do: :persistent_term.get({Map.fetch!(@handle_keys, key), name})

  # ---------------------------------------------------------------------------
  # Public API — key encoding / decoding
  # ---------------------------------------------------------------------------

  @doc """
  Encodes GSN as 64-bit big-endian unsigned integer.
  This ordering ensures GSN range scans return actions in sequence order.
  """
  @spec encode_gsn_key(gsn()) :: binary()
  def encode_gsn_key(gsn), do: <<gsn::unsigned-big-integer-size(64)>>

  @spec decode_gsn_key(binary()) :: gsn()
  def decode_gsn_key(<<gsn::unsigned-big-integer-size(64)>>), do: gsn

  @doc """
  Composite key for the entity -> flush index.

  The entity ID is a variable-length prefix and the GSN is fixed 8 bytes at
  the end. One row covers a `(subject, flush)` pair: the GSN component is the
  subject's **highest** GSN in that flush, and the value is the sorted list of
  every GSN the flush wrote for that subject (`encode_gsn_list/1`). Keying by
  the maximum is what lets a reader seek from `last_gsn + 1`: a row whose max
  is at or after the seek can never be skipped while it still holds an
  unapplied GSN, even when `last_gsn` points inside the row's list.
  """
  @spec encode_entity_flush_key(binary(), gsn()) :: binary()
  def encode_entity_flush_key(entity_id, max_gsn) do
    <<entity_id::binary, max_gsn::unsigned-big-integer-size(64)>>
  end

  @spec decode_entity_flush_key(binary()) :: {binary(), gsn()}
  def decode_entity_flush_key(key) do
    entity_size = byte_size(key) - 8
    <<entity_id::binary-size(entity_size), max_gsn::unsigned-big-integer-size(64)>> = key
    {entity_id, max_gsn}
  end

  @doc """
  Encodes the `cf_entity_actions` row for one subject's GSNs in a flush.

  Returns `{key, value}` with the key at the list's **highest** GSN and the
  value holding the sorted, unique list. Normalization lives here so every
  writer emits the same row whatever order the flush accumulated the GSNs in.
  """
  @spec encode_entity_gsn_row(binary(), [gsn()]) :: {binary(), binary()}
  def encode_entity_gsn_row(entity_id, gsns) when is_list(gsns) and gsns != [] do
    sorted = gsns |> Enum.uniq() |> Enum.sort()
    {encode_entity_flush_key(entity_id, List.last(sorted)), encode_sorted_gsns(sorted)}
  end

  @doc """
  Encodes a non-empty GSN list as raw 8-byte big-endian integers, concatenated.

  No count prefix is needed: `byte_size(value) / 8` is the number of GSNs.
  The list is sorted and deduplicated here; the matching row key is the last
  element of that normalized list (`encode_entity_gsn_row/2`).
  """
  @spec encode_gsn_list([gsn()]) :: binary()
  def encode_gsn_list([_ | _] = gsns) do
    gsns |> Enum.uniq() |> Enum.sort() |> encode_sorted_gsns()
  end

  def encode_gsn_list([]) do
    raise ArgumentError, "cf_entity_actions GSN list cannot be empty"
  end

  defp encode_sorted_gsns(gsns) do
    for gsn <- gsns, into: <<>>, do: <<gsn::unsigned-big-integer-size(64)>>
  end

  @doc """
  Decodes a `cf_entity_actions` GSN list.

  Raises on an empty value or one whose length is not a multiple of 8, as the
  frame decoders do: a partial or missing GSN means the row is corrupt, not
  empty.
  """
  @spec decode_gsn_list(binary()) :: [gsn()]
  def decode_gsn_list(<<>>) do
    raise ArgumentError, "cf_entity_actions GSN list cannot be empty"
  end

  def decode_gsn_list(value) when is_binary(value) and rem(byte_size(value), 8) == 0 do
    for <<gsn::unsigned-big-integer-size(64) <- value>>, do: gsn
  end

  def decode_gsn_list(value) do
    raise ArgumentError,
          "cf_entity_actions GSN list must be a multiple of 8 bytes, got: " <>
            inspect(value, limit: 4)
  end

  @doc """
  Composite key for group -> actions index.
  Group ID is variable-length prefix, GSN is fixed 8 bytes at the end.
  Prefix scans on group_id return that group's actions in GSN order.
  """
  @spec encode_group_action_key(binary(), gsn()) :: binary()
  def encode_group_action_key(group_id, gsn) do
    <<group_id::binary, gsn::unsigned-big-integer-size(64)>>
  end

  @spec decode_group_action_key(binary()) :: {binary(), gsn()} | :error
  def decode_group_action_key(key) when byte_size(key) >= 8 do
    group_size = byte_size(key) - 8
    <<group_id::binary-size(group_size), gsn::unsigned-big-integer-size(64)>> = key
    {group_id, gsn}
  end

  def decode_group_action_key(_key), do: :error

  @doc """
  Iterator over an entire column family. Yields `{key, value}` tuples
  in key-sorted order. Convenience wrapper around `:rocksdb.iterator/3`.
  """
  @spec full_iterator(cf_ref(), keyword()) :: Enumerable.t()
  def full_iterator(cf_ref, opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)

    Stream.resource(
      fn ->
        {:ok, iter} = :rocksdb.iterator(db_ref(name), cf_ref, [])
        {iter, :rocksdb.iterator_move(iter, :first)}
      end,
      fn
        {iter, {:ok, key, value}} ->
          {[{key, value}], {iter, :rocksdb.iterator_move(iter, :next)}}

        {iter, {:error, :invalid_iterator}} ->
          {:halt, iter}

        {iter, {:error, _reason}} ->
          {:halt, iter}
      end,
      fn iter ->
        try do
          :rocksdb.iterator_close(iter)
        catch
          :error, {:invalid_iterator, _} -> :ok
        end
      end
    )
  end

  @doc """
  Encodes a composite key for the type-entities column family.

  Uses a `0x00` null byte as the separator between `type` and `entity_id`.
  Callers must ensure `type` never contains a `0x00` byte, otherwise the
  key boundary becomes ambiguous and lookups/prefix scans will silently break.
  """
  @spec encode_type_entity_key(binary(), binary()) :: binary()
  def encode_type_entity_key(type, entity_id) do
    type = validate_key_component(type, "type")
    entity_id = validate_key_component(entity_id, "entity_id")

    if :binary.match(type, <<0>>) != :nomatch do
      raise ArgumentError, "type must not contain null bytes (0x00)"
    end

    <<type::binary, 0, entity_id::binary>>
  end

  @spec validate_key_component(binary(), String.t()) :: binary()
  def validate_key_component(value, field_name) do
    if is_binary(value) and value != "" do
      value
    else
      raise ArgumentError, "#{field_name} must be a non-empty binary"
    end
  end

  # ---------------------------------------------------------------------------
  # Public API — data operations
  # ---------------------------------------------------------------------------

  @doc """
  Rows of the entity-actions index for `entity_id` whose key GSN is at or
  after `from_gsn`, in ascending key order.

  The key is `<<entity_id::binary, max_gsn_in_flush::64-big>>`, so this seeks
  straight to the first flush the caller might still need. A reader that has
  already applied every GSN up to `last_gsn` passes `last_gsn + 1` and touches
  only its delta, however long the entity's history is; `prefix_iterator/3` on
  the entity id would walk the whole history and filter afterwards. A row may
  still contain GSNs at or below `last_gsn` when the seek lands inside it; the
  reader decodes the list and filters those out.

  The upper bound is the entity id's prefix bound, so this inherits
  `prefix_iterator/3`'s assumption that no entity id is a prefix of another.
  """
  @spec entity_gsn_iterator(cf_ref(), binary(), gsn(), keyword()) :: Enumerable.t()
  def entity_gsn_iterator(cf_ref, entity_id, from_gsn, opts \\ []) when is_integer(from_gsn) do
    range_iterator(
      cf_ref,
      encode_entity_flush_key(entity_id, from_gsn),
      prefix_upper_bound(entity_id),
      opts
    )
  end

  @doc """
  Returns the highest GSN stored in the `cf_actions` column family.

  Uses a RocksDB iterator to seek to the last key, then decodes it.
  Returns 0 if the database is empty.
  """
  @spec get_max_gsn(name()) :: non_neg_integer()
  def get_max_gsn(name \\ __MODULE__) do
    {:ok, iter} = :rocksdb.iterator(db_ref(name), cf_actions(name), [])

    try do
      case :rocksdb.iterator_move(iter, :last) do
        {:ok, key, _value} ->
          decode_gsn_key(key)

        {:error, _reason} ->
          0
      end
    after
      :rocksdb.iterator_close(iter)
    end
  end

  @spec write_batch([{:put, cf_ref(), binary(), binary()}], keyword()) ::
          :ok | {:error, term()}
  def write_batch(operations, opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    {:ok, batch} = :rocksdb.batch()

    try do
      Enum.each(operations, fn {:put, cf_ref, key, value} ->
        :ok = :rocksdb.batch_put(batch, cf_ref, key, value)
      end)

      :rocksdb.write_batch(db_ref(name), batch, sync: true)
    after
      :rocksdb.release_batch(batch)
    end
  end

  @spec get(cf_ref(), binary(), keyword()) ::
          {:ok, binary()} | :not_found | {:error, term()}
  def get(cf_ref, key, opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    :rocksdb.get(db_ref(name), cf_ref, key, [])
  end

  @doc """
  Retrieves multiple values from a single column family in a single RocksDB call.

  Returns a list of values in the same order as the input keys.
  Returns `:not_found` for keys that don't exist.
  """
  @spec multi_get(cf_ref(), [binary()], keyword()) :: [{:ok, binary()} | :not_found]
  def multi_get(cf_ref, keys, opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    results = :rocksdb.multi_get(db_ref(name), cf_ref, keys, [])
    Enum.map(results, &format_multi_get_result/1)
  end

  defp format_multi_get_result({:ok, value}), do: {:ok, value}
  defp format_multi_get_result(:not_found), do: :not_found

  @doc """
  Returns a lazy stream of `{key, value}` pairs whose keys fall in the
  half-open range `[prefix, prefix_upper_bound(prefix))`.

  This uses RocksDB's `iterate_upper_bound` option for efficient scanning.
  It does **not** perform a per-key prefix check — every key in the range is
  emitted. This means that if key `A` is a proper prefix of key `B`, a scan
  with prefix `A` will also return keys that logically belong to `B`.

  For `cf_entity_actions` this is safe because entity IDs are nanoid-generated
  fixed-length random strings, so no entity ID is ever a prefix of another.
  If you use this function with variable-length prefixes where one prefix
  could be a proper prefix of another, you must filter the results yourself.
  """
  @spec prefix_iterator(cf_ref(), binary(), keyword()) :: Enumerable.t()
  def prefix_iterator(cf_ref, prefix, opts \\ []) when prefix != <<>> do
    name = Keyword.get(opts, :name, __MODULE__)

    iter_opts =
      case prefix_upper_bound(prefix) do
        :none -> []
        upper_bound -> [{:iterate_upper_bound, upper_bound}]
      end

    Stream.resource(
      fn ->
        {:ok, iter} = :rocksdb.iterator(db_ref(name), cf_ref, iter_opts)

        seek_result = :rocksdb.iterator_move(iter, {:seek, prefix})
        {iter, seek_result}
      end,
      fn
        {iter, {:ok, key, value}} ->
          {[{key, value}], {iter, :rocksdb.iterator_move(iter, :next)}}

        {iter, {:error, :invalid_iterator}} ->
          {:halt, iter}

        {iter, {:error, _reason}} ->
          {:halt, iter}
      end,
      fn iter ->
        # The iterator may already be invalidated if the DB was closed
        # mid-stream (e.g., between tests). The BEAM surfaces that as
        # either an `ArgumentError` (when the NIF returns :badarg) or
        # a tagged `{:error, :invalid_iterator}` tuple — both of which
        # Stream.resource turns into exceptions. Swallow them silently:
        # we got the data we cared about, and the caller is already
        # cleaning up the DB anyway.
        try do
          :rocksdb.iterator_close(iter)
        catch
          :error, _ -> :ok
          {:error, _} -> :ok
        end
      end
    )
  end

  @doc """
  Returns a lazy stream of `{key, value}` pairs whose keys fall in the
  half-open range `[from_key, to_key)`.

  Uses RocksDB's `iterate_upper_bound` option for efficient bounded scanning.
  The bound check happens in RocksDB itself, not in Elixir, so this is as
  efficient as `prefix_iterator` for large ranges. `to_key: :none` scans to
  the end of the column family, which is only correct when `from_key` is the
  last key the caller will ever read from it.
  """
  @spec range_iterator(cf_ref(), binary(), binary() | :none, keyword()) :: Enumerable.t()
  def range_iterator(cf_ref, from_key, to_key, opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    iter_opts = if to_key == :none, do: [], else: [{:iterate_upper_bound, to_key}]

    Stream.resource(
      fn ->
        {:ok, iter} = :rocksdb.iterator(db_ref(name), cf_ref, iter_opts)
        seek_result = :rocksdb.iterator_move(iter, {:seek, from_key})
        {iter, seek_result}
      end,
      fn
        {iter, {:ok, key, value}} ->
          {[{key, value}], {iter, :rocksdb.iterator_move(iter, :next)}}

        {iter, {:error, :invalid_iterator}} ->
          {:halt, iter}

        {iter, {:error, _reason}} ->
          {:halt, iter}
      end,
      fn
        {iter, _} ->
          try do
            :rocksdb.iterator_close(iter)
          catch
            :error, {:invalid_iterator, _} -> :ok
          end

        iter ->
          try do
            :rocksdb.iterator_close(iter)
          catch
            :error, {:invalid_iterator, _} -> :ok
          end
      end
    )
  end

  # ---------------------------------------------------------------------------
  # GenServer callbacks
  # ---------------------------------------------------------------------------

  @impl true
  def init(opts) do
    # Without this the supervisor's `:shutdown` signal kills this process
    # outright: `terminate/2` never runs, the handles it published stay in
    # `:persistent_term`, and the next instance on the same directory cannot
    # take the LOCK file (ebbjs/ebbjs#632).
    Process.flag(:trap_exit, true)

    data_dir = Keyword.fetch!(opts, :data_dir)
    name = Keyword.get(opts, :name, __MODULE__)
    path = Path.join(data_dir, "rocksdb")

    case safe_mkdir_p(path) do
      :ok ->
        open_database(path, name, opts)

      {:error, reason} ->
        {:stop, {:data_dirCreation_failed, reason}}
    end
  end

  defp open_database(path, name, opts) do
    # A predecessor killed before `terminate/2` left its handles behind, and a
    # `db_ref` that is still referenced keeps the LOCK file held. Dropping the
    # stale handles first is what lets the replacement open at all.
    release_stale_handles(name)

    db_opts =
      [
        create_if_missing: true,
        create_missing_column_families: true
      ] ++ @tuning

    retry_delays = Keyword.get(opts, :open_retry_delays_ms, @open_retry_delays_ms)

    attempt_open(String.to_charlist(path), path, db_opts, name, retry_delays)
  end

  defp attempt_open(path_chars, path, db_opts, name, retry_delays) do
    case :rocksdb.open(path_chars, db_opts, @cf_descriptors) do
      {:ok, db_ref,
       [
         default_cf,
         cf_actions,
         cf_entity_actions,
         cf_type_entities,
         cf_action_dedup,
         cf_group_actions
       ]} ->
        store_handles(name, %{
          db: db_ref,
          default: default_cf,
          actions: cf_actions,
          entity_actions: cf_entity_actions,
          type_entities: cf_type_entities,
          action_dedup: cf_action_dedup,
          group_actions: cf_group_actions
        })

        {:ok, %{db_ref: db_ref, name: name}}

      {:error, reason} ->
        retry_open(reason, path_chars, path, db_opts, name, retry_delays)
    end
  end

  defp retry_open(reason, path_chars, path, db_opts, name, [delay | rest]) do
    if lock_contention?(reason) do
      Logger.warning(fn ->
        "RocksDB open at #{path} is blocked by a held lock (#{safe_stringify(reason)}); " <>
          "retrying in #{delay}ms"
      end)

      Process.sleep(delay)
      attempt_open(path_chars, path, db_opts, name, rest)
    else
      fail_open(reason, path)
    end
  end

  defp retry_open(reason, _path_chars, path, _db_opts, _name, []), do: fail_open(reason, path)

  defp fail_open(reason, path) do
    log_rocksdb_error(reason, path)
    {:stop, {:rocksdb_open_failed, reason}}
  end

  # A lock conflict is a RocksDB IO error, not a tagged reason, so the message
  # is the only place the two are distinguishable. Only the lock case is worth
  # waiting on: a corrupt or otherwise unreadable database would just fail the
  # same way after the retries.
  defp lock_contention?({:db_open, message}) when is_list(message) do
    message
    |> List.to_string()
    |> String.contains?(@lock_contention_fragments)
  rescue
    _ -> false
  end

  defp lock_contention?(_reason), do: false

  # `mkdir_p` reports a concurrent opener as a creation failure even though the
  # directory is there by the time it returns.
  defp safe_mkdir_p(path) do
    case File.mkdir_p(path) do
      :ok -> :ok
      {:error, reason} -> if File.dir?(path), do: :ok, else: {:error, reason}
    end
  end

  defp store_handles(name, handles) do
    # The owner goes first: it is what tells a competing opener that these
    # handles belong to a live process rather than a dead predecessor's.
    :persistent_term.put({@owner_key, name}, self())

    Enum.each(@handle_keys, fn {key, term_key} ->
      :persistent_term.put({term_key, name}, Map.fetch!(handles, key))
    end)

    :ok
  end

  # Only a live owner keeps its handles: a second instance on the same
  # `data_dir` must fail loudly instead of silently detaching the running
  # database from its accessors. No owner at all means the publisher was
  # killed between opening and publishing, or predates the owner key.
  defp release_stale_handles(name) do
    case :persistent_term.get({@owner_key, name}, nil) do
      owner when is_pid(owner) -> if Process.alive?(owner), do: :ok, else: erase_handles(name)
      _no_owner -> erase_handles(name)
    end
  end

  defp log_rocksdb_error(reason, path) do
    Logger.error("RocksDB failed to open at #{path}: #{safe_stringify(reason)}")
  end

  defp safe_stringify(term) do
    term
    |> inspect(limit: 1000, printable_limit: 1000)
    |> String.replace("\t", "~t")
    |> String.replace("\n", "~n")
    |> String.replace("\r", "~r")
  end

  @impl true
  def terminate(_reason, %{db_ref: db_ref, name: name}) do
    erase_handles(name)
    safe_close(db_ref)
  end

  def terminate(_reason, %{name: name}) do
    erase_handles(name)
  end

  def terminate(_reason, _state) do
    :ok
  end

  defp erase_handles(name) do
    Enum.each(@handle_keys, fn {_key, term_key} ->
      :persistent_term.erase({term_key, name})
    end)

    :persistent_term.erase({@owner_key, name})
    :ok
  end

  defp safe_close(db_ref) do
    :rocksdb.close(db_ref)
  rescue
    _ -> :ok
  end

  # ---------------------------------------------------------------------------
  # Private helpers
  # ---------------------------------------------------------------------------

  # All bytes were 0xFF — no upper bound exists for this prefix.
  defp prefix_upper_bound(<<>>), do: :none

  defp prefix_upper_bound(prefix) do
    size = byte_size(prefix) - 1
    <<head::binary-size(size), last>> = prefix

    if last < 0xFF do
      <<head::binary, last + 1>>
    else
      prefix_upper_bound(head)
    end
  end
end
