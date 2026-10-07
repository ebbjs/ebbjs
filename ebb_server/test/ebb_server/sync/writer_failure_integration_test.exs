defmodule EbbServer.Sync.WriterFailureHttpTest do
  @moduledoc """
  A failed commit surfaces as `503 write_failed` (ebbjs/ebbjs#282).
  """

  use ExUnit.Case, async: false
  use EbbServer.Integration.StorageCase, with_auth_mode: true

  alias EbbServer.Integration.ActionHelpers

  def storage_writer_opts do
    [commit_fn: fn _ops, _opts -> {:error, :injected_rocksdb_failure} end]
  end

  test "POST /sync/actions returns 503 write_failed when the commit fails" do
    actor_id = "a_282_fail_#{:erlang.unique_integer([:positive])}"
    group_id = "g_282_fail_#{:erlang.unique_integer([:positive])}"

    conn = ActionHelpers.bootstrap_group(actor_id, group_id, ["todo.*"])

    assert conn.status == 503
    assert conn.resp_body == ~s({"error":"write_failed"})
  end
end

defmodule EbbServer.Sync.WriterCacheEscalationTest do
  @moduledoc """
  A cache update that fails *after* a durable commit escalates to a
  storage rebuild, and reads stay consistent from the log
  (ebbjs/ebbjs#282).
  """

  use ExUnit.Case, async: false
  use EbbServer.Integration.StorageCase

  alias EbbServer.Storage.{CacheTables, GroupCache, RocksDB, WatermarkTracker, Writer}
  alias EbbServer.TestHelpers

  # A cache table that never exists: the commit lands, then the Writer's
  # `update_system_caches/2` raises on the insert.
  def storage_writer_opts, do: [group_members: :ebb_282_missing_table]

  test "post-commit cache update failure escalates and reads stay consistent" do
    system_cache_before = Process.whereis(EbbServer.Storage.SystemCache)
    assert is_pid(system_cache_before)

    actor_id = "a_282_cache_#{:erlang.unique_integer([:positive])}"
    group_id = "g_282_cache_#{:erlang.unique_integer([:positive])}"
    gm_id = "gm_282_cache_#{:erlang.unique_integer([:positive])}"
    hlc = TestHelpers.generate_hlc()

    update = %{
      id: "upd_282_cache_#{:erlang.unique_integer([:positive])}",
      subject_id: gm_id,
      subject_type: "groupMember",
      method: :put,
      data: %{
        "fields" => %{
          "actor_id" => %{"type" => "lww", "value" => actor_id, "hlc" => hlc},
          "group_id" => %{"type" => "lww", "value" => group_id, "hlc" => hlc},
          "permissions" => %{"type" => "lww", "value" => ["todo.read"], "hlc" => hlc}
        }
      }
    }

    action = %{
      id: "act_282_cache_#{:erlang.unique_integer([:positive])}",
      actor_id: actor_id,
      hlc: hlc,
      updates: [update]
    }

    # The batch is durable, so the caller gets success even though the cache
    # update blows up.
    assert {:ok, {1, 1}, []} = Writer.write_actions([action])

    # ...and the storage tree rebuilds from the log.
    assert eventually(fn ->
             pid = Process.whereis(EbbServer.Storage.SystemCache)
             is_pid(pid) and pid != system_cache_before
           end)

    # Reads stay consistent: SystemCache repopulated the membership from the
    # committed Action, and the frontier is at the committed GSN.
    assert eventually(fn ->
             Enum.any?(
               GroupCache.get_actor_groups(actor_id, CacheTables.group_members()),
               fn member -> member.group_id == group_id end
             )
           end)

    assert eventually(fn -> WatermarkTracker.committed_watermark() == 1 end)

    assert {:ok, _} =
             RocksDB.get(
               RocksDB.cf_actions(EbbServer.Storage.RocksDB),
               RocksDB.encode_gsn_key(1),
               name: EbbServer.Storage.RocksDB
             )
  end

  defp eventually(fun, attempts \\ 200)
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

defmodule EbbServer.Sync.FanOutRouterRangeResolvedTest do
  @moduledoc """
  The FanOutRouter's `{:range_resolved, from, to}` nudge re-drains
  already-buffered notifications without buffering or pushing the hole
  (ebbjs/ebbjs#282).
  """

  use ExUnit.Case, async: false
  use EbbServer.Integration.StorageCase

  alias EbbServer.Storage.{RocksDB, WatermarkTracker}
  alias EbbServer.Sync.FanOutRouter

  test "re-reads the frontier and drains buffered ranges past a resolved hole" do
    group_id = "g_282_drain_#{:erlang.unique_integer([:positive])}"

    action = %{
      "id" => "act_282_drain",
      "actor_id" => "a_282",
      "hlc" => 1,
      "gsn" => 1,
      "updates" => [
        %{
          "id" => "upd_282_drain",
          "subject_id" => "todo_282_drain",
          "subject_type" => "todo",
          "method" => "put",
          "data" => %{}
        }
      ]
    }

    :ok =
      RocksDB.write_batch([
        {:put, RocksDB.cf_actions(), RocksDB.encode_gsn_key(1), :erlang.term_to_binary(action)}
      ])

    :sys.replace_state(FanOutRouter, fn state ->
      %{
        state
        | pending_notifications: [{1, 1}],
          pending_groups: %{1 => [group_id]},
          last_pushed_gsn: 0
      }
    end)

    # Frontier still 0: the buffered range stays put and the hole is not
    # buffered. (:sys.get_state/1 synchronizes on the earlier send.)
    send(FanOutRouter, {:range_resolved, 1, 1})
    assert :sys.get_state(FanOutRouter).pending_notifications == [{1, 1}]

    # The Writer resolves the abandoned hole and the frontier passes it.
    WatermarkTracker.mark_range_resolved(1, 1)
    WatermarkTracker.advance_watermark()

    send(FanOutRouter, {:range_resolved, 1, 1})

    state = :sys.get_state(FanOutRouter)
    assert state.pending_notifications == []
    assert state.last_pushed_gsn == 1
  end
end

defmodule EbbServer.Sync.WriterFailureEndToEndTest do
  @moduledoc """
  End-to-end failed-write-does-not-stall (ebbjs/ebbjs#282).

  The failure travels through the real `Storage.Supervisor`-owned Writer
  and the real `FanOutRouter`, not a registered test pid or
  `:sys.replace_state`. A fail-once `commit_fn` rejects the first POST
  with `503`; the second, identical self-bootstrap Action commits and is
  pushed to a real `SSEConnection` parented to this test.
  """

  use ExUnit.Case, async: false
  use EbbServer.Integration.StorageCase

  alias EbbServer.Integration.ActionHelpers
  alias EbbServer.Storage.RocksDB
  alias EbbServer.Sync.{FanOutRouter, SSEConnection}
  alias EbbServer.TestHelpers

  # Runs once per setup, so the counter is fresh for each test. The
  # closure captures its own counter; no globals or test process needed.
  def storage_writer_opts do
    attempts = :atomics.new(1, signed: false)

    [
      commit_fn: fn ops, opts ->
        if :atomics.add_get(attempts, 1, 1) == 1 do
          {:error, :injected_rocksdb_failure}
        else
          RocksDB.write_batch(ops, opts)
        end
      end
    ]
  end

  test "a failed seed does not stall fan-out; the retried Action reaches the subscriber" do
    group_id = "g_282_e2e_#{:erlang.unique_integer([:positive])}"
    actor_id = "a_282_e2e_#{:erlang.unique_integer([:positive])}"

    {:ok, sse_pid} = SSEConnection.start_link(self(), [group_id], %{group_id => 0})
    :ok = FanOutRouter.subscribe([group_id], sse_pid, actor_id)

    body = ActionHelpers.msgpack_encode!(%{"actions" => [seed_action(group_id, actor_id)]})

    # First attempt: commit fails, the range is abandoned + resolved, and
    # the caller is told to retry.
    first = ActionHelpers.post_actions(body, actor_id)
    assert first.status == 503
    assert first.resp_body == ~s({"error":"write_failed"})

    # Retry of the same Action: the resolved hole does not gate it, so it
    # commits and the real Router fans it out.
    second = ActionHelpers.post_actions(body, actor_id)
    assert second.status == 200
    assert second.resp_body == ~s({"rejected":[]})

    assert_receive {:sse_chunk, "data", json}, 5_000
    payload = Jason.decode!(json)
    assert payload["actor_id"] == actor_id

    :ok = FanOutRouter.unsubscribe(sse_pid)
  end

  # One self-bootstrap Action: the actor joins its own new group and
  # writes a todo + entityGroup edge, the shape #197 pins.
  defp seed_action(group_id, actor_id) do
    hlc = TestHelpers.generate_hlc()
    todo_id = "todo_282_e2e_#{:erlang.unique_integer([:positive])}"

    %{
      "id" => "act_282_e2e_#{:erlang.unique_integer([:positive])}",
      "actor_id" => actor_id,
      "hlc" => hlc,
      "updates" => [
        update("group", group_id, "put", %{
          "name" => %{"type" => "lww", "value" => "Seed", "hlc" => hlc}
        }),
        update("groupMember", "gm_282_e2e_owner", "put", %{
          "actor_id" => %{"type" => "lww", "value" => actor_id, "hlc" => hlc},
          "group_id" => %{"type" => "lww", "value" => group_id, "hlc" => hlc},
          "permissions" => %{"type" => "lww", "value" => ["todo.*"], "hlc" => hlc}
        }),
        update("todo", todo_id, "put", %{
          "title" => %{"type" => "lww", "value" => "Seed", "hlc" => hlc}
        }),
        update("entityGroup", "eg_282_e2e", "put", %{
          "entity_id" => %{"type" => "lww", "value" => todo_id, "hlc" => hlc},
          "group_id" => %{"type" => "lww", "value" => group_id, "hlc" => hlc}
        })
      ]
    }
  end

  defp update(subject_type, subject_id, method, fields) do
    %{
      "id" => "upd_282_e2e_#{:erlang.unique_integer([:positive])}",
      "subject_id" => subject_id,
      "subject_type" => subject_type,
      "method" => method,
      "data" => %{"fields" => fields}
    }
  end
end

defmodule EbbServer.Sync.ActionDedupLostAckHttpTest do
  @moduledoc """
  A durable commit whose HTTP ack is lost is idempotent on retry
  (ebbjs/ebbjs#285).

  The lost-ack Action is written to RocksDB, then the Writer raises
  before it can reply, so the caller never learns the commit landed. The
  retry carries the same `action_id`, so the Writer's `cf_action_dedup`
  lookup skips it and reports silent success without a second GSN.
  """

  use ExUnit.Case, async: false
  use EbbServer.Integration.StorageCase, with_auth_mode: true

  alias EbbServer.Integration.ActionHelpers
  alias EbbServer.Storage.{RocksDB, Writer}
  alias EbbServer.TestHelpers

  @lost_ack_action_id "act_285_lost_ack"

  # Commit durably, then raise only for the Action under test: the retry
  # is deduped before it reaches this function, so it never raises twice.
  def storage_writer_opts do
    [
      commit_fn: fn ops, opts ->
        :ok = RocksDB.write_batch(ops, opts)

        if lost_ack_write?(ops) do
          raise "ack lost"
        end

        :ok
      end
    ]
  end

  test "the retry after a lost ack applies the Action once" do
    actor_id = "a_285_#{:erlang.unique_integer([:positive])}"
    group_id = "g_285_#{:erlang.unique_integer([:positive])}"

    assert ActionHelpers.bootstrap_group(actor_id, group_id, ["todo.create", "todo.read"]).status ==
             200

    entity_id = "todo_285_#{:erlang.unique_integer([:positive])}"

    body =
      ActionHelpers.msgpack_encode!(%{
        "actions" => [lost_ack_action(actor_id, entity_id, group_id)]
      })

    # The commit lands, then the Writer crashes before replying: the ack
    # is lost but the Action is durable.
    catch_exit(ActionHelpers.post_actions(body, actor_id))
    committed_gsn = RocksDB.get_max_gsn()

    assert eventually(fn -> writer_ready?() end)

    retry = ActionHelpers.post_actions(body, actor_id)
    assert retry.status == 200
    assert retry.resp_body == ~s({"rejected":[]})

    # No second GSN: the retry was deduped, not re-applied.
    assert RocksDB.get_max_gsn() == committed_gsn

    assert {:ok, _} =
             RocksDB.get(RocksDB.cf_actions(), RocksDB.encode_gsn_key(committed_gsn))
  end

  defp lost_ack_action(actor_id, entity_id, group_id) do
    hlc = TestHelpers.generate_hlc()

    %{
      "id" => @lost_ack_action_id,
      "actor_id" => actor_id,
      "hlc" => hlc,
      "updates" => [
        %{
          "id" => "upd_285_lost_ack",
          "subject_id" => entity_id,
          "subject_type" => "todo",
          "method" => "put",
          "data" => %{
            "fields" => %{"title" => %{"type" => "lww", "value" => "Lost ack", "hlc" => hlc}}
          }
        },
        ActionHelpers.entity_group_update(entity_id, group_id, hlc)
      ]
    }
  end

  defp lost_ack_write?(ops) do
    Enum.any?(ops, fn
      {:put, cf, @lost_ack_action_id, _gsn} -> cf == RocksDB.cf_action_dedup()
      _op -> false
    end)
  end

  # A no-op write is a safe readiness probe: it reads no keys and returns
  # the `{0, 0}` sentinel once the restarted Writer is serving calls.
  defp writer_ready? do
    match?({:ok, {0, 0}, []}, Writer.write_actions([]))
  catch
    :exit, _ -> false
  end

  defp eventually(fun, attempts \\ 200)
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
