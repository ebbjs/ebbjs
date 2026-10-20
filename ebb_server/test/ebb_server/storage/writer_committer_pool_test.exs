defmodule EbbServer.Storage.WriterCommitterPoolTest do
  @moduledoc """
  Committer-pool failure containment in the Writer (ebbjs/ebbjs#550).

  A Committer death or raise abandons only the range that worker owned:
  the Writer stays alive, the healthy range keeps committing, and the
  failed range advances the frontier as a normal hole. The ordered
  release stage holds a later durable range until every earlier claim is
  resolved, so fan-out still sees claim order.
  """

  use ExUnit.Case, async: false

  alias EbbServer.Storage.{
    ActionLog,
    InFlightActions,
    RocksDB,
    WatermarkTracker,
    Writer
  }

  import EbbServer.TestHelpers

  setup do
    cache = start_isolated_cache()
    %{name: rocks_name} = start_rocks()

    Map.put(cache, :rocks_name, rocks_name)
  end

  describe "one worker death does not take the Writer down" do
    test "the healthy range commits and the crashed range becomes a resolved hole", ctx do
      router = register_router()
      first = validated_action(%{id: "act_pool_first"})
      second = validated_action(%{id: "act_pool_second"})

      %{name: writer_name, pid: writer_pid} =
        start_writer(pool_writer_opts(ctx, router, :block, nil))

      first_task = Task.async(fn -> Writer.write_actions([first], writer_name) end)
      assert_receive {:commit_started, first_worker}, 2_000

      second_task = Task.async(fn -> Writer.write_actions([second], writer_name) end)
      assert_receive {:commit_started, second_worker}, 2_000
      assert first_worker != second_worker

      assert wait_until(fn ->
               state = :sys.get_state(writer_name)
               owners = state.pipeline.batches |> Map.values() |> Enum.map(& &1.owner)
               Enum.sort(owners) == Enum.sort([first_worker, second_worker])
             end)

      Process.exit(second_worker, :kill)

      assert {:error, {:rocksdb_write_failed, {:committer_crashed, :killed}}} =
               Task.await(second_task, 2_000)

      # The Writer and the first range are still alive while the failed
      # range is already resolved.
      assert Process.alive?(writer_pid)
      assert_receive {:range_resolved, 2, 2}, 2_000
      assert InFlightActions.size(ctx.in_flight_actions) == 1

      send(first_worker, :release)

      assert {:ok, {1, 1}, []} = Task.await(first_task, 2_000)
      assert_receive {:batch_committed, 1, 1, _groups, _committed_at}, 2_000

      assert WatermarkTracker.committed_watermark(ctx.watermark_tracker) == 2
      assert RocksDB.get_max_gsn(ctx.rocks_name) == 1
      assert InFlightActions.size(ctx.in_flight_actions) == 0

      assert wait_until(fn ->
               pipeline = :sys.get_state(writer_name).pipeline
               pipeline.claim_order == [] and pipeline.batches == %{}
             end)

      assert [%{"id" => "act_pool_first", "gsn" => 1}] =
               ActionLog.read(1, 2, rocks_name: ctx.rocks_name)

      assert :not_found =
               RocksDB.get(
                 RocksDB.cf_actions(ctx.rocks_name),
                 RocksDB.encode_gsn_key(2),
                 name: ctx.rocks_name
               )
    end
  end

  describe "an earlier failure releases the later committed range" do
    test "the range behind the hole commits after the failed range is abandoned", ctx do
      router = register_router()
      first = validated_action(%{id: "act_pool_fail"})
      second = validated_action(%{id: "act_pool_healthy"})

      %{name: writer_name} = start_writer(pool_writer_opts(ctx, router, :first_fails, nil))

      first_task = Task.async(fn -> Writer.write_actions([first], writer_name) end)
      assert_receive {:commit_started, first_worker}, 2_000

      second_task = Task.async(fn -> Writer.write_actions([second], writer_name) end)
      assert_receive {:commit_started, second_worker}, 2_000
      assert first_worker != second_worker

      send(first_worker, :release)

      assert {:error, {:rocksdb_write_failed, :injected}} = Task.await(first_task, 2_000)
      assert_receive {:range_resolved, 1, 1}, 2_000

      # The later range is still committing, so it must not be released
      # past the unresolved hole yet.
      refute_receive {:batch_committed, _, _, _, _}, 100

      send(second_worker, :release)

      assert {:ok, {2, 2}, []} = Task.await(second_task, 2_000)
      assert_receive {:batch_committed, 2, 2, _groups, _committed_at}, 2_000

      assert WatermarkTracker.committed_watermark(ctx.watermark_tracker) == 2
      assert RocksDB.get_max_gsn(ctx.rocks_name) == 2
      assert InFlightActions.size(ctx.in_flight_actions) == 0

      assert [%{"id" => "act_pool_healthy", "gsn" => 2}] =
               ActionLog.read(1, 2, rocks_name: ctx.rocks_name)
    end
  end

  describe "worker restart" do
    test "an idle worker death is replaced and the next write succeeds", ctx do
      %{name: writer_name, pid: writer_pid} =
        start_writer(pool_writer_opts(ctx, nil, :immediate, nil, 1))

      pool = :sys.get_state(writer_name).committer_pool
      old_worker = pool |> :sys.get_state() |> Map.fetch!(:idle) |> hd()

      Process.exit(old_worker, :kill)

      assert wait_until(fn ->
               state = :sys.get_state(pool)
               state.idle != [] and hd(state.idle) != old_worker
             end)

      assert Process.alive?(writer_pid)
      assert {:ok, {1, 1}, []} = Writer.write_actions([validated_action()], writer_name)
    end
  end

  describe "a crash after the write lands" do
    test "the durable range is not lost and a retry is deduped", ctx do
      router = register_router()
      first = validated_action(%{id: "act_after_write_first"})
      second = validated_action(%{id: "act_after_write_second"})

      %{name: writer_name} =
        start_writer(pool_writer_opts(ctx, router, :second_crash_after_write, nil))

      first_task = Task.async(fn -> Writer.write_actions([first], writer_name) end)
      assert_receive {:commit_started, first_worker}, 2_000

      second_task = Task.async(fn -> Writer.write_actions([second], writer_name) end)
      assert_receive {:commit_started, second_worker}, 2_000
      assert first_worker != second_worker

      # The second worker wrote GSN 2 before dying, so the range is
      # reported as a resolved hole but the Action is already durable.
      assert {:error, {:rocksdb_write_failed, {:committer_crashed, :killed}}} =
               Task.await(second_task, 2_000)

      assert_receive {:range_resolved, 2, 2}, 2_000
      assert RocksDB.get_max_gsn(ctx.rocks_name) == 2

      send(first_worker, :release)
      assert {:ok, {1, 1}, []} = Task.await(first_task, 2_000)

      assert WatermarkTracker.committed_watermark(ctx.watermark_tracker) == 2
      assert InFlightActions.size(ctx.in_flight_actions) == 0

      assert [
               %{"id" => "act_after_write_first", "gsn" => 1},
               %{"id" => "act_after_write_second", "gsn" => 2}
             ] =
               ActionLog.read(1, 2, rocks_name: ctx.rocks_name)

      # The retry sees the durable dedup marker, not a second GSN.
      assert {:ok, {0, 0}, []} = Writer.write_actions([second], writer_name)
      assert RocksDB.get_max_gsn(ctx.rocks_name) == 2
    end
  end

  describe "pool death" do
    test "the linked Writer dies so the supervisor can rebuild the storage tree", ctx do
      %{name: writer_name, pid: writer_pid} =
        start_writer(pool_writer_opts(ctx, nil, :immediate, nil, 1))

      Process.unlink(writer_pid)
      pool = :sys.get_state(writer_name).committer_pool
      ref = Process.monitor(writer_pid)

      Process.exit(pool, :kill)

      assert_receive {:DOWN, ^ref, :process, ^writer_pid, _reason}, 2_000
    end
  end

  describe "Writer restart with several ranges" do
    test "every orphaned claim is reconciled and durable work survives", ctx do
      first = validated_action(%{id: "act_orphan_first"})
      second = validated_action(%{id: "act_orphan_second"})

      %{name: writer_name, pid: writer_pid} =
        start_writer(pool_writer_opts(ctx, nil, :block, nil, 2))

      Process.unlink(writer_pid)

      test_pid = self()

      spawn(fn ->
        send(test_pid, {:first_result, catch_exit(Writer.write_actions([first], writer_name))})
      end)

      assert_receive {:commit_started, _first_worker}, 2_000

      spawn(fn ->
        send(test_pid, {:second_result, catch_exit(Writer.write_actions([second], writer_name))})
      end)

      assert_receive {:commit_started, second_worker}, 2_000

      # The later range lands first and stays durable but unreleased while
      # the earlier range is still committing.
      send(second_worker, :release)
      refute_receive {:second_result, _}, 100
      assert RocksDB.get_max_gsn(ctx.rocks_name) == 2

      Process.exit(writer_pid, :kill)
      assert_receive {:first_result, _exit}, 2_000
      assert_receive {:second_result, _exit}, 2_000

      # The pool stopped with its owner, so the replacement treats every
      # surviving claim as orphaned, clears the ids, and resolves the tail.
      Process.unlink(writer_pid)

      %{name: restarted_name} = start_writer(pool_writer_opts(ctx, nil, :immediate, nil, 2))

      assert InFlightActions.size(ctx.in_flight_actions) == 0
      assert WatermarkTracker.committed_watermark(ctx.watermark_tracker) == 2

      assert {:ok, {3, 3}, []} = Writer.write_actions([validated_action()], restarted_name)
      assert RocksDB.get_max_gsn(ctx.rocks_name) == 3

      assert [%{"id" => "act_orphan_second", "gsn" => 2}, %{"gsn" => 3}] =
               ActionLog.read(1, 3, rocks_name: ctx.rocks_name)
    end
  end

  defp pool_writer_opts(ctx, router, mode, fail_fn, size \\ 2) do
    writer_opts(ctx, %{
      max_in_flight: size,
      committer_pool_size: size,
      fan_out_router: router,
      commit_fn: commit_fn(mode, fail_fn)
    })
  end

  # Runs in the Committer worker. The blocking mode lets the test hold two
  # ranges in flight and name each worker by arrival order.
  defp commit_fn(:immediate, _fail_fn), do: &RocksDB.write_batch/2

  defp commit_fn(:second_crash_after_write, _fail_fn) do
    test_pid = self()
    attempts = :atomics.new(1, signed: false)

    fn ops, opts ->
      send(test_pid, {:commit_started, self()})

      if :atomics.add_get(attempts, 1, 1) == 1 do
        receive do
          :release -> RocksDB.write_batch(ops, opts)
        end
      else
        :ok = RocksDB.write_batch(ops, opts)
        Process.exit(self(), :kill)
      end
    end
  end

  defp commit_fn(:block, nil) do
    test_pid = self()

    fn ops, opts ->
      send(test_pid, {:commit_started, self()})

      receive do
        :release -> RocksDB.write_batch(ops, opts)
      end
    end
  end

  defp commit_fn(:first_fails, _fail_fn) do
    test_pid = self()
    attempts = :atomics.new(1, signed: false)

    fn ops, opts ->
      send(test_pid, {:commit_started, self()})

      receive do
        :release ->
          if :atomics.add_get(attempts, 1, 1) == 1 do
            {:error, :injected}
          else
            RocksDB.write_batch(ops, opts)
          end
      end
    end
  end

  defp commit_fn(:block, fail_fn) do
    test_pid = self()

    fn ops, opts ->
      send(test_pid, {:commit_started, self()})

      receive do
        :release -> fail_fn.(ops, opts)
      end
    end
  end

  defp register_router do
    name = :"pool_router_#{System.unique_integer([:positive])}"
    true = Process.register(self(), name)
    name
  end
end
