defmodule EbbServer.Storage.WriterClaimOrderTest do
  @moduledoc """
  Ordered apply and notify through the Writer's reorder buffer
  (ebbjs/ebbjs#534).

  A Committer ack may arrive for a later claim first, but the Writer only
  releases the committed prefix, so fan-out never sees a successor before
  its predecessor. The buffer is observable as the `in_flight_batches` and
  `oldest_unreleased_gsn` gauges, and `:writer_max_in_flight` sizes the
  pipeline for deployments that want overlapping commits.
  """

  use ExUnit.Case, async: false

  alias EbbServer.Storage.{CommitPipeline, RocksDB, WatermarkTracker, Writer}

  import EbbServer.TestHelpers

  @pipeline_events [
    [:ebb, :writer, :in_flight_batches],
    [:ebb, :writer, :oldest_unreleased_gsn]
  ]

  setup do
    cache = start_isolated_cache()
    %{name: rocks_name} = start_rocks()

    Map.put(cache, :rocks_name, rocks_name)
  end

  describe "out-of-order commit acks" do
    test "acks out of order still notify in claim order", ctx do
      router = register_router()
      test_pid = self()

      %{name: writer_name} =
        start_writer(depth_writer_opts(ctx, router, blocking_commit_fn(test_pid)))

      first_task =
        Task.async(fn ->
          Writer.write_actions([validated_action(%{id: "act_order_first"})], writer_name)
        end)

      assert_receive {:commit_started, first_worker}, 2_000

      second_task =
        Task.async(fn ->
          Writer.write_actions([validated_action(%{id: "act_order_second"})], writer_name)
        end)

      assert_receive {:commit_started, second_worker}, 2_000
      assert first_worker != second_worker

      # The successor is durable first but has to wait behind the held head.
      send(second_worker, :release)

      assert wait_until(fn -> phases(writer_name) == [:committing, :committed] end),
             "expected the successor to commit while its predecessor is still in flight"

      pipeline = pipeline(writer_name)
      assert [%{phase: :committing}, %{phase: :committed}] = CommitPipeline.open_batches(pipeline)
      assert CommitPipeline.releasable(pipeline) == []

      refute_receive {:batch_committed, _, _, _, _, _}, 200

      send(first_worker, :release)

      assert {:ok, {1, 1}, []} = Task.await(first_task, 2_000)
      assert {:ok, {2, 2}, []} = Task.await(second_task, 2_000)

      assert_receive {:batch_committed, 1, 1, _groups, _committed_at, _payloads}, 2_000
      assert_receive {:batch_committed, 2, 2, _groups, _committed_at, _payloads}, 2_000

      assert WatermarkTracker.committed_watermark(ctx.watermark_tracker) == 2
      assert wait_until(fn -> pipeline_empty?(writer_name) end)
    end
  end

  describe "abandoned head" do
    test "an abandoned head releases the committed successor in order", ctx do
      router = register_router()
      test_pid = self()

      %{name: writer_name} =
        start_writer(depth_writer_opts(ctx, router, failing_head_commit_fn(test_pid)))

      first_task =
        Task.async(fn ->
          Writer.write_actions([validated_action(%{id: "act_abandon_head"})], writer_name)
        end)

      assert_receive {:commit_started, first_worker}, 2_000

      second_task =
        Task.async(fn ->
          Writer.write_actions([validated_action(%{id: "act_abandon_successor"})], writer_name)
        end)

      assert_receive {:commit_started, second_worker}, 2_000
      assert first_worker != second_worker

      send(first_worker, :release)

      assert {:error, {:rocksdb_write_failed, :injected}} = Task.await(first_task, 2_000)

      # The hole is resolved and nudged to the router before the successor,
      # which is still committing, may be notified.
      assert_receive {:range_resolved, 1, 1}, 2_000
      refute_receive {:batch_committed, 2, 2, _, _, _}, 200

      send(second_worker, :release)

      assert {:ok, {2, 2}, []} = Task.await(second_task, 2_000)
      assert_receive {:batch_committed, 2, 2, _groups, _committed_at, _payloads}, 2_000

      assert WatermarkTracker.committed_watermark(ctx.watermark_tracker) == 2
      assert RocksDB.get_max_gsn(ctx.rocks_name) == 2
    end
  end

  describe "pipeline gauges" do
    test "the reorder buffer is visible as telemetry", ctx do
      ref = attach_telemetry(@pipeline_events)
      router = register_router()
      test_pid = self()

      %{name: writer_name} =
        start_writer(depth_writer_opts(ctx, router, blocking_commit_fn(test_pid)))

      first_task =
        Task.async(fn ->
          Writer.write_actions([validated_action(%{id: "act_gauge_first"})], writer_name)
        end)

      assert_receive {:commit_started, first_worker}, 2_000

      second_task =
        Task.async(fn ->
          Writer.write_actions([validated_action(%{id: "act_gauge_second"})], writer_name)
        end)

      assert_receive {:commit_started, second_worker}, 2_000

      send(second_worker, :release)
      assert wait_until(fn -> phases(writer_name) == [:committing, :committed] end)

      send(first_worker, :release)

      assert {:ok, {1, 1}, []} = Task.await(first_task, 2_000)
      assert {:ok, {2, 2}, []} = Task.await(second_task, 2_000)

      series =
        ref
        |> telemetry_events()
        |> Enum.flat_map(fn
          {[:ebb, :writer, :in_flight_batches], measurements, _metadata} ->
            [{:in_flight_batches, measurements}]

          {[:ebb, :writer, :oldest_unreleased_gsn], measurements, _metadata} ->
            [{:oldest_unreleased_gsn, measurements}]

          _ ->
            []
        end)

      assert series == [
               {:in_flight_batches, %{count: 1}},
               {:oldest_unreleased_gsn, %{gsn: 1}},
               {:in_flight_batches, %{count: 2}},
               {:oldest_unreleased_gsn, %{gsn: 1}},
               {:in_flight_batches, %{count: 1}},
               {:oldest_unreleased_gsn, %{gsn: 2}},
               {:in_flight_batches, %{count: 0}},
               {:oldest_unreleased_gsn, %{gsn: 0}}
             ]
    end
  end

  describe "pipeline depth configuration" do
    test ":writer_max_in_flight sets the pipeline depth", ctx do
      previous = Application.get_env(:ebb_server, :writer_max_in_flight)

      on_exit(fn ->
        if previous == nil do
          Application.delete_env(:ebb_server, :writer_max_in_flight)
        else
          Application.put_env(:ebb_server, :writer_max_in_flight, previous)
        end
      end)

      Application.put_env(:ebb_server, :writer_max_in_flight, 2)

      %{name: writer_name} = start_writer(writer_opts(ctx, %{}))
      assert :sys.get_state(writer_name).pipeline.max_in_flight == 2

      %{name: explicit_name} = start_writer(writer_opts(ctx, %{max_in_flight: 3}))
      assert :sys.get_state(explicit_name).pipeline.max_in_flight == 3
    end

    test ":writer_max_in_flight outside 1..4 raises at boot", ctx do
      previous = Application.get_env(:ebb_server, :writer_max_in_flight)

      on_exit(fn ->
        if previous == nil do
          Application.delete_env(:ebb_server, :writer_max_in_flight)
        else
          Application.put_env(:ebb_server, :writer_max_in_flight, previous)
        end
      end)

      Application.put_env(:ebb_server, :writer_max_in_flight, 5)

      name = :"invalid_depth_#{System.unique_integer([:positive])}"
      Process.flag(:trap_exit, true)

      assert {:error, {%ArgumentError{message: message}, _stacktrace}} =
               Writer.start_link(Map.to_list(writer_opts(ctx, %{})) ++ [name: name])

      assert message =~ "must be an integer in 1..4"
    end
  end

  defp depth_writer_opts(ctx, router, commit_fn) do
    writer_opts(ctx, %{
      max_in_flight: 2,
      committer_pool_size: 2,
      batch_max_size: 1,
      fan_out_router: router,
      commit_fn: commit_fn
    })
  end

  defp pipeline(writer_name), do: :sys.get_state(writer_name).pipeline

  defp phases(writer_name) do
    writer_name |> pipeline() |> CommitPipeline.open_batches() |> Enum.map(& &1.phase)
  end

  defp pipeline_empty?(writer_name) do
    pipeline = pipeline(writer_name)
    pipeline.claim_order == [] and pipeline.batches == %{}
  end

  # Runs in the Committer, so naming the worker lets the test release the
  # later claim first.
  defp blocking_commit_fn(test_pid) do
    fn ops, opts ->
      send(test_pid, {:commit_started, self()})

      receive do
        :release -> RocksDB.write_batch(ops, opts)
      end
    end
  end

  defp failing_head_commit_fn(test_pid) do
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

  defp register_router do
    name = :"claim_order_router_#{System.unique_integer([:positive])}"
    true = Process.register(self(), name)
    name
  end
end
