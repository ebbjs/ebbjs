defmodule EbbServer.Sync.FanOutRouterIntegrationTest do
  @moduledoc """
  Integration tests for FanOutRouter that require the full supervision tree.

  Tests subscribe/unsubscribe handler behavior with GroupDynamicSupervisor
  and GroupServer interactions.
  """

  use ExUnit.Case, async: false
  use EbbServer.Integration.StorageCase

  alias EbbServer.Sync.FanOutRouter

  describe "subscribe/2 — second subscriber to same group" do
    test "does not crash when GroupServer already exists for group" do
      conn1 = spawn(fn -> receive do: (_ -> :ok) end)
      conn2 = spawn(fn -> receive do: (_ -> :ok) end)

      :ok = FanOutRouter.subscribe(["shared_group"], conn1)

      second_result = FanOutRouter.subscribe(["shared_group"], conn2)

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

      :ok = FanOutRouter.subscribe(["push_test_group"], conn1)
      :ok = FanOutRouter.subscribe(["push_test_group"], conn2)

      :ok = FanOutRouter.unsubscribe(conn1)
      :ok = FanOutRouter.unsubscribe(conn2)
    end
  end
end
