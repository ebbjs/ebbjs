defmodule EbbServer.TelemetryTest do
  use ExUnit.Case, async: true

  import EbbServer.TestHelpers

  alias EbbServer.Telemetry

  describe "execute/3" do
    test "prefixes the [:ebb] root and forwards measurements and metadata" do
      ref = attach_telemetry([[:ebb, :writer, :batch_size]])

      assert :ok =
               Telemetry.execute(
                 [:writer, :batch_size],
                 %{count: 3},
                 %{gsn_start: 1, gsn_end: 3}
               )

      assert [event] = telemetry_events(ref)

      assert event ==
               {[:ebb, :writer, :batch_size], %{count: 3}, %{gsn_start: 1, gsn_end: 3}}
    end

    test "is a no-op when no handler is attached" do
      assert :ok = Telemetry.execute([:writer, :batch_size], %{count: 1}, %{})
    end

    test "only emits the requested event name" do
      ref = attach_telemetry([[:ebb, :writer, :batch_size]])

      assert :ok = Telemetry.execute([:watermark, :lag], %{lag: 7}, %{})

      assert telemetry_events(ref) == []
    end

    test "rejects an event that already carries the :ebb root" do
      ref = attach_telemetry([[:ebb, :writer, :batch_size]])

      assert_raise FunctionClauseError, fn ->
        Telemetry.execute([:ebb, :writer, :batch_size], %{count: 1}, %{})
      end

      assert telemetry_events(ref) == []
    end
  end

  describe "span/3" do
    test "emits a start/stop pair, measures duration, and returns the result" do
      ref =
        attach_telemetry([
          [:ebb, :entity_store, :materialize, :start],
          [:ebb, :entity_store, :materialize, :stop]
        ])

      result =
        Telemetry.span([:entity_store, :materialize], %{subject_id: "todo_1"}, fn ->
          {:materialized, %{subject_type: "todo"}}
        end)

      assert result == :materialized

      assert [
               {[:ebb, :entity_store, :materialize, :start], start_measurements, start_metadata},
               {[:ebb, :entity_store, :materialize, :stop], stop_measurements, stop_metadata}
             ] = telemetry_events(ref)

      assert is_integer(start_measurements.monotonic_time)
      assert is_integer(start_measurements.system_time)
      assert start_metadata.subject_id == "todo_1"

      assert is_integer(stop_measurements.duration)
      assert is_integer(stop_measurements.monotonic_time)
      assert stop_metadata.subject_type == "todo"
    end

    test "carries extra measurements returned by the span function" do
      ref =
        attach_telemetry([
          [:ebb, :writer, :flush, :start],
          [:ebb, :writer, :flush, :stop]
        ])

      result =
        Telemetry.span([:writer, :flush], %{}, fn ->
          {:ok, %{batch_size: 5}, %{gsn_start: 10, gsn_end: 14}}
        end)

      assert result == :ok

      assert [_, {[:ebb, :writer, :flush, :stop], measurements, metadata}] =
               telemetry_events(ref)

      assert measurements.batch_size == 5
      assert is_integer(measurements.duration)
      assert metadata.gsn_start == 10
      assert metadata.gsn_end == 14
    end

    test "emits an exception event and re-raises when the span function fails" do
      ref =
        attach_telemetry([
          [:ebb, :writer, :flush, :start],
          [:ebb, :writer, :flush, :stop],
          [:ebb, :writer, :flush, :exception]
        ])

      assert_raise RuntimeError, "commit blew up", fn ->
        Telemetry.span([:writer, :flush], %{gsn_start: 1}, fn ->
          raise "commit blew up"
        end)
      end

      events = telemetry_events(ref)

      assert [
               {[:ebb, :writer, :flush, :start], _, _},
               {[:ebb, :writer, :flush, :exception], measurements, metadata}
             ] = events

      assert is_integer(measurements.duration)
      assert metadata.gsn_start == 1
      assert metadata.kind == :error
      assert %RuntimeError{message: "commit blew up"} = metadata.reason
    end
  end

  describe "test helpers" do
    test "tag forwarded events with the attachment reference" do
      ref_one = attach_telemetry([[:ebb, :watermark, :lag]])
      ref_two = attach_telemetry([[:ebb, :watermark, :lag]])

      assert :ok = Telemetry.execute([:watermark, :lag], %{lag: 4}, %{})

      assert [{[:ebb, :watermark, :lag], %{lag: 4}, %{}}] = telemetry_events(ref_one)
      assert [{[:ebb, :watermark, :lag], %{lag: 4}, %{}}] = telemetry_events(ref_two)
    end
  end
end
