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

  import EbbServer.SSEHelpers
  import EbbServer.TestHelpers

  alias EbbServer.Integration.ActionHelpers
  alias EbbServer.Storage.{GsnCounter, WatermarkTracker}
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
      assert :sys.get_state(FanOutRouter).plan.pending_notifications == [{2, 2}]

      :ok = terminate_router()

      WatermarkTracker.mark_range_resolved(1, 1)
      WatermarkTracker.advance_watermark()

      {:ok, _pid} = restart_router()

      bytes = receive_sse_data()
      assert Jason.decode!(single_data_payload(bytes))["actor_id"] == actor_id

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
      assert :sys.get_state(FanOutRouter).plan.pending_notifications == [{2, 2}]

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

      bytes = receive_sse_data()
      assert Jason.decode!(single_data_payload(bytes))["actor_id"] == actor_id

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
      # on the persisted frontier. It predates the payload hand-off, so the
      # payloads are omitted intentionally and the Router takes the log path.
      send(FanOutRouter, {:batch_committed, 1, 1, %{}, nil, nil})
      state = :sys.get_state(FanOutRouter)

      assert state.plan.last_pushed_gsn == 2
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
      assert :sys.get_state(FanOutRouter).plan.pending_notifications == [{2, 2}]
      assert_no_chunk(200)

      WatermarkTracker.mark_range_resolved(1, 1)
      WatermarkTracker.advance_watermark()

      send(FanOutRouter, {:range_resolved, 1, 1})

      bytes = receive_sse_data()
      assert Jason.decode!(single_data_payload(bytes))["actor_id"] == actor_id

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

      bytes = receive_sse_data()
      assert Jason.decode!(single_data_payload(bytes))["actor_id"] == actor_id
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

      _bytes = receive_sse_data()
      refute_received {:telemetry_event, ^ref, [:ebb, :fanout, :push_latency_ms], _, _}

      :ok = FanOutRouter.unsubscribe(sse_pid)
    end
  end

  describe "per-Update delivery on recovery (#473)" do
    test "a spanning Action recovered while the Router was down is delivered per scope" do
      actor_id = "a_473_rec_#{:erlang.unique_integer([:positive])}"
      g1 = "g_473_rec_a_#{:erlang.unique_integer([:positive])}"
      g2 = "g_473_rec_b_#{:erlang.unique_integer([:positive])}"

      assert ActionHelpers.bootstrap_group(actor_id, g1, ["todo.*", "entityGroup.*"]).status ==
               200

      assert ActionHelpers.bootstrap_group(actor_id, g2, ["todo.*", "entityGroup.*"]).status ==
               200

      # Seed an entity in g2 before anyone subscribes, so the recovered
      # window holds only the spanning Action.
      hlc = generate_hlc()
      other_id = "todo_473_rec_other_#{:erlang.unique_integer([:positive])}"

      seed = %{
        "id" => "act_473_rec_seed_#{:erlang.unique_integer([:positive])}",
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

      {:ok, sse1} = SSEConnection.start_link(self(), [g1], %{g1 => 0})
      {:ok, sse2} = SSEConnection.start_link(self(), [g2], %{g2 => 0})
      :ok = FanOutRouter.subscribe([g1], sse1, actor_id)
      :ok = FanOutRouter.subscribe([g2], sse2, actor_id)

      # The Router is down when the spanning Action commits, so only log
      # re-derivation and the recovered group index can deliver it.
      :ok = terminate_router()

      leaked_id = "todo_473_rec_leak_#{:erlang.unique_integer([:positive])}"
      eg_leak = "eg_473_rec_leak_#{:erlang.unique_integer([:positive])}"
      # The row the seed already minted for the pair: re-putting it is
      # idempotent, a second row for a live pair is not (#623).
      eg_other = ActionHelpers.membership_row_id(other_id, g2)

      action = %{
        "id" => "act_473_rec_span_#{:erlang.unique_integer([:positive])}",
        "actor_id" => actor_id,
        "hlc" => hlc,
        "updates" => [
          todo_update(leaked_id, hlc),
          entity_group_put(eg_leak, leaked_id, g1, hlc),
          entity_group_put(eg_other, other_id, g2, hlc)
        ]
      }

      assert ActionHelpers.post_actions(
               ActionHelpers.msgpack_encode!(%{"actions" => [action]}),
               actor_id
             ).status == 200

      {:ok, _pid} = restart_router()

      scoped =
        1..2
        |> Enum.map(fn _ ->
          bytes = receive_sse_data()
          update_subject_ids(Jason.decode!(single_data_payload(bytes)))
        end)
        |> Enum.sort()

      assert scoped == Enum.sort([Enum.sort([leaked_id, eg_leak]), [eg_other]])

      :ok = FanOutRouter.unsubscribe(sse1)
      :ok = FanOutRouter.unsubscribe(sse2)
    end
  end

  defp todo_update(entity_id, hlc) do
    %{
      "id" => "upd_473_rec_#{:erlang.unique_integer([:positive])}",
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

  defp update_subject_ids(payload) do
    payload |> Map.get("updates") |> Enum.map(& &1["subject_id"]) |> Enum.sort()
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
    refute_sse_data(timeout)
  end
end
