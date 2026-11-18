defmodule EbbServer.Storage.MembershipCache do
  @moduledoc """
  GenServer that owns the entity↔Group membership ETS tables.

  It takes keyword-list options and offers `reset/1` rather than
  `GrantCache`'s single-table signatures. The split from `GrantCache` is
  deliberate: a grant carries permissions and is the authorization
  primitive; a membership carries sync scope only.

  The GenServer exists solely to own the ETS table lifetime and
  manage startup/shutdown. All public functions are lock-free.
  """

  use GenServer

  @default_memberships :ebb_memberships
  @default_memberships_by_id :ebb_memberships_by_id
  @default_memberships_by_group :ebb_memberships_by_group

  @type t :: %__MODULE__{
          memberships: atom(),
          memberships_by_id: atom(),
          memberships_by_group: atom()
        }
  defstruct [:memberships, :memberships_by_id, :memberships_by_group]

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  @spec put_membership(map(), keyword()) :: :ok | {:error, :nil_values_not_allowed}
  def put_membership(membership, opts \\ []) do
    table = Keyword.get(opts, :memberships, @default_memberships)
    by_id_table = Keyword.get(opts, :memberships_by_id, @default_memberships_by_id)

    by_group_table =
      Keyword.get(opts, :memberships_by_group, @default_memberships_by_group)

    entity_id = membership[:entity_id] || membership["entity_id"]
    group_id = membership[:group_id] || membership["group_id"]
    entry_id = membership[:id] || membership["id"]

    if is_nil(entity_id) or is_nil(group_id) or is_nil(entry_id) do
      {:error, :nil_values_not_allowed}
    else
      entry = %{id: entry_id, entity_id: entity_id, group_id: group_id}
      previous = get_membership(entry_id, by_id_table)

      # A delete-first re-put opens a window in which a concurrent reader
      # sees the entity with no membership at all. Insert the replacement
      # before removing the previous objects.
      if previous == entry do
        upsert_entry(entry, table, by_id_table, by_group_table)
      else
        upsert_then_delete_previous(previous, entry, table, by_id_table, by_group_table)
      end
    end
  end

  defp upsert_entry(entry, table, by_id_table, by_group_table) do
    :ets.insert(table, {entry.entity_id, entry})
    :ets.insert(by_id_table, {entry.id, entry})
    :ets.insert(by_group_table, {{entry.group_id, entry.entity_id}})
    :ok
  end

  defp upsert_then_delete_previous(previous, entry, table, by_id_table, by_group_table) do
    :ok = upsert_entry(entry, table, by_id_table, by_group_table)
    if previous != nil, do: delete_objects(table, by_group_table, previous)
    :ok
  end

  defp delete_objects(table, by_group_table, entry) do
    :ets.delete_object(table, {entry.entity_id, entry})
    :ets.delete(by_group_table, {entry.group_id, entry.entity_id})
  end

  @spec delete_membership(String.t(), keyword()) :: :ok
  def delete_membership(entry_id, opts \\ []) do
    table = Keyword.get(opts, :memberships, @default_memberships)
    by_id_table = Keyword.get(opts, :memberships_by_id, @default_memberships_by_id)

    by_group_table =
      Keyword.get(opts, :memberships_by_group, @default_memberships_by_group)

    case :ets.lookup(by_id_table, entry_id) do
      [{_, entry}] ->
        delete_objects(table, by_group_table, entry)
        :ets.delete(by_id_table, entry_id)
        :ok

      [] ->
        :ok
    end
  end

  @spec get_membership(String.t(), atom()) :: map() | nil
  def get_membership(entry_id, table \\ @default_memberships_by_id) do
    case :ets.lookup(table, entry_id) do
      [{_, entry}] -> entry
      [] -> nil
    end
  end

  @spec memberships(String.t(), atom()) :: [String.t()]
  def memberships(entity_id, table \\ @default_memberships) do
    entity_id
    |> membership_entries(table)
    |> memberships_from_entries()
  end

  @spec memberships_from_entries([map()]) :: [String.t()]
  def memberships_from_entries(entries) do
    entries
    |> Enum.map(fn entry -> entry[:group_id] || entry["group_id"] end)
    |> Enum.uniq()
  end

  @spec membership_entries(String.t(), atom()) :: [map()]
  def membership_entries(entity_id, table \\ @default_memberships) do
    table
    |> :ets.lookup(entity_id)
    |> Enum.map(fn {_entity_id, entry} -> entry end)
  end

  @doc """
  No production caller yet; the cache tests use it to pin the by-group
  index's put/delete behavior.

  Reads the `:ordered_set` by the partially-bound composite key, so cost
  scales with the number of members rather than the whole index.
  """
  @spec group_entities(String.t(), atom()) :: [String.t()]
  def group_entities(group_id, table \\ @default_memberships_by_group) do
    :ets.select(table, [{{{group_id, :"$1"}}, [], [:"$1"]}])
  end

  @spec reset(keyword()) :: :ok
  def reset(opts \\ []) do
    table = Keyword.get(opts, :memberships, @default_memberships)
    by_id_table = Keyword.get(opts, :memberships_by_id, @default_memberships_by_id)

    by_group_table =
      Keyword.get(opts, :memberships_by_group, @default_memberships_by_group)

    reset_table(table, :bag)
    reset_table(by_id_table, :set)
    reset_table(by_group_table, :ordered_set)
    :ok
  end

  defp reset_table(table, type) do
    case :ets.info(table, :name) do
      :undefined ->
        :ets.new(table, [type, :public, :named_table])

      _ ->
        try do
          :ets.delete_all_objects(table)
        rescue
          ArgumentError -> :ets.new(table, [type, :public, :named_table])
        end
    end
  end

  @impl true
  def init(opts) do
    table = Keyword.get(opts, :memberships, @default_memberships)
    by_id_table = Keyword.get(opts, :memberships_by_id, @default_memberships_by_id)

    by_group_table =
      Keyword.get(opts, :memberships_by_group, @default_memberships_by_group)

    :persistent_term.put({__MODULE__, :memberships}, table)
    :persistent_term.put({__MODULE__, :memberships_by_id}, by_id_table)
    :persistent_term.put({__MODULE__, :memberships_by_group}, by_group_table)
    :ets.new(table, [:bag, :public, :named_table])
    :ets.new(by_id_table, [:set, :public, :named_table])
    :ets.new(by_group_table, [:ordered_set, :public, :named_table])

    {:ok,
     %__MODULE__{
       memberships: table,
       memberships_by_id: by_id_table,
       memberships_by_group: by_group_table
     }}
  end

  @impl true
  def terminate(_reason, state) do
    for table <- [state.memberships, state.memberships_by_id, state.memberships_by_group] do
      try do
        :ets.delete(table)
      rescue
        ArgumentError -> :ok
      end
    end

    :ok
  end
end
