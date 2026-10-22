defmodule EbbServer.Storage.WriterPrepareStageTest do
  @moduledoc """
  The Writer's prepare stage (ebbjs/ebbjs#553).

  Payload build and ETF encode run in a linked `PreparePool`, not on the
  Writer's call path. The Writer fixes arrival order before dispatching a
  job, so a later call that prepares first must wait for every earlier
  call to resolve. A slow or dead prepare worker becomes an error reply
  for its own call; it never claims a GSN and never stalls later calls.
  """

  use ExUnit.Case, async: false

  alias EbbServer.Storage.{ActionFormat, CommitPipeline, RocksDB, Writer}

  import EbbServer.TestHelpers

  # Holds one committed range so the Writer is not idle: a prepare arriving
  # now goes to the pool. The containment tests below are about the pooled
  # path; `prepare_inline?/1` only applies to a completely idle Writer.
  defp busy_writer(ctx, prepare_opts) do
    test_pid = self()
    commits = :atomics.new(1, signed: false)

    commit_fn = fn ops, opts ->
      if :atomics.add_get(commits, 1, 1) == 1 do
        send(test_pid, {:holding_commit, self()})

        receive do
          :release_held -> RocksDB.write_batch(ops, opts)
        end
      else
        RocksDB.write_batch(ops, opts)
      end
    end

    writer =
      start_writer(
        writer_opts(
          ctx,
          Map.merge(
            %{max_in_flight: 2, committer_pool_size: 2, commit_fn: commit_fn},
            prepare_opts
          )
        )
      )

    held =
      Task.async(fn ->
        Writer.write_actions([validated_action(%{id: "act_held"})], writer.name)
      end)

    assert_receive {:holding_commit, worker}, 2_000
    {writer, %{writer: writer, worker: worker, task: held, released: false}}
  end

  # The held range is the head of claim order, so nothing behind it can be
  # released until it commits. Tests call this just before they wait on a
  # later range's reply.
  defp release_held_commit(held) do
    if Map.get(held, :released, false) do
      held
    else
      send(held.worker, :release_held)
      assert {:ok, {1, 1}, []} = Task.await(held.task, 2_000)
      Map.put(held, :released, true)
    end
  end

  setup do
    cache = start_isolated_cache()
    %{name: rocks_name} = start_rocks()
    Map.put(cache, :rocks_name, rocks_name)
  end

  describe "prepare off the call path" do
    test "the Writer stays responsive while a prepare worker is busy", ctx do
      test_pid = self()
      action = validated_action(%{id: "act_prepare"})
      expected_etf = action |> ActionFormat.build() |> ActionFormat.encode()

      prepare_fn = fn input ->
        if input.id == "act_prepare" do
          send(test_pid, {:preparing, self()})

          receive do
            {:release, etf} -> etf
          end
        else
          input |> ActionFormat.build() |> ActionFormat.encode()
        end
      end

      {writer, held} =
        busy_writer(ctx, %{prepare_fn: prepare_fn, prepare_pool_size: 1})

      task = Task.async(fn -> Writer.write_actions([action], writer.name) end)

      assert_receive {:preparing, worker}, 2_000

      # The prepare runs off the Writer's call path while the pipeline is
      # busy, so the Writer keeps answering.
      assert is_pid(:sys.get_state(writer.pid, 500).prepare.pool)

      send(worker, {:release, expected_etf})

      release_held_commit(held)

      assert {:ok, {2, 2}, []} = Task.await(task, 2_000)
      assert persisted_payload(ctx.rocks_name, 2)["id"] == "act_prepare"
    end
  end

  describe "inline prepare (#574)" do
    test "an idle Writer prepares on its own process", ctx do
      test_pid = self()
      writer_pid = :erlang.whereis(:writer_placeholder)

      prepare_fn = fn input ->
        send(test_pid, {:prepared_in, self(), input.id})
        input |> ActionFormat.build() |> ActionFormat.encode()
      end

      writer = start_writer(writer_opts(ctx, %{prepare_fn: prepare_fn}))

      assert {:ok, {1, 1}, []} =
               Writer.write_actions([validated_action(%{id: "act_idle"})], writer.name)

      assert_receive {:prepared_in, prepared_in, "act_idle"}, 2_000
      assert prepared_in == writer.pid
      refute writer.pid == writer_pid
      assert persisted_payload(ctx.rocks_name, 1)["id"] == "act_idle"
    end

    test "a slow inline prepare fails its call and claims no GSN", ctx do
      test_pid = self()

      prepare_fn = fn input ->
        if input.id == "act_slow" do
          send(test_pid, {:inline_started, self()})
          Process.sleep(120)
        end

        input |> ActionFormat.build() |> ActionFormat.encode()
      end

      writer = start_writer(writer_opts(ctx, %{prepare_fn: prepare_fn, prepare_timeout_ms: 50}))

      assert {:error, {:prepare_failed, {:timeout, 50}}} =
               Writer.write_actions([validated_action(%{id: "act_slow"})], writer.name)

      assert_receive {:inline_started, prepared_in}, 2_000
      assert prepared_in == writer.pid
      assert RocksDB.get_max_gsn(ctx.rocks_name) == 0

      # The next call still commits at the first GSN.
      assert {:ok, {1, 1}, []} =
               Writer.write_actions([validated_action(%{id: "act_after_slow"})], writer.name)
    end
  end

  describe "arrival order" do
    test "a later call does not overtake an earlier call still preparing", ctx do
      test_pid = self()

      prepare_fn = fn input ->
        if input.id == "act_first" do
          send(test_pid, {:first_started, self()})

          receive do
            :release -> :ok
          end
        end

        input |> ActionFormat.build() |> ActionFormat.encode()
      end

      {writer, held} = busy_writer(ctx, %{prepare_fn: prepare_fn, prepare_pool_size: 2})

      first =
        Task.async(fn ->
          Writer.write_actions([validated_action(%{id: "act_first"})], writer.name)
        end)

      assert_receive {:first_started, first_worker}, 2_000

      second =
        Task.async(fn ->
          Writer.write_actions([validated_action(%{id: "act_second"})], writer.name)
        end)

      # The second call is prepared by another worker and is ready first,
      # but the Writer must hold it behind the earlier call.
      refute Task.yield(second, 100)

      send(first_worker, :release)

      release_held_commit(held)

      assert {:ok, {2, 2}, []} = Task.await(first, 2_000)
      assert {:ok, {3, 3}, []} = Task.await(second, 2_000)
    end
  end

  describe "failure containment" do
    test "a stuck prepare times out and the next call still commits", ctx do
      test_pid = self()

      prepare_fn = fn input ->
        if input.id == "act_stuck" do
          send(test_pid, {:stuck_started, self()})
          Process.sleep(500)
        end

        input |> ActionFormat.build() |> ActionFormat.encode()
      end

      {writer, held} =
        busy_writer(ctx, %{prepare_fn: prepare_fn, prepare_pool_size: 2, prepare_timeout_ms: 50})

      stuck =
        Task.async(fn ->
          Writer.write_actions([validated_action(%{id: "act_stuck"})], writer.name)
        end)

      assert_receive {:stuck_started, _worker}, 2_000

      next =
        Task.async(fn ->
          Writer.write_actions([validated_action(%{id: "act_next"})], writer.name)
        end)

      assert {:error, {:prepare_failed, {:timeout, 50}}} = Task.await(stuck, 2_000)

      release_held_commit(held)

      assert {:ok, {2, 2}, []} = Task.await(next, 2_000)
      assert persisted_payload(ctx.rocks_name, 2)["id"] == "act_next"

      # The stuck worker's late result must not claim the timed-out call.
      Process.sleep(600)
      assert RocksDB.get_max_gsn(ctx.rocks_name) == 2
    end

    test "a timed-out prepare worker is retired and replaced", ctx do
      test_pid = self()

      prepare_fn = fn input ->
        if input.id == "act_hang" do
          send(test_pid, {:hang_started, self()})

          receive do
            :never -> :ok
          end
        end

        input |> ActionFormat.build() |> ActionFormat.encode()
      end

      {writer, held} =
        busy_writer(ctx, %{prepare_fn: prepare_fn, prepare_pool_size: 1, prepare_timeout_ms: 50})

      hung =
        Task.async(fn ->
          Writer.write_actions([validated_action(%{id: "act_hang"})], writer.name)
        end)

      assert_receive {:hang_started, worker}, 2_000
      assert {:error, {:prepare_failed, {:timeout, 50}}} = Task.await(hung, 2_000)

      # The wedged worker must not permanently consume the only pool slot.
      assert wait_until(fn -> not Process.alive?(worker) end)

      release_held_commit(held)

      assert {:ok, {2, 2}, []} =
               Writer.write_actions([validated_action(%{id: "act_after_hang"})], writer.name)
    end

    test "a dead prepare worker fails only its call and a replacement takes the next", ctx do
      test_pid = self()

      prepare_fn = fn input ->
        if input.id == "act_crash" do
          send(test_pid, {:crash_worker, self()})

          receive do
            :never -> :ok
          end
        end

        input |> ActionFormat.build() |> ActionFormat.encode()
      end

      {writer, held} = busy_writer(ctx, %{prepare_fn: prepare_fn, prepare_pool_size: 1})

      crashed =
        Task.async(fn ->
          Writer.write_actions([validated_action(%{id: "act_crash"})], writer.name)
        end)

      assert_receive {:crash_worker, worker}, 2_000
      Process.exit(worker, :kill)

      assert {:error, {:prepare_failed, {:crashed, :killed}}} = Task.await(crashed, 2_000)

      release_held_commit(held)

      assert {:ok, {2, 2}, []} =
               Writer.write_actions([validated_action(%{id: "act_after_crash"})], writer.name)
    end

    test "a full prepare queue rejects the call without claiming a GSN", ctx do
      test_pid = self()

      prepare_fn = fn input ->
        if input.id == "act_blocked" do
          send(test_pid, {:blocked_prepare, self()})

          receive do
            :release -> :ok
          end
        end

        input |> ActionFormat.build() |> ActionFormat.encode()
      end

      {writer, held} =
        busy_writer(ctx, %{prepare_fn: prepare_fn, prepare_pool_size: 1, prepare_queue_max: 1})

      blocked =
        Task.async(fn ->
          Writer.write_actions([validated_action(%{id: "act_blocked"})], writer.name)
        end)

      assert_receive {:blocked_prepare, worker}, 2_000

      assert {:error, {:prepare_queue_full, 1}} =
               Writer.write_actions([validated_action(%{id: "act_rejected"})], writer.name)

      send(worker, :release)

      release_held_commit(held)

      assert {:ok, {2, 2}, []} = Task.await(blocked, 2_000)

      assert {:ok, {3, 3}, []} =
               Writer.write_actions([validated_action(%{id: "act_after_full"})], writer.name)
    end
  end

  describe "burst scheduling" do
    test "a commit ack never discards the burst it frees a slot for", ctx do
      test_pid = self()
      commits = :atomics.new(1, signed: false)

      # Hold only the first commit, so the test controls the exact moment the
      # pipeline drops from full to one range with a cap-sized burst waiting.
      commit_fn = fn ops, opts ->
        if :atomics.add_get(commits, 1, 1) == 1 do
          send(test_pid, {:first_commit_started, self()})

          receive do
            :release -> RocksDB.write_batch(ops, opts)
          end
        else
          RocksDB.write_batch(ops, opts)
        end
      end

      writer =
        start_writer(
          writer_opts(ctx, %{
            max_in_flight: 2,
            committer_pool_size: 2,
            batch_max_size: 2,
            commit_fn: commit_fn
          })
        )

      # Range 1..2 reaches the held committer.
      first = Task.async(fn -> write_pair(writer.name, "act_a") end)
      assert_receive {:first_commit_started, worker}, 2_000

      # Range 3..4 fills the pipeline to max_in_flight.
      second = Task.async(fn -> write_pair(writer.name, "act_b") end)
      assert wait_until(fn -> open_batch_count(writer.name) == 2 end)

      # A third call is a complete burst on its own. The pipeline is at
      # capacity, so only the ack below can free a slot for it -- and that
      # flush must survive the ack's bookkeeping.
      third = Task.async(fn -> write_pair(writer.name, "act_c") end)
      assert wait_until(fn -> pending_count(writer.name) == 2 end)

      send(worker, :release)

      assert {:ok, {1, 2}, []} = Task.await(first, 2_000)
      assert {:ok, {3, 4}, []} = Task.await(second, 2_000)
      assert {:ok, {5, 6}, []} = Task.await(third, 2_000)

      # A discarded claim spends its GSNs without writing them: the log would
      # end at 4 with a hole where 5..6 should be.
      assert persisted_gsns(ctx.rocks_name) == Enum.to_list(1..6)
      assert RocksDB.get_max_gsn(ctx.rocks_name) == 6
    end
  end

  defp write_pair(writer_name, id_prefix) do
    actions = [
      validated_action(%{id: id_prefix <> "_1"}),
      validated_action(%{id: id_prefix <> "_2"})
    ]

    Writer.write_actions(actions, writer_name)
  end

  defp open_batch_count(writer_name) do
    writer_name |> pipeline() |> CommitPipeline.open_batches() |> length()
  end

  defp pending_count(writer_name) do
    writer_name |> pipeline() |> CommitPipeline.pending_count()
  end

  defp pipeline(writer_name), do: :sys.get_state(writer_name).pipeline

  defp persisted_gsns(rocks_name) do
    max_gsn = RocksDB.get_max_gsn(rocks_name)

    RocksDB.cf_actions(rocks_name)
    |> RocksDB.range_iterator(
      RocksDB.encode_gsn_key(1),
      RocksDB.encode_gsn_key(max_gsn + 1),
      name: rocks_name
    )
    |> Enum.map(fn {key, _value} -> RocksDB.decode_gsn_key(key) end)
  end

  defp persisted_payload(rocks_name, gsn) do
    {:ok, binary} =
      RocksDB.get(
        RocksDB.cf_actions(rocks_name),
        RocksDB.encode_gsn_key(gsn),
        name: rocks_name
      )

    {payload_etf, _scopes} = :erlang.binary_to_term(binary, [:safe])
    :erlang.binary_to_term(payload_etf, [:safe])
  end
end
