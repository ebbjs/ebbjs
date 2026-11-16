defmodule EbbServer.Storage.EntityModelCache do
  @moduledoc """
  GenServer that owns the entity id → committed model ETS table.

  The authorizer needs an existing entity's committed model to gate
  membership mutations by `<model>.create` / `<model>.update` (#264). The
  model is the row's committed model, carried by no component of a sibling
  write, and a same-Action create only covers the row it creates, so the
  resolved model lives here: populated from the component index's model
  entries, which the boot replay reconstructs from `cf_actions`, and maintained
  by the Writer for every committed row.

  Entries are monotonic: there is no delete, so a tombstoned entity
  keeps its entry. The table is therefore an **existence** signal (a
  deleted id still reads as existing, fail-closed) and the recorded
  model may be stale — callers must not read it as "current".
  """

  use GenServer

  @default_entity_models :ebb_entity_models

  @type t :: %__MODULE__{entity_models: atom()}
  defstruct [:entity_models]

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  @doc """
  Accepts nothing when either side is missing so the Writer can call it
  unconditionally. A later write for the same id replaces the entry.
  """
  @spec put_model(String.t() | nil, String.t() | nil, keyword()) :: :ok
  def put_model(entity_id, model, opts \\ []) do
    if is_binary(entity_id) and is_binary(model) do
      table = Keyword.get(opts, :entity_models, @default_entity_models)
      :ets.insert(table, {entity_id, model})
    end

    :ok
  end

  @spec get_model(String.t(), atom()) :: String.t() | nil
  def get_model(entity_id, table \\ @default_entity_models) do
    case :ets.lookup(table, entity_id) do
      [{_, model}] -> model
      [] -> nil
    end
  end

  @spec reset(keyword()) :: :ok
  def reset(opts \\ []) do
    table = Keyword.get(opts, :entity_models, @default_entity_models)
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
    table = Keyword.get(opts, :entity_models, @default_entity_models)
    :persistent_term.put({__MODULE__, :entity_models}, table)
    ensure_table(table, :set)

    {:ok, %__MODULE__{entity_models: table}}
  end

  @impl true
  def terminate(_reason, state) do
    try do
      :ets.delete(state.entity_models)
    rescue
      ArgumentError -> :ok
    end

    :ok
  end
end
