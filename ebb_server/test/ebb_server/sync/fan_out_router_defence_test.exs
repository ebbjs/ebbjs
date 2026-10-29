defmodule EbbServer.Sync.FanOutRouterDefenceTest do
  @moduledoc """
  The Router's defence branches (#641 slice 10).

  Covers a restart with nothing to recover, a subscribe whose GroupServer
  cannot start, re-subscribe bookkeeping, presence forwarding, and an
  Action that scopes no Update to a group its commit snapshot names.

  Every case runs through the Router's public surface — `subscribe/3`,
  `broadcast_presence/4`, the Writer's `{:batch_committed, ...}` hand-off
  and the Sync supervisor's Router restart — against real GroupServers and
  SSE connections, so a lost push or a silently dropped subscriber shows
  up as a missing frame rather than as a state assertion.
  """

  use ExUnit.Case, async: false
  use EbbServer.Integration.StorageCase

  import EbbServer.SSEHelpers
  import EbbServer.TestHelpers

  alias EbbServer.Integration.ActionHelpers
  alias EbbServer.Storage.{ActionFormat, RocksDB, WatermarkTracker}

  alias EbbServer.Sync.{
    FanOutFrontier,
    FanOutRouter,
    GroupDynamicSupervisor,
    SSEConnection
  }

  describe "restart resume with nothing to recover" do
    test "keeps its place in the log and pushes the next commit" do
      first_group = "g_641_10_resume_a_#{:erlang.unique_integer([:positive])}"
      second_group = "g_641_10_resume_b_#{:erlang.unique_integer([:positive])}"
      actor_id = "a_641_10_resume_#{:erlang.unique_integer([:positive])}"

      first_gsn = post_bootstrap!(actor_id, first_group)
      sync_router()
      assert FanOutFrontier.get() == {:ok, first_gsn}

      sse = subscribe!(first_group, actor_id)

      :ok = terminate_router()
      {:ok, _pid} = restart_router()

      state = :sys.get_state(FanOutRouter)
      assert state.plan.pending_notifications == []
      assert state.plan.last_pushed_gsn == first_gsn
      assert FanOutFrontier.get() == {:ok, first_gsn}

      # A frontier already level with the log must not replay, so there is
      # no un-pushed range to deliver.
      refute_sse_data(300)

      :ok = FanOutRouter.subscribe([second_group], sse, actor_id)

      second_gsn = post_bootstrap!(actor_id, second_group)
      assert second_gsn == first_gsn + 1

      bytes = receive_sse_data()
      assert Jason.decode!(single_data_payload(bytes))["actor_id"] == actor_id

      sync_router()
      assert FanOutFrontier.get() == {:ok, second_gsn}

      :ok = FanOutRouter.unsubscribe(sse)
    end
  end

  describe "subscribe when the GroupServer cannot start" do
    test "crashes the Router instead of reporting a subscription it does not have" do
      group_id = "g_641_10_noserver_#{:erlang.unique_integer([:positive])}"
      connection = spawn(fn -> Process.sleep(:infinity) end)
      on_exit(fn -> Process.exit(connection, :kill) end)

      supervisor = Process.whereis(GroupDynamicSupervisor)
      %{max_children: max_children} = :sys.get_state(supervisor)

      on_exit(fn ->
        if Process.alive?(supervisor), do: set_max_children(supervisor, max_children)
      end)

      # The group supervisor handle is the seam: a real DynamicSupervisor
      # that genuinely refuses the child, as an out-of-slots one would.
      set_max_children(supervisor, 0)

      old_router = Process.whereis(FanOutRouter)
      reason = catch_exit(FanOutRouter.subscribe([group_id], connection, "a_641_10_noserver"))

      assert inspect(reason) =~ "Failed to start GroupServer for #{group_id}"
      assert inspect(reason) =~ ":max_children"

      set_max_children(supervisor, max_children)

      # The supervised Router is back, and the refused subscription left no
      # half-registered connection behind.
      new_router = wait_for_new_router(old_router)
      assert new_router != old_router
      assert :sys.get_state(FanOutRouter).subscriptions == %{}

      :ok = FanOutRouter.subscribe([group_id], connection, "a_641_10_noserver")
      :ok = FanOutRouter.unsubscribe(connection)
    end
  end

  describe "re-subscribe from one connection" do
    test "reuses its monitor and does not duplicate its groups" do
      first_group = "g_641_10_resub_a_#{:erlang.unique_integer([:positive])}"
      second_group = "g_641_10_resub_b_#{:erlang.unique_integer([:positive])}"
      actor_id = "a_641_10_resub_#{:erlang.unique_integer([:positive])}"

      {:ok, sse} = SSEConnection.start_link(self(), [first_group], %{first_group => 0})
      :ok = FanOutRouter.subscribe([first_group], sse, actor_id)

      state = :sys.get_state(FanOutRouter)
      monitor = state.monitors[sse]
      assert is_reference(monitor)
      assert state.subscriptions[sse] == [first_group]

      :ok = FanOutRouter.subscribe([first_group, second_group], sse, actor_id)

      state = :sys.get_state(FanOutRouter)
      assert state.subscriptions[sse] == [first_group, second_group]
      assert state.monitors[sse] == monitor

      :ok = FanOutRouter.unsubscribe(sse)

      state = :sys.get_state(FanOutRouter)
      refute Map.has_key?(state.subscriptions, sse)
      refute Map.has_key?(state.monitors, sse)
    end
  end

  describe "presence forwarding" do
    test "a broadcast reaches the group's connection" do
      group_id = "g_641_10_presence_#{:erlang.unique_integer([:positive])}"

      {:ok, sse} = SSEConnection.start_link(self(), [group_id], %{group_id => 0})
      :ok = FanOutRouter.subscribe([group_id], sse, "a_641_10_presence_self")

      :ok =
        FanOutRouter.broadcast_presence(
          [group_id],
          "doc_641_10_presence",
          "a_641_10_presence_other",
          %{"status" => "typing"}
        )

      assert_receive {:sse_chunk, "presence", payload}, 5_000

      assert Jason.decode!(payload) == %{
               "actor_id" => "a_641_10_presence_other",
               "entity_id" => "doc_641_10_presence",
               "data" => %{"status" => "typing"}
             }

      :ok = FanOutRouter.unsubscribe(sse)
    end
  end

  describe "a group with no scoped Update (#473)" do
    test "is pushed nothing while the scoped group and the frontier still advance" do
      scoped_group = "g_641_10_scope_a_#{:erlang.unique_integer([:positive])}"
      unscoped_group = "g_641_10_scope_b_#{:erlang.unique_integer([:positive])}"
      actor_id = "a_641_10_scope_#{:erlang.unique_integer([:positive])}"
      action_id = "act_641_10_scope_#{:erlang.unique_integer([:positive])}"

      scoped_sse = subscribe!(scoped_group, actor_id)
      unscoped_sse = subscribe!(unscoped_group, actor_id)

      gsn = WatermarkTracker.committed_watermark() + 1
      carried = carried_payload([[scoped_group]], action_id, actor_id)

      :ok = WatermarkTracker.mark_range_committed(gsn, gsn)
      assert WatermarkTracker.advance_watermark() == gsn

      # The commit snapshot names both groups, but the only Update scopes to
      # the first: the second group has nothing to deliver and must not be
      # handed an Action with an empty Update list.
      groups_by_gsn = %{gsn => [scoped_group, unscoped_group]}

      send(
        FanOutRouter,
        {:batch_committed, gsn, gsn, groups_by_gsn, System.monotonic_time(), [carried]}
      )

      bytes = receive_sse_data()
      assert [%{"id" => ^action_id}] = bytes |> data_payloads() |> Enum.map(&Jason.decode!/1)
      refute_sse_data(300)

      sync_router()
      assert FanOutFrontier.get() == {:ok, gsn}

      :ok = FanOutRouter.unsubscribe(scoped_sse)
      :ok = FanOutRouter.unsubscribe(unscoped_sse)
    end
  end

  defp subscribe!(group_id, actor_id) do
    {:ok, sse} = SSEConnection.start_link(self(), [group_id], %{group_id => 0})
    :ok = FanOutRouter.subscribe([group_id], sse, actor_id)
    sse
  end

  # Commits one bootstrap Action through the HTTP write path and returns
  # the GSN it committed at, so the Router's frontier is known exactly.
  defp post_bootstrap!(actor_id, group_id) do
    conn = ActionHelpers.bootstrap_group(actor_id, group_id, ["todo.*"])
    assert conn.status == 200
    assert conn.resp_body == ~s({"rejected":[]})
    RocksDB.get_max_gsn()
  end

  defp carried_payload(scopes, action_id, actor_id) do
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

  defp set_max_children(supervisor, max_children) do
    :sys.replace_state(supervisor, &%{&1 | max_children: max_children})
  end

  defp terminate_router do
    Supervisor.terminate_child(EbbServer.Sync.Supervisor, FanOutRouter)
  end

  defp restart_router do
    Supervisor.restart_child(EbbServer.Sync.Supervisor, FanOutRouter)
  end

  # `Supervisor.restart_child/2` can hand back the pid before `init/1` has
  # finished, so the state read below is what actually serialises on it.
  defp sync_router, do: :sys.get_state(FanOutRouter)

  defp wait_for_new_router(old_pid, attempts \\ 100)

  defp wait_for_new_router(_old_pid, 0) do
    flunk("FanOutRouter did not restart")
  end

  defp wait_for_new_router(old_pid, attempts) do
    case Process.whereis(FanOutRouter) do
      pid when is_pid(pid) and pid != old_pid ->
        pid

      _ ->
        Process.sleep(10)
        wait_for_new_router(old_pid, attempts - 1)
    end
  end
end
