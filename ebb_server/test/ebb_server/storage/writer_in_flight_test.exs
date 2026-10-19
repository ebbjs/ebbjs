defmodule EbbServer.Storage.WriterInFlightTest do
  @moduledoc """
  The in-flight action-id guard on the Writer's plan path
  (ebbjs/ebbjs#535).

  A retried Action must never claim a second GSN while its first copy is
  still in flight, so `plan/2` claims the surviving ids in
  `EbbServer.Storage.InFlightActions` before the flush claims its range and
  releases them on both the durable commit and every abandon path. The set
  is a concurrency guard only: `cf_action_dedup` stays the durable marker.
  """

  use ExUnit.Case, async: false

  alias EbbServer.Storage.{ActionLog, InFlightActions, RocksDB, Writer}

  import EbbServer.TestHelpers

  setup do
    cache = start_isolated_cache()
    %{name: rocks_name} = start_rocks()

    Map.put(cache, :rocks_name, rocks_name)
  end

  describe "plan/2 drops in-flight ids" do
    test "an in-flight id claims no GSN and is not rejected", ctx do
      seeded = validated_action(%{id: "act_in_flight"})
      fresh = validated_action(%{id: "act_fresh"})

      %{name: writer_name, pid: writer_pid} = start_writer(writer_opts(ctx, %{}))

      # Another batch's claim, placed after the Writer's boot clear.
      assert {["act_in_flight"], []} =
               InFlightActions.claim(["act_in_flight"], ctx.in_flight_actions)

      tasks =
        run_concurrent_calls(writer_name, writer_pid, [
          [seeded],
          [fresh]
        ])

      assert [in_flight_reply, fresh_reply] = Enum.map(tasks, &Task.await(&1, 2_000))

      assert {:ok, {0, 0}, []} = in_flight_reply
      assert {:ok, {1, 1}, []} = fresh_reply

      # The in-flight copy wrote nothing and its marker belongs to the
      # batch that claimed it, so it survives this flush.
      assert [:not_found] =
               RocksDB.multi_get(RocksDB.cf_action_dedup(ctx.rocks_name), ["act_in_flight"],
                 name: ctx.rocks_name
               )

      assert RocksDB.get_max_gsn(ctx.rocks_name) == 1
      assert [%{"id" => "act_fresh"}] = ActionLog.read(1, 1, rocks_name: ctx.rocks_name)

      # The seeded claim still owns the id; this flush never released it.
      assert InFlightActions.size(ctx.in_flight_actions) == 1

      assert {[], ["act_in_flight"]} =
               InFlightActions.claim(["act_in_flight"], ctx.in_flight_actions)
    end
  end

  describe "markers span the commit window" do
    test "the set holds exactly the claimed ids until the ack, then empties", ctx do
      test_pid = self()
      commit_fn = blocking_commit_fn(test_pid)

      %{name: writer_name} = start_writer(writer_opts(ctx, %{commit_fn: commit_fn}))

      actions = [
        validated_action(%{id: "act_a"}),
        validated_action(%{id: "act_b"})
      ]

      task = Task.async(fn -> Writer.write_actions(actions, writer_name) end)

      assert_receive {:commit_started, committer_pid}, 2_000

      assert {[], ["act_a", "act_b"]} =
               InFlightActions.claim(["act_a", "act_b"], ctx.in_flight_actions)

      assert InFlightActions.size(ctx.in_flight_actions) == 2
      refute Task.yield(task, 100)

      send(committer_pid, :release)
      assert {:ok, {1, 2}, []} = Task.await(task, 2_000)
      assert InFlightActions.size(ctx.in_flight_actions) == 0
    end
  end

  describe "abandon paths release the markers" do
    test "a failed commit releases them so the retry claims a fresh GSN", ctx do
      attempts = :atomics.new(1, signed: false)

      commit_fn = fn ops, opts ->
        if :atomics.add_get(attempts, 1, 1) == 1 do
          {:error, :injected_rocksdb_failure}
        else
          RocksDB.write_batch(ops, opts)
        end
      end

      %{name: writer_name} = start_writer(writer_opts(ctx, %{commit_fn: commit_fn}))

      action = validated_action(%{id: "act_retry"})

      assert {:error, {:rocksdb_write_failed, :injected_rocksdb_failure}} =
               Writer.write_actions([action], writer_name)

      assert InFlightActions.size(ctx.in_flight_actions) == 0

      assert {:ok, {2, 2}, []} = Writer.write_actions([action], writer_name)
      assert InFlightActions.size(ctx.in_flight_actions) == 0

      assert [%{"id" => "act_retry", "gsn" => 2}] =
               ActionLog.read(2, 2, rocks_name: ctx.rocks_name)
    end

    test "a raising commit releases them", ctx do
      commit_fn = fn _ops, _opts -> raise "commit boom" end

      %{name: writer_name, pid: writer_pid} =
        start_writer(writer_opts(ctx, %{commit_fn: commit_fn}))

      Process.unlink(writer_pid)

      catch_exit(Writer.write_actions([validated_action(%{id: "act_raise"})], writer_name))

      assert InFlightActions.size(ctx.in_flight_actions) == 0
    end
  end

  describe "concurrent planners" do
    test "two flushes race one action id: exactly one claims a GSN", ctx do
      test_pid = self()
      commit_fn = blocking_commit_fn(test_pid)

      %{name: owner_name} = start_writer(writer_opts(ctx, %{commit_fn: commit_fn}))
      # V0 runs one Writer; the second planner stands in for the concurrent
      # sub-batches of #536 so the guard is exercised against a real race
      # between two `plan/2` calls, not only a seeded marker.
      %{name: late_name} = start_writer(writer_opts(ctx, %{}))

      action = validated_action(%{id: "act_race"})
      owner = Task.async(fn -> Writer.write_actions([action], owner_name) end)

      assert_receive {:commit_started, committer_pid}, 2_000
      assert InFlightActions.size(ctx.in_flight_actions) == 1

      assert {:ok, {0, 0}, []} = Writer.write_actions([action], late_name)
      assert InFlightActions.size(ctx.in_flight_actions) == 1

      send(committer_pid, :release)
      assert {:ok, {1, 1}, []} = Task.await(owner, 2_000)

      assert InFlightActions.size(ctx.in_flight_actions) == 0
      assert :atomics.get(ctx.gsn_counter, 1) == 1
      assert RocksDB.get_max_gsn(ctx.rocks_name) == 1

      assert [%{"id" => "act_race", "gsn" => 1}] =
               ActionLog.read(1, 1, rocks_name: ctx.rocks_name)

      # A later retry sees the durable marker, not just the guard.
      assert {:ok, {0, 0}, []} = Writer.write_actions([action], late_name)
      assert RocksDB.get_max_gsn(ctx.rocks_name) == 1
    end
  end

  describe "startup clear" do
    test "a replacement Writer clears the markers a killed Writer left behind", ctx do
      test_pid = self()
      commit_fn = blocking_commit_fn(test_pid)

      %{name: writer_name, pid: writer_pid} =
        start_writer(writer_opts(ctx, %{commit_fn: commit_fn}))

      Process.unlink(writer_pid)

      action = validated_action(%{id: "act_orphaned"})

      spawn(fn ->
        send(test_pid, {:write_result, catch_exit(Writer.write_actions([action], writer_name))})
      end)

      assert_receive {:commit_started, _committer_pid}, 2_000
      assert InFlightActions.size(ctx.in_flight_actions) == 1

      Process.exit(writer_pid, :kill)
      assert_receive {:write_result, _exit}, 2_000

      # No commit is in flight at boot, so the replacement clears the set.
      %{name: restarted_name} = start_writer(writer_opts(ctx, %{}))
      assert InFlightActions.size(ctx.in_flight_actions) == 0

      # The abandoned GSN 1 is resolved on init and never reused.
      assert {:ok, {2, 2}, []} = Writer.write_actions([action], restarted_name)
    end
  end

  describe "bounded by pipeline depth" do
    test "sequential and overlapping writes leave the set empty", ctx do
      %{name: writer_name} = start_writer(writer_opts(ctx, %{}))

      actions = for i <- 1..8, do: validated_action(%{id: "act_#{i}"})

      for round <- 1..12 do
        batch = Enum.take(actions, rem(round, 8) + 1)
        assert {:ok, _range, []} = Writer.write_actions(batch, writer_name)
        assert InFlightActions.size(ctx.in_flight_actions) == 0
      end
    end
  end

  describe "randomized concurrent submits" do
    test "every retry is a success and no id is logged twice", ctx do
      :rand.seed(:exsss, {11, 22, 33})

      %{name: writer_name} = start_writer(writer_opts(ctx, %{}))

      pool = for i <- 1..6, do: "act_pool_#{i}"
      actions = Map.new(pool, &{&1, validated_action(%{id: &1})})

      for _round <- 1..15 do
        callers = Enum.random(4..8)

        tasks =
          for _ <- 1..callers do
            subset = pool |> Enum.shuffle() |> Enum.take(Enum.random(1..3))

            Task.async(fn ->
              Writer.write_actions(Enum.map(subset, &Map.fetch!(actions, &1)), writer_name)
            end)
          end

        for task <- tasks do
          assert {:ok, _range, []} = Task.await(task, 5_000)
        end

        assert InFlightActions.size(ctx.in_flight_actions) == 0
      end

      logged = ActionLog.read(1, RocksDB.get_max_gsn(ctx.rocks_name), rocks_name: ctx.rocks_name)
      logged_ids = Enum.map(logged, & &1["id"])

      assert Enum.uniq(logged_ids) == logged_ids

      assert Enum.all?(
               RocksDB.multi_get(RocksDB.cf_action_dedup(ctx.rocks_name), pool,
                 name: ctx.rocks_name
               ),
               &match?({:ok, _gsn}, &1)
             )
    end
  end

  # Runs in the Committer; the test releases it by sending `:release`.
  defp blocking_commit_fn(test_pid) do
    fn ops, opts ->
      send(test_pid, {:commit_started, self()})

      receive do
        :release -> RocksDB.write_batch(ops, opts)
      end
    end
  end

  defp run_concurrent_calls(writer_name, writer_pid, action_groups) do
    :ok = :sys.suspend(writer_name)

    tasks =
      Enum.map(action_groups, fn actions ->
        Task.async(fn -> Writer.write_actions(actions, writer_name) end)
      end)

    assert wait_until(fn -> queue_len(writer_pid) >= length(action_groups) end)

    :ok = :sys.resume(writer_name)
    tasks
  end
end
