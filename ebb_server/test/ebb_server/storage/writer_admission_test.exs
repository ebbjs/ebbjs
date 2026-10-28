defmodule EbbServer.Storage.WriterAdmissionTest do
  @moduledoc """
  Admission control in front of the Writer mailbox (ebbjs/ebbjs#538).

  A saturated Writer rejects a new call with `{:error, {:overloaded, ms}}`
  before the call is enqueued, and releases the slot for every accepted call.
  """

  use ExUnit.Case, async: false

  alias EbbServer.Storage.{RocksDB, Writer}

  import EbbServer.TestHelpers

  setup do
    cache = start_isolated_cache()
    %{name: rocks_name} = start_rocks()

    Map.put(cache, :rocks_name, rocks_name)
  end

  test "rejects before the mailbox once the pending-call bound is reached", ctx do
    test_pid = self()

    %{name: writer_name} =
      start_writer(
        writer_opts(ctx, %{
          max_pending_calls: 2,
          commit_fn: blocking_commit_fn(test_pid)
        })
      )

    ref = attach_telemetry([[:ebb, :writer, :admission_rejected]])

    first =
      Task.async(fn ->
        Writer.write_actions([validated_action(%{id: "act_admission_1"})], writer_name)
      end)

    second =
      Task.async(fn ->
        Writer.write_actions([validated_action(%{id: "act_admission_2"})], writer_name)
      end)

    assert_receive {:commit_started, worker}, 2_000

    %{counter: counter} =
      :persistent_term.get({Writer, :pending_calls, writer_name})

    assert wait_until(fn -> :atomics.get(counter, 1) == 2 end)

    assert {:error, {:overloaded, 1_000}} =
             Writer.write_actions([validated_action(%{id: "act_admission_3"})], writer_name)

    assert {[:ebb, :writer, :admission_rejected], %{count: 1}, %{max_pending_calls: 2}} =
             Enum.find(telemetry_events(ref), fn {event, _, _} ->
               event == [:ebb, :writer, :admission_rejected]
             end)

    send(worker, :release)

    # Admission does not rename arrival order: the two accepted calls settle
    # into the two GSNs in whichever order the tasks reached the Writer.
    assert Enum.sort([Task.await(first, 2_000), Task.await(second, 2_000)]) ==
             [{:ok, {1, 1}, []}, {:ok, {2, 2}, []}]

    # Both accepted calls released their slot, so the Writer admits again.
    assert {:ok, {3, 3}, []} =
             Writer.write_actions([validated_action(%{id: "act_admission_4"})], writer_name)

    assert telemetry_events(ref) == []
  end

  test "EBB_WRITER_MAX_PENDING_CALLS sets the bound when no option is given", ctx do
    previous = System.get_env("EBB_WRITER_MAX_PENDING_CALLS")
    System.put_env("EBB_WRITER_MAX_PENDING_CALLS", "7")

    on_exit(fn ->
      if previous,
        do: System.put_env("EBB_WRITER_MAX_PENDING_CALLS", previous),
        else: System.delete_env("EBB_WRITER_MAX_PENDING_CALLS")
    end)

    %{name: writer_name} = start_writer(writer_opts(ctx, %{}))

    assert %{max: 7} =
             :persistent_term.get({Writer, :pending_calls, writer_name})
  end

  test "a rejected max_pending_calls is a boot error", ctx do
    name = :"invalid_pending_#{System.unique_integer([:positive])}"
    Process.flag(:trap_exit, true)

    assert {:error, {%ArgumentError{message: message}, _stacktrace}} =
             Writer.start_link(
               writer_opts(ctx, %{max_pending_calls: 0})
               |> Map.to_list()
               |> Keyword.put(:name, name)
             )

    assert message =~ "must be a positive integer"
  end

  # Runs in the Committer worker. The test holds the range until it has seen
  # both accepted calls enqueue and the third one be rejected.
  defp blocking_commit_fn(test_pid) do
    attempts = :atomics.new(1, signed: false)

    fn ops, opts ->
      send(test_pid, {:commit_started, self()})

      if :atomics.add_get(attempts, 1, 1) == 1 do
        receive do
          :release -> RocksDB.write_batch(ops, opts)
        end
      else
        RocksDB.write_batch(ops, opts)
      end
    end
  end
end
