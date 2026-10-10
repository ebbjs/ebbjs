defmodule EbbServer.Storage.WriterCoalescingTest do
  @moduledoc """
  Batch coalescing tests for the Writer (ebbjs/ebbjs#332).

  Concurrent `write_actions/2` callers that arrive in the same mailbox
  burst are coalesced into a single commit: one GSN range, one
  `write_batch`, one fan-out notification, and a contiguous per-caller
  sub-range reply.
  """

  use ExUnit.Case, async: false

  alias EbbServer.Storage.{DirtyTracker, RocksDB, Writer}

  import EbbServer.TestHelpers

  setup do
    cache = start_isolated_cache()
    %{name: rocks_name} = start_rocks()

    Map.put(cache, :rocks_name, rocks_name)
  end

  describe "batch coalescing (#332)" do
    test "N concurrent calls coalesce into one committed range", ctx do
      router = register_router()
      test_pid = self()
      n = 4

      writer =
        start_writer(
          writer_opts(ctx, %{commit_fn: blocking_commit_fn(test_pid), fan_out_router: router})
        )

      actions = for i <- 1..n, do: validated_action(%{id: "act_#{i}"})
      tasks = run_concurrent_calls(writer, Enum.map(actions, &[&1]))

      assert_receive {:commit_started, _ops}, 2_000
      send(writer.pid, :release)

      results = Enum.map(tasks, &Task.await(&1, 2_000))

      assert Enum.sort(Enum.map(results, &elem(&1, 1))) == Enum.map(1..n, &{&1, &1})

      assert_receive {:batch_committed, 1, ^n, groups}
      assert map_size(groups) == n
      refute_receive {:batch_committed, _, _, _}, 200
    end

    test "callers with multiple actions each get contiguous sub-ranges", ctx do
      router = register_router()
      test_pid = self()

      writer =
        start_writer(
          writer_opts(ctx, %{commit_fn: blocking_commit_fn(test_pid), fan_out_router: router})
        )

      action_groups =
        for c <- 1..3 do
          for k <- 1..2, do: validated_action(%{id: "act_#{c}_#{k}"})
        end

      tasks = run_concurrent_calls(writer, action_groups)

      assert_receive {:commit_started, _ops}, 2_000
      send(writer.pid, :release)

      results = Enum.map(tasks, &Task.await(&1, 2_000))
      assert Enum.sort(Enum.map(results, &elem(&1, 1))) == [{1, 2}, {3, 4}, {5, 6}]

      assert_receive {:batch_committed, 1, 6, groups}
      assert map_size(groups) == 6
    end

    test "callers with only empty or committed actions reply {0,0} while others get ranges",
         ctx do
      seed_writer = start_writer(writer_opts(ctx, %{}))

      committed = validated_action(%{id: "act_committed"})
      assert {:ok, {1, 1}, []} = Writer.write_actions([committed], seed_writer.name)

      router = register_router()
      test_pid = self()

      writer =
        start_writer(
          writer_opts(ctx, %{commit_fn: blocking_commit_fn(test_pid), fan_out_router: router})
        )

      action_groups = [
        [validated_action(%{id: "act_fresh_a"}), validated_action(%{id: "act_fresh_b"})],
        [validated_action(%{id: "act_empty", updates: []})],
        [committed]
      ]

      tasks = run_concurrent_calls(writer, action_groups)

      assert_receive {:commit_started, _ops}, 2_000
      send(writer.pid, :release)

      results = Enum.map(tasks, &Task.await(&1, 2_000))
      assert Enum.sort(Enum.map(results, &elem(&1, 1))) == [{0, 0}, {0, 0}, {2, 3}]

      assert_receive {:batch_committed, 2, 3, _groups}
    end

    test "a duplicate action_id across concurrent callers claims one GSN and both succeed", ctx do
      router = register_router()
      test_pid = self()

      writer =
        start_writer(
          writer_opts(ctx, %{commit_fn: blocking_commit_fn(test_pid), fan_out_router: router})
        )

      action = validated_action(%{id: "act_dup"})
      tasks = run_concurrent_calls(writer, [[action], [action]])

      assert_receive {:commit_started, _ops}, 2_000
      send(writer.pid, :release)

      results = Enum.map(tasks, &Task.await(&1, 2_000))
      assert Enum.sort(Enum.map(results, &elem(&1, 1))) == [{0, 0}, {1, 1}]

      assert RocksDB.get_max_gsn(ctx.rocks_name) == 1
      assert_receive {:batch_committed, 1, 1, _groups}
      refute_receive {:batch_committed, _, _, _}, 200
    end

    test "a coalesced commit failure acks every caller with rocksdb_write_failed and leaves no marks",
         ctx do
      router = register_router()
      n = 3

      writer =
        start_writer(
          writer_opts(ctx, %{
            commit_fn: fn _ops, _opts -> {:error, :injected_rocksdb_failure} end,
            fan_out_router: router
          })
        )

      actions =
        for i <- 1..n do
          validated_action(%{
            id: "act_fail_#{i}",
            updates: [validated_update(%{subject_id: "todo_fail_#{i}"})]
          })
        end

      tasks = run_concurrent_calls(writer, Enum.map(actions, &[&1]))
      results = Enum.map(tasks, &Task.await(&1, 2_000))

      assert Enum.all?(
               results,
               &match?({:error, {:rocksdb_write_failed, :injected_rocksdb_failure}}, &1)
             )

      for i <- 1..n do
        refute DirtyTracker.dirty?("todo_fail_#{i}", ctx.dirty_set)
      end

      assert_receive {:range_resolved, 1, ^n}
      refute_receive {:batch_committed, _, _, _}, 200
    end

    test "a post-commit cache failure replies every caller before escalating", ctx do
      router = register_router()
      n = 2

      writer =
        start_writer(
          writer_opts(ctx, %{
            entity_types: :ebb_332_missing_table,
            fan_out_router: router
          })
        )

      actions =
        for i <- 1..n do
          validated_action(%{
            id: "act_esc_#{i}",
            updates: [validated_update(%{subject_id: "todo_esc_#{i}"})]
          })
        end

      results =
        writer
        |> run_concurrent_calls(Enum.map(actions, &[&1]))
        |> Enum.map(&Task.await(&1, 2_000))

      # The batch is durable, so every caller gets its success sub-range even
      # though the cache update blows up and terminates SystemCache.
      assert Enum.sort(Enum.map(results, &elem(&1, 1))) == [{1, 1}, {2, 2}]
      assert Enum.all?(results, &match?({:ok, _range, []}, &1))
    end

    test "batch_max_size forces a flush at the cap", ctx do
      router = register_router()

      writer = start_writer(writer_opts(ctx, %{fan_out_router: router, batch_max_size: 2}))

      actions = for i <- 1..3, do: validated_action(%{id: "act_cap_#{i}"})
      tasks = run_concurrent_calls(writer, Enum.map(actions, &[&1]))

      results = Enum.map(tasks, &Task.await(&1, 2_000))
      assert Enum.sort(Enum.map(results, &elem(&1, 1))) == [{1, 1}, {2, 2}, {3, 3}]

      assert_receive {:batch_committed, 1, 2, _groups}
      assert_receive {:batch_committed, 3, 3, _groups}
      refute_receive {:batch_committed, _, _, _}, 200
    end

    test "batch_timeout_ms > 0 defers the flush to the send_after timer", ctx do
      writer = start_writer(writer_opts(ctx, %{batch_timeout_ms: 200}))

      task =
        Task.async(fn ->
          Writer.write_actions([validated_action(%{id: "act_timer"})], writer.name)
        end)

      assert wait_until(fn ->
               match?(%{flush_timer: ref} when not is_nil(ref), :sys.get_state(writer.pid))
             end)

      # A burst-drain marker would have replied already; the timer holds it.
      assert Task.yield(task, 50) == nil
      assert {:ok, {1, 1}, []} = Task.await(task, 2_000)
    end

    test "write_actions([]) still replies {0,0} without claiming a GSN", ctx do
      writer = start_writer(writer_opts(ctx, %{}))

      assert {:ok, {0, 0}, []} = Writer.write_actions([], writer.name)
      assert :atomics.get(ctx.gsn_counter, 1) == 0
    end
  end

  defp register_router do
    name = :"coalescing_router_#{System.unique_integer([:positive])}"
    true = Process.register(self(), name)
    name
  end

  defp blocking_commit_fn(test_pid) do
    fn ops, opts ->
      send(test_pid, {:commit_started, length(ops)})

      receive do
        :release -> RocksDB.write_batch(ops, opts)
      end
    end
  end

  defp run_concurrent_calls(writer, action_groups) do
    :ok = :sys.suspend(writer.name)

    tasks =
      Enum.map(action_groups, fn actions ->
        Task.async(fn -> Writer.write_actions(actions, writer.name) end)
      end)

    assert wait_until(fn -> queue_len(writer.pid) >= length(action_groups) end),
           "expected all #{length(action_groups)} calls to reach the suspended Writer's mailbox"

    :ok = :sys.resume(writer.name)
    tasks
  end
end
