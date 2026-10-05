defmodule EbbServer.Sync.FanOutFrontier do
  @moduledoc """
  Last-pushed GSN frontier for `EbbServer.Sync.FanOutRouter` that is
  persisted across the Router's lifetime: it is owned by a sibling
  process under `Sync.Supervisor`, so it survives a Router restart (but
  not a node restart).

  ## Why this exists

  `FanOutRouter` buffers committed ranges in memory until the resolution
  watermark passes them. A `:one_for_one` restart of the Router alone
  would otherwise start from an empty buffer: ranges that were waiting at
  crash time are never re-pushed, and subscribers miss live events until
  they reconnect and catch up (ebbjs/ebbjs#286).

  The Router's *in-memory* buffer stays in memory — it is cheap to
  re-derive from the durable log. Only the frontier (the highest GSN the
  Router has pushed) needs to outlive the Router, so this tiny GenServer
  owns a public ETS table holding that single integer. On `init/1` the
  Router resumes from it, re-deriving the un-pushed committed ranges from
  `cf_actions`/`cf_group_actions`.

  ## Lock-free reads and writes

  Every public function is a direct ETS operation; no `GenServer.call` is
  made on the Router's push path. The GenServer exists only to own the
  table's lifetime. This mirrors `EbbServer.Storage.WatermarkTracker`.
  """

  use GenServer

  @key :last_pushed_gsn
  @default_table :fan_out_frontier

  @type gsn :: non_neg_integer()

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, opts, name: name)
  end

  @doc """
  Returns the persisted frontier, or `:empty` when nothing has been
  pushed yet (or the frontier table is not available).
  """
  @spec get(GenServer.name()) :: {:ok, gsn()} | :empty
  def get(name \\ __MODULE__) do
    case table(name) do
      nil -> :empty
      table -> lookup(table)
    end
  end

  @doc """
  Persists the highest GSN the Router has pushed.

  Monotonic by construction: a lower value never lowers the stored
  frontier, so a duplicate or overlapping sub-frontier range cannot
  rewind it. A no-op when the frontier table is unavailable (the owning
  GenServer is mid-restart), since there is nothing to write.
  """
  @spec put(gsn(), GenServer.name()) :: :ok
  def put(last_pushed_gsn, name \\ __MODULE__) do
    case table(name) do
      nil -> :ok
      table -> insert_max(table, last_pushed_gsn)
    end
  end

  defp insert_max(table, last_pushed_gsn) do
    current =
      case :ets.lookup(table, @key) do
        [{@key, current}] -> current
        [] -> 0
      end

    :ets.insert(table, {@key, max(last_pushed_gsn, current)})
    :ok
  rescue
    # Mirror `get/1`: a stale `:persistent_term` entry can point at a
    # table the owner has already deleted. There is nothing to write.
    ArgumentError -> :ok
  end

  @doc """
  Clears the frontier. Test support only.
  """
  @spec reset(GenServer.name()) :: :ok
  def reset(name \\ __MODULE__) do
    case table(name) do
      nil -> :ok
      table -> :ets.delete_all_objects(table)
    end

    :ok
  end

  defp table(name), do: :persistent_term.get({name, :table}, nil)

  # The Router starts after this process under the Sync supervisor, but
  # `get/1` is defensive so a stale `:persistent_term` entry or a
  # terminated table reads as a cold start rather than raising.
  defp lookup(table) do
    case :ets.lookup(table, @key) do
      [{@key, gsn}] -> {:ok, gsn}
      [] -> :empty
    end
  rescue
    ArgumentError -> :empty
  end

  @impl true
  def init(opts) do
    name = Keyword.get(opts, :name, __MODULE__)
    table = Keyword.get(opts, :table, @default_table)

    # A previous owner can leave the named table behind only if it is
    # still alive under a different GenServer name; the RestartStrategy
    # for a killed owner is handled by ETS itself.
    if :ets.whereis(table) != :undefined do
      :ets.delete(table)
    end

    :ets.new(table, [:set, :public, :named_table, read_concurrency: true])
    :persistent_term.put({name, :table}, table)

    {:ok, %{name: name, table: table}}
  end

  @impl true
  def terminate(_reason, state) do
    try do
      :ets.delete(state.table)
    rescue
      ArgumentError -> :ok
    end

    :ok
  end
end
