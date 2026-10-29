defmodule EbbServer.Sync.FanOutRouterCarriedPayloadTest do
  @moduledoc """
  #584: live fan-out decodes the payloads carried by the Writer's commit
  notification instead of re-reading `cf_actions`.

  Recovery still replays the log, so these tests pin that the carried
  hand-off and `FanOutRouter.Recovery` produce the same SSE frames, and
  that carried payloads are dropped once the range is pushed or resolved.
  """

  use ExUnit.Case, async: false
  use EbbServer.Integration.StorageCase

  import ExUnit.CaptureLog
  import EbbServer.SSEHelpers, only: [data_payloads: 1, receive_sse_data: 0]
  import EbbServer.TestHelpers

  alias EbbServer.Storage.{ActionFormat, RocksDB, WatermarkTracker}
  alias EbbServer.Sync.{FanOutFrontier, FanOutRouter, SSEConnection}

  describe "live and recovery output (#584)" do
    test "the carried hand-off and Recovery's log replay emit identical per-group frames" do
      first_group = "g_584_parity_a_#{:erlang.unique_integer([:positive])}"
      second_group = "g_584_parity_b_#{:erlang.unique_integer([:positive])}"
      actor_id = "a_584_parity_#{:erlang.unique_integer([:positive])}"

      first_sse = subscribe!(first_group, actor_id)
      second_sse = subscribe!(second_group, actor_id)

      first_gsn = RocksDB.get_max_gsn() + 1
      last_gsn = first_gsn + 1

      # Two Actions in one range. The first scopes one Update to each group,
      # so the per-group split gives the first group both Actions and the
      # second group only the first.
      carried =
        [
          {first_gsn, "act_584_parity_first_#{:erlang.unique_integer([:positive])}",
           [[first_group], [second_group]]},
          {last_gsn, "act_584_parity_second_#{:erlang.unique_integer([:positive])}",
           [[first_group]]}
        ]
        |> Enum.map(fn {gsn, action_id, scopes} ->
          put_framed_action!(gsn, scopes, actor_id, action_id)
        end)

      :ok = WatermarkTracker.mark_range_committed(first_gsn, last_gsn)
      WatermarkTracker.advance_watermark()

      groups_by_gsn = %{first_gsn => [first_group, second_group], last_gsn => [first_group]}

      send(
        FanOutRouter,
        {:batch_committed, first_gsn, last_gsn, groups_by_gsn, System.monotonic_time(), carried}
      )

      live = receive_group_frames(2)
      assert map_size(live) == 2

      # Rewind the persisted frontier and let `init/1` re-derive the same
      # range through `Recovery.recover_committed/2`, which must log-read.
      :ets.delete_all_objects(:fan_out_frontier)
      :ets.insert(:fan_out_frontier, {:last_pushed_gsn, first_gsn - 1})

      :ok = terminate_router()
      {:ok, _pid} = restart_router()

      recovered = receive_group_frames(2)

      assert recovered == live

      sync_router()
      assert FanOutFrontier.get() == {:ok, last_gsn}

      :ok = FanOutRouter.unsubscribe(first_sse)
      :ok = FanOutRouter.unsubscribe(second_sse)
    end

    test "a carried count mismatch reads the log instead of shifting GSNs" do
      group_id = "g_584_mismatch_#{:erlang.unique_integer([:positive])}"
      actor_id = "a_584_mismatch_#{:erlang.unique_integer([:positive])}"

      {:ok, sse_pid} = SSEConnection.start_link(self(), [group_id], %{group_id => 0})
      :ok = FanOutRouter.subscribe([group_id], sse_pid, actor_id)

      first_gsn = RocksDB.get_max_gsn() + 1
      last_gsn = first_gsn + 1

      first_payload =
        put_framed_action!(first_gsn, [[group_id]], actor_id, "act_584_mismatch_first")

      put_framed_action!(last_gsn, [[group_id]], actor_id, "act_584_mismatch_second")

      :ok = WatermarkTracker.mark_range_committed(first_gsn, last_gsn)
      WatermarkTracker.advance_watermark()

      groups_by_gsn = Map.new(first_gsn..last_gsn, &{&1, [group_id]})

      log =
        capture_log(fn ->
          send(
            FanOutRouter,
            {:batch_committed, first_gsn, last_gsn, groups_by_gsn, System.monotonic_time(),
             [first_payload]}
          )

          bytes = receive_sse_data()
          payloads = bytes |> data_payloads() |> Enum.map(&Jason.decode!/1)
          assert Enum.map(payloads, & &1["gsn"]) == [first_gsn, last_gsn]
        end)

      assert log =~
               "fan-out range #{first_gsn}..#{last_gsn} carried 1 payloads, expected 2"

      :ok = FanOutRouter.unsubscribe(sse_pid)
    end
  end

  describe "bounded carried state (#584)" do
    test "payloads are dropped on push and resolve, and state does not grow across ranges" do
      group_id = "g_584_bounded_#{:erlang.unique_integer([:positive])}"
      watermark = WatermarkTracker.committed_watermark()
      first_gsn = watermark + 1
      second_gsn = first_gsn + 1
      third_gsn = second_gsn + 1
      last_gsn = third_gsn + 249

      first_payload = carried_payload([[group_id]], "act_584_bounded_#{first_gsn}")
      second_payload = carried_payload([[group_id]], "act_584_bounded_#{second_gsn}")

      # A range above the watermark keeps its carried payloads buffered.
      send_batch(first_gsn, first_gsn, group_id, [first_payload])

      state = :sys.get_state(FanOutRouter)
      assert state.plan.pending_notifications == [{first_gsn, first_gsn}]
      assert state.batch_meta[{first_gsn, first_gsn}].payloads == [first_payload]

      # Releasing it drops the payload with the range.
      :ok = WatermarkTracker.mark_range_committed(first_gsn, first_gsn)
      WatermarkTracker.advance_watermark()
      send_batch(first_gsn, first_gsn, group_id, [first_payload])

      state = :sys.get_state(FanOutRouter)
      assert state.plan.pending_notifications == []
      assert state.batch_meta == %{}

      # A resolved hole drops its claim and its payloads without pushing.
      send_batch(second_gsn, second_gsn, group_id, [second_payload])

      state = :sys.get_state(FanOutRouter)
      assert state.plan.pending_notifications == [{second_gsn, second_gsn}]
      assert state.batch_meta[{second_gsn, second_gsn}].payloads == [second_payload]

      send(FanOutRouter, {:range_resolved, second_gsn, second_gsn})

      state = :sys.get_state(FanOutRouter)
      assert state.plan.pending_notifications == []
      assert state.batch_meta == %{}

      :ok = WatermarkTracker.mark_range_resolved(second_gsn, second_gsn)
      :ok = WatermarkTracker.mark_range_committed(third_gsn, last_gsn)
      assert WatermarkTracker.advance_watermark() == last_gsn

      # 250 ranges is a 25 s run at n=1000, r=1000: 10 ranges/s at the
      # 100-Action batch. Every released range must leave the Router's
      # buffered state empty, so nothing can accumulate over the run.
      for gsn <- third_gsn..last_gsn do
        send_batch(gsn, gsn, group_id, [
          carried_payload([[group_id]], "act_584_bounded_#{gsn}")
        ])

        assert_released_state()
      end

      assert_released_state()
      assert FanOutFrontier.get() == {:ok, last_gsn}
    end
  end

  defp send_batch(from_gsn, to_gsn, group_id, payloads) do
    groups_by_gsn = Map.new(from_gsn..to_gsn, &{&1, [group_id]})

    send(
      FanOutRouter,
      {:batch_committed, from_gsn, to_gsn, groups_by_gsn, System.monotonic_time(), payloads}
    )
  end

  defp subscribe!(group_id, actor_id) do
    {:ok, sse_pid} = SSEConnection.start_link(self(), [group_id], %{group_id => 0})
    :ok = FanOutRouter.subscribe([group_id], sse_pid, actor_id)
    sse_pid
  end

  # One SSE chunk per group per range, delivered to this process without a
  # group tag. Keying on the Action ids inside each chunk identifies the
  # group independently of arrival order.
  defp receive_group_frames(count) do
    Enum.reduce(1..count, %{}, fn _, acc ->
      bytes = receive_sse_data()
      ids = bytes |> data_payloads() |> Enum.map(&Jason.decode!(&1)["id"])
      Map.put(acc, ids, bytes)
    end)
  end

  defp assert_released_state do
    state = :sys.get_state(FanOutRouter)
    assert state.plan.pending_notifications == []
    assert state.plan.acked == MapSet.new()
    assert state.batch_meta == %{}
    assert state.pending_groups == %{}
  end

  defp put_framed_action!(gsn, scopes, actor_id, action_id) do
    {payload_etf, scopes} = carried_payload(scopes, action_id, actor_id)

    group_ids = scopes |> List.flatten() |> Enum.uniq()

    :ok =
      RocksDB.write_batch(
        [
          {:put, RocksDB.cf_actions(), RocksDB.encode_gsn_key(gsn),
           ActionFormat.frame(payload_etf, scopes)}
        ] ++ group_index_puts(group_ids, gsn, action_id)
      )

    {payload_etf, scopes}
  end

  defp group_index_puts(group_ids, gsn, action_id) do
    Enum.map(group_ids, fn group_id ->
      {:put, RocksDB.cf_group_actions(), RocksDB.encode_group_action_key(group_id, gsn),
       action_id}
    end)
  end

  defp carried_payload(scopes, action_id, actor_id \\ "a_584") do
    hlc = generate_hlc()

    payload_etf =
      %{
        id: action_id,
        actor_id: actor_id,
        hlc: hlc,
        updates: Enum.map(scopes, &carried_update(&1, action_id, hlc))
      }
      |> ActionFormat.build()
      |> ActionFormat.encode()

    {payload_etf, scopes}
  end

  defp carried_update(group_ids, action_id, hlc) do
    update_id = "upd_#{action_id}_#{Enum.join(group_ids, "_")}"

    %{
      id: update_id,
      subject_id: "todo_#{update_id}",
      subject_type: "todo",
      method: :put,
      data: %{
        "fields" => %{
          "title" => %{"type" => "lww", "value" => update_id, "hlc" => hlc}
        }
      }
    }
  end

  defp terminate_router do
    Supervisor.terminate_child(EbbServer.Sync.Supervisor, FanOutRouter)
  end

  defp restart_router do
    Supervisor.restart_child(EbbServer.Sync.Supervisor, FanOutRouter)
  end

  defp sync_router, do: :sys.get_state(FanOutRouter)
end
