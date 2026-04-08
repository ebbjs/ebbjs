defmodule EbbServer.Storage.GroupCache do
  @moduledoc """
  GenServer that owns the group membership ETS table.

  Manages actor-to-group mappings and permissions. The GenServer exists
  solely to own the ETS table lifetime and manage startup/shutdown.

  All public functions are lock-free (ETS reads/writes) and do not
  route through `GenServer.call`.
  """

  use GenServer

  @default_group_members :ebb_group_members

  @type t :: %__MODULE__{
          group_members: atom()
        }
  defstruct [:group_members]

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  @doc """
  Stores a group membership entry.

  Accepts both atom keys (`:actor_id`) and string keys (`"actor_id"`).

  ## Examples

      iex> GroupCache.put_group_member(%{id: "gm_1", actor_id: "a_1", group_id: "g_1", permissions: ["read"]})
      :ok
  """
  @spec put_group_member(map(), atom()) :: :ok | {:error, :nil_values_not_allowed}
  def put_group_member(member, table \\ @default_group_members) do
    actor_id = member[:actor_id] || member["actor_id"]
    group_id = member[:group_id] || member["group_id"]
    entry_id = member[:id] || member["id"]

    if is_nil(actor_id) or is_nil(group_id) or is_nil(entry_id) do
      {:error, :nil_values_not_allowed}
    else
      entry = %{
        id: entry_id,
        group_id: group_id,
        permissions: member[:permissions] || member["permissions"]
      }

      delete_group_member_by_id(entry.id, actor_id, table)
      :ets.insert(table, {actor_id, entry})
      :ok
    end
  end

  @doc """
  Deletes a group membership entry by member ID.

  ## Examples

      iex> GroupCache.delete_group_member("gm_1")
      :ok
  """
  @spec delete_group_member(String.t(), atom()) :: :ok
  def delete_group_member(member_id, table \\ @default_group_members) do
    table
    |> :ets.tab2list()
    |> Enum.each(fn object ->
      if object |> elem(1) |> Map.get(:id) == member_id do
        :ets.delete_object(table, object)
      end
    end)

    :ok
  end

  @doc """
  Gets all groups for an actor.

  ## Examples

      iex> GroupCache.get_actor_groups("a_1")
      [%{group_id: "g_1", permissions: ["read", "write"]}]
  """
  @spec get_actor_groups(String.t(), atom()) :: [%{group_id: String.t(), permissions: list()}]
  def get_actor_groups(actor_id, table \\ @default_group_members) do
    case resolve_table(table) do
      nil ->
        []

      actual_table ->
        :ets.lookup(actual_table, actor_id)
        |> Enum.map(fn {_actor_id, entry} ->
          %{group_id: entry.group_id, permissions: entry.permissions}
        end)
    end
  end

  @doc """
  Gets permissions for a specific actor/group combination.

  Returns a flat list of permission strings, or `nil` if no membership exists.

  ## Examples

      iex> GroupCache.get_permissions("a_1", "g_1")
      ["read", "write"]

      iex> GroupCache.get_permissions("a_1", "g_nonexistent")
      nil
  """
  @spec get_permissions(String.t(), String.t(), atom()) :: list() | nil
  def get_permissions(actor_id, group_id, table \\ @default_group_members) do
    case resolve_table(table) do
      nil ->
        nil

      actual_table ->
        :ets.lookup(actual_table, actor_id)
        |> flat_map_permissions(group_id)
        |> case do
          [] -> nil
          perms -> Enum.uniq(List.flatten(perms))
        end
    end
  end

  @doc """
  Resets the group cache by clearing all entries.

  ## Examples

      iex> GroupCache.reset()
      :ok
  """
  @spec reset(atom()) :: :ok
  def reset(table \\ @default_group_members) do
    case :ets.info(table, :name) do
      :undefined ->
        :ets.new(table, [:bag, :public, :named_table])

      _ ->
        :ets.delete_all_objects(table)
    end

    :ok
  end

  defp resolve_table(nil), do: nil
  defp resolve_table(table) when table == [], do: nil
  defp resolve_table(table) when is_atom(table), do: table

  defp delete_group_member_by_id(member_id, actor_id, table) do
    table
    |> :ets.tab2list()
    |> Enum.each(fn entry ->
      [stored_actor_id, stored_entry] = Tuple.to_list(entry)
      entry_id = stored_entry[:id] || stored_entry["id"]

      if stored_actor_id == actor_id && entry_id == member_id do
        :ets.delete_object(table, entry)
      end
    end)
  end

  defp flat_map_permissions(entries, group_id) do
    Enum.flat_map(entries, fn {_actor_id, entry} ->
      if entry.group_id == group_id, do: entry.permissions, else: []
    end)
  end

  @impl true
  def init(opts) do
    table = Keyword.get(opts, :table, @default_group_members)
    :persistent_term.put({__MODULE__, :group_members}, table)
    :ets.new(table, [:bag, :public, :named_table])

    {:ok, %__MODULE__{group_members: table}}
  end

  @impl true
  def terminate(_reason, state) do
    try do
      :ets.delete(state.group_members)
    rescue
      ArgumentError -> :ok
    end

    :ok
  end
end
