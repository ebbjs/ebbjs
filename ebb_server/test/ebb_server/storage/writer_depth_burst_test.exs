defmodule EbbServer.Storage.WriterDepthBurstTest do
  @moduledoc """
  The depth>1 free-slot flush and the burst it must not discard
  (ebbjs/ebbjs#660, pinning the fix for ebbjs/ebbjs#570).

  `advance_pipeline/1` runs once a commit ack resolves the head range. When
  the ack also drops the pipeline below `:writer_max_in_flight` while a
  burst of at least `:writer_batch_max_size` Actions is already waiting,
  that ack is the only event that can flush it. #570 fixed a state discard
  that let the flush claim a GSN range and then throw the claim away: the
  callers never got a reply and their GSNs were spent without a
  `cf_actions` record.

  The shape below reproduces it deterministically: two held commits fill
  the pipeline, a cap-sized burst spread across two callers waits behind
  them, and only releasing the head may start the third commit. The
  assertions cover the whole claimed range, not just the caller-visible
  replies, so a hole fails even when every caller still returns; an extra
  claim shows up in the GSN counter and max-GSN asserts.
  """

  use ExUnit.Case, async: false

  alias EbbServer.Storage.{CommitPipeline, RocksDB, WatermarkTracker, Writer}

  import EbbServer.TestHelpers

  setup do
    cache = start_isolated_cache()
    %{name: rocks_name} = start_rocks()

    Map.put(cache, :rocks_name, rocks_name)
  end

  test "an ack-freed slot flushes a cap-sized burst into its own commit", ctx do
    router = register_router()
    test_pid = self()
    commit_fn = holding_commit_fn(test_pid, 2)

    %{name: writer_name} =
      start_writer(
        writer_opts(ctx, %{
          max_in_flight: 2,
          committer_pool_size: 2,
          batch_max_size: 3,
          fan_out_router: router,
          commit_fn: commit_fn
        })
      )

    # The head is cap-sized on its own, so it flushes as one held range.
    head = Task.async(fn -> write_actions(writer_name, 3, "head") end)
    assert_receive {:commit_started, 1, head_worker}, 2_000

    # The successor fills the second slot and is held too, so the burst
    # below has nowhere to go until an ack frees a slot.
    successor = Task.async(fn -> write_actions(writer_name, 3, "successor") end)
    assert_receive {:commit_started, 2, successor_worker}, 2_000
    assert head_worker != successor_worker

    # Exactly one cap-sized burst across two callers. The pipeline is at
    # capacity, so neither caller may be claimed until an ack frees a slot.
    # Start them one at a time so the sub-range each caller receives is
    # determined by arrival order, not by task scheduling.
    burst_a = Task.async(fn -> write_actions(writer_name, 2, "burst_a") end)
    assert wait_until(fn -> pending_count(writer_name) == 2 end)

    burst_b = Task.async(fn -> write_actions(writer_name, 1, "burst_b") end)
    assert wait_until(fn -> pending_count(writer_name) == 3 end)
    assert phases(writer_name) == [:committing, :committing]

    send(head_worker, :release)

    assert {:ok, {1, 3}, []} = Task.await(head, 2_000)

    # The ack-freed slot must flush the waiting burst. Before #570 the
    # flush claimed 7..9 and its state was then discarded, leaving the
    # pending burst stranded in the pipeline. The flush happens inside the
    # ack, so a short window is enough; a longer one would let the stranded
    # callers' own call timeouts mask which assertion failed.
    assert wait_until(fn -> pending_count(writer_name) == 0 end, 100),
           "the ack-freed slot left the pending burst unflushed"

    assert_receive {:commit_started, 3, _burst_worker}, 2_000

    send(successor_worker, :release)

    assert {:ok, {4, 6}, []} = Task.await(successor, 2_000)
    assert {:ok, {7, 8}, []} = Task.await(burst_a, 2_000)
    assert {:ok, {9, 9}, []} = Task.await(burst_b, 2_000)

    assert_receive {:batch_committed, 1, 3, _groups, _committed_at, _payloads}, 2_000
    assert_receive {:batch_committed, 4, 6, _groups, _committed_at, _payloads}, 2_000
    assert_receive {:batch_committed, 7, 9, _groups, _committed_at, _payloads}, 2_000

    # Every claimed GSN is durable exactly once: a discarded claim would
    # show up here as a hole even if the callers had been answered.
    assert persisted_gsns(ctx.rocks_name) == Enum.to_list(1..9)
    assert RocksDB.get_max_gsn(ctx.rocks_name) == 9
    assert :atomics.get(ctx.gsn_counter, 1) == 9
    assert WatermarkTracker.committed_watermark(ctx.watermark_tracker) == 9
    assert wait_until(fn -> pipeline_empty?(writer_name) end)
  end

  defp write_actions(writer_name, count, id_prefix) do
    actions =
      for index <- 1..count do
        validated_action(%{id: "#{id_prefix}_#{index}"})
      end

    Writer.write_actions(actions, writer_name)
  end

  # Holds the first `held` commits so the test controls when a slot frees;
  # later ranges write straight through.
  defp holding_commit_fn(test_pid, held) do
    attempts = :atomics.new(1, signed: false)

    fn ops, opts ->
      attempt = :atomics.add_get(attempts, 1, 1)
      send(test_pid, {:commit_started, attempt, self()})

      if attempt <= held do
        receive do
          :release -> RocksDB.write_batch(ops, opts)
        end
      else
        RocksDB.write_batch(ops, opts)
      end
    end
  end

  defp pending_count(writer_name), do: writer_name |> pipeline() |> CommitPipeline.pending_count()

  defp phases(writer_name) do
    writer_name |> pipeline() |> CommitPipeline.open_batches() |> Enum.map(& &1.phase)
  end

  defp pipeline_empty?(writer_name) do
    pipeline = pipeline(writer_name)
    pipeline.claim_order == [] and pipeline.batches == %{}
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

  defp register_router do
    name = :"depth_burst_router_#{System.unique_integer([:positive])}"
    true = Process.register(self(), name)
    name
  end
end
