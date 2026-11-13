defmodule EbbServer.Sync.FanOutRouterClaimOrderTest do
  @moduledoc """
  #534: the Router releases committed ranges in claim order and pumps the
  persisted frontier only for what it actually pushed.

  The Writer notifies in claim order, so a range that is still buffered
  behind the watermark (or behind an unresolved hole) must never let the
  frontier — or a later range — move ahead of it. A push that happens
  before the frontier persist is re-pushed after a restart (at-least-once).
  """

  use ExUnit.Case, async: false
  use EbbServer.Integration.StorageCase

  import EbbServer.SSEHelpers
  import EbbServer.TestHelpers

  alias EbbServer.Integration.ActionHelpers
  alias EbbServer.Storage.{ActionFormat, GsnCounter, RocksDB, WatermarkTracker}
  alias EbbServer.Sync.{FanOutFrontier, FanOutRouter, SSEConnection}

  describe "claim-order release (#534)" do
    test "two committed ranges release in claim order" do
      group_id = "g_534_mixed_#{:erlang.unique_integer([:positive])}"
      actor_id = "a_534_mixed_#{:erlang.unique_integer([:positive])}"

      {:ok, sse_pid} = SSEConnection.start_link(self(), [group_id], %{group_id => 0})
      :ok = FanOutRouter.subscribe([group_id], sse_pid, actor_id)

      gsn1 = RocksDB.get_max_gsn() + 1
      gsn2 = gsn1 + 1

      first_id = "act_534_first_#{:erlang.unique_integer([:positive])}"
      second_id = "act_534_second_#{:erlang.unique_integer([:positive])}"

      {first_frame, first_payload} = framed(group_id, actor_id, first_id)
      {second_frame, second_payload} = framed(group_id, actor_id, second_id)

      :ok =
        RocksDB.write_batch([
          {:put, RocksDB.cf_actions(), RocksDB.encode_gsn_key(gsn1), first_frame},
          {:put, RocksDB.cf_group_actions(), RocksDB.encode_group_action_key(group_id, gsn1),
           first_id},
          {:put, RocksDB.cf_actions(), RocksDB.encode_gsn_key(gsn2), second_frame},
          {:put, RocksDB.cf_group_actions(), RocksDB.encode_group_action_key(group_id, gsn2),
           second_id}
        ])

      :ok = WatermarkTracker.mark_range_committed(gsn1, gsn2)
      WatermarkTracker.advance_watermark()

      # The Writer notifies each committed range in claim order, carrying
      # the payload it already holds for the live hand-off.
      send(
        FanOutRouter,
        {:batch_committed, gsn1, gsn1, %{gsn1 => [group_id]}, System.monotonic_time(),
         [first_payload], []}
      )

      send(
        FanOutRouter,
        {:batch_committed, gsn2, gsn2, %{gsn2 => [group_id]}, System.monotonic_time(),
         [second_payload], []}
      )

      # Each released range is its own push, so flatten the chunks to assert
      # the stream order across them.
      [first_pushed, second_pushed] =
        receive_data_payloads(2) |> Enum.map(&Jason.decode!/1)

      assert [first_pushed["gsn"], second_pushed["gsn"]] == [gsn1, gsn2]
      assert [first_pushed["id"], second_pushed["id"]] == [first_id, second_id]
      assert [%{"subject_id" => subject}] = first_pushed["updates"]
      assert subject == "todo_#{first_id}"

      # Decoding the stored value is what keeps the push uniform: the key's
      # GSN plus the persisted scopes, whichever range it came from.
      {:ok, frame_value} = RocksDB.get(RocksDB.cf_actions(), RocksDB.encode_gsn_key(gsn2))
      decoded = ActionFormat.decode(frame_value, gsn2)

      assert decoded["gsn"] == gsn2
      assert decoded["subject_scopes"] == [{"todo_#{second_id}", [group_id]}]

      sync_router()
      assert FanOutFrontier.get() == {:ok, gsn2}

      :ok = FanOutRouter.unsubscribe(sse_pid)
    end

    test "a spanning Action reaches each group with only its own subject's Updates" do
      g1 = "g_534_span_a_#{:erlang.unique_integer([:positive])}"
      g2 = "g_534_span_b_#{:erlang.unique_integer([:positive])}"
      actor_id = "a_534_span_#{:erlang.unique_integer([:positive])}"

      {:ok, sse1} = SSEConnection.start_link(self(), [g1], %{g1 => 0})
      {:ok, sse2} = SSEConnection.start_link(self(), [g2], %{g2 => 0})
      :ok = FanOutRouter.subscribe([g1], sse1, actor_id)
      :ok = FanOutRouter.subscribe([g2], sse2, actor_id)

      gsn = RocksDB.get_max_gsn() + 1
      action_id = "act_534_span_#{:erlang.unique_integer([:positive])}"
      hlc = generate_hlc()

      updates = [
        update_for("upd_#{action_id}_a", "todo_#{action_id}_a", hlc),
        update_for("upd_#{action_id}_b", "todo_#{action_id}_b", hlc)
      ]

      payload_etf =
        %{id: action_id, actor_id: actor_id, hlc: hlc, updates: updates}
        |> ActionFormat.build()
        |> ActionFormat.encode()

      subject_scopes = [
        {"todo_#{action_id}_a", [g1]},
        {"todo_#{action_id}_b", [g2]}
      ]

      :ok =
        RocksDB.write_batch([
          {:put, RocksDB.cf_actions(), RocksDB.encode_gsn_key(gsn),
           ActionFormat.frame(payload_etf, subject_scopes)},
          {:put, RocksDB.cf_group_actions(), RocksDB.encode_group_action_key(g1, gsn), action_id},
          {:put, RocksDB.cf_group_actions(), RocksDB.encode_group_action_key(g2, gsn), action_id}
        ])

      :ok = WatermarkTracker.mark_range_committed(gsn, gsn)
      WatermarkTracker.advance_watermark()

      # The live hand-off carries the payload and its per-subject scopes;
      # each group's frame is the join over its own scope entry.
      send(
        FanOutRouter,
        {:batch_committed, gsn, gsn, %{gsn => [g1, g2]}, System.monotonic_time(),
         [{payload_etf, subject_scopes}], []}
      )

      delivered =
        1..2
        |> Enum.map(fn _ -> receive_data_payloads(1) |> hd() |> Jason.decode!() end)
        |> Map.new(fn action -> {hd(action["updates"])["subject_id"], action["updates"]} end)

      assert delivered == %{
               "todo_#{action_id}_a" => [
                 %{
                   "id" => "upd_#{action_id}_a",
                   "subject_id" => "todo_#{action_id}_a",
                   "component" => "todo/title",
                   "method" => "replace",
                   "data" => %{"type" => "lww", "value" => "x", "hlc" => hlc}
                 }
               ],
               "todo_#{action_id}_b" => [
                 %{
                   "id" => "upd_#{action_id}_b",
                   "subject_id" => "todo_#{action_id}_b",
                   "component" => "todo/title",
                   "method" => "replace",
                   "data" => %{"type" => "lww", "value" => "x", "hlc" => hlc}
                 }
               ]
             }

      sync_router()

      :ok = FanOutRouter.unsubscribe(sse1)
      :ok = FanOutRouter.unsubscribe(sse2)
    end

    test "a push persisted behind its frontier is re-pushed on resume (at-least-once)" do
      group_id = "g_534_replay_#{:erlang.unique_integer([:positive])}"
      actor_id = "a_534_replay_#{:erlang.unique_integer([:positive])}"

      {:ok, sse_pid} = SSEConnection.start_link(self(), [group_id], %{group_id => 0})
      :ok = FanOutRouter.subscribe([group_id], sse_pid, actor_id)

      post_bootstrap!(actor_id, group_id)

      first_bytes = receive_sse_data()
      first = first_bytes |> single_data_payload() |> Jason.decode!()
      gsn = first["gsn"]

      sync_router()
      assert FanOutFrontier.get() == {:ok, gsn}

      # Simulate a crash between the push and `FanOutFrontier.put`: the
      # frontier is still behind the range that already reached subscribers.
      :ets.delete_all_objects(:fan_out_frontier)
      :ets.insert(:fan_out_frontier, {:last_pushed_gsn, 0})
      assert FanOutFrontier.get() == {:ok, 0}

      :ok = terminate_router()
      {:ok, _pid} = restart_router()

      # At-least-once: the resumed Router re-pushes from the persisted
      # frontier. Duplicates are tolerated, not suppressed.
      second_bytes = receive_sse_data()
      second = second_bytes |> single_data_payload() |> Jason.decode!()

      assert second["id"] == first["id"]
      assert second["gsn"] == gsn

      sync_router()
      assert FanOutFrontier.get() == {:ok, gsn}

      :ok = FanOutRouter.unsubscribe(sse_pid)
    end

    test "the frontier never passes a buffered range" do
      group_id = "g_534_frontier_#{:erlang.unique_integer([:positive])}"
      actor_id = "a_534_frontier_#{:erlang.unique_integer([:positive])}"

      {:ok, sse_pid} = SSEConnection.start_link(self(), [group_id], %{group_id => 0})
      :ok = FanOutRouter.subscribe([group_id], sse_pid, actor_id)

      post_bootstrap!(actor_id, group_id)

      _first_bytes = receive_sse_data()
      pushed_gsn = RocksDB.get_max_gsn()
      sync_router()
      assert FanOutFrontier.get() == {:ok, pushed_gsn}

      # Reserve the next GSN without resolving it: the range behind the hole
      # commits but waits, so the frontier must stay put.
      %{gsn_counter: counter} = GsnCounter.get_resources()
      hole_gsn = pushed_gsn + 1
      assert {^hole_gsn, ^hole_gsn} = GsnCounter.claim_gsn_range(1, counter)

      buffered_gsn = hole_gsn + 1
      post_entity!(actor_id, group_id)

      ref = attach_telemetry([[:ebb, :fanout, :hop_ms]])

      sync_router()

      assert :sys.get_state(FanOutRouter).plan.pending_notifications == [
               {buffered_gsn, buffered_gsn}
             ]

      assert FanOutFrontier.get() == {:ok, pushed_gsn}
      refute_sse_data(200)

      # Once the hole resolves, the watermark covers the buffered range and
      # only then does the frontier follow it.
      :ok = WatermarkTracker.mark_range_resolved(hole_gsn, hole_gsn)
      WatermarkTracker.advance_watermark()
      send(FanOutRouter, {:range_resolved, hole_gsn, hole_gsn})

      second_bytes = receive_sse_data()

      assert second_bytes |> single_data_payload() |> Jason.decode!() |> Map.fetch!("gsn") ==
               buffered_gsn

      assert [
               {[:ebb, :fanout, :hop_ms], %{duration: dwell},
                %{hop: :router_dwell, group_id: nil}}
             ] =
               Enum.filter(telemetry_events(ref), fn
                 {_, _, %{hop: :router_dwell}} -> true
                 _ -> false
               end)

      assert is_integer(dwell) and dwell > 0

      sync_router()
      assert FanOutFrontier.get() == {:ok, buffered_gsn}

      :ok = FanOutRouter.unsubscribe(sse_pid)
    end
  end

  defp post_bootstrap!(actor_id, group_id) do
    conn = ActionHelpers.bootstrap_group(actor_id, group_id, ["todo.*"])
    assert conn.status == 200
    assert conn.resp_body == ~s({"rejected":[]})
  end

  defp post_entity!(actor_id, group_id) do
    conn =
      ActionHelpers.write_entity_in_group(
        actor_id,
        "todo_534_buffered_#{:erlang.unique_integer([:positive])}",
        "todo",
        group_id,
        %{"title" => %{"type" => "lww", "value" => "buffered", "hlc" => generate_hlc()}}
      )

    assert conn.status == 200
    assert conn.resp_body == ~s({"rejected":[]})
  end

  defp terminate_router do
    Supervisor.terminate_child(EbbServer.Sync.Supervisor, FanOutRouter)
  end

  defp restart_router do
    Supervisor.restart_child(EbbServer.Sync.Supervisor, FanOutRouter)
  end

  # Blocks until the Router has finished handling the message that pushed the
  # range, so the persisted frontier reflects that push.
  defp sync_router, do: :sys.get_state(FanOutRouter)

  defp update_for(update_id, subject_id, hlc) do
    %{
      id: update_id,
      subject_id: subject_id,
      component: "todo/title",
      method: :replace,
      data: %{"type" => "lww", "value" => "x", "hlc" => hlc}
    }
  end

  defp framed(group_id, actor_id, action_id) do
    hlc = generate_hlc()
    scopes = [{"todo_#{action_id}", [group_id]}]

    payload_etf =
      %{
        id: action_id,
        actor_id: actor_id,
        hlc: hlc,
        updates: [
          %{
            id: "upd_#{action_id}",
            subject_id: "todo_#{action_id}",
            component: "todo/title",
            method: :replace,
            data: %{"type" => "lww", "value" => action_id, "hlc" => hlc}
          }
        ]
      }
      |> ActionFormat.build()
      |> ActionFormat.encode()

    {ActionFormat.frame(payload_etf, scopes), {payload_etf, scopes}}
  end
end
