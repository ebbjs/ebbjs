defmodule EbbServer.Storage.WriterFailurePolicyTest do
  @moduledoc """
  Behavioral tests for the Writer's abandon-and-resolve failure policy
  (ebbjs/ebbjs#282).

  A failed commit must never leave the claimed GSN range unresolved: an
  unresolved claim stalls the watermark and freezes live sync for every
  group. These tests exercise the failure path, the structural
  `try`/`after` guarantee, and the `init/1` reconcile that heals a Writer
  crash between claim and resolve.
  """

  use ExUnit.Case, async: false

  alias EbbServer.Storage.{RocksDB, WatermarkTracker, Writer}

  import EbbServer.TestHelpers

  setup do
    %{
      dirty_set: dirty_set,
      gsn_counter: gsn_counter,
      group_members: group_members,
      group_members_by_id: group_members_by_id,
      entity_groups: entity_groups,
      entity_groups_by_id: entity_groups_by_id,
      entity_groups_by_group: entity_groups_by_group,
      relationships: relationships,
      relationships_by_id: relationships_by_id,
      watermark_tracker: watermark_tracker
    } = start_isolated_cache()

    %{name: rocks_name} = start_rocks()

    %{
      dirty_set: dirty_set,
      gsn_counter: gsn_counter,
      group_members: group_members,
      group_members_by_id: group_members_by_id,
      entity_groups: entity_groups,
      entity_groups_by_id: entity_groups_by_id,
      entity_groups_by_group: entity_groups_by_group,
      relationships: relationships,
      relationships_by_id: relationships_by_id,
      watermark_tracker: watermark_tracker,
      rocks_name: rocks_name
    }
  end

  describe "failed commit abandons and resolves the claim" do
    test "a fail-once commit does not stall the watermark and later batches fan out", ctx do
      test_pid = self()
      router_name = :"failure_router_#{System.unique_integer([:positive])}"
      true = Process.register(test_pid, router_name)
      attempts = :atomics.new(1, signed: false)

      commit_fn = fn ops, opts ->
        if :atomics.add_get(attempts, 1, 1) == 1 do
          {:error, :injected_rocksdb_failure}
        else
          RocksDB.write_batch(ops, opts)
        end
      end

      %{name: writer_name} =
        start_writer(Map.merge(ctx, %{fan_out_router: router_name, commit_fn: commit_fn}))

      first = validated_action(%{updates: [validated_update(%{subject_id: "todo_first"})]})

      assert {:error, {:rocksdb_write_failed, :injected_rocksdb_failure}} =
               Writer.write_actions([first], writer_name)

      # The abandoned range is resolved and the router is nudged so
      # anything gated on the hole can drain.
      assert_receive {:range_resolved, 1, 1}
      assert WatermarkTracker.committed_watermark(ctx.watermark_tracker) == 1

      second = validated_action(%{updates: [validated_update(%{subject_id: "todo_second"})]})

      assert {:ok, {2, 2}, []} = Writer.write_actions([second], writer_name)
      assert_receive {:batch_committed, 2, 2, _groups}
      assert WatermarkTracker.committed_watermark(ctx.watermark_tracker) == 2
    end
  end

  describe "structural resolution" do
    test "a commit_fn that raises still resolves the claimed range, nudges, and persists nothing",
         ctx do
      test_pid = self()
      router_name = :"raising_router_#{System.unique_integer([:positive])}"
      true = Process.register(test_pid, router_name)
      commit_fn = fn _ops, _opts -> raise "boom" end

      %{name: writer_name, pid: writer_pid} =
        start_writer(Map.merge(ctx, %{commit_fn: commit_fn, fan_out_router: router_name}))

      Process.unlink(writer_pid)

      action = validated_action()

      catch_exit(Writer.write_actions([action], writer_name))

      # The raise path abandons like a failed commit: resolve, then nudge.
      assert_receive {:range_resolved, 1, 1}
      assert WatermarkTracker.committed_watermark(ctx.watermark_tracker) == 1

      assert :not_found =
               RocksDB.get(
                 RocksDB.cf_actions(ctx.rocks_name),
                 RocksDB.encode_gsn_key(1),
                 name: ctx.rocks_name
               )
    end
  end

  describe "crash between claim and resolve" do
    test "init/1 reconcile heals the abandoned claim on restart", ctx do
      test_pid = self()

      commit_fn = fn _ops, _opts ->
        send(test_pid, {:commit_started, self()})

        receive do
          :never -> :ok
        end
      end

      %{name: writer_name, pid: writer_pid} =
        start_writer(Map.merge(ctx, %{commit_fn: commit_fn}))

      Process.unlink(writer_pid)

      action = validated_action()

      spawn(fn ->
        send(test_pid, {:write_result, catch_exit(Writer.write_actions([action], writer_name))})
      end)

      assert_receive {:commit_started, ^writer_pid}
      Process.exit(writer_pid, :kill)
      assert_receive {:write_result, _exit}, 2_000

      # The counter advanced to 1 for the claim the crashed writer never
      # resolved; the watermark is still 0.
      assert :atomics.get(ctx.gsn_counter, 1) == 1
      assert WatermarkTracker.committed_watermark(ctx.watermark_tracker) == 0

      %{name: restarted_name} = start_writer(ctx)

      # Reconcile advanced the frontier over the hole.
      assert WatermarkTracker.committed_watermark(ctx.watermark_tracker) == 1

      # The abandoned GSN 1 is not reused.
      assert {:ok, {2, 2}, []} = Writer.write_actions([validated_action()], restarted_name)
      assert WatermarkTracker.committed_watermark(ctx.watermark_tracker) == 2
    end
  end

  describe "init/1 reconcile" do
    test "resolves a counter that is ahead of the durable log", ctx do
      :atomics.put(ctx.gsn_counter, 1, 5)

      %{name: writer_name} = start_writer(ctx)

      assert WatermarkTracker.committed_watermark(ctx.watermark_tracker) == 5
      assert {:ok, {6, 6}, []} = Writer.write_actions([validated_action()], writer_name)
    end

    test "is a no-op when the counter and the frontier already agree", ctx do
      %{name: writer_name} = start_writer(ctx)

      assert WatermarkTracker.committed_watermark(ctx.watermark_tracker) == 0
      assert {:ok, {1, 1}, []} = Writer.write_actions([validated_action()], writer_name)
    end
  end
end
