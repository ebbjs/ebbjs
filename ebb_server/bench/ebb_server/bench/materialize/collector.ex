defmodule EbbServer.Bench.Materialize.Collector do
  @moduledoc """
  Collects wall-clock and `ebb.entity_store.*` telemetry samples for one
  benchmark run.

  The bench calls `EntityStore.get/2` and `EntityStore.query/4` in the
  collector's own process, and `:telemetry` handlers run in the emitting
  process, so the scenario and a per-sample id are stashed in the process
  dictionary and read back by the handler. The id lets the runner sum one
  materialize's phases and compare that sum to the same sample's total,
  which is how the phase breakdown stays honest when the per-phase medians
  are not co-monotonic.

  Samples land in a public ETS table, which keeps the emitter off any
  collector mailbox. Rows are `{kind, scenario, sample_id, ...}` tuples and
  are interpreted by the runner.
  """

  @handler_id {__MODULE__, :materialize_bench}
  @table :ebb_bench_materialize
  @tag :ebb_bench_materialize_scenario

  @events [
    [:ebb, :entity_store, :materialize_phase_ms],
    [:ebb, :entity_store, :materialize_latency_ms],
    [:ebb, :entity_store, :read_latency_ms]
  ]

  @type t :: %{table: :ets.tid()}

  @doc """
  Creates the sample table and attaches the telemetry handlers.
  """
  @spec start() :: t()
  def start do
    :telemetry.detach(@handler_id)
    table = :ets.new(@table, [:duplicate_bag, :public, write_concurrency: true])
    :ok = :telemetry.attach_many(@handler_id, @events, &__MODULE__.handle_event/4, table)
    %{table: table}
  end

  @doc """
  Times `fun`, records the sample under `scenario`, and returns its result.
  """
  @spec measure(t(), map(), (-> result)) :: result when result: var
  def measure(%{table: table}, scenario, fun) when is_function(fun, 0) do
    sample_id = :erlang.unique_integer([:positive])
    Process.put(@tag, {scenario, sample_id})
    started_at = System.monotonic_time(:microsecond)

    try do
      fun.()
    after
      duration = System.monotonic_time(:microsecond) - started_at
      :ets.insert(table, {:total, scenario, sample_id, duration})
      Process.delete(@tag)
    end
  end

  @doc """
  Detaches the handlers, returns the raw rows, and drops the table.
  """
  @spec stop(t()) :: [tuple()]
  def stop(%{table: table}) do
    :telemetry.detach(@handler_id)
    rows = :ets.tab2list(table)
    :ets.delete(table)
    rows
  end

  @doc """
  Detaches the handlers and drops the table. Idempotent cleanup.
  """
  @spec detach(t()) :: :ok
  def detach(%{table: table}) do
    :telemetry.detach(@handler_id)
    if :ets.info(table) != :undefined, do: :ets.delete(table)
    :ok
  end

  @doc false
  def handle_event([:ebb, :entity_store, :materialize_phase_ms], measurements, metadata, table) do
    with {scenario, sample_id} <- Process.get(@tag) do
      insert(table, {:phase, scenario, sample_id, metadata.phase, duration_us(measurements)})
    end

    :ok
  end

  def handle_event([:ebb, :entity_store, :materialize_latency_ms], measurements, _metadata, table) do
    with {scenario, sample_id} <- Process.get(@tag) do
      insert(table, {:bytes, scenario, sample_id, measurements.byte_size, nil})
      insert(table, {:materialize, scenario, sample_id, duration_us(measurements)})
    end

    :ok
  end

  def handle_event([:ebb, :entity_store, :read_latency_ms], measurements, _metadata, table) do
    with {scenario, sample_id} <- Process.get(@tag) do
      insert(table, {:bytes, scenario, sample_id, measurements.byte_size, measurements.row_count})
      insert(table, {:read, scenario, sample_id, duration_us(measurements)})
    end

    :ok
  end

  defp insert(table, row) do
    :ets.insert(table, row)
  rescue
    ArgumentError -> :ok
  end

  # The server emits native time units; the report works in microseconds to
  # match the write-path harness.
  defp duration_us(%{duration: duration}) do
    System.convert_time_unit(duration, :native, :microsecond)
  end
end
