defmodule EbbServer.Storage.GroupAppsCache do
  @moduledoc """
  GenServer that owns the group app-scope ETS table.

  Holds each group's `apps` value alongside its projection, so the
  handshake can answer from ETS instead of lazily materializing every
  group row. `apps` is one key of the group's atomic `ebb/group` value: the
  app ids the group is in scope for. The projection is what readers see: a
  set of app ids.

  Scope is a sync/residency filter, not authorization. A group with no
  cached entry, or no `apps` key, is `:unscoped`; an empty list projects to
  an empty set, which is distinct from unscoped.

  The GenServer exists solely to own the ETS table lifetime and manage
  startup/shutdown. All public functions are lock-free reads and writes.
  """

  use GenServer

  require Logger

  alias EbbServer.Storage.CacheTables

  @default_group_apps :ebb_group_apps

  @type apps :: :unscoped | MapSet.t(String.t())
  @type field :: [String.t()] | nil
  @type entry :: %{field: field(), apps: apps()}

  @type t :: %__MODULE__{group_apps: atom()}
  defstruct [:group_apps]

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  @doc """
  Stores a group's `apps` value and its projection.

  `apps_field` is the app-id list from the group's atomic value, or `nil`
  for an unscoped group.

  ## Examples

      iex> GroupAppsCache.put_group_apps("g_1", ["notes"])
      :ok

      iex> GroupAppsCache.put_group_apps("g_2", nil)
      :ok
  """
  @spec put_group_apps(String.t(), field(), keyword()) :: :ok
  def put_group_apps(group_id, apps_field, opts \\ []) do
    table = Keyword.get(opts, :group_apps) || CacheTables.group_apps()
    :ets.insert(table, {group_id, %{field: apps_field, apps: project(apps_field)}})
    :ok
  end

  @doc """
  Returns the projected app ids for a group.

  No entry or a `nil` value is `:unscoped`; an empty list is an empty set.

  ## Examples

      iex> GroupAppsCache.get_apps("g_unscoped")
      :unscoped

      iex> GroupAppsCache.get_apps("g_notes")
      MapSet.new(["notes"])
  """
  @spec get_apps(String.t(), atom()) :: apps()
  def get_apps(group_id, table \\ nil) do
    case lookup(group_id, table) do
      nil -> :unscoped
      %{apps: apps} -> apps
    end
  end

  @doc """
  Whether a group's app scope has been cached at all.

  A group row is cached even when it declares no `apps` field (unscoped), so
  presence is how the by-id caches answer "is this id a group row?".
  """
  @spec known?(String.t(), atom() | nil) :: boolean()
  def known?(group_id, table \\ nil) do
    table = table || CacheTables.group_apps()

    # A caller whose options carry a cache table this process tree never
    # started (unit tests, an ablated boot) gets "not known" rather than an
    # `ArgumentError` out of a read path.
    :ets.info(table, :name) != :undefined and :ets.member(table, group_id)
  end

  @doc """
  Returns the stored `apps` list, or `nil` when none is cached.

  The planner and the boot replay write this from the group's atomic value;
  it is the value readers compare against, not a merge base.
  """
  @spec get_field(String.t(), atom()) :: field()
  def get_field(group_id, table \\ nil) do
    case lookup(group_id, table) do
      nil -> nil
      %{field: field} -> field
    end
  end

  @doc """
  Deletes a group's app scope.

  ## Examples

      iex> GroupAppsCache.delete_group_apps("g_1")
      :ok
  """
  @spec delete_group_apps(String.t(), keyword()) :: :ok
  def delete_group_apps(group_id, opts \\ []) do
    table = Keyword.get(opts, :group_apps) || CacheTables.group_apps()
    :ets.delete(table, group_id)
    :ok
  end

  @doc """
  Clears every group's app scope.

  ## Examples

      iex> GroupAppsCache.reset()
      :ok
  """
  @spec reset(keyword()) :: :ok
  def reset(opts \\ []) do
    table = Keyword.get(opts, :group_apps) || CacheTables.group_apps()

    case :ets.info(table, :name) do
      :undefined ->
        :ets.new(table, [:set, :public, :named_table])

      _ ->
        try do
          :ets.delete_all_objects(table)
        rescue
          ArgumentError -> :ets.new(table, [:set, :public, :named_table])
        end
    end

    :ok
  end

  defp lookup(group_id, nil), do: lookup(group_id, CacheTables.group_apps())

  defp lookup(group_id, table) do
    case :ets.lookup(table, group_id) do
      [{_, entry}] -> entry
      [] -> nil
    end
  end

  # An absent value is unscoped: the group is in scope for every app. An
  # empty list is a present statement of "no app".
  defp project(nil), do: :unscoped

  defp project(apps) when is_list(apps) do
    apps
    |> Enum.filter(&is_binary/1)
    |> MapSet.new()
  end

  defp project(_field) do
    # A malformed value must not deny delivery: app scope is not a boundary,
    # so an unexpected shape reads as unscoped like an absent one. The write
    # is still visible here rather than silently changing the projection.
    Logger.warning("group apps value is not a list; treating the group as unscoped")
    :unscoped
  end

  @impl true
  def init(opts) do
    table = Keyword.get(opts, :group_apps, @default_group_apps)
    :persistent_term.put({__MODULE__, :group_apps}, table)
    :ets.new(table, [:set, :public, :named_table])

    {:ok, %__MODULE__{group_apps: table}}
  end

  @impl true
  def terminate(_reason, state) do
    try do
      :ets.delete(state.group_apps)
    rescue
      ArgumentError -> :ok
    end

    :ok
  end
end
