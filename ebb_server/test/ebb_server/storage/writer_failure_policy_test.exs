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

  alias EbbServer.Storage.{DirtyTracker, RocksDB, WatermarkTracker, Writer}

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

  describe "failed commit leaves no provisional marks" do
    test "a fail-once commit clears the provisional mark it wrote", ctx do
      commit_fn = fn _ops, _opts -> {:error, :injected_rocksdb_failure} end

      %{name: writer_name} = start_writer(Map.merge(ctx, %{commit_fn: commit_fn}))

      action = validated_action(%{updates: [validated_update(%{subject_id: "todo_failed"})]})

      assert {:error, {:rocksdb_write_failed, :injected_rocksdb_failure}} =
               Writer.write_actions([action], writer_name)

      refute DirtyTracker.dirty?("todo_failed", ctx.dirty_set)
    end

    test "a commit_fn that raises clears the provisional mark it wrote", ctx do
      commit_fn = fn _ops, _opts -> raise "boom" end

      %{name: writer_name, pid: writer_pid} =
        start_writer(Map.merge(ctx, %{commit_fn: commit_fn}))

      Process.unlink(writer_pid)

      action = validated_action(%{updates: [validated_update(%{subject_id: "todo_failed"})]})

      catch_exit(Writer.write_actions([action], writer_name))

      refute DirtyTracker.dirty?("todo_failed", ctx.dirty_set)
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

  describe "build failure abandons and resolves the claim" do
    test "a raise while building ops abandons, resolves, nudges, and persists nothing", ctx do
      test_pid = self()
      router_name = :"build_failure_router_#{System.unique_integer([:positive])}"
      true = Process.register(test_pid, router_name)

      # `entity_groups` names a table that does not exist, so group
      # resolution raises while the batch is being built — after the GSN
      # range is claimed but before any commit. The range must still be
      # abandoned and resolved, exactly like a commit failure.
      %{name: writer_name, pid: writer_pid} =
        start_writer(
          Map.merge(ctx, %{
            fan_out_router: router_name,
            entity_groups: :ebb_336_missing_table
          })
        )

      Process.unlink(writer_pid)

      actions =
        for i <- 1..2 do
          validated_action(%{
            id: "act_build_failure_#{i}",
            updates: [validated_update(%{subject_id: "todo_build_failure_#{i}"})]
          })
        end

      catch_exit(Writer.write_actions(actions, writer_name))

      # The build raise abandons like a failed commit: resolve, then nudge.
      assert_receive {:range_resolved, 1, 2}
      assert WatermarkTracker.committed_watermark(ctx.watermark_tracker) == 2

      for i <- 1..2 do
        refute DirtyTracker.dirty?("todo_build_failure_#{i}", ctx.dirty_set)
      end

      for gsn <- 1..2 do
        assert :not_found =
                 RocksDB.get(
                   RocksDB.cf_actions(ctx.rocks_name),
                   RocksDB.encode_gsn_key(gsn),
                   name: ctx.rocks_name
                 )
      end
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

  describe "lost ack (#285)" do
    test "a durable commit whose ack was lost makes the retry a no-op", ctx do
      commit_fn = fn ops, opts ->
        :ok = RocksDB.write_batch(ops, opts)
        raise "ack lost"
      end

      %{name: writer_name, pid: writer_pid} =
        start_writer(Map.put(ctx, :commit_fn, commit_fn))

      Process.unlink(writer_pid)

      action = validated_action(%{updates: [validated_update(%{subject_id: "todo_lost_ack"})]})

      catch_exit(Writer.write_actions([action], writer_name))

      # The commit landed before the raise, so GSN 1 is durable even
      # though the caller saw the Writer crash.
      assert RocksDB.get_max_gsn(ctx.rocks_name) == 1

      %{name: restarted_name} = start_writer(ctx)

      assert {:ok, {0, 0}, []} = Writer.write_actions([action], restarted_name)

      assert RocksDB.get_max_gsn(ctx.rocks_name) == 1

      assert :not_found =
               RocksDB.get(RocksDB.cf_actions(ctx.rocks_name), RocksDB.encode_gsn_key(2),
                 name: ctx.rocks_name
               )

      assert {:ok, binary} =
               RocksDB.get(RocksDB.cf_actions(ctx.rocks_name), RocksDB.encode_gsn_key(1),
                 name: ctx.rocks_name
               )

      assert :erlang.binary_to_term(binary, [:safe])["id"] == action.id
    end
  end

  describe "init/1 reconcile" do
    test "resolves a counter that is ahead of the durable log", ctx do
      :atomics.put(ctx.gsn_counter, 1, 5)

      %{name: writer_name} = start_writer(ctx)

      assert WatermarkTracker.committed_watermark(ctx.watermark_tracker) == 5
      assert {:ok, {6, 6}, []} = Writer.write_actions([validated_action()], writer_name)
    end

    test "emits range_resolved for the abandoned tail it reconciles", ctx do
      ref = attach_telemetry([[:ebb, :writer, :range_resolved]])
      :atomics.put(ctx.gsn_counter, 1, 5)

      %{name: _writer_name} = start_writer(ctx)

      assert [{[:ebb, :writer, :range_resolved], %{count: 1}, metadata}] =
               telemetry_events(ref)

      assert metadata == %{gsn_start: 1, gsn_end: 5, reason: :reconciled_on_startup}
    end

    test "is a no-op when the counter and the frontier already agree", ctx do
      ref = attach_telemetry([[:ebb, :writer, :range_resolved]])

      %{name: writer_name} = start_writer(ctx)

      assert WatermarkTracker.committed_watermark(ctx.watermark_tracker) == 0
      assert {:ok, {1, 1}, []} = Writer.write_actions([validated_action()], writer_name)
      assert telemetry_events(ref) == []
    end
  end
end
