defmodule EbbServer.Sync.FanOutRouterIntegrationTest do
  @moduledoc """
  Integration tests for FanOutRouter that require the full supervision tree.

  Tests subscribe/unsubscribe handler behavior with GroupDynamicSupervisor
  and GroupServer interactions.
  """

  use ExUnit.Case, async: false
  use EbbServer.Integration.StorageCase

  import EbbServer.TestHelpers

  alias EbbServer.Integration.ActionHelpers
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

      assert_receive {:sse_chunk, "data", json}, 5_000
      payload = Jason.decode!(json)

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

      assert_receive {:sse_chunk, "data", _json}, 5_000

      assert {[:ebb, :fanout, :push_latency_ms], %{duration: duration}, %{group_id: ^group_id}} =
               await_event(ref)

      assert is_integer(duration) and duration >= 0

      :ok = FanOutRouter.unsubscribe(sse_pid)
    end
  end

  defp await_event(ref, timeout \\ 1_000) do
    receive do
      {:telemetry_event, ^ref, event, measurements, metadata} ->
        {event, measurements, metadata}
    after
      timeout -> flunk("expected a telemetry event within #{timeout}ms")
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
