defmodule EbbServer.Storage.GroupCache do
  @moduledoc """
  GenServer that owns the group membership ETS tables.

  Manages actor-to-group mappings, permissions, a secondary index
  keyed by member id that allows resolving a membership by its entity
  id, and a by-group index that enumerates a group's members (#479,
  the last-capable-member guard). The GenServer exists solely to own
  the ETS table lifetime and manage startup/shutdown.

  All public functions are lock-free (ETS reads/writes) and do not
  route through `GenServer.call`.
  """

  use GenServer

  alias EbbServer.Storage.CacheTables

  @default_group_members :ebb_group_members
  @default_group_members_by_id :ebb_group_members_by_id
  @default_group_members_by_group :ebb_group_members_by_group

  @type t :: %__MODULE__{
          group_members: atom(),
          group_members_by_id: atom(),
          group_members_by_group: atom()
        }
  defstruct [:group_members, :group_members_by_id, :group_members_by_group]

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  @doc """
  Stores a group membership entry.

  `opts` carries the tables of the cache instance the row belongs to:
  `:group_members`, `:group_members_by_id` and `:group_members_by_group`.
  A caller holding a specific cache set must pass all three; any omitted
  table falls back to the one published for the running cache.

  Accepts both atom keys (`:actor_id`) and string keys (`"actor_id"`).

  ## Examples

      iex> GroupCache.put_group_member(%{id: "gm_1", actor_id: "a_1", group_id: "g_1", permissions: ["read"]})
      :ok
  """
  @spec put_group_member(map(), keyword()) :: :ok | {:error, :nil_values_not_allowed}
  def put_group_member(member, opts \\ []) do
    %{
      group_members: table,
      group_members_by_id: by_id_table,
      group_members_by_group: by_group_table
    } =
      resolve_tables(opts)

    actor_id = member[:actor_id] || member["actor_id"]
    group_id = member[:group_id] || member["group_id"]
    entry_id = member[:id] || member["id"]

    if is_nil(actor_id) or is_nil(group_id) or is_nil(entry_id) do
      {:error, :nil_values_not_allowed}
    else
      entry = %{
        id: entry_id,
        group_id: group_id,
        actor_id: actor_id,
        permissions: member[:permissions] || member["permissions"]
      }

      # A re-put may re-key the row to another group or actor, so both the
      # stale by-group entry and the previous actor's primary row have to
      # go before the new row lands. Deleting only under the new actor
      # leaves the old `{actor, row}` behind, granting the old actor cached
      # access to a row that is no longer theirs (#625).
      previous_actor_id = stale_actor_id(entry_id, by_id_table)
      drop_stale_by_group(entry_id, by_id_table, by_group_table)

      [actor_id, previous_actor_id]
      |> Enum.reject(&is_nil/1)
      |> Enum.uniq()
      |> Enum.each(&delete_from_primary(table, entry_id, &1))

      :ets.insert(table, {actor_id, entry})
      :ets.insert(by_id_table, {entry_id, entry})
      :ets.insert(by_group_table, {{group_id, entry_id}})
      :ok
    end
  end

  @doc """
  Deletes a group membership entry by member ID.

  `opts` names the cache instance's tables, as in `put_group_member/2`.

  ## Examples

      iex> GroupCache.delete_group_member("gm_1")
      :ok
  """
  @spec delete_group_member(String.t(), keyword()) :: :ok
  def delete_group_member(member_id, opts \\ []) do
    %{
      group_members: table,
      group_members_by_id: by_id_table,
      group_members_by_group: by_group_table
    } =
      resolve_tables(opts)

    case :ets.lookup(by_id_table, member_id) do
      [{_, %{actor_id: actor_id, group_id: group_id}}] ->
        delete_from_primary(table, member_id, actor_id)
        :ets.delete(by_group_table, {group_id, member_id})
        :ok

      [] ->
        :ok
    end

    :ets.delete(by_id_table, member_id)
    :ok
  end

  defp delete_from_primary(table, member_id, actor_id) do
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

  @doc """
  Looks up a group membership entry by its member id.

  ## Examples

      iex> GroupCache.get_group_member("gm_1")
      %{id: "gm_1", actor_id: "a_1", group_id: "g_1", permissions: ["read"]}

      iex> GroupCache.get_group_member("unknown")
      nil
  """
  @spec get_group_member(String.t(), atom()) :: map() | nil
  def get_group_member(member_id, table \\ CacheTables.group_members_by_id()) do
    case :ets.lookup(table, member_id) do
      [{_, entry}] -> entry
      [] -> nil
    end
  end

  @doc """
  Returns the member ids of every membership row scoping to a group.

  Reads the `:ordered_set` by the partially-bound composite key, so cost
  scales with the group's member count rather than the size of the whole
  index. The authorizer uses it to decide whether a `groupMember`
  mutation would strand the group (#479).

  ## Examples

      iex> GroupCache.group_member_ids("g_1")
      ["gm_1", "gm_2"]

      iex> GroupCache.group_member_ids("unknown")
      []
  """
  @spec group_member_ids(String.t(), atom()) :: [String.t()]
  def group_member_ids(group_id, table \\ CacheTables.group_members_by_group()) do
    :ets.select(table, [{{{group_id, :"$1"}}, [], [:"$1"]}])
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

  `opts` names the cache instance's tables, as in `put_group_member/2`.

  ## Examples

      iex> GroupCache.reset()
      :ok
  """
  @spec reset(keyword()) :: :ok
  def reset(opts \\ []) do
    %{
      group_members: table,
      group_members_by_id: by_id_table,
      group_members_by_group: by_group_table
    } =
      resolve_tables(opts)

    reset_table(table, :bag)
    reset_table(by_id_table, :set)
    reset_table(by_group_table, :ordered_set)
    :ok
  end

  # Resolve a call's table set once: explicit options win, and an omitted table
  # falls back to the instance published for the running cache. Threading all
  # three from the caller is what keeps one cache's write out of another's
  # indexes (#424).
  defp resolve_tables(opts) do
    %{
      group_members: Keyword.get(opts, :group_members) || CacheTables.group_members(),
      group_members_by_id:
        Keyword.get(opts, :group_members_by_id) || CacheTables.group_members_by_id(),
      group_members_by_group:
        Keyword.get(opts, :group_members_by_group) || CacheTables.group_members_by_group()
    }
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

  defp drop_stale_by_group(member_id, by_id_table, by_group_table) do
    case :ets.lookup(by_id_table, member_id) do
      [{_, %{group_id: group_id}}] -> :ets.delete(by_group_table, {group_id, member_id})
      [] -> :ok
    end
  end

  defp stale_actor_id(member_id, by_id_table) do
    case :ets.lookup(by_id_table, member_id) do
      [{_, %{actor_id: actor_id}}] -> actor_id
      [] -> nil
    end
  end

  defp resolve_table(nil), do: nil
  defp resolve_table(table) when table == [], do: nil
  defp resolve_table(table) when is_atom(table), do: table

  defp flat_map_permissions(entries, group_id) do
    Enum.flat_map(entries, fn {_actor_id, entry} ->
      if entry.group_id == group_id, do: entry.permissions, else: []
    end)
  end

  @impl true
  def init(opts) do
    table = Keyword.get(opts, :table, @default_group_members)
    by_id_table = Keyword.get(opts, :group_members_by_id, @default_group_members_by_id)

    by_group_table =
      Keyword.get(opts, :group_members_by_group, @default_group_members_by_group)

    :persistent_term.put({__MODULE__, :group_members}, table)
    :persistent_term.put({__MODULE__, :group_members_by_id}, by_id_table)
    :persistent_term.put({__MODULE__, :group_members_by_group}, by_group_table)
    :ets.new(table, [:bag, :public, :named_table])
    :ets.new(by_id_table, [:set, :public, :named_table])
    :ets.new(by_group_table, [:ordered_set, :public, :named_table])

    {:ok,
     %__MODULE__{
       group_members: table,
       group_members_by_id: by_id_table,
       group_members_by_group: by_group_table
     }}
  end

  @impl true
  def terminate(_reason, state) do
    for table <- [state.group_members, state.group_members_by_id, state.group_members_by_group] do
      try do
        :ets.delete(table)
      rescue
        ArgumentError -> :ok
      end
    end

    :ok
  end
end
