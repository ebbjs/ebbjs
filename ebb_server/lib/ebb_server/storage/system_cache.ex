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

  alias EbbServer.Storage.{DirtyTracker, EntityStore, GroupCache, RelationshipCache, RocksDB}

  @default_gsn_counter_name :ebb_gsn_counter

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
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
          populate_system_caches()
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

  defp populate_system_caches do
    rocks_name = EbbServer.Storage.RocksDB

    populate_type("groupMember", rocks_name, fn entity_data ->
      data = entity_data["data"] || %{}
      fields = data["fields"] || %{}

      group_members = :persistent_term.get({GroupCache, :group_members})

      GroupCache.put_group_member(
        %{
          id: entity_data["id"],
          actor_id: get_in(data, ["actor_id"]) || get_in(fields, ["actor_id", "value"]),
          group_id: get_in(data, ["group_id"]) || get_in(fields, ["group_id", "value"]),
          permissions: get_in(data, ["permissions"]) || get_in(fields, ["permissions", "value"])
        },
        group_members
      )
    end)

    populate_type("relationship", rocks_name, fn entity_data ->
      relationships = :persistent_term.get({RelationshipCache, :relationships})
      relationships_by_group = :persistent_term.get({RelationshipCache, :relationships_by_group})

      RelationshipCache.put_relationship(
        %{
          id: entity_data["id"],
          source_id: get_in(entity_data, ["data", "source_id"]),
          target_id: get_in(entity_data, ["data", "target_id"]),
          type: get_in(entity_data, ["data", "type"]),
          field: get_in(entity_data, ["data", "field"])
        },
        relationships: relationships,
        relationships_by_group: relationships_by_group
      )
    end)
  end

  defp populate_type(type, rocks_name, insert_fn) do
    prefix = type <> <<0>>
    cf = RocksDB.cf_type_entities(rocks_name)

    RocksDB.prefix_iterator(cf, prefix, name: rocks_name)
    |> Stream.each(fn {key, _value} ->
      <<_type_bytes::binary-size(byte_size(type)), 0, entity_id::binary>> = key

      case EntityStore.materialize(entity_id, rocks_name: rocks_name) do
        {:ok, entity} -> insert_fn.(entity)
        error -> Logger.warning("Failed to materialize entity #{entity_id}: #{inspect(error)}")
      end
    end)
    |> Stream.run()
  end
end
