defmodule EbbServer.Bench.TelemetryTest do
  @moduledoc """
  Pins what the bench collector keeps from the Writer's phase event and its
  two pipeline gauges: one row per phase per range plus the range's
  accounting total, and the raw gauge levels, all in the same
  `{tag, offset_us, value}` shape the analysis reads.
  """

  use ExUnit.Case, async: true

  alias EbbServer.Bench.Telemetry
  alias EbbServer.Telemetry, as: WriterTelemetry

  setup do
    table = :ets.new(:ebb_bench_telemetry_test, [:duplicate_bag, :public])

    on_exit(fn -> if :ets.info(table) != :undefined, do: :ets.delete(table) end)

    %{config: %{table: table, measure_start: 0}}
  end

  test "records one row per phase plus the accounting total for a range", %{config: config} do
    measurements = %{
      queue: native(1),
      prepare: native(2),
      resolve: native(3),
      commit_wait: native(4),
      apply: native(5),
      notify: native(6)
    }

    Telemetry.handle_event(
      [:ebb, :writer, :flush_phase_ms],
      measurements,
      %{gsn_start: 1, gsn_end: 1, outcome: :ok},
      config
    )

    assert rows(config) == [
             {:writer_flush_total, 21},
             {{:writer_flush_phase, :apply}, 5},
             {{:writer_flush_phase, :commit_wait}, 4},
             {{:writer_flush_phase, :notify}, 6},
             {{:writer_flush_phase, :prepare}, 2},
             {{:writer_flush_phase, :queue}, 1},
             {{:writer_flush_phase, :resolve}, 3}
           ]
  end

  test "every phase in the contract gets a row even when it did not run", %{config: config} do
    measurements =
      Map.new(WriterTelemetry.writer_flush_phases(), fn phase -> {phase, native(0)} end)

    Telemetry.handle_event([:ebb, :writer, :flush_phase_ms], measurements, %{}, config)

    tags = Enum.map(rows(config), &elem(&1, 0))

    assert Enum.sort(tags) ==
             Enum.sort([
               :writer_flush_total
               | Enum.map(WriterTelemetry.writer_flush_phases(), &{:writer_flush_phase, &1})
             ])
  end

  test "records the pipeline gauges at their raw level", %{config: config} do
    Telemetry.handle_event([:ebb, :writer, :in_flight_batches], %{count: 3}, %{}, config)
    Telemetry.handle_event([:ebb, :writer, :oldest_unreleased_gsn], %{gsn: 42}, %{}, config)

    Telemetry.handle_event(
      [:ebb, :writer, :batch_size],
      %{count: 200},
      %{gsn_start: 1, gsn_end: 200, callers: 2},
      config
    )

    assert rows(config) == [
             {:writer_in_flight, 3},
             {:writer_oldest_unreleased_gsn, 42},
             {:writer_queue_depth, 2}
           ]
  end

  # The event carries native durations; the collector must convert them, so
  # the fixture builds native values from the microseconds it asserts on.
  defp native(microseconds), do: System.convert_time_unit(microseconds, :microsecond, :native)

  defp rows(%{table: table}) do
    table
    |> :ets.tab2list()
    |> Enum.map(fn {tag, _offset, value} -> {tag, value} end)
    |> Enum.sort()
  end
end
