defmodule EbbServer.Storage.WriterTelemetryTest do
  @moduledoc """
  Telemetry tests for the Writer's coalesced flush (ebbjs/ebbjs#360).

  The success path emits batch size, batch latency, and the accepted-Action
  counter; the abandon path emits `range_resolved` and the failed-commit
  path emits both `commit_failed` and `range_resolved`. An abandon must
  never be reported as a failed commit, and a committed batch must never
  report either. The reorder-buffer gauge brackets every claim and release.
  """

  use ExUnit.Case, async: false

  alias EbbServer.Storage.Writer
  alias EbbServer.Telemetry

  import EbbServer.TestHelpers

  @writer_events [
    [:ebb, :writer, :batch_size],
    [:ebb, :writer, :batch_latency_ms],
    [:ebb, :writer, :commit_latency_ms],
    [:ebb, :writer, :actions_per_sec],
    [:ebb, :writer, :range_resolved],
    [:ebb, :writer, :commit_failed],
    [:ebb, :writer, :in_flight_batches],
    [:ebb, :writer, :oldest_unreleased_gsn],
    [:ebb, :writer, :flush_phase_ms]
  ]

  setup do
    cache = start_isolated_cache()
    %{name: rocks_name} = start_rocks()

    Map.put(cache, :rocks_name, rocks_name)
  end

  describe "successful commit" do
    test "emits batch size, batch latency, and accepted Actions", ctx do
      ref = attach_telemetry(@writer_events)
      %{name: writer_name} = start_writer(writer_opts(ctx, %{}))

      actions = [
        validated_action(%{id: "act_ok_1"}),
        validated_action(%{id: "act_ok_2"})
      ]

      assert {:ok, {1, 2}, []} = Writer.write_actions(actions, writer_name)

      events = telemetry_events(ref)

      assert {_event, %{count: 2}, %{gsn_start: 1, gsn_end: 2, callers: 1}} =
               find_event(events, [:ebb, :writer, :batch_size])

      assert {_event, %{duration: duration}, %{gsn_start: 1, gsn_end: 2}} =
               find_event(events, [:ebb, :writer, :batch_latency_ms])

      assert is_integer(duration)

      assert {_event, %{duration: commit_duration}, %{gsn_start: 1, gsn_end: 2}} =
               find_event(events, [:ebb, :writer, :commit_latency_ms])

      assert is_integer(commit_duration)

      assert {_event, %{count: 2}, %{}} = find_event(events, [:ebb, :writer, :actions_per_sec])

      assert [
               {:in_flight_batches, %{count: 1}},
               {:oldest_unreleased_gsn, %{gsn: 1}},
               {:in_flight_batches, %{count: 0}},
               {:oldest_unreleased_gsn, %{gsn: 0}}
             ] = pipeline_measurements(events)

      refute find_event(events, [:ebb, :writer, :range_resolved])
      refute find_event(events, [:ebb, :writer, :commit_failed])
    end

    test "batch size metadata counts the callers coalesced into one flush", ctx do
      ref = attach_telemetry(@writer_events)
      %{name: writer_name, pid: writer_pid} = start_writer(writer_opts(ctx, %{}))

      :ok = :sys.suspend(writer_name)

      tasks =
        for i <- 1..2 do
          Task.async(fn ->
            Writer.write_actions([validated_action(%{id: "act_caller_#{i}"})], writer_name)
          end)
        end

      assert wait_until(fn -> queue_len(writer_pid) >= 2 end)
      :ok = :sys.resume(writer_name)

      for task <- tasks, do: Task.await(task, 2_000)

      assert [{[:ebb, :writer, :batch_size], %{count: 2}, %{callers: 2}}] =
               Enum.filter(
                 telemetry_events(ref),
                 &match?({[:ebb, :writer, :batch_size], _, _}, &1)
               )
    end

    test "emits the accepted-Action counter when a cache failure escalates", ctx do
      ref = attach_telemetry(@writer_events)

      %{name: writer_name} =
        start_writer(writer_opts(ctx, %{entity_types: :ebb_360_missing_table}))

      assert {:ok, {1, 1}, []} =
               Writer.write_actions([validated_action(%{id: "act_escalate"})], writer_name)

      events = telemetry_events(ref)

      assert {_event, %{count: 1}, %{}} = find_event(events, [:ebb, :writer, :actions_per_sec])
      refute find_event(events, [:ebb, :writer, :range_resolved])
      refute find_event(events, [:ebb, :writer, :commit_failed])
    end
  end

  describe "abandon via a raising commit" do
    test "containing the raise emits commit_failed and range_resolved with the reason", ctx do
      ref = attach_telemetry(@writer_events)
      commit_fn = fn _ops, _opts -> raise "commit boom" end

      %{name: writer_name} = start_writer(writer_opts(ctx, %{commit_fn: commit_fn}))

      assert {:error, {:rocksdb_write_failed, {:committer_raised, %RuntimeError{}}}} =
               Writer.write_actions([validated_action(%{id: "act_raise"})], writer_name)

      events = telemetry_events(ref)

      assert {_event, %{count: 1}, %{gsn_start: 1, gsn_end: 1, reason: reason}} =
               find_event(events, [:ebb, :writer, :range_resolved])

      assert {:committer_raised, %RuntimeError{message: "commit boom"}} = reason

      assert {_event, %{count: 1}, %{gsn_start: 1, gsn_end: 1, reason: ^reason}} =
               find_event(events, [:ebb, :writer, :commit_failed])

      assert [
               {:in_flight_batches, %{count: 1}},
               {:oldest_unreleased_gsn, %{gsn: 1}},
               {:in_flight_batches, %{count: 0}},
               {:oldest_unreleased_gsn, %{gsn: 0}}
             ] = pipeline_measurements(events)
    end
  end

  describe "failed commit" do
    test "emits commit_failed and range_resolved, both carrying the reason", ctx do
      ref = attach_telemetry(@writer_events)
      commit_fn = fn _ops, _opts -> {:error, :injected_rocksdb_failure} end

      %{name: writer_name} = start_writer(writer_opts(ctx, %{commit_fn: commit_fn}))

      assert {:error, {:rocksdb_write_failed, :injected_rocksdb_failure}} =
               Writer.write_actions([validated_action(%{id: "act_fail"})], writer_name)

      events = telemetry_events(ref)

      assert {_event, %{count: 1}, %{gsn_start: 1, gsn_end: 1, reason: :injected_rocksdb_failure}} =
               find_event(events, [:ebb, :writer, :commit_failed])

      assert {_event, %{count: 1}, %{gsn_start: 1, gsn_end: 1, reason: :injected_rocksdb_failure}} =
               find_event(events, [:ebb, :writer, :range_resolved])

      assert {_event, %{duration: duration}, %{gsn_start: 1, gsn_end: 1}} =
               find_event(events, [:ebb, :writer, :commit_latency_ms])

      assert is_integer(duration)
    end
  end

  describe "flush phase timings" do
    test "a successful flush reports one event per range with every phase", ctx do
      ref = attach_telemetry(@writer_events)
      %{name: writer_name} = start_writer(writer_opts(ctx, %{}))

      actions = [
        validated_action(%{id: "act_phase_ok_1"}),
        validated_action(%{id: "act_phase_ok_2"})
      ]

      started_at = System.monotonic_time()
      assert {:ok, {1, 2}, []} = Writer.write_actions(actions, writer_name)
      events = telemetry_events(ref)

      # Read after the event lands, so the bound cannot race the Writer's
      # last phase stamp.
      elapsed = System.monotonic_time() - started_at

      assert [{[:ebb, :writer, :flush_phase_ms], measurements, metadata}] =
               flush_phase_events(events)

      assert Enum.sort(Map.keys(measurements)) == Enum.sort(Telemetry.writer_flush_phases())

      for phase <- Telemetry.writer_flush_phases() do
        assert is_integer(measurements[phase]), "#{phase} is not an integer"
        assert measurements[phase] >= 0, "#{phase} is negative"
      end

      assert metadata == %{gsn_start: 1, gsn_end: 2, outcome: :ok}

      # Every phase is a slice of the range's lifetime, so the sum of the
      # six is the wall time the test itself observed.
      assert Enum.sum(Map.values(measurements)) > 0
      assert Enum.sum(Map.values(measurements)) <= elapsed
    end

    test "coalesced calls report the oldest call's mailbox wait in queue", ctx do
      ref = attach_telemetry(@writer_events)
      %{name: writer_name, pid: writer_pid} = start_writer(writer_opts(ctx, %{}))

      :ok = :sys.suspend(writer_name)

      tasks =
        for i <- 1..2 do
          Task.async(fn ->
            Writer.write_actions(
              [validated_action(%{id: "act_phase_coalesced_#{i}"})],
              writer_name
            )
          end)
        end

      assert wait_until(fn -> queue_len(writer_pid) >= 2 end)
      :ok = :sys.resume(writer_name)

      for task <- tasks, do: assert({:ok, {_, _}, []} = Task.await(task, 2_000))

      assert [
               {[:ebb, :writer, :flush_phase_ms], %{queue: queue},
                %{gsn_start: 1, gsn_end: 2, outcome: :ok}}
             ] = flush_phase_events(telemetry_events(ref))

      assert queue > 0
    end

    test "a failed commit reports only the phases reached before the abandon", ctx do
      ref = attach_telemetry(@writer_events)

      commit_fn = fn _ops, _opts ->
        Process.sleep(2)
        {:error, :injected_rocksdb_failure}
      end

      %{name: writer_name} = start_writer(writer_opts(ctx, %{commit_fn: commit_fn}))

      assert {:error, {:rocksdb_write_failed, :injected_rocksdb_failure}} =
               Writer.write_actions([validated_action(%{id: "act_phase_fail"})], writer_name)

      assert [{[:ebb, :writer, :flush_phase_ms], measurements, metadata}] =
               flush_phase_events(telemetry_events(ref))

      assert Enum.sort(Map.keys(measurements)) == Enum.sort(Telemetry.writer_flush_phases())

      assert metadata == %{
               gsn_start: 1,
               gsn_end: 1,
               outcome: :abandoned,
               reason: :injected_rocksdb_failure
             }

      assert measurements.queue >= 0
      assert measurements.prepare >= 0
      assert measurements.resolve >= 0
      assert measurements.commit_wait > 0
      assert measurements.apply == 0
      assert measurements.notify == 0
    end

    test "a raising commit reports the abandon reason and stops before apply", ctx do
      ref = attach_telemetry(@writer_events)

      commit_fn = fn _ops, _opts ->
        Process.sleep(2)
        raise "phase boom"
      end

      %{name: writer_name} = start_writer(writer_opts(ctx, %{commit_fn: commit_fn}))

      assert {:error, {:rocksdb_write_failed, {:committer_raised, %RuntimeError{}}}} =
               Writer.write_actions([validated_action(%{id: "act_phase_raise"})], writer_name)

      events = telemetry_events(ref)

      assert {_event, _measurements, %{reason: reason}} =
               find_event(events, [:ebb, :writer, :range_resolved])

      assert [{[:ebb, :writer, :flush_phase_ms], measurements, metadata}] =
               flush_phase_events(events)

      assert %{gsn_start: 1, gsn_end: 1, outcome: :abandoned, reason: ^reason} = metadata
      assert reason == {:committer_raised, %RuntimeError{message: "phase boom"}}
      assert measurements.commit_wait > 0
      assert measurements.apply == 0
      assert measurements.notify == 0
    end

    test "a failed cache apply reports the durable range as ok with the replies in notify", ctx do
      ref = attach_telemetry(@writer_events)

      %{name: writer_name} =
        start_writer(writer_opts(ctx, %{entity_types: :ebb_537_missing_table}))

      assert {:ok, {1, 1}, []} =
               Writer.write_actions([validated_action(%{id: "act_phase_escalate"})], writer_name)

      assert [{[:ebb, :writer, :flush_phase_ms], measurements, metadata}] =
               flush_phase_events(telemetry_events(ref))

      assert metadata == %{gsn_start: 1, gsn_end: 1, outcome: :ok}
      assert measurements.apply > 0
      assert measurements.notify > 0
    end

    test "a resolve-time abandon reports queue, prepare, and resolve only", ctx do
      ref = attach_telemetry(@writer_events)

      # `entity_groups` names a table that does not exist, so group
      # resolution raises inside `dispatch/8` after the range is claimed.
      %{name: writer_name, pid: writer_pid} =
        start_writer(writer_opts(ctx, %{entity_groups: :ebb_537_missing_table}))

      Process.unlink(writer_pid)

      catch_exit(
        Writer.write_actions([validated_action(%{id: "act_phase_resolve_fail"})], writer_name)
      )

      assert [{[:ebb, :writer, :flush_phase_ms], measurements, metadata}] =
               flush_phase_events(telemetry_events(ref))

      assert %{gsn_start: 1, gsn_end: 1, outcome: :abandoned, reason: reason} = metadata
      assert %ArgumentError{} = reason
      assert measurements.queue >= 0
      assert measurements.prepare >= 0
      assert measurements.resolve >= 0
      assert measurements.commit_wait == 0
      assert measurements.apply == 0
      assert measurements.notify == 0
    end

    defp flush_phase_events(events) do
      Enum.filter(events, &match?({[:ebb, :writer, :flush_phase_ms], _, _}, &1))
    end
  end

  defp find_event(events, name) do
    Enum.find(events, fn {event, _measurements, _metadata} -> event == name end)
  end

  defp pipeline_measurements(events) do
    for {event, measurements, _metadata} <- events,
        event in [[:ebb, :writer, :in_flight_batches], [:ebb, :writer, :oldest_unreleased_gsn]] do
      {List.last(event), measurements}
    end
  end
end
