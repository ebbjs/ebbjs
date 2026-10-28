defmodule EbbServer.Sync.FanOutRouterCommitTimeoutE2ETest do
  @moduledoc """
  A commit-watchdog timeout resolves its range so the subscriber stream
  resumes (ebbjs/ebbjs#538, AC3).

  The head commit is held past the threshold, which abandons its GSN range
  and nudges the real Router. A later write must then reach the subscriber
  without waiting for the stuck worker.
  """

  use ExUnit.Case, async: false
  use EbbServer.Integration.StorageCase

  import EbbServer.SSEHelpers
  import EbbServer.TestHelpers

  alias EbbServer.Integration.ActionHelpers
  alias EbbServer.Storage.{RocksDB, WatermarkTracker}
  alias EbbServer.Sync.{FanOutFrontier, FanOutRouter, SSEConnection}

  @arm_table :ebb_538_commit_timeout_arm

  def storage_writer_opts do
    test_pid = self()
    arm_table = @arm_table

    if :ets.whereis(arm_table) == :undefined do
      :ets.new(arm_table, [:named_table, :public, :set])
    end

    [
      max_in_flight: 1,
      committer_pool_size: 1,
      commit_timeout_ms: 75,
      sweep_interval_ms: 10,
      commit_fn: fn ops, opts ->
        if armed?(arm_table) do
          send(test_pid, {:commit_started, self()})

          receive do
            :release -> RocksDB.write_batch(ops, opts)
          after
            5_000 -> RocksDB.write_batch(ops, opts)
          end
        else
          RocksDB.write_batch(ops, opts)
        end
      end
    ]
  end

  setup do
    :ets.delete_all_objects(@arm_table)
    :ets.insert(@arm_table, {:armed, false})

    on_exit(fn ->
      if :ets.whereis(@arm_table) != :undefined, do: :ets.delete(@arm_table)
    end)

    :ok
  end

  test "a timed-out head range resolves and the subscriber receives the next write" do
    group_id = "g_538_timeout_#{:erlang.unique_integer([:positive])}"
    actor_id = "a_538_timeout_#{:erlang.unique_integer([:positive])}"
    [head_entity, successor_entity] = seed_group!(actor_id, group_id, 2)

    :sys.get_state(FanOutRouter)
    head_gsn = RocksDB.get_max_gsn() + 1
    assert FanOutFrontier.get() == {:ok, head_gsn - 1}

    {:ok, sse_pid} = SSEConnection.start_link(self(), [group_id], %{group_id => 0})
    :ok = FanOutRouter.subscribe([group_id], sse_pid, actor_id)

    :ets.insert(@arm_table, {:armed, true})

    head_task = Task.async(fn -> post_todo!(actor_id, head_entity, "head") end)
    assert_receive {:commit_started, head_worker}, 2_000

    # The watchdog abandons the range and the caller gets the retryable 503.
    assert %{status: 503} = Task.await(head_task, 2_000)
    assert WatermarkTracker.committed_watermark() >= head_gsn

    :ets.insert(@arm_table, {:armed, false})

    assert ActionHelpers.write_entity_in_group(
             actor_id,
             successor_entity,
             "todo",
             group_id,
             %{"title" => %{"type" => "lww", "value" => "successor", "hlc" => generate_hlc()}}
           ).status == 200

    payloads = receive_data_payloads(1) |> Enum.map(&Jason.decode!/1)
    assert [%{"gsn" => gsn}] = payloads
    assert gsn > head_gsn

    # The late write is allowed to land after the hole is resolved.
    send(head_worker, :release)

    :ok = FanOutRouter.unsubscribe(sse_pid)
  end

  defp armed?(table) do
    :ets.lookup(table, :armed) == [{:armed, true}]
  rescue
    ArgumentError -> false
  end

  defp seed_group!(actor_id, group_id, entity_count) do
    assert ActionHelpers.bootstrap_group(actor_id, group_id, ["todo.*"]).status == 200

    for index <- 1..entity_count do
      entity_id = "todo_538_#{index}_#{:erlang.unique_integer([:positive])}"

      assert ActionHelpers.write_entity_in_group(
               actor_id,
               entity_id,
               "todo",
               group_id,
               %{"title" => %{"type" => "lww", "value" => "seed", "hlc" => generate_hlc()}}
             ).status == 200

      entity_id
    end
  end

  defp post_todo!(actor_id, entity_id, title) do
    hlc = generate_hlc()

    action = %{
      "id" => "act_538_timeout_#{:erlang.unique_integer([:positive])}",
      "actor_id" => actor_id,
      "hlc" => hlc,
      "updates" => [
        %{
          "id" => "upd_538_timeout_#{:erlang.unique_integer([:positive])}",
          "subject_id" => entity_id,
          "subject_type" => "todo",
          "method" => "put",
          "data" => %{
            "fields" => %{"title" => %{"type" => "lww", "value" => title, "hlc" => hlc}}
          }
        }
      ]
    }

    ActionHelpers.post_actions(
      ActionHelpers.msgpack_encode!(%{"actions" => [action]}),
      actor_id
    )
  end
end
