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

      :ok =
        RocksDB.write_batch([
          {:put, RocksDB.cf_actions(), RocksDB.encode_gsn_key(gsn1),
           framed(group_id, actor_id, first_id)},
          {:put, RocksDB.cf_group_actions(), RocksDB.encode_group_action_key(group_id, gsn1),
           first_id},
          {:put, RocksDB.cf_actions(), RocksDB.encode_gsn_key(gsn2),
           framed(group_id, actor_id, second_id)},
          {:put, RocksDB.cf_group_actions(), RocksDB.encode_group_action_key(group_id, gsn2),
           second_id}
        ])

      :ok = WatermarkTracker.mark_range_committed(gsn1, gsn2)
      WatermarkTracker.advance_watermark()

      # The Writer notifies each committed range in claim order.
      send(
        FanOutRouter,
        {:batch_committed, gsn1, gsn1, %{gsn1 => [group_id]}, System.monotonic_time()}
      )

      send(
        FanOutRouter,
        {:batch_committed, gsn2, gsn2, %{gsn2 => [group_id]}, System.monotonic_time()}
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
      assert decoded["update_scopes"] == [[group_id]]

      sync_router()
      assert FanOutFrontier.get() == {:ok, gsn2}

      :ok = FanOutRouter.unsubscribe(sse_pid)
    end

    test "a push persisted behind its frontier is re-pushed on resume (at-least-once)" do
      group_id = "g_534_replay_#{:erlang.unique_integer([:positive])}"
      actor_id = "a_534_replay_#{:erlang.unique_integer([:positive])}"

      {:ok, sse_pid} = SSEConnection.start_link(self(), [group_id], %{group_id => 0})
      :ok = FanOutRouter.subscribe([group_id], sse_pid, actor_id)

      post_bootstrap!(actor_id, group_id)

      assert_receive {:sse_data, first_bytes}, 5_000
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
      assert_receive {:sse_data, second_bytes}, 5_000
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

      assert_receive {:sse_data, _first_bytes}, 5_000
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

      sync_router()

      assert :sys.get_state(FanOutRouter).plan.pending_notifications == [
               {buffered_gsn, buffered_gsn}
             ]

      assert FanOutFrontier.get() == {:ok, pushed_gsn}
      refute_receive {:sse_data, _}, 200

      # Once the hole resolves, the watermark covers the buffered range and
      # only then does the frontier follow it.
      :ok = WatermarkTracker.mark_range_resolved(hole_gsn, hole_gsn)
      WatermarkTracker.advance_watermark()
      send(FanOutRouter, {:range_resolved, hole_gsn, hole_gsn})

      assert_receive {:sse_data, second_bytes}, 5_000

      assert second_bytes |> single_data_payload() |> Jason.decode!() |> Map.fetch!("gsn") ==
               buffered_gsn

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

  defp framed(group_id, actor_id, action_id) do
    hlc = generate_hlc()

    payload =
      %{
        id: action_id,
        actor_id: actor_id,
        hlc: hlc,
        updates: [
          %{
            id: "upd_#{action_id}",
            subject_id: "todo_#{action_id}",
            subject_type: "todo",
            method: :put,
            data: %{
              "fields" => %{"title" => %{"type" => "lww", "value" => action_id, "hlc" => hlc}}
            }
          }
        ]
      }
      |> ActionFormat.build()
      |> ActionFormat.encode()

    ActionFormat.frame(payload, [[group_id]])
  end
end
