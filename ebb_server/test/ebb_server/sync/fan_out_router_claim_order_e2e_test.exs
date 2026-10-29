defmodule EbbServer.Sync.FanOutRouterClaimOrderE2ETest do
  @moduledoc """
  End-to-end claim-order release (ebbjs/ebbjs#534).

  Ranges are held in a depth-2 Writer and acked in reverse order. The
  Writer must still notify the real Router in claim order, the subscriber
  must receive the ranges in that order, and the persisted frontier must
  not move past the head until the head is actually pushed.
  """

  use ExUnit.Case, async: false
  use EbbServer.Integration.StorageCase

  import EbbServer.SSEHelpers
  import EbbServer.TestHelpers

  alias EbbServer.Integration.ActionHelpers
  alias EbbServer.Storage.{RocksDB, WatermarkTracker, Writer}
  alias EbbServer.Sync.{FanOutFrontier, FanOutRouter, SSEConnection}

  @arm_table :ebb_534_claim_order_arm

  # The commit workers park only while the test has armed the gate, so the
  # setup writes below still commit synchronously.
  def storage_writer_opts do
    test_pid = self()
    arm_table = @arm_table

    if :ets.whereis(arm_table) == :undefined do
      :ets.new(arm_table, [:named_table, :public, :set])
    end

    writer_opts = [
      max_in_flight: 2,
      committer_pool_size: 2,
      batch_max_size: 1
    ]

    Keyword.put(writer_opts, :commit_fn, fn ops, opts ->
      if armed?(arm_table) do
        send(test_pid, {:commit_started, self()})

        receive do
          :release -> RocksDB.write_batch(ops, opts)
          :fail -> {:error, :injected}
        after
          10_000 -> RocksDB.write_batch(ops, opts)
        end
      else
        RocksDB.write_batch(ops, opts)
      end
    end)
  end

  setup do
    :ets.delete_all_objects(@arm_table)
    :ets.insert(@arm_table, {:armed, false})

    on_exit(fn ->
      if :ets.whereis(@arm_table) != :undefined, do: :ets.delete(@arm_table)
    end)

    :ok
  end

  test "a later multi-GSN range acked first is still pushed after the head" do
    group_id = "g_534_e2e_#{:erlang.unique_integer([:positive])}"
    actor_id = "a_534_e2e_#{:erlang.unique_integer([:positive])}"
    entities = seed_group!(actor_id, group_id, 4)

    :sys.get_state(FanOutRouter)
    head_gsn = RocksDB.get_max_gsn() + 1
    assert FanOutFrontier.get() == {:ok, head_gsn - 1}

    {:ok, sse_pid} = SSEConnection.start_link(self(), [group_id], %{group_id => 0})
    :ok = FanOutRouter.subscribe([group_id], sse_pid, actor_id)

    # From here each commit parks its worker, so the two ranges can be
    # acknowledged in reverse order.
    :ets.insert(@arm_table, {:armed, true})

    head_task = Task.async(fn -> post_todos!(actor_id, Enum.take(entities, 2), "head") end)
    assert_receive {:commit_started, head_worker}, 5_000

    successor_task = Task.async(fn -> post_todos!(actor_id, Enum.drop(entities, 2), "later") end)
    assert_receive {:commit_started, successor_worker}, 5_000
    assert head_worker != successor_worker

    # The successor (two GSNs) is durable first and waits in the buffer.
    send(successor_worker, :release)

    assert wait_until(fn ->
             phases() == [:committing, :committed]
           end)

    refute_sse_data(200)
    assert FanOutFrontier.get() == {:ok, head_gsn - 1}

    send(head_worker, :release)

    assert %{status: 200} = Task.await(head_task, 5_000)
    assert %{status: 200} = Task.await(successor_task, 5_000)

    payloads = receive_data_payloads(4) |> Enum.map(&Jason.decode!/1)
    assert Enum.map(payloads, & &1["gsn"]) == [head_gsn, head_gsn + 1, head_gsn + 2, head_gsn + 3]

    :sys.get_state(FanOutRouter)
    assert FanOutFrontier.get() == {:ok, head_gsn + 3}
    assert WatermarkTracker.committed_watermark() == head_gsn + 3

    :ok = FanOutRouter.unsubscribe(sse_pid)
  end

  test "an abandoned head drains the nudge before the successor is pushed" do
    group_id = "g_534_abandon_#{:erlang.unique_integer([:positive])}"
    actor_id = "a_534_abandon_#{:erlang.unique_integer([:positive])}"
    [head_entity, successor_entity] = seed_group!(actor_id, group_id, 2)

    :sys.get_state(FanOutRouter)
    head_gsn = RocksDB.get_max_gsn() + 1

    {:ok, sse_pid} = SSEConnection.start_link(self(), [group_id], %{group_id => 0})
    :ok = FanOutRouter.subscribe([group_id], sse_pid, actor_id)

    :ets.insert(@arm_table, {:armed, true})

    head_task = Task.async(fn -> post_todos!(actor_id, [head_entity], "head") end)
    assert_receive {:commit_started, head_worker}, 5_000

    successor_task = Task.async(fn -> post_todos!(actor_id, [successor_entity], "successor") end)
    assert_receive {:commit_started, successor_worker}, 5_000

    # The head fails while the successor is still committing. The hole is
    # resolved and nudged, but the successor must not be pushed until its
    # own ack arrives.
    send(head_worker, :fail)

    assert %{status: 503} = Task.await(head_task, 5_000)
    assert wait_until(fn -> length(open_batches()) == 1 end)

    assert WatermarkTracker.committed_watermark() == head_gsn
    assert FanOutFrontier.get() == {:ok, head_gsn - 1}
    refute_sse_data(200)

    send(successor_worker, :release)
    assert %{status: 200} = Task.await(successor_task, 5_000)

    payloads = receive_data_payloads(1) |> Enum.map(&Jason.decode!/1)
    assert Enum.map(payloads, & &1["gsn"]) == [head_gsn + 1]

    :sys.get_state(FanOutRouter)
    assert FanOutFrontier.get() == {:ok, head_gsn + 1}

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
      entity_id = "todo_534_#{index}_#{:erlang.unique_integer([:positive])}"

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

  defp phases do
    open_batches() |> Enum.map(& &1.phase)
  end

  defp open_batches do
    Writer
    |> :sys.get_state()
    |> Map.fetch!(:pipeline)
    |> EbbServer.Storage.CommitPipeline.open_batches()
  end

  # One request with one Action per entity, so a call claims a multi-GSN
  # range without coalescing two callers.
  defp post_todos!(actor_id, entities, title) do
    hlc = generate_hlc()

    actions =
      Enum.map(entities, fn entity_id ->
        %{
          "id" => "act_534_e2e_#{:erlang.unique_integer([:positive])}",
          "actor_id" => actor_id,
          "hlc" => hlc,
          "updates" => [
            %{
              "id" => "upd_534_e2e_#{:erlang.unique_integer([:positive])}",
              "subject_id" => entity_id,
              "subject_type" => "todo",
              "method" => "put",
              "data" => %{
                "fields" => %{
                  "title" => %{"type" => "lww", "value" => title, "hlc" => hlc}
                }
              }
            }
          ]
        }
      end)

    ActionHelpers.post_actions(
      ActionHelpers.msgpack_encode!(%{"actions" => actions}),
      actor_id
    )
  end
end
