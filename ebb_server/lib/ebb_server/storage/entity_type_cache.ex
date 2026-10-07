defmodule EbbServer.Storage.EntityTypeCache do
  @moduledoc """
  GenServer that owns the entity id → `subject_type` ETS table.

  The authorizer needs an existing entity's type to gate membership
  mutations by `<type>.create` / `<type>.update` (#264). The type is not
  on the `entityGroup` wire and a same-Action entity `put` only covers
  creates, so the resolved type lives here: populated from the RocksDB
  `cf_type_entities` index on startup and maintained by the Writer for
  every committed Update.

  A plain `:set` keyed by entity id. The GenServer exists solely to own
  the table lifetime and publish its name; every read is a lock-free
  ETS lookup.
  """

  use GenServer

  @default_entity_types :ebb_entity_types

  @type t :: %__MODULE__{entity_types: atom()}
  defstruct [:entity_types]

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  @doc """
  Records the resolved type for an entity id.

  Accepts nothing when either side is missing so the Writer can call it
  unconditionally. A later write for the same id replaces the entry.
  """
  @spec put_type(String.t() | nil, String.t() | nil, keyword()) :: :ok
  def put_type(entity_id, type, opts \\ []) do
    if is_binary(entity_id) and is_binary(type) do
      table = Keyword.get(opts, :entity_types, @default_entity_types)
      :ets.insert(table, {entity_id, type})
    end

    :ok
  end

  @doc """
  Looks up an entity's resolved type.

  ## Examples

      iex> EntityTypeCache.put_type("todo_1", "todo")
      iex> EntityTypeCache.get_type("todo_1")
      "todo"

      iex> EntityTypeCache.get_type("unknown")
      nil
  """
  @spec get_type(String.t(), atom()) :: String.t() | nil
  def get_type(entity_id, table \\ @default_entity_types) do
    case :ets.lookup(table, entity_id) do
      [{_, type}] -> type
      [] -> nil
    end
  end

  @doc """
  Clears every entry.

  ## Examples

      iex> EntityTypeCache.reset()
      :ok
  """
  @spec reset(keyword()) :: :ok
  def reset(opts \\ []) do
    table = Keyword.get(opts, :entity_types, @default_entity_types)
    reset_table(table, :set)
    :ok
  end

  defp reset_table(table, type) do
    ensure_table(table, type)
    :ets.delete_all_objects(table)
    :ok
  end

  defp ensure_table(table, type) do
    case :ets.info(table, :name) do
      :undefined -> :ets.new(table, [type, :public, :named_table])
      _ -> table
    end
  end

  @impl true
  def init(opts) do
    table = Keyword.get(opts, :entity_types, @default_entity_types)
    :persistent_term.put({__MODULE__, :entity_types}, table)
    ensure_table(table, :set)

    {:ok, %__MODULE__{entity_types: table}}
  end

  @impl true
  def terminate(_reason, state) do
    try do
      :ets.delete(state.entity_types)
    rescue
      ArgumentError -> :ok
    end

    :ok
  end
end
