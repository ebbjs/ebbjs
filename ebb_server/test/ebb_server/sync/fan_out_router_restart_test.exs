defmodule EbbServer.Sync.FanOutRouterRestartTest do
  @moduledoc """
  Regression tests for #286.

  `FanOutRouter` buffers committed ranges in memory until the resolution
  watermark passes them. Before this fix a Router restart started from an
  empty buffer, so any range waiting at crash time — and any commit that
  landed while the Router was down — was never pushed live.

  The Router now resumes from a persisted last-pushed frontier
  (`EbbServer.Sync.FanOutFrontier`) and re-derives the un-pushed committed
  ranges from the log on `init/1`.
  """

  use ExUnit.Case, async: false
  use EbbServer.Integration.StorageCase

  import EbbServer.TestHelpers

  alias EbbServer.Integration.ActionHelpers
  alias EbbServer.Storage.{GsnCounter, RocksDB, WatermarkTracker}
  alias EbbServer.Sync.{FanOutFrontier, FanOutRouter, SSEConnection}

  describe "restart resume (#286)" do
    test "restart after the watermark advances re-pushes a range waiting at crash time" do
      group_id = "g_286_accept_#{:erlang.unique_integer([:positive])}"
      actor_id = "a_286_accept_#{:erlang.unique_integer([:positive])}"

      {:ok, sse_pid} = SSEConnection.start_link(self(), [group_id], %{group_id => 0})
      :ok = FanOutRouter.subscribe([group_id], sse_pid, actor_id)

      # Hold the watermark back: reserve GSN 1 without resolving it. The
      # real batch below commits at GSN 2 and is buffered behind the hole.
      %{gsn_counter: counter} = GsnCounter.get_resources()
      assert {1, 1} = GsnCounter.claim_gsn_range(1, counter)

      post_bootstrap!(actor_id, group_id)

      # The batch is committed but gated: the Router holds it in memory.
      assert :sys.get_state(FanOutRouter).pending_notifications == [{2, 2}]

      :ok = terminate_router()

      WatermarkTracker.mark_range_resolved(1, 1)
      WatermarkTracker.advance_watermark()

      {:ok, _pid} = restart_router()

      assert_receive {:sse_chunk, "data", json}, 5_000
      assert Jason.decode!(json)["actor_id"] == actor_id

      sync_router()
      assert FanOutFrontier.get() == {:ok, 2}
      :ok = FanOutRouter.unsubscribe(sse_pid)
    end

    test "hard-killing the Router resumes from the persisted frontier" do
      group_id = "g_286_kill_#{:erlang.unique_integer([:positive])}"
      actor_id = "a_286_kill_#{:erlang.unique_integer([:positive])}"

      {:ok, sse_pid} = SSEConnection.start_link(self(), [group_id], %{group_id => 0})
      :ok = FanOutRouter.subscribe([group_id], sse_pid, actor_id)

      # Hold the watermark back: reserve GSN 1 without resolving it. The
      # real batch below commits at GSN 2 and is buffered behind the hole.
      %{gsn_counter: counter} = GsnCounter.get_resources()
      assert {1, 1} = GsnCounter.claim_gsn_range(1, counter)
      post_bootstrap!(actor_id, group_id)
      assert :sys.get_state(FanOutRouter).pending_notifications == [{2, 2}]

      # `:kill` skips `terminate/2`, so the in-memory buffer dies abruptly
      # and only the persisted frontier can carry the resume.
      old_pid = Process.whereis(FanOutRouter)
      Process.exit(old_pid, :kill)
      new_pid = wait_for_new_router(old_pid)

      WatermarkTracker.mark_range_resolved(1, 1)
      WatermarkTracker.advance_watermark()

      # The resumed Router reads the watermark during `init/1`; nudging the
      # new pid here re-drains the recovered range deterministically instead
      # of racing that init-time read against the advance above.
      send(new_pid, {:range_resolved, 1, 1})

      assert_receive {:sse_chunk, "data", json}, 5_000
      assert Jason.decode!(json)["actor_id"] == actor_id

      sync_router()
      assert FanOutFrontier.get() == {:ok, 2}
      :ok = FanOutRouter.unsubscribe(sse_pid)
    end

    test "a sub-frontier duplicate range does not rewind the persisted frontier" do
      group_id = "g_286_rewind_#{:erlang.unique_integer([:positive])}"
      actor_id = "a_286_rewind_#{:erlang.unique_integer([:positive])}"

      # Two committed batches move the Router's frontier to GSN 2.
      post_bootstrap!(actor_id, group_id)
      post_bootstrap!(actor_id, group_id <> "_b")
      :sys.get_state(FanOutRouter)
      assert FanOutFrontier.get() == {:ok, 2}

      # A stale replay below the frontier must not lower it, in memory or
      # on the persisted frontier.
      send(FanOutRouter, {:batch_committed, 1, 1, %{}, nil})
      state = :sys.get_state(FanOutRouter)

      assert state.last_pushed_gsn == 2
      assert FanOutFrontier.get() == {:ok, 2}
    end

    test "a restored buffered range drains on the existing range_resolved nudge" do
      group_id = "g_286_nudge_#{:erlang.unique_integer([:positive])}"
      actor_id = "a_286_nudge_#{:erlang.unique_integer([:positive])}"

      {:ok, sse_pid} = SSEConnection.start_link(self(), [group_id], %{group_id => 0})
      :ok = FanOutRouter.subscribe([group_id], sse_pid, actor_id)

      %{gsn_counter: counter} = GsnCounter.get_resources()
      assert {1, 1} = GsnCounter.claim_gsn_range(1, counter)
      post_bootstrap!(actor_id, group_id)

      :ok = terminate_router()

      # Restart before the frontier moves: the range is re-derived from the
      # log and buffered again, still gated on the unresolved hole.
      {:ok, _pid} = restart_router()
      assert :sys.get_state(FanOutRouter).pending_notifications == [{2, 2}]
      assert_no_chunk(200)

      WatermarkTracker.mark_range_resolved(1, 1)
      WatermarkTracker.advance_watermark()

      send(FanOutRouter, {:range_resolved, 1, 1})

      assert_receive {:sse_chunk, "data", json}, 5_000
      assert Jason.decode!(json)["actor_id"] == actor_id

      :ok = FanOutRouter.unsubscribe(sse_pid)
    end

    test "a cold start does not replay historical actions" do
      group_id = "g_286_cold_#{:erlang.unique_integer([:positive])}"
      actor_id = "a_286_cold_#{:erlang.unique_integer([:positive])}"

      post_bootstrap!(actor_id, group_id)

      {:ok, sse_pid} = SSEConnection.start_link(self(), [group_id], %{group_id => 0})
      :ok = FanOutRouter.subscribe([group_id], sse_pid, actor_id)

      # An empty frontier forces the cold-start path even though the log
      # already has a committed Action.
      :ok = FanOutFrontier.reset()
      :ok = terminate_router()
      {:ok, _pid} = restart_router()

      assert_no_chunk(500)
      :ok = FanOutRouter.unsubscribe(sse_pid)
    end

    test "recovers a batch committed while the Router was down" do
      group_id = "g_286_down_#{:erlang.unique_integer([:positive])}"
      actor_id = "a_286_down_#{:erlang.unique_integer([:positive])}"

      {:ok, sse_pid} = SSEConnection.start_link(self(), [group_id], %{group_id => 0})
      :ok = FanOutRouter.subscribe([group_id], sse_pid, actor_id)

      :ok = terminate_router()
      assert FanOutFrontier.get() == {:ok, 0}

      # The Writer's `Process.whereis/1` guard drops this notification, so
      # the only way the batch reaches the subscriber is log re-derivation.
      post_bootstrap!(actor_id, group_id)
      assert_no_chunk(200)

      {:ok, _pid} = restart_router()

      assert_receive {:sse_chunk, "data", json}, 5_000
      assert Jason.decode!(json)["actor_id"] == actor_id
      sync_router()
      assert FanOutFrontier.get() == {:ok, 1}

      :ok = FanOutRouter.unsubscribe(sse_pid)
    end

    test "a recovered range emits no push latency sample" do
      group_id = "g_363_recover_#{:erlang.unique_integer([:positive])}"
      actor_id = "a_363_recover_#{:erlang.unique_integer([:positive])}"

      {:ok, sse_pid} = SSEConnection.start_link(self(), [group_id], %{group_id => 0})
      :ok = FanOutRouter.subscribe([group_id], sse_pid, actor_id)

      :ok = terminate_router()
      post_bootstrap!(actor_id, group_id)

      # A recovered range has no commit time, so the resumed push must not
      # be reported as a latency sample.
      ref = attach_telemetry([[:ebb, :fanout, :push_latency_ms]])
      {:ok, _pid} = restart_router()

      assert_receive {:sse_chunk, "data", _json}, 5_000
      refute_received {:telemetry_event, ^ref, [:ebb, :fanout, :push_latency_ms], _, _}

      :ok = FanOutRouter.unsubscribe(sse_pid)
    end
  end

  describe "recover_committed/2" do
    test "folds present GSNs into contiguous ranges and groups them by GSN" do
      put_action!(2, "act_2")
      put_action!(3, "act_3")
      put_action!(5, "act_5")

      put_group_action!("g_a", 2, "act_2")
      put_group_action!("g_b", 2, "act_2")
      put_group_action!("g_a", 3, "act_3")
      put_group_action!("g_a", 5, "act_5")
      # Outside [1, 5]: must not leak into the recovery window.
      put_group_action!("g_c", 10, "act_10")

      assert {ranges, groups_by_gsn} = FanOutRouter.recover_committed(1, 5)
      assert ranges == [{2, 3}, {5, 5}]

      assert groups_by_gsn == %{
               2 => ["g_a", "g_b"],
               3 => ["g_a"],
               5 => ["g_a"]
             }
    end

    test "returns no ranges and no groups when the window has no committed actions" do
      assert FanOutRouter.recover_committed(1, 3) == {[], %{}}
    end

    test "a bounded window ignores actions above its end" do
      put_action!(1, "act_1")
      put_action!(2, "act_2")
      put_action!(9, "act_9")

      assert {ranges, _groups} = FanOutRouter.recover_committed(1, 2)
      assert ranges == [{1, 2}]
    end
  end

  defp put_action!(gsn, action_id) do
    action = %{
      "id" => action_id,
      "gsn" => gsn,
      "actor_id" => "actor",
      "hlc" => 0,
      "updates" => []
    }

    :ok =
      RocksDB.write_batch([
        {:put, RocksDB.cf_actions(), RocksDB.encode_gsn_key(gsn), :erlang.term_to_binary(action)}
      ])
  end

  defp put_group_action!(group_id, gsn, action_id) do
    key = RocksDB.encode_group_action_key(group_id, gsn)
    :ok = RocksDB.write_batch([{:put, RocksDB.cf_group_actions(), key, action_id}])
  end

  defp post_bootstrap!(actor_id, group_id) do
    conn = ActionHelpers.bootstrap_group(actor_id, group_id, ["todo.*"])
    assert conn.status == 200
    assert conn.resp_body == ~s({"rejected":[]})
  end

  defp terminate_router do
    Supervisor.terminate_child(EbbServer.Sync.Supervisor, FanOutRouter)
  end

  defp restart_router do
    Supervisor.restart_child(EbbServer.Sync.Supervisor, FanOutRouter)
  end

  # `:kill` is asynchronous: the supervisor restarts the child, but
  # `Process.whereis/1` can briefly return the dead pid (or nil) in between.
  defp wait_for_new_router(old_pid, attempts \\ 100)

  defp wait_for_new_router(_old_pid, 0) do
    flunk("FanOutRouter did not restart after being killed")
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

  # Blocks until the Router has finished handling the message that pushed the
  # range, so the persisted frontier reflects that push.
  defp sync_router, do: :sys.get_state(FanOutRouter)

  defp assert_no_chunk(timeout) do
    refute_receive {:sse_chunk, "data", _}, timeout
  end
end
