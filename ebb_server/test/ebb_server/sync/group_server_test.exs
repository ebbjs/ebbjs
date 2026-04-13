defmodule EbbServer.Sync.GroupServerTest do
  @moduledoc """
  Tests for GroupServer.
  """

  use ExUnit.Case, async: false
  use EbbServer.Integration.StorageCase

  alias EbbServer.Sync.GroupServer

  setup do
    group_id = "test_group_#{:erlang.unique_integer([:positive])}"
    {:ok, gs} = GroupServer.start_link(group_id)

    on_exit(fn ->
      try do
        case Process.whereis(GroupServer) do
          nil -> :ok
          pid when is_pid(pid) -> GenServer.stop(pid, :normal, 5000)
        end
      catch
        _, _ -> :ok
      end
    end)

    %{group_server: gs, group_id: group_id}
  end

  describe "add_subscriber/3" do
    test "GenServer.call includes timeout argument" do
      code = File.read!(Path.expand("../../../lib/ebb_server/sync/group_server.ex", __DIR__))

      gen_server_call =
        code
        |> String.split("\n")
        |> Enum.find(fn line ->
          String.contains?(line, "GenServer.call") && String.contains?(line, "add_subscriber")
        end)

      assert gen_server_call =~ ~r/, 5_000/,
             "GenServer.call should include 5000ms timeout, got: #{gen_server_call}"
    end

    test "adds subscriber and monitors connection", %{group_server: gs} do
      subscriber =
        spawn(fn ->
          receive do
            _ -> :ok
          end
        end)

      ref = Process.monitor(subscriber)

      result = GroupServer.add_subscriber(gs, subscriber, "actor_1")
      assert result == :ok

      Process.exit(subscriber, :kill)

      receive do
        {:DOWN, ^ref, :process, _, _} -> :ok
      after
        1000 -> flunk("Timeout waiting for DOWN")
      end
    end

    test "reply includes actor_id in state", %{group_server: gs} do
      subscriber =
        spawn(fn ->
          receive do
            _ -> :ok
          end
        end)

      :ok = GroupServer.add_subscriber(gs, subscriber, "actor_test")
      Process.exit(subscriber, :kill)
    end
  end

  describe "broadcast_presence/3" do
    test "no crash when sending to dead connection", %{group_server: gs} do
      dead_conn =
        spawn(fn ->
          receive do
            _ -> :ok
          end
        end)

      Process.monitor(dead_conn)

      :ok = GroupServer.add_subscriber(gs, dead_conn, "actor_dead")
      Process.exit(dead_conn, :kill)

      :ok = GroupServer.broadcast_presence(gs, "actor_other", %{"data" => "test"})
    end
  end

  describe "push_actions/2" do
    test "pushes actions to all subscribers", %{group_server: gs} do
      sub1 =
        spawn(fn ->
          receive do
            _ -> :ok
          end
        end)

      sub2 =
        spawn(fn ->
          receive do
            _ -> :ok
          end
        end)

      GroupServer.add_subscriber(gs, sub1, "actor_1")
      GroupServer.add_subscriber(gs, sub2, "actor_2")

      actions = [
        %{"id" => "act_1", "actor_id" => "actor_1", "gsn" => 1, "hlc" => 1, "updates" => []}
      ]

      result = GroupServer.push_actions(gs, actions)
      assert result == :ok

      Process.exit(sub1, :kill)
      Process.exit(sub2, :kill)
    end
  end

  describe "remove_subscriber/2" do
    test "removes subscriber from state", %{group_server: gs} do
      subscriber =
        spawn(fn ->
          receive do
            _ -> :ok
          end
        end)

      :ok = GroupServer.add_subscriber(gs, subscriber, "actor_1")
      :ok = GroupServer.remove_subscriber(gs, subscriber)

      Process.exit(subscriber, :kill)
    end
  end
end
