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

  alias EbbServer.Storage.{
    ActionFormat,
    CommitPipeline,
    DirtyTracker,
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
      assert_receive {:batch_committed, 2, 2, _groups, _committed_at}
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

      # Depth 2 so the commit runs in a pool worker: the Writer commits
      # inline only when it has a single committer slot.
      %{name: writer_name, pid: writer_pid} =
        start_writer(
          Map.merge(ctx, %{commit_fn: commit_fn, max_in_flight: 2, committer_pool_size: 2})
        )

      Process.unlink(writer_pid)

      action = validated_action(%{updates: [validated_update(%{subject_id: "todo_failed"})]})

      assert {:error, {:rocksdb_write_failed, {:committer_raised, %RuntimeError{}}}} =
               Writer.write_actions([action], writer_name)

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

      assert {:error, {:rocksdb_write_failed, {:committer_raised, %RuntimeError{}}}} =
               Writer.write_actions([action], writer_name)

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

      # The pre-dispatch raise releases the in-flight ids it just claimed.
      assert InFlightActions.size(ctx.in_flight_actions) == 0

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

  describe "pre-encode before the claim" do
    test "a raise while building the payload claims no GSN", ctx do
      %{name: writer_name, pid: writer_pid} = start_writer(ctx)
      Process.unlink(writer_pid)

      # `ActionFormat.build/1` maps over `updates`, so a non-list raises
      # while the call is being enqueued — before the flush claims a range.
      action = validated_action(%{updates: :not_a_list})

      catch_exit(Writer.write_actions([action], writer_name))

      assert :atomics.get(ctx.gsn_counter, 1) == 0
      assert WatermarkTracker.committed_watermark(ctx.watermark_tracker) == 0
      assert RocksDB.get_max_gsn(ctx.rocks_name) == 0
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

      # Depth 2 so the commit runs in a pool worker: the Writer commits
      # inline only when it has a single committer slot.
      %{name: writer_name, pid: writer_pid} =
        start_writer(
          Map.merge(ctx, %{commit_fn: commit_fn, max_in_flight: 2, committer_pool_size: 2})
        )

      Process.unlink(writer_pid)

      action = validated_action()

      spawn(fn ->
        send(test_pid, {:write_result, catch_exit(Writer.write_actions([action], writer_name))})
      end)

      # The commit blocks in a pool worker, not in the Writer; a hard
      # kill of the Writer takes the linked pool and its workers with it.
      assert_receive {:commit_started, committer_pid}
      assert committer_pid != writer_pid
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

      assert {:error, {:rocksdb_write_failed, {:committer_raised, %RuntimeError{}}}} =
               Writer.write_actions([action], writer_name)

      # The commit landed before the raise, so GSN 1 is durable even
      # though the caller saw a failed write and the range was resolved.
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

      assert ActionFormat.decode(binary, 1)["id"] == action.id
    end
  end

  describe "post-commit failure" do
    test "a raise after the durable mark leaves the range committed and still emits latency",
         ctx do
      ref =
        attach_telemetry([
          [:ebb, :writer, :batch_latency_ms],
          [:ebb, :writer, :range_resolved]
        ])

      after_commit = fn -> raise "post-commit boom" end

      %{name: writer_name, pid: writer_pid} =
        start_writer(Map.merge(ctx, %{after_commit: after_commit}))

      Process.unlink(writer_pid)

      action = validated_action(%{updates: [validated_update(%{subject_id: "todo_post_commit"})]})

      catch_exit(Writer.write_actions([action], writer_name))

      assert RocksDB.get_max_gsn(ctx.rocks_name) == 1
      assert WatermarkTracker.committed_watermark(ctx.watermark_tracker) == 1

      events = telemetry_events(ref)

      assert Enum.any?(events, fn
               {[:ebb, :writer, :batch_latency_ms], %{duration: duration},
                %{gsn_start: 1, gsn_end: 1}} ->
                 is_integer(duration)

               _ ->
                 false
             end)

      refute Enum.any?(events, fn
               {[:ebb, :writer, :range_resolved], _measurements, %{gsn_start: 1}} -> true
               _ -> false
             end)
    end

    test "a queued flush that fails to prepare does not abandon the committed batch", ctx do
      ref = attach_telemetry([[:ebb, :writer, :range_resolved]])
      test_pid = self()

      commit_fn = fn ops, opts ->
        send(test_pid, {:commit_started, self()})

        receive do
          :release -> RocksDB.write_batch(ops, opts)
        end
      end

      %{name: writer_name, pid: writer_pid} =
        start_writer(
          Map.merge(ctx, %{
            commit_fn: commit_fn,
            batch_max_size: 1,
            # Only group resolution reads this table. The first Action is a
            # `group` update whose group set needs no cache read, so it
            # commits; the queued `todo` Action's resolution raises.
            entity_groups: :ebb_531_missing_table
          })
        )

      Process.unlink(writer_pid)

      first_action =
        validated_action(%{
          id: "act_531_committed_first",
          updates: [
            validated_update(%{
              subject_type: "group",
              subject_id: "g_531_first",
              method: :put,
              data: %{"fields" => %{}}
            })
          ]
        })

      spawn(fn ->
        result =
          try do
            Writer.write_actions([first_action], writer_name)
          catch
            :exit, reason -> {:exit, reason}
          end

        send(test_pid, {:first_result, result})
      end)

      assert_receive {:commit_started, committer_pid}, 2_000

      broken_action =
        validated_action(%{
          id: "act_531_prepare_boom",
          updates: [validated_update(%{subject_id: "todo_531_boom"})]
        })

      spawn(fn ->
        result =
          try do
            Writer.write_actions([broken_action], writer_name)
          catch
            :exit, reason -> {:exit, reason}
          end

        send(test_pid, {:second_result, result})
      end)

      # A single committer slot puts the commit inside the Writer, so the
      # broken call waits in the mailbox rather than in the pipeline.
      assert wait_until(fn -> queue_len(writer_pid) >= 1 end)

      send(committer_pid, :release)

      assert_receive {:first_result, {:ok, {1, 1}, []}}, 2_000
      assert_receive {:second_result, {:exit, _reason}}, 2_000

      events = telemetry_events(ref)

      assert Enum.any?(events, fn
               {[:ebb, :writer, :range_resolved], %{count: 1}, %{gsn_start: 2, gsn_end: 2}} ->
                 true

               _ ->
                 false
             end)

      refute Enum.any?(events, fn
               {[:ebb, :writer, :range_resolved], _measurements, %{gsn_start: 1}} -> true
               _ -> false
             end)

      assert RocksDB.get_max_gsn(ctx.rocks_name) == 1
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
