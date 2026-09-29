defmodule EbbServer.Sync.FanOutRouterIntegrationTest do
  @moduledoc """
  Integration tests for FanOutRouter that require the full supervision tree.

  Tests subscribe/unsubscribe handler behavior with GroupDynamicSupervisor
  and GroupServer interactions.
  """

  use ExUnit.Case, async: false
  use EbbServer.Integration.StorageCase

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
    test "relationship and groupMember actions reach the per-group GroupServer" do
      # The pre-#197 dispatch keyed on subject_id alone, so a relationship
      # action (subject_id = relationship id) never resolved to its
      # target group. Subscribe an SSEConnection to the bootstrap group,
      # write the seed via ActionHelpers, and verify the listener
      # receives an SSE chunk carrying the group, groupMember, and
      # relationship updates — i.e., the fan-out is no longer dropping
      # them. The SSEConnection is parented to `self()` so `assert_receive`
      # can drain chunks directly.
      group_id = "g_197_#{:erlang.unique_integer([:positive])}"
      actor_id = "a_197_#{:erlang.unique_integer([:positive])}"

      {:ok, sse_pid} =
        EbbServer.Sync.SSEConnection.start_link(self(), [group_id], %{group_id => 0})

      :ok = FanOutRouter.subscribe([group_id], sse_pid, actor_id)

      ActionHelpers.bootstrap_group(actor_id, group_id, [
        "todo.read",
        "todo.write",
        "todo.create"
      ])

      # FanOutRouter dispatches via GenServer.cast → GroupServer →
      # SSEConnection.handle_cast → `{:sse_chunk, "data", payload}` to
      # this test process. Wait for one such chunk (the bootstrap Action
      # carries all three system updates in a single batch).
      assert_receive {:sse_chunk, "data", json}, 5_000
      payload = Jason.decode!(json)

      subject_types =
        payload["updates"]
        |> Enum.map(fn update -> update["subject_type"] end)
        |> Enum.uniq()
        |> Enum.sort()

      # Bootstrap emits one of each: group, groupMember, relationship.
      assert "group" in subject_types
      assert "groupMember" in subject_types
      assert "relationship" in subject_types

      :ok = FanOutRouter.unsubscribe(sse_pid)
    end
  end
end
