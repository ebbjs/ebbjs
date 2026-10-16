defmodule EbbServer.Sync.GroupServerTest do
  @moduledoc """
  Tests for GroupServer.
  """

  use ExUnit.Case, async: false
  use EbbServer.Integration.StorageCase

  import EbbServer.TestHelpers

  alias EbbServer.Sync.{GroupServer, SSEConnection}

  # Byte-for-byte output of the pre-encode-once fan-out encoder. Pinning the
  # literal keeps the wire format (field set, forbidden extras, key order)
  # under test rather than recomputing it the way the code does.
  @pinned_action_payload "{\"actor_id\":\"actor_1\",\"gsn\":1,\"hlc\":1711036800000," <>
                           "\"id\":\"act_1\",\"updates\":[{\"field\":\"text\"," <>
                           "\"path\":[\"title\"],\"value\":\"Hello\"}]}"

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

  describe "push_actions/2 fan-out encoding" do
    test "encodes each action once per cast, not once per subscriber", %{
      group_server: gs,
      group_id: group_id
    } do
      sse_pids =
        for i <- 1..4 do
          {:ok, pid} = SSEConnection.start_link(self(), [group_id], %{group_id => 0})
          :ok = GroupServer.add_subscriber(gs, pid, "actor_#{i}")
          pid
        end

      actions =
        for i <- 1..3 do
          %{
            "id" => "act_#{i}",
            "actor_id" => "actor_1",
            "gsn" => i,
            "hlc" => 1_711_036_800_000 + i,
            "updates" => [%{"path" => ["title"], "field" => "text", "value" => "v#{i}"}]
          }
        end

      trace_targets = [gs | sse_pids]

      # `trace_pattern/3` only takes effect for an already-loaded module; the
      # first call would otherwise return 0 and trace nothing.
      {:module, Jason} = Code.ensure_loaded(Jason)
      Enum.each(trace_targets, &:erlang.trace(&1, true, [:call]))

      assert :erlang.trace_pattern({Jason, :encode!, 1}, true, [:global]) > 0

      on_exit(fn ->
        :erlang.trace_pattern({Jason, :encode!, 1}, false, [:global])
      end)

      :ok = GroupServer.push_actions(gs, actions)

      # `:sys.get_state/1` is a call, so the cast is fully handled (and the
      # encodes done) by the time it returns. Flushing each subscriber makes
      # the test independent of how the payloads are forwarded.
      _state = :sys.get_state(gs)
      Enum.each(sse_pids, &:sys.get_state/1)

      :erlang.trace_pattern({Jason, :encode!, 1}, false, [:global])
      Enum.each(trace_targets, &:erlang.trace(&1, false, [:call]))

      encode_count = count_encode_calls()

      assert encode_count == length(actions),
             "expected one encode per action (#{length(actions)}), got #{encode_count}"
    end

    test "two subscribers receive byte-identical payloads", %{
      group_server: gs,
      group_id: group_id
    } do
      action = %{
        "id" => "act_1",
        "actor_id" => "actor_1",
        "gsn" => 1,
        "hlc" => 1_711_036_800_000,
        "updates" => [%{"path" => ["title"], "field" => "text", "value" => "Hello"}],
        # Not a wire field; must not leak into the payload.
        "extra_ignored" => "nope"
      }

      for i <- 1..2 do
        {:ok, pid} = SSEConnection.start_link(self(), [group_id], %{group_id => 0})
        :ok = GroupServer.add_subscriber(gs, pid, "actor_#{i}")
      end

      :ok = GroupServer.push_actions(gs, [action])

      assert_receive {:sse_chunk, "data", payload_1}
      assert_receive {:sse_chunk, "data", payload_2}

      assert payload_1 == @pinned_action_payload
      assert payload_2 == @pinned_action_payload
    end
  end

  defp count_encode_calls(acc \\ 0) do
    receive do
      {:trace, _pid, :call, {Jason, :encode!, [_action]}} -> count_encode_calls(acc + 1)
    after
      200 -> acc
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

      :ok = GroupServer.push_actions(gs, [action], committed_at)

      # `get_state/1` is a call, so it is handled after the cast.
      _state = :sys.get_state(gs)

      assert [{[:ebb, :fanout, :push_latency_ms], %{duration: duration}, %{group_id: ^group_id}}] =
               telemetry_events(ref)

      assert is_integer(duration) and duration >= 0
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

      :ok = GroupServer.push_actions(gs, [action], nil)
      _state = :sys.get_state(gs)

      assert telemetry_events(ref) == []
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
