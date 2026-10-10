defmodule EbbServer.Storage.WriterTelemetryTest do
  @moduledoc """
  Telemetry tests for the Writer's coalesced flush (ebbjs/ebbjs#360).

  The success path emits batch size, batch latency, and the accepted-Action
  counter; the abandon path emits `range_resolved` and the failed-commit
  path emits both `commit_failed` and `range_resolved`. An abandon must
  never be reported as a failed commit, and a committed batch must never
  report either.
  """

  use ExUnit.Case, async: false

  alias EbbServer.Storage.Writer

  import EbbServer.TestHelpers

  @writer_events [
    [:ebb, :writer, :batch_size],
    [:ebb, :writer, :batch_latency_ms],
    [:ebb, :writer, :actions_per_sec],
    [:ebb, :writer, :range_resolved],
    [:ebb, :writer, :commit_failed]
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

      assert {_event, %{count: 2}, %{}} = find_event(events, [:ebb, :writer, :actions_per_sec])

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
    test "emits range_resolved with the reason and no commit_failed", ctx do
      ref = attach_telemetry(@writer_events)
      commit_fn = fn _ops, _opts -> raise "commit boom" end

      %{name: writer_name, pid: writer_pid} =
        start_writer(writer_opts(ctx, %{commit_fn: commit_fn}))

      Process.unlink(writer_pid)

      catch_exit(Writer.write_actions([validated_action(%{id: "act_raise"})], writer_name))

      events = telemetry_events(ref)

      assert {_event, %{count: 1}, %{gsn_start: 1, gsn_end: 1, reason: reason}} =
               find_event(events, [:ebb, :writer, :range_resolved])

      assert %RuntimeError{message: "commit boom"} = reason

      refute find_event(events, [:ebb, :writer, :commit_failed])
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
    end
  end

  defp find_event(events, name) do
    Enum.find(events, fn {event, _measurements, _metadata} -> event == name end)
  end
end
