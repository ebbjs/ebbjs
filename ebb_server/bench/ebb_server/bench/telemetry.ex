defmodule EbbServer.Bench.Telemetry do
  @moduledoc """
  Collects server-side `ebb.*` latency telemetry for one benchmark run.

  The server emits its own latency events — `ebb.writer.batch_latency_ms`,
  `ebb.http.request_latency_ms`, and `ebb.fanout.push_latency_ms`. Attaching
  a handler in the bench process lets a run report latency measured *inside*
  the server instead of inferring it from the client's wall clock.

  Handlers run in whichever process emits the event — the Writer, a request
  process, a GroupServer — so samples land in a public ETS table an emitter
  can write without blocking on the collector. Each sample is stamped with
  its offset from the measured window's start; warmup samples carry a
  negative offset and are discarded during analysis, exactly like the
  client-side samples.

  Handlers are attached for the whole run and detached on stop. `detach/1`
  is safe after `stop/1`, so the runner can guarantee cleanup in an `after`
  even when a worker crashes.
  """

  @handler_id {__MODULE__, :bench}
  @table :ebb_bench_telemetry
  # A batch-1 run emits one sample per event per Action, so the cap bounds
  # memory; past it the retained samples still describe the run.
  @cap 2_000_000

  @events [
    [:ebb, :writer, :batch_latency_ms],
    [:ebb, :http, :request_latency_ms],
    [:ebb, :fanout, :push_latency_ms]
  ]

  @type t :: %{table: :ets.tid(), handler_id: term()}

  @doc """
  Attaches the handlers and returns a collector.

  `measure_start_us` is the monotonic-microsecond instant the measured
  window begins; samples are stamped as an offset from it.
  """
  @spec start(integer()) :: t()
  def start(measure_start_us) do
    :telemetry.detach(@handler_id)
    table = :ets.new(@table, [:duplicate_bag, :public, write_concurrency: true])
    config = %{table: table, measure_start: measure_start_us}
    :ok = :telemetry.attach_many(@handler_id, @events, &__MODULE__.handle_event/4, config)
    %{table: table, handler_id: @handler_id}
  end

  @doc """
  Detaches the handlers, returns the samples, and drops the table.

  Samples are grouped by tag and returned oldest first as
  `%{tag => [{offset_us, duration_us}]}`.
  """
  @spec stop(t()) :: map()
  def stop(%{table: table, handler_id: handler_id}) do
    :telemetry.detach(handler_id)
    samples = table |> :ets.tab2list() |> partition()
    :ets.delete(table)
    samples
  end

  @doc """
  Detaches the handlers and drops the table. Idempotent cleanup.
  """
  @spec detach(t()) :: :ok
  def detach(%{table: table, handler_id: handler_id}) do
    :telemetry.detach(handler_id)
    if :ets.info(table) != :undefined, do: :ets.delete(table)
    :ok
  end

  @doc false
  def handle_event([:ebb, :writer, :batch_latency_ms], measurements, _metadata, config) do
    record(config, :writer_batch, duration_us(measurements))
  end

  def handle_event([:ebb, :http, :request_latency_ms], measurements, _metadata, config) do
    record(config, :http_request, duration_us(measurements))
  end

  def handle_event([:ebb, :fanout, :push_latency_ms], measurements, _metadata, config) do
    record(config, :fanout_push, duration_us(measurements))
  end

  defp duration_us(measurements) do
    System.convert_time_unit(measurements.duration, :native, :microsecond)
  end

  defp record(%{table: table, measure_start: start}, tag, value) do
    if :ets.info(table, :size) < @cap do
      insert(table, tag, System.monotonic_time(:microsecond) - start, value)
    end

    :ok
  end

  # The table is owned by the bench process; a handler can still fire just
  # after it is dropped, and a stale tid raises rather than returning
  # `:undefined`, so the insert is the only operation that needs guarding.
  defp insert(table, tag, offset, value) do
    :ets.insert(table, {tag, offset, value})
  rescue
    ArgumentError -> :ok
  end

  defp partition(rows) do
    rows
    |> Enum.reduce(%{}, fn {tag, offset, value}, acc ->
      Map.update(acc, tag, [{offset, value}], &[{offset, value} | &1])
    end)
    |> Map.new(fn {tag, samples} -> {tag, Enum.reverse(samples)} end)
  end
end
