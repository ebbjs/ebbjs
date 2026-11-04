defmodule EbbServer.Functions.Stats do
  @moduledoc """
  Per-version invocation counters and pool gauges behind `ebb functions health`.

  The counters live in one public ETS table owned by this process, so a
  request or an invocation increments them without a message to a single
  bottleneck, and a reader takes a snapshot without blocking a worker. The
  table is created by this process and dies with it; the supervisor restarts
  it, and counters restart at zero, which is the honest answer for a node that
  just restarted.

  `:telemetry` handlers attach to the functions events here, so emitted spans
  and gauges have exactly one consumer that writes counters. The invocation
  event is `[:ebb, :functions, :invoke]` with `start`/`stop`/`exception`;
  fetch audits arrive as `[:ebb, :functions, :fetch]`; pool state changes as
  `[:ebb, :functions, :pool, :state]`.

  Counters are per `{name, version}` and cover what the issue's acceptance
  asks an operator to see: invocations, errors, timeouts, and worker kills.
  Fetch counts are per version as well. Pool gauges are absolute values, not
  counters: idle, busy, queued, workers, spawn failures, kills.
  """

  use GenServer

  require Logger

  @table :ebb_functions_stats
  @events [
    [:ebb, :functions, :invoke, :stop],
    [:ebb, :functions, :invoke, :exception],
    [:ebb, :functions, :fetch],
    [:ebb, :functions, :pool, :state]
  ]
  @pool_metrics [:idle, :busy, :queued, :workers, :spawn_failures, :kills, :respawning]

  @doc "The ETS table holding the counters."
  @spec table() :: atom()
  def table, do: @table

  @doc false
  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(_opts) do
    table =
      :ets.new(@table, [
        :named_table,
        :public,
        :set,
        read_concurrency: true,
        write_concurrency: true
      ])

    :ets.insert(table, Enum.map(@pool_metrics, fn metric -> {{:pool, metric}, 0} end))

    # A restart after a crash finds the handler still attached to the old
    # process; the counters are looked up by table name, so one attachment is
    # enough and a second must not fail the boot.
    _ =
      :telemetry.attach_many("ebb-functions-stats", @events, &__MODULE__.handle_event/4, nil)

    {:ok, %{}}
  end

  @impl true
  def terminate(_reason, _state) do
    :telemetry.detach("ebb-functions-stats")
    :ok
  end

  @doc false
  def handle_event([:ebb, :functions, :invoke, :stop], measurements, metadata, _config) do
    record_invocation(metadata, measurements)
  end

  def handle_event([:ebb, :functions, :invoke, :exception], measurements, metadata, _config) do
    record_invocation(%{metadata | outcome: :error}, measurements)
  end

  def handle_event([:ebb, :functions, :fetch], _measurements, metadata, _config) do
    increment_function(metadata, :fetch_calls)
  end

  def handle_event([:ebb, :functions, :pool, :state], measurements, _metadata, _config) do
    set_pool(measurements)
  end

  @doc "Increments one counter for a function version."
  @spec increment_function(map(), atom(), integer()) :: :ok
  def increment_function(metadata, metric, amount \\ 1) do
    with name when is_binary(name) <- Map.get(metadata, :name),
         version when is_binary(version) <- Map.get(metadata, :version) do
      increment({:function, name, version, metric}, amount)
    end

    :ok
  end

  @doc "Sets the pool gauges from a map of `metric => value`."
  @spec set_pool(map()) :: :ok
  def set_pool(measurements) when is_map(measurements) do
    Enum.each(measurements, fn {metric, value} ->
      if metric in @pool_metrics do
        :ets.insert(@table, {{:pool, metric}, value})
      end
    end)

    :ok
  end

  @doc "Increments one pool gauge."
  @spec bump_pool(atom(), integer()) :: :ok
  def bump_pool(metric, amount \\ 1) when metric in @pool_metrics do
    increment({:pool, metric}, amount)
  end

  @doc """
  The counters as plain data for the health route.

  `functions` is a list of `%{"name", "version", metric => count}` maps, sorted
  by name then version; `pool` maps the gauge names to their last value.
  """
  @spec snapshot() :: %{String.t() => term()}
  def snapshot do
    {:ok, functions} =
      try do
        {:ok, :ets.tab2list(@table)}
      catch
        :error, :badarg -> {:ok, []}
      end

    %{
      "functions" => function_rows(functions),
      "pool" => pool_row(functions)
    }
  end

  defp function_rows(entries) do
    entries
    |> Enum.reduce(%{}, fn
      {{:function, name, version, metric}, count}, acc ->
        Map.update(acc, {name, version}, %{metric => count}, &Map.put(&1, metric, count))

      _other, acc ->
        acc
    end)
    |> Enum.map(fn {{name, version}, metrics} ->
      metrics
      |> Map.new(fn {metric, count} -> {Atom.to_string(metric), count} end)
      |> Map.merge(%{"name" => name, "version" => version})
    end)
    |> Enum.sort_by(&{&1["name"], &1["version"]})
  end

  defp pool_row(entries) do
    entries
    |> Enum.reduce(%{}, fn
      {{:pool, metric}, value}, acc -> Map.put(acc, Atom.to_string(metric), value)
      _other, acc -> acc
    end)
  end

  defp record_invocation(metadata, _measurements) do
    increment_function(metadata, :invocations)

    case Map.get(metadata, :outcome) do
      :ok ->
        :ok

      :timeout ->
        increment_function(metadata, :errors)
        increment_function(metadata, :timeouts)
        increment_function(metadata, :worker_kills)

      _other ->
        increment_function(metadata, :errors)
        increment_function(metadata, :worker_kills)
    end

    :ok
  end

  defp increment(key, amount) do
    :ets.update_counter(@table, key, {2, amount}, {key, 0})
    :ok
  catch
    :error, :badarg -> :ok
  end
end
