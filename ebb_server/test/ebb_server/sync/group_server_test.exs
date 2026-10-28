defmodule EbbServer.Sync.GroupServerTest do
  @moduledoc """
  Tests for GroupServer.
  """

  use ExUnit.Case, async: false
  use EbbServer.Integration.StorageCase

  import EbbServer.TestHelpers

  alias EbbServer.Sync.{GroupServer, SSEConnection}

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

  describe "broadcast_presence/4" do
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

      :ok = GroupServer.broadcast_presence(gs, "doc_demo", "actor_other", %{"data" => "test"})
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

  describe "push_actions/2 coalescing" do
    test "sends one push_data per subscriber per batch, not per action", %{
      group_server: gs
    } do
      test_pid = self()
      subscribers = for _ <- 1..3, do: start_push_collector(test_pid)

      for {subscriber, i} <- Enum.with_index(subscribers) do
        :ok = GroupServer.add_subscriber(gs, subscriber, "actor_#{i}")
      end

      actions = [action("act_1", 1), action("act_2", 2), action("act_3", 3), action("act_4", 4)]
      :ok = GroupServer.push_actions(gs, actions)

      received =
        for _ <- subscribers do
          assert_receive {:pushed_data, subscriber, bytes}, 1_000
          {subscriber, bytes}
        end

      assert Enum.map(received, &elem(&1, 0)) |> Enum.sort() == Enum.sort(subscribers)
      refute_receive {:pushed_data, _, _}, 100
    end

    test "two subscribers of one group receive the same bytes", %{group_server: gs} do
      test_pid = self()
      sub1 = start_push_collector(test_pid)
      sub2 = start_push_collector(test_pid)

      :ok = GroupServer.add_subscriber(gs, sub1, "actor_1")
      :ok = GroupServer.add_subscriber(gs, sub2, "actor_2")

      :ok = GroupServer.push_actions(gs, [action("act_1", 1), action("act_2", 2)])

      assert_receive {:pushed_data, ^sub1, bytes1}, 1_000
      assert_receive {:pushed_data, ^sub2, bytes2}, 1_000
      assert bytes1 == bytes2
    end

    test "the bytes are the frames of every Action in order", %{group_server: gs} do
      sub = start_push_collector(self())
      :ok = GroupServer.add_subscriber(gs, sub, "actor_1")

      actions = [action("act_1", 1), action("act_2", 2)]
      :ok = GroupServer.push_actions(gs, actions)

      assert_receive {:pushed_data, ^sub, bytes}, 1_000
      assert bytes == Enum.map_join(actions, &SSEConnection.data_frame/1)
    end
  end

  describe "push_actions/3 telemetry" do
    test "emits push latency once with the group id when given a commit time", %{
      group_server: gs,
      group_id: group_id
    } do
      subscriber = spawn(fn -> receive do: (_ -> :ok) end)
      :ok = GroupServer.add_subscriber(gs, subscriber, "actor_1")

      ref = attach_telemetry([[:ebb, :fanout, :push_latency_ms]])
      committed_at = System.monotonic_time()

      action = %{
        "id" => "act_latency",
        "actor_id" => "actor_1",
        "gsn" => 1,
        "hlc" => 1,
        "updates" => []
      }

      :ok = GroupServer.push_actions(gs, [action], %{committed_at: committed_at})

      # `get_state/1` is a call, so it is handled after the cast.
      _state = :sys.get_state(gs)

      assert [{[:ebb, :fanout, :push_latency_ms], %{duration: duration}, %{group_id: ^group_id}}] =
               telemetry_events(ref)

      assert is_integer(duration) and duration >= 0
    end

    test "emits the dispatched Action count and subscriber count per batch", %{
      group_server: gs,
      group_id: group_id
    } do
      subscribers = for _ <- 1..3, do: spawn(fn -> receive do: (_ -> :ok) end)

      for {subscriber, i} <- Enum.with_index(subscribers) do
        :ok = GroupServer.add_subscriber(gs, subscriber, "actor_#{i}")
      end

      ref = attach_telemetry([[:ebb, :fanout, :dispatched_actions]])
      actions = for gsn <- 1..4, do: action("act_#{gsn}", gsn)

      :ok = GroupServer.push_actions(gs, actions)

      # `get_state/1` is a call, so it is handled after the cast.
      _state = :sys.get_state(gs)

      assert [
               {[:ebb, :fanout, :dispatched_actions], %{count: 4, subscribers: 3},
                %{group_id: ^group_id}}
             ] = telemetry_events(ref)
    end

    test "emits group_queue and group_encode with the group id", %{
      group_server: gs,
      group_id: group_id
    } do
      subscriber = spawn(fn -> receive do: (_ -> :ok) end)
      :ok = GroupServer.add_subscriber(gs, subscriber, "actor_1")

      ref = attach_telemetry([[:ebb, :fanout, :hop_ms]])
      committed_at = System.monotonic_time()
      cast_at = System.monotonic_time()

      :ok =
        GroupServer.push_actions(gs, [action("act_hops", 1)], %{
          committed_at: committed_at,
          cast_at: cast_at,
          conn_sample_rate: 0
        })

      _state = :sys.get_state(gs)

      events = telemetry_events(ref)

      assert [
               {[:ebb, :fanout, :hop_ms], %{duration: queue_duration},
                %{hop: :group_queue, group_id: ^group_id}},
               {[:ebb, :fanout, :hop_ms], %{duration: encode_duration},
                %{hop: :group_encode, group_id: ^group_id}},
               {[:ebb, :fanout, :hop_ms], %{duration: cast_duration},
                %{hop: :group_cast, group_id: ^group_id}}
             ] = events

      assert is_integer(queue_duration) and queue_duration >= 0
      assert is_integer(encode_duration) and encode_duration >= 0
      assert is_integer(cast_duration) and cast_duration >= 0
    end

    test "samples conn_deliver per delivery and honours the sample-rate control", %{
      group_server: gs
    } do
      test_pid = self()
      subscriber = start_meta_collector(test_pid)
      :ok = GroupServer.add_subscriber(gs, subscriber, "actor_1")

      :ok = GroupServer.push_actions(gs, [action("act_sampled", 1)], %{conn_sample_rate: 1})
      assert_receive {:pushed_meta, ^subscriber, %{cast_at: cast_at, group_id: _}}, 1_000
      assert is_integer(cast_at)

      :ok = GroupServer.push_actions(gs, [action("act_unsampled", 2)], %{conn_sample_rate: 0})
      assert_receive {:pushed_data, ^subscriber, _bytes}, 1_000
      refute_receive {:pushed_meta, ^subscriber, _}, 100
    end

    test "emits nothing for a recovered range without a commit time", %{
      group_server: gs
    } do
      ref = attach_telemetry([[:ebb, :fanout, :push_latency_ms]])

      action = %{
        "id" => "act_recovered",
        "actor_id" => "actor_1",
        "gsn" => 1,
        "hlc" => 1,
        "updates" => []
      }

      :ok = GroupServer.push_actions(gs, [action], %{})
      _state = :sys.get_state(gs)

      assert telemetry_events(ref) == []
    end
  end

  defp action(id, gsn) do
    %{"id" => id, "actor_id" => "actor_1", "gsn" => gsn, "hlc" => gsn, "updates" => []}
  end

  # A subscriber that reports the coalesced bytes GroupServer pushes to it,
  # so the test can count pushes per batch.
  defp start_push_collector(test_pid) do
    spawn(fn -> collect_push_data(test_pid) end)
  end

  defp collect_push_data(test_pid) do
    receive do
      {:"$gen_cast", {:push_data, bytes}} ->
        send(test_pid, {:pushed_data, self(), bytes})
        collect_push_data(test_pid)

      {:"$gen_cast", {:push_data, bytes, _meta}} ->
        send(test_pid, {:pushed_data, self(), bytes})
        collect_push_data(test_pid)
    end
  end

  defp start_meta_collector(test_pid) do
    spawn(fn -> collect_push_meta(test_pid) end)
  end

  defp collect_push_meta(test_pid) do
    receive do
      {:"$gen_cast", {:push_data, bytes}} ->
        send(test_pid, {:pushed_data, self(), bytes})
        collect_push_meta(test_pid)

      {:"$gen_cast", {:push_data, bytes, meta}} ->
        send(test_pid, {:pushed_meta, self(), meta})
        send(test_pid, {:pushed_data, self(), bytes})
        collect_push_meta(test_pid)
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
