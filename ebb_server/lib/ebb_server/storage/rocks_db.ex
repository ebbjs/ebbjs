defmodule EbbServer.Storage.RocksDB do
  @moduledoc """
  GenServer that owns the RocksDB database lifecycle.

  On init, opens the database and stores all column family handles in
  `:persistent_term` for lock-free access from any process. The GenServer
  itself never receives read/write messages — it exists solely to open
  the database on startup and close it on shutdown.

  All public accessor and data functions accept an optional `name`
  parameter (defaulting to `__MODULE__`) so that tests can run multiple
  isolated instances concurrently.

  Column families and their key schemas:

    default           - RocksDB default, unused
    cf_actions        - GSN (64-bit big-endian) -> action (ETF binary)
    cf_updates        - (action_id, 0x00, update_id) -> update (ETF binary)
    cf_entity_actions - (entity_id, GSN) -> action_id binary
    cf_type_entities  - (type, 0x00, entity_id) -> <<>> (presence index)
    cf_action_dedup   - action_id -> GSN (duplicate detection)
  """

  use GenServer

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
    {~c"cf_updates", []},
    {~c"cf_entity_actions", []},
    {~c"cf_type_entities", []},
    {~c"cf_action_dedup", []}
  ]

  # ---------------------------------------------------------------------------
  # Public API — start / stop
  # ---------------------------------------------------------------------------

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts) do
    name = Keyword.get(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, opts, name: name)
  end

  # ---------------------------------------------------------------------------
  # Public API — persistent_term accessors
  # ---------------------------------------------------------------------------

  @spec db_ref(name()) :: :rocksdb.db_handle()
  def db_ref(name \\ __MODULE__), do: :persistent_term.get({:ebb_rocksdb_db, name})

  @spec cf_actions(name()) :: cf_ref()
  def cf_actions(name \\ __MODULE__), do: :persistent_term.get({:ebb_cf_actions, name})

  @spec cf_updates(name()) :: cf_ref()
  def cf_updates(name \\ __MODULE__), do: :persistent_term.get({:ebb_cf_updates, name})

  @spec cf_entity_actions(name()) :: cf_ref()
  def cf_entity_actions(name \\ __MODULE__),
    do: :persistent_term.get({:ebb_cf_entity_actions, name})

  @spec cf_type_entities(name()) :: cf_ref()
  def cf_type_entities(name \\ __MODULE__),
    do: :persistent_term.get({:ebb_cf_type_entities, name})

  @spec cf_action_dedup(name()) :: cf_ref()
  def cf_action_dedup(name \\ __MODULE__), do: :persistent_term.get({:ebb_cf_action_dedup, name})

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
  Composite key for entity -> actions index.
  Entity ID is variable-length prefix, GSN is fixed 8 bytes at the end.
  Prefix scans on entity_id return all actions for that entity in GSN order.
  """
  @spec encode_entity_gsn_key(binary(), gsn()) :: binary()
  def encode_entity_gsn_key(entity_id, gsn) do
    <<entity_id::binary, gsn::unsigned-big-integer-size(64)>>
  end

  @spec decode_entity_gsn_key(binary()) :: {binary(), gsn()}
  def decode_entity_gsn_key(key) do
    entity_size = byte_size(key) - 8
    <<entity_id::binary-size(entity_size), gsn::unsigned-big-integer-size(64)>> = key
    {entity_id, gsn}
  end

  @doc """
  Encodes a composite key for the updates column family.

  Uses a `0x00` null byte as the separator between `action_id` and `update_id`.
  Callers must ensure `action_id` never contains a `0x00` byte, otherwise the
  key boundary becomes ambiguous and lookups/prefix scans will silently break.
  """
  @spec encode_update_key(binary(), binary()) :: binary()
  def encode_update_key(action_id, update_id) do
    action_id = validate_key_component(action_id, "action_id")
    update_id = validate_key_component(update_id, "update_id")

    if :binary.match(action_id, <<0>>) != :nomatch do
      raise ArgumentError, "action_id must not contain null bytes (0x00)"
    end

    <<action_id::binary, 0, update_id::binary>>
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
        :rocksdb.iterator_close(iter)
      end
    )
  end

  @doc """
  Returns a lazy stream of `{key, value}` pairs whose keys fall in the
  half-open range `[from_key, to_key)`.

  Unlike `prefix_iterator/3`, this function cannot use RocksDB's
  `iterate_upper_bound` option because the bound is caller-specified rather
  than derived from the prefix. The bound check is performed in Elixir after
  each `iterator_move`, making it slightly less efficient for large ranges
  but flexible for arbitrary key ranges.
  """
  @spec range_iterator(cf_ref(), binary(), binary(), keyword()) :: Enumerable.t()
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
      fn
        {iter, _seek_result} -> :rocksdb.iterator_close(iter)
        iter -> :rocksdb.iterator_close(iter)
      end
    )
  end

  # ---------------------------------------------------------------------------
  # GenServer callbacks
  # ---------------------------------------------------------------------------

  @impl true
  def init(opts) do
    data_dir = Keyword.fetch!(opts, :data_dir)
    name = Keyword.get(opts, :name, __MODULE__)
    path = Path.join(data_dir, "rocksdb")
    File.mkdir_p!(path)

    db_opts = [
      create_if_missing: true,
      create_missing_column_families: true,
      max_background_jobs: 4,
      enable_pipelined_write: true
    ]

    case :rocksdb.open(String.to_charlist(path), db_opts, @cf_descriptors) do
      {:ok, db_ref,
       [_default_cf, cf_actions, cf_updates, cf_entity_actions, cf_type_entities, cf_action_dedup]} ->
        :persistent_term.put({:ebb_rocksdb_db, name}, db_ref)
        :persistent_term.put({:ebb_cf_actions, name}, cf_actions)
        :persistent_term.put({:ebb_cf_updates, name}, cf_updates)
        :persistent_term.put({:ebb_cf_entity_actions, name}, cf_entity_actions)
        :persistent_term.put({:ebb_cf_type_entities, name}, cf_type_entities)
        :persistent_term.put({:ebb_cf_action_dedup, name}, cf_action_dedup)

        {:ok, %{db_ref: db_ref, name: name}}

      {:error, reason} ->
        {:stop, reason}
    end
  end

  @impl true
  def terminate(_reason, %{db_ref: db_ref, name: name}) do
    :persistent_term.erase({:ebb_rocksdb_db, name})
    :persistent_term.erase({:ebb_cf_actions, name})
    :persistent_term.erase({:ebb_cf_updates, name})
    :persistent_term.erase({:ebb_cf_entity_actions, name})
    :persistent_term.erase({:ebb_cf_type_entities, name})
    :persistent_term.erase({:ebb_cf_action_dedup, name})

    :rocksdb.close(db_ref)
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
