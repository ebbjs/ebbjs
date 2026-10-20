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

  alias EbbServer.Storage.{ActionFormat, RocksDB, Writer}

  import EbbServer.TestHelpers

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

      prepare_fn = fn _input ->
        send(test_pid, {:preparing, self()})

        receive do
          {:release, etf} -> etf
        end
      end

      writer =
        start_writer(
          writer_opts(ctx, %{
            prepare_fn: prepare_fn,
            prepare_pool_size: 1
          })
        )

      task = Task.async(fn -> Writer.write_actions([action], writer.name) end)

      assert_receive {:preparing, worker}, 2_000

      # If build/encode still ran on the Writer's call path this sys call
      # would not return until the worker was released.
      assert is_pid(:sys.get_state(writer.pid, 500).prepare_pool)

      send(worker, {:release, expected_etf})

      assert {:ok, {1, 1}, []} = Task.await(task, 2_000)
      assert persisted_payload(ctx.rocks_name, 1)["id"] == "act_prepare"
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

      writer =
        start_writer(
          writer_opts(ctx, %{
            prepare_fn: prepare_fn,
            prepare_pool_size: 2
          })
        )

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

      assert {:ok, {1, 1}, []} = Task.await(first, 2_000)
      assert {:ok, {2, 2}, []} = Task.await(second, 2_000)
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

      writer =
        start_writer(
          writer_opts(ctx, %{
            prepare_fn: prepare_fn,
            prepare_pool_size: 2,
            prepare_timeout_ms: 50
          })
        )

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
      assert {:ok, {1, 1}, []} = Task.await(next, 2_000)
      assert persisted_payload(ctx.rocks_name, 1)["id"] == "act_next"

      # The stuck worker's late result must not claim the timed-out call.
      Process.sleep(600)
      assert RocksDB.get_max_gsn(ctx.rocks_name) == 1
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

      writer =
        start_writer(
          writer_opts(ctx, %{
            prepare_fn: prepare_fn,
            prepare_pool_size: 1,
            prepare_timeout_ms: 50
          })
        )

      hung =
        Task.async(fn ->
          Writer.write_actions([validated_action(%{id: "act_hang"})], writer.name)
        end)

      assert_receive {:hang_started, worker}, 2_000
      assert {:error, {:prepare_failed, {:timeout, 50}}} = Task.await(hung, 2_000)

      # The wedged worker must not permanently consume the only pool slot.
      assert wait_until(fn -> not Process.alive?(worker) end)

      assert {:ok, {1, 1}, []} =
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

      writer =
        start_writer(
          writer_opts(ctx, %{
            prepare_fn: prepare_fn,
            prepare_pool_size: 1
          })
        )

      crashed =
        Task.async(fn ->
          Writer.write_actions([validated_action(%{id: "act_crash"})], writer.name)
        end)

      assert_receive {:crash_worker, worker}, 2_000
      Process.exit(worker, :kill)

      assert {:error, {:prepare_failed, {:crashed, :killed}}} = Task.await(crashed, 2_000)

      assert {:ok, {1, 1}, []} =
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

      writer =
        start_writer(
          writer_opts(ctx, %{
            prepare_fn: prepare_fn,
            prepare_pool_size: 1,
            prepare_queue_max: 1
          })
        )

      blocked =
        Task.async(fn ->
          Writer.write_actions([validated_action(%{id: "act_blocked"})], writer.name)
        end)

      assert_receive {:blocked_prepare, worker}, 2_000

      assert {:error, {:prepare_queue_full, 1}} =
               Writer.write_actions([validated_action(%{id: "act_rejected"})], writer.name)

      send(worker, :release)

      assert {:ok, {1, 1}, []} = Task.await(blocked, 2_000)

      assert {:ok, {2, 2}, []} =
               Writer.write_actions([validated_action(%{id: "act_after_full"})], writer.name)
    end
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
