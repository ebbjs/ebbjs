defmodule EbbServer.Storage.GroupAppsCache do
  @moduledoc """
  GenServer that owns the group app-scope ETS table.

  Holds each group's raw `apps` wire field alongside its projection, so
  the handshake can answer from ETS instead of lazily materializing every
  group row. The raw field is kept because a patch merges its incoming
  `apps` map over the stored one with `FieldMerge.merge/2`; the projection
  is what readers see: a set of app ids whose leaf value is exactly `true`.

  Scope is a sync/residency filter, not authorization. A group with no
  cached entry, or a `nil` field, is `:unscoped`; a present-but-empty map
  projects to an empty set, which is distinct from unscoped.

  The GenServer exists solely to own the ETS table lifetime and manage
  startup/shutdown. All public functions are lock-free reads and writes.
  """

  use GenServer

  alias EbbServer.Storage.CacheTables

  @default_group_apps :ebb_group_apps

  @type apps :: :unscoped | MapSet.t(String.t())
  @type field :: map() | nil
  @type entry :: %{field: field(), apps: apps()}

  @type t :: %__MODULE__{group_apps: atom()}
  defstruct [:group_apps]

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: Keyword.get(opts, :name, __MODULE__))
  end

  @doc """
  Stores a group's raw `apps` field and its projection.

  `apps_field` is the wire field value (`%{"map" => %{app_id => leaf}}`)
  or `nil` for an unscoped group. The raw value is retained for later
  patch merges.

  ## Examples

      iex> GroupAppsCache.put_group_apps("g_1", %{"map" => %{"notes" => %{"value" => true}}})
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

  No entry or a `nil` field is `:unscoped`; a present map with no truthy
  entry is an empty set.

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
  Returns the raw stored `apps` field, or `nil` when none is cached.

  The planner reads this as the pre-plan value a patch merges over.
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

  # Scope is in iff the leaf's value is exactly `true`; `false`, `nil` and
  # tombstoned leaves stay out of the projection without deleting the key.
  defp project(nil), do: :unscoped

  defp project(%{"map" => entries}) when is_map(entries) do
    entries
    |> Enum.filter(fn {_app_id, leaf} -> match?(%{"value" => true}, leaf) end)
    |> Enum.map(fn {app_id, _leaf} -> app_id end)
    |> MapSet.new()
  end

  defp project(_field), do: :unscoped

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
