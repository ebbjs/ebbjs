defmodule EbbServer.Storage.SystemCache do
  @moduledoc """
  Supervisor GenServer for the storage cache layer.

  Manages the lifecycle of cache subsystems:
  - `DirtyTracker` - tracks dirty entity IDs
  - `GroupCache` - manages group memberships
  - `RelationshipCache` - manages entity relationships

  Also manages the GSN counter via persistent_term.

  ## Child Start Arguments

  All child modules accept optional keyword arguments to override default ETS table names:
  - `:dirty_set` - defaults to `:ebb_dirty_set`
  - `:table` (GroupCache) - defaults to `:ebb_group_members`
  - `:relationships` - defaults to `:ebb_relationships`
  - `:relationships_by_group` - defaults to `:ebb_relationships_by_group`

  ## Example

      SystemCache.start_link([])
  """

  use GenServer

  require Logger

  alias EbbServer.Storage.{
    DirtyTracker,
    EntityStore,
    Fields,
    GroupCache,
    RelationshipCache,
    RocksDB
  }

  @default_gsn_counter_name :ebb_gsn_counter

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  @doc """
  Public entry point for the startup cache-rebuild flow. Same logic
  that runs from `init/1`: backfill the type-entities index from the
  action log, then materialize every entity into GroupCache and
  RelationshipCache. Used by tests that want to verify the rebuild
  without spinning up a fresh supervisor.

  Accepts the same keyword options as `init/1` (`:rocks_name`,
  `:table`, `:relationships`, `:relationships_by_group`,
  `:sqlite_name`) so callers can drive the rebuild against isolated
  stores without relying on global `:persistent_term` state.
  """
  @default_dirty_set_name :ebb_dirty_set

  @spec populate_system_caches(keyword()) :: :ok
  def populate_system_caches(opts \\ []) do
    rocks_name = Keyword.get(opts, :rocks_name, EbbServer.Storage.RocksDB)
    gm_table = Keyword.get(opts, :table) || :persistent_term.get({GroupCache, :group_members})

    rel_table =
      Keyword.get(opts, :relationships) ||
        :persistent_term.get({RelationshipCache, :relationships})

    rbg_table =
      Keyword.get(opts, :relationships_by_group) ||
        :persistent_term.get({RelationshipCache, :relationships_by_group})

    dirty_set =
      Keyword.get(opts, :dirty_set) ||
        :persistent_term.get({DirtyTracker, :dirty_set}, @default_dirty_set_name)

    backfill_type_entities(rocks_name)

    populate_caches_from_indexes(
      rocks_name,
      gm_table,
      rel_table,
      rbg_table,
      dirty_set,
      opts
    )
  end

  @impl true
  def init(opts) do
    gsn_counter_name = Keyword.get(opts, :gsn_counter_name, @default_gsn_counter_name)

    dirty_set_opts = Keyword.take(opts, [:dirty_set])
    group_cache_opts = Keyword.take(opts, [:table])
    rel_cache_opts = Keyword.take(opts, [:relationships, :relationships_by_group])

    children = [
      {DirtyTracker, dirty_set_opts},
      {GroupCache, group_cache_opts},
      {RelationshipCache, rel_cache_opts}
    ]

    case Supervisor.start_link(__MODULE__.Children, {:start_children, children}) do
      {:ok, sup_pid} ->
        gsn_counter = setup_gsn_counter(opts, gsn_counter_name)

        try do
          populate_system_caches(
            Keyword.take(opts, [:rocks_name, :table, :relationships, :relationships_by_group])
          )
        rescue
          e ->
            Logger.warning("Failed to populate system caches: #{inspect(e)}")
        end

        {:ok, %{sup_pid: sup_pid, gsn_counter: gsn_counter, gsn_counter_name: gsn_counter_name}}

      {:error, reason} ->
        {:stop, reason}
    end
  end

  @impl true
  def terminate(_reason, _state) do
    :ok
  end

  defmodule Children do
    @moduledoc false
    use Supervisor

    def init({:start_children, children}) do
      Supervisor.init(children, strategy: :one_for_all)
    end
  end

  defp setup_gsn_counter(opts, gsn_counter_name) do
    counter =
      case Keyword.get(opts, :gsn_counter) do
        nil -> :atomics.new(1, signed: false)
        existing -> existing
      end

    :persistent_term.put(gsn_counter_name, counter)

    case Keyword.get_lazy(opts, :initial_gsn, fn -> RocksDB.get_max_gsn() end) do
      n when n > 0 -> :atomics.put(counter, 1, n)
      _ -> :ok
    end

    counter
  end

  defp populate_caches_from_indexes(
         rocks_name,
         gm_table,
         rel_table,
         rbg_table,
         dirty_set,
         opts
       ) do
    sqlite_opts = Keyword.take(opts, [:sqlite_name])

    populate_type(
      "groupMember",
      rocks_name,
      dirty_set,
      fn entity_data ->
        data = entity_data.data || %{}

        member = %{
          id: entity_data.id,
          # Use Fields.get/2 to handle both shapes: `{"actor_id" => "x"}`
          # and `{"fields" => {"actor_id" => {"value" => "x"}}}`.
          actor_id: Fields.get(data, "actor_id"),
          group_id: Fields.get(data, "group_id"),
          permissions: Fields.get(data, "permissions")
        }

        GroupCache.put_group_member(member, gm_table)
      end,
      sqlite_opts
    )

    populate_type(
      "relationship",
      rocks_name,
      dirty_set,
      fn entity_data ->
        data = entity_data.data || %{}

        RelationshipCache.put_relationship(
          %{
            id: entity_data.id,
            source_id: Fields.get(data, "source_id"),
            target_id: Fields.get(data, "target_id"),
            type: Fields.get(data, "type"),
            field: Fields.get(data, "field")
          },
          relationships: rel_table,
          relationships_by_group: rbg_table
        )
      end,
      sqlite_opts
    )
  end

  defp populate_type(type, rocks_name, dirty_set, insert_fn, opts) do
    prefix = type <> <<0>>
    cf = RocksDB.cf_type_entities(rocks_name)
    sqlite_name = Keyword.get(opts, :sqlite_name, EbbServer.Storage.SQLite)

    cf
    |> RocksDB.prefix_iterator(prefix, name: rocks_name)
    |> Stream.each(fn {key, _value} ->
      <<_type_bytes::binary-size(byte_size(type)), 0, entity_id::binary>> = key

      case EntityStore.materialize(
             entity_id,
             rocks_name: rocks_name,
             sqlite_name: sqlite_name,
             dirty_set: dirty_set
           ) do
        {:ok, entity} -> insert_fn.(entity)
        error -> Logger.warning("Failed to materialize entity #{entity_id}: #{inspect(error)}")
      end
    end)
    |> Stream.run()
  end

  # Walk every action in `cf_actions` and ensure each (type, entity_id)
  # pair has an entry in `cf_type_entities`. Idempotent — skips entries
  # that already exist. Skips tombstones (a tombstoned entity was
  # created at some point, so its initial put/update still warrants an
  # index entry; we don't bother adding one if the action itself is a
  # pure tombstone of a never-created entity).
  defp backfill_type_entities(rocks_name) do
    cf_actions = RocksDB.cf_actions(rocks_name)
    cf_type_entities = RocksDB.cf_type_entities(rocks_name)

    # Use a Set for membership tests in the inner loop. For the demo's
    # action-log size (a few thousand entries) building the set up-front
    # is cheaper than a per-key RocksDB lookup.
    existing_keys =
      cf_type_entities
      |> RocksDB.full_iterator(name: rocks_name)
      |> Enum.reduce(MapSet.new(), fn {key, _value}, acc -> MapSet.put(acc, key) end)

    ops =
      cf_actions
      |> RocksDB.range_iterator(
        <<0::unsigned-big-integer-size(64)>>,
        <<0xFFFFFFFFFFFFFFFF::unsigned-big-integer-size(64)>>,
        name: rocks_name
      )
      |> Stream.map(fn {_gsn_key, action_etf} -> :erlang.binary_to_term(action_etf, [:safe]) end)
      |> Stream.flat_map(fn action ->
        # Each update contributes at most one (type, entity_id) pair.
        # Tombstones (method == "delete") still imply a prior create,
        # so we index them too — the materialize path handles
        # deleted_hlc by returning :not_found and the cache populate
        # gracefully no-ops on those.
        action["updates"] || []
      end)
      |> Stream.map(fn update ->
        type = update["subject_type"]
        id = update["subject_id"]
        key = RocksDB.encode_type_entity_key(type, id)
        {key, type, id}
      end)
      |> Stream.filter(fn {key, _type, _id} -> not MapSet.member?(existing_keys, key) end)
      |> Stream.uniq_by(fn {key, _, _} -> key end)
      |> Enum.map(fn {key, _type, _id} -> {:put, cf_type_entities, key, <<>>} end)

    ops_list = Enum.to_list(ops)

    if ops_list != [] do
      Logger.info("Backfilling #{length(ops_list)} missing cf_type_entities entries")

      case RocksDB.write_batch(ops_list, name: rocks_name) do
        :ok ->
          :ok

        {:error, reason} ->
          Logger.warning("cf_type_entities backfill write failed: #{inspect(reason)}")
      end
    end

    :ok
  rescue
    e ->
      Logger.warning("Failed to backfill cf_type_entities: #{inspect(e)}")
      :ok
  end
end
