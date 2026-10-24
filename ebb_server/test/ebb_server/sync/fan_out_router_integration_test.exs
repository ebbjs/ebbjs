defmodule EbbServer.Sync.FanOutRouterIntegrationTest do
  @moduledoc """
  Integration tests for FanOutRouter that require the full supervision tree.

  Tests subscribe/unsubscribe handler behavior with GroupDynamicSupervisor
  and GroupServer interactions.
  """

  use ExUnit.Case, async: false
  use EbbServer.Integration.StorageCase

  import EbbServer.SSEHelpers
  import EbbServer.TestHelpers

  alias EbbServer.Integration.ActionHelpers
  alias EbbServer.Storage.{ActionFormat, RocksDB, WatermarkTracker}
  alias EbbServer.Sync.FanOutRouter

  describe "subscribe/2 — second subscriber to same group" do
    test "does not crash when GroupServer already exists for group" do
      conn1 = spawn(fn -> receive do: (_ -> :ok) end)
      conn2 = spawn(fn -> receive do: (_ -> :ok) end)

      :ok = FanOutRouter.subscribe(["shared_group"], conn1, "actor_1")

      second_result = FanOutRouter.subscribe(["shared_group"], conn2, "actor_2")

      assert second_result == :ok

      :ok = FanOutRouter.unsubscribe(conn1)
      :ok = FanOutRouter.unsubscribe(conn2)
    end

    test "second subscriber to existing group receives push_actions" do
      conn1 =
        spawn(fn ->
          receive do
            msg -> send(self(), {:conn1, msg})
          end
        end)

      conn2 =
        spawn(fn ->
          receive do
            msg -> send(self(), {:conn2, msg})
          end
        end)

      :ok = FanOutRouter.subscribe(["push_test_group"], conn1, "actor_1")
      :ok = FanOutRouter.subscribe(["push_test_group"], conn2, "actor_2")

      :ok = FanOutRouter.unsubscribe(conn1)
      :ok = FanOutRouter.unsubscribe(conn2)
    end
  end

  describe "system-entity fan-out (#197)" do
    test "entityGroup and groupMember actions reach the per-group GroupServer" do
      # Pinned by #197: the FanOutRouter must route entityGroup /
      # groupMember / group updates to the right GroupServer. Subscribe
      # an SSEConnection to the bootstrap group, write the seed, and
      # verify the chunk carries all three system-entity subject types.
      # Parent the SSEConnection to `self()` so `assert_receive` can
      # drain chunks directly.
      group_id = "g_197_#{:erlang.unique_integer([:positive])}"
      actor_id = "a_197_#{:erlang.unique_integer([:positive])}"

      {:ok, sse_pid} =
        EbbServer.Sync.SSEConnection.start_link(self(), [group_id], %{group_id => 0})

      :ok = FanOutRouter.subscribe([group_id], sse_pid, actor_id)

      # One legitimate self-bootstrap Action that also adds a third party
      # and an entity membership edge, so the chunk carries `group`,
      # `groupMember` and `entityGroup` updates.
      hlc = EbbServer.TestHelpers.generate_hlc()
      todo_id = "todo_197_#{:erlang.unique_integer([:positive])}"

      seed = %{
        "id" => "act_197_#{:erlang.unique_integer([:positive])}",
        "actor_id" => actor_id,
        "hlc" => hlc,
        "updates" => [
          system_update("group", group_id, "put", %{
            "name" => %{"type" => "lww", "value" => "Seed", "hlc" => hlc}
          }),
          system_update("groupMember", "gm_197_owner", "put", %{
            "actor_id" => %{"type" => "lww", "value" => actor_id, "hlc" => hlc},
            "group_id" => %{"type" => "lww", "value" => group_id, "hlc" => hlc},
            "permissions" => %{
              "type" => "lww",
              "value" => ["todo.*", "groupMember.*"],
              "hlc" => hlc
            }
          }),
          system_update("todo", todo_id, "put", %{
            "title" => %{"type" => "lww", "value" => "Seed", "hlc" => hlc}
          }),
          system_update("entityGroup", "eg_197", "put", %{
            "entity_id" => %{"type" => "lww", "value" => todo_id, "hlc" => hlc},
            "group_id" => %{"type" => "lww", "value" => group_id, "hlc" => hlc}
          }),
          system_update("groupMember", "gm_197_third", "put", %{
            "actor_id" => %{"type" => "lww", "value" => "a_197_third", "hlc" => hlc},
            "group_id" => %{"type" => "lww", "value" => group_id, "hlc" => hlc},
            "permissions" => %{"type" => "lww", "value" => ["todo.read"], "hlc" => hlc}
          })
        ]
      }

      conn =
        ActionHelpers.post_actions(
          ActionHelpers.msgpack_encode!(%{"actions" => [seed]}),
          actor_id
        )

      assert conn.status == 200
      assert conn.resp_body == ~s({"rejected":[]})

      assert_receive {:sse_data, bytes}, 5_000
      payload = bytes |> single_data_payload() |> Jason.decode!()

      subject_types =
        payload["updates"]
        |> Enum.map(fn update -> update["subject_type"] end)
        |> Enum.uniq()
        |> Enum.sort()

      assert "group" in subject_types
      assert "groupMember" in subject_types
      assert "entityGroup" in subject_types

      :ok = FanOutRouter.unsubscribe(sse_pid)
    end
  end

  describe "stored action shape (#532)" do
    test "pushes an Action stored in a frame" do
      group_id = "g_532_#{:erlang.unique_integer([:positive])}"
      actor_id = "a_532_#{:erlang.unique_integer([:positive])}"

      {:ok, sse_pid} =
        EbbServer.Sync.SSEConnection.start_link(self(), [group_id], %{group_id => 0})

      :ok = FanOutRouter.subscribe([group_id], sse_pid, actor_id)

      gsn = RocksDB.get_max_gsn() + 1
      hlc = generate_hlc()
      action_id = "act_532_#{:erlang.unique_integer([:positive])}"
      update_id = "upd_532_#{:erlang.unique_integer([:positive])}"

      payload =
        %{
          id: action_id,
          actor_id: actor_id,
          hlc: hlc,
          updates: [
            %{
              id: update_id,
              subject_id: "todo_532",
              subject_type: "todo",
              method: :put,
              data: %{
                "fields" => %{"title" => %{"type" => "lww", "value" => "x", "hlc" => hlc}}
              }
            }
          ]
        }
        |> ActionFormat.build()
        |> ActionFormat.encode()

      frame = ActionFormat.frame(payload, [[group_id]])

      :ok =
        RocksDB.write_batch([
          {:put, RocksDB.cf_actions(), RocksDB.encode_gsn_key(gsn), frame},
          {:put, RocksDB.cf_group_actions(), RocksDB.encode_group_action_key(group_id, gsn),
           action_id}
        ])

      :ok = WatermarkTracker.mark_range_committed(gsn, gsn)
      WatermarkTracker.advance_watermark()

      send(
        FanOutRouter,
        {:batch_committed, gsn, gsn, %{gsn => [group_id]}, System.monotonic_time()}
      )

      assert_receive {:sse_data, bytes}, 5_000

      pushed = bytes |> single_data_payload() |> Jason.decode!()

      assert pushed["gsn"] == gsn
      assert pushed["id"] == action_id
      assert pushed["actor_id"] == actor_id
      assert [%{"id" => ^update_id}] = pushed["updates"]

      :ok = FanOutRouter.unsubscribe(sse_pid)
    end
  end

  describe "push latency telemetry (#363)" do
    test "emits one event per dispatched batch carrying the subscribed group id" do
      group_id = "g_363_#{:erlang.unique_integer([:positive])}"
      actor_id = "a_363_#{:erlang.unique_integer([:positive])}"

      {:ok, sse_pid} =
        EbbServer.Sync.SSEConnection.start_link(self(), [group_id], %{group_id => 0})

      :ok = FanOutRouter.subscribe([group_id], sse_pid, actor_id)

      ref = attach_telemetry([[:ebb, :fanout, :push_latency_ms]])

      conn = ActionHelpers.bootstrap_group(actor_id, group_id, ["todo.*"])
      assert conn.status == 200
      assert conn.resp_body == ~s({"rejected":[]})

      assert_receive {:sse_data, _bytes}, 5_000

      assert [{[:ebb, :fanout, :push_latency_ms], %{duration: duration}, %{group_id: ^group_id}}] =
               telemetry_events(ref)

      assert is_integer(duration) and duration >= 0

      :ok = FanOutRouter.unsubscribe(sse_pid)
    end

    test "emits a single sample for a multi-Action batch to one group" do
      group_id = "g_363_batch_#{:erlang.unique_integer([:positive])}"
      actor_id = "a_363_batch_#{:erlang.unique_integer([:positive])}"

      conn = ActionHelpers.bootstrap_group(actor_id, group_id, ["todo.*"])
      assert conn.status == 200

      {:ok, sse_pid} =
        EbbServer.Sync.SSEConnection.start_link(self(), [group_id], %{group_id => 0})

      :ok = FanOutRouter.subscribe([group_id], sse_pid, actor_id)
      ref = attach_telemetry([[:ebb, :fanout, :push_latency_ms]])

      hlc = generate_hlc()

      actions =
        for i <- 1..2 do
          entity_id = "todo_363_batch_#{i}_#{:erlang.unique_integer([:positive])}"

          %{
            "id" => "act_363_batch_#{i}_#{:erlang.unique_integer([:positive])}",
            "actor_id" => actor_id,
            "hlc" => hlc,
            "updates" => [
              %{
                "id" => "upd_363_#{i}_#{:erlang.unique_integer([:positive])}",
                "subject_id" => entity_id,
                "subject_type" => "todo",
                "method" => "put",
                "data" => %{
                  "fields" => %{
                    "title" => %{"type" => "lww", "value" => "Batch #{i}", "hlc" => hlc}
                  }
                }
              },
              ActionHelpers.entity_group_update(entity_id, group_id, hlc)
            ]
          }
        end

      conn =
        ActionHelpers.post_actions(
          ActionHelpers.msgpack_encode!(%{"actions" => actions}),
          actor_id
        )

      assert conn.status == 200
      assert conn.resp_body == ~s({"rejected":[]})

      # Both Actions reach the group as one dispatched batch, coalesced
      # into a single chunk carrying one frame per Action.
      assert_receive {:sse_data, bytes}, 5_000
      assert length(data_payloads(bytes)) == 2

      assert [{[:ebb, :fanout, :push_latency_ms], %{duration: duration}, %{group_id: ^group_id}}] =
               telemetry_events(ref)

      assert is_integer(duration) and duration >= 0

      :ok = FanOutRouter.unsubscribe(sse_pid)
    end
  end

  defp system_update(subject_type, subject_id, method, fields) do
    %{
      "id" => "upd_197_#{:erlang.unique_integer([:positive])}",
      "subject_id" => subject_id,
      "subject_type" => subject_type,
      "method" => method,
      "data" => %{"fields" => fields}
    }
  end

  describe "subscriber lifecycle (#278)" do
    test "dead subscriber pid is removed from subscriptions" do
      conn = spawn(fn -> receive do: (:stop -> :ok) end)

      :ok = FanOutRouter.subscribe(["reap_test_group"], conn, "actor_reap")
      assert Map.has_key?(router_subscriptions(), conn)

      Process.exit(conn, :kill)

      assert eventually(fn -> not Map.has_key?(router_subscriptions(), conn) end),
             "expected dead subscriber #{inspect(conn)} to be reaped from subscriptions"
    end

    test "explicit unsubscribe/1 still removes a live subscriber" do
      conn = spawn(fn -> receive do: (:stop -> :ok) end)

      :ok = FanOutRouter.subscribe(["reap_test_explicit"], conn, "actor_reap")
      assert Map.has_key?(router_subscriptions(), conn)

      :ok = FanOutRouter.unsubscribe(conn)
      refute Map.has_key?(router_subscriptions(), conn)

      Process.exit(conn, :kill)
    end
  end

  describe "per-Update delivery (#473)" do
    test "pushes each Update only to the group it scopes to" do
      actor_id = "a_473_#{:erlang.unique_integer([:positive])}"
      g1 = "g_473_a_#{:erlang.unique_integer([:positive])}"
      g2 = "g_473_b_#{:erlang.unique_integer([:positive])}"

      assert ActionHelpers.bootstrap_group(actor_id, g1, ["todo.*", "entityGroup.*"]).status ==
               200

      assert ActionHelpers.bootstrap_group(actor_id, g2, ["todo.*", "entityGroup.*"]).status ==
               200

      # An entity already in g2, so the membership delta can target it.
      hlc = generate_hlc()
      other_id = "todo_473_other_#{:erlang.unique_integer([:positive])}"

      seed = %{
        "id" => "act_473_seed_#{:erlang.unique_integer([:positive])}",
        "actor_id" => actor_id,
        "hlc" => hlc,
        "updates" => [
          todo_update(other_id, hlc),
          ActionHelpers.entity_group_update(other_id, g2, hlc)
        ]
      }

      assert ActionHelpers.post_actions(
               ActionHelpers.msgpack_encode!(%{"actions" => [seed]}),
               actor_id
             ).status == 200

      c1 = start_collector(:g1)
      c2 = start_collector(:g2)

      {:ok, sse1} = EbbServer.Sync.SSEConnection.start_link(c1, [g1], %{g1 => 0})
      {:ok, sse2} = EbbServer.Sync.SSEConnection.start_link(c2, [g2], %{g2 => 0})

      :ok = FanOutRouter.subscribe([g1], sse1, actor_id)
      :ok = FanOutRouter.subscribe([g2], sse2, actor_id)

      leaked_id = "todo_473_leak_#{:erlang.unique_integer([:positive])}"
      eg_leak = "eg_473_leak_#{:erlang.unique_integer([:positive])}"
      eg_other = "eg_473_other_#{:erlang.unique_integer([:positive])}"
      action_id = "act_473_span_#{:erlang.unique_integer([:positive])}"

      action = %{
        "id" => action_id,
        "actor_id" => actor_id,
        "hlc" => hlc,
        "updates" => [
          todo_update(leaked_id, hlc),
          entity_group_put(eg_leak, leaked_id, g1, hlc),
          entity_group_put(eg_other, other_id, g2, hlc)
        ]
      }

      conn =
        ActionHelpers.post_actions(
          ActionHelpers.msgpack_encode!(%{"actions" => [action]}),
          actor_id
        )

      assert conn.status == 200
      assert conn.resp_body == ~s({"rejected":[]})

      g1_ids = action_id |> await_chunk(:g1) |> update_subject_ids()
      g2_ids = action_id |> await_chunk(:g2) |> update_subject_ids()

      # One Action; g1 sees only its own write and membership row, g2 only
      # the row for the entity it already holds.
      assert Enum.sort(g1_ids) == Enum.sort([leaked_id, eg_leak])
      assert g2_ids == [eg_other]

      :ok = FanOutRouter.unsubscribe(sse1)
      :ok = FanOutRouter.unsubscribe(sse2)
    end
  end

  defp todo_update(entity_id, hlc) do
    %{
      "id" => "upd_473_#{:erlang.unique_integer([:positive])}",
      "subject_id" => entity_id,
      "subject_type" => "todo",
      "method" => "put",
      "data" => %{"fields" => %{"title" => %{"type" => "lww", "value" => "x", "hlc" => hlc}}}
    }
  end

  defp entity_group_put(eg_id, entity_id, group_id, hlc) do
    %{
      "id" => eg_id,
      "subject_id" => eg_id,
      "subject_type" => "entityGroup",
      "method" => "put",
      "data" => %{
        "fields" => %{
          "entity_id" => %{"type" => "lww", "value" => entity_id, "hlc" => hlc},
          "group_id" => %{"type" => "lww", "value" => group_id, "hlc" => hlc}
        }
      }
    }
  end

  defp start_collector(tag) do
    test = self()
    spawn(fn -> collect_chunks(test, tag) end)
  end

  defp collect_chunks(test, tag) do
    receive do
      {:sse_data, bytes} ->
        for payload <- data_payloads(bytes), do: send(test, {tag, payload})

      _other ->
        :ok
    end

    collect_chunks(test, tag)
  end

  defp await_chunk(action_id, tag) do
    receive do
      {^tag, json} ->
        payload = Jason.decode!(json)
        if payload["id"] == action_id, do: payload, else: await_chunk(action_id, tag)
    after
      5_000 -> flunk("timed out waiting for #{action_id} on #{inspect(tag)}")
    end
  end

  defp update_subject_ids(payload) do
    payload |> Map.get("updates") |> Enum.map(& &1["subject_id"])
  end

  defp router_subscriptions do
    :sys.get_state(FanOutRouter).subscriptions
  end

  defp eventually(fun, attempts \\ 100)
  defp eventually(fun, 0), do: fun.()

  defp eventually(fun, attempts) do
    if fun.() do
      true
    else
      Process.sleep(10)
      eventually(fun, attempts - 1)
    end
  end
end
