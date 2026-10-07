defmodule EbbServer.Sync.FanOutRouterDeleteSnapshotTest do
  @moduledoc """
  Regression tests for #251.

  An `entityGroup` or `groupMember` delete is indexed into
  `cf_group_actions` from the *pre-update* cache, so catch-up delivers
  it. The FanOutRouter used to re-resolve the Action's groups from the
  *post-update* cache at dispatch time: by then the by-id entry is gone
  (`data: nil` carries no `group_id`), it resolved to `[]`, and live
  SSE never saw the delete.

  The Writer now hands the Router the same group set it used to build
  `cf_group_actions`. These tests pin live fan-out against that index
  for the delete path.
  """

  use ExUnit.Case, async: false
  use EbbServer.Integration.StorageCase

  alias EbbServer.Integration.ActionHelpers
  alias EbbServer.Storage.RocksDB
  alias EbbServer.Sync.{CatchUp, FanOutRouter, SSEConnection}
  alias EbbServer.TestHelpers

  describe "delete fan-out uses the commit snapshot (#251)" do
    test "entityGroup delete reaches live subscribers and cf_group_actions" do
      %{actor_id: actor_id, group_id: group_id, eg_id: eg_id} = setup_membership()

      {:ok, sse_pid} = subscribe(group_id, actor_id)

      delete = entity_group_delete_action(actor_id, eg_id)
      :ok = post!(delete, actor_id)

      pushed = assert_pushed(group_id, actor_id, eg_id)
      assert_same_action(pushed, group_id)

      :ok = FanOutRouter.unsubscribe(sse_pid)
    end

    test "groupMember delete reaches live subscribers and cf_group_actions" do
      %{actor_id: actor_id, group_id: group_id} = setup_membership()

      member_actor_id = "a_251_member_#{:erlang.unique_integer([:positive])}"
      gm_id = "gm_251_#{:erlang.unique_integer([:positive])}"
      :ok = post!(group_member_put_action(actor_id, member_actor_id, gm_id, group_id), actor_id)

      {:ok, sse_pid} = subscribe(group_id, actor_id)

      delete = group_member_delete_action(actor_id, gm_id)
      :ok = post!(delete, actor_id)

      pushed = assert_pushed(group_id, actor_id, gm_id)
      assert_same_action(pushed, group_id)

      :ok = FanOutRouter.unsubscribe(sse_pid)
    end
  end

  # Subscribes *after* the membership setup so the only actions the
  # connection can observe are the deletes under test.
  defp subscribe(group_id, actor_id) do
    {:ok, sse_pid} = SSEConnection.start_link(self(), [group_id], %{group_id => 0})
    :ok = FanOutRouter.subscribe([group_id], sse_pid, actor_id)
    {:ok, sse_pid}
  end

  defp assert_pushed(group_id, actor_id, deleted_id) do
    # The same Action must be reachable through cf_group_actions — the
    # index catch-up reads.
    {:ok, actions, _meta} = CatchUp.catch_up_group(group_id, actor_id, 0)

    indexed =
      Enum.find(actions, fn action ->
        Enum.any?(action["updates"], &delete_of?(&1, deleted_id))
      end)

    assert indexed, "expected the delete of #{deleted_id} in cf_group_actions"

    payload = await_action(deleted_id, System.monotonic_time(:millisecond) + 5_000)

    assert payload["gsn"] == indexed["gsn"]
    assert payload["id"] == indexed["id"]

    payload
  end

  # The membership setup can still be in flight when the SSE subscribes,
  # so skip any earlier chunks until the delete under test arrives.
  defp await_action(deleted_id, deadline) do
    timeout = max(deadline - System.monotonic_time(:millisecond), 0)

    receive do
      {:sse_chunk, "data", json} ->
        payload = Jason.decode!(json)

        if Enum.any?(payload["updates"], &delete_of?(&1, deleted_id)) do
          payload
        else
          await_action(deleted_id, deadline)
        end
    after
      timeout ->
        flunk("expected the delete of #{deleted_id} to fan out live")
    end
  end

  defp delete_of?(update, deleted_id) do
    update["subject_id"] == deleted_id and update["method"] == "delete"
  end

  defp assert_same_action(action, group_id) do
    key = RocksDB.encode_group_action_key(group_id, action["gsn"])

    assert {:ok, action_id} = RocksDB.get(RocksDB.cf_group_actions(), key)
    assert action_id == action["id"]
  end

  defp post!(action, actor_id) do
    conn =
      ActionHelpers.post_actions(
        ActionHelpers.msgpack_encode!(%{"actions" => [action]}),
        actor_id
      )

    assert conn.status == 200
    assert conn.resp_body == ~s({"rejected":[]})
    :ok
  end

  # Creates the group, the actor's membership, and an entity with two
  # membership rows: `eg_id` (deleted under test) and a second row in
  # another group. The second row keeps the entity owned after the delete
  # so the #264 last-membership invariant does not refuse it; the delete
  # is still indexed into `group_id` from the pre-update snapshot.
  defp setup_membership do
    actor_id = "a_251_#{:erlang.unique_integer([:positive])}"
    group_id = "g_251_#{:erlang.unique_integer([:positive])}"
    other_group_id = "g_251_other_#{:erlang.unique_integer([:positive])}"
    todo_id = "todo_251_#{:erlang.unique_integer([:positive])}"
    eg_id = "eg_251_#{:erlang.unique_integer([:positive])}"
    eg_other_id = "eg_251_other_#{:erlang.unique_integer([:positive])}"

    ActionHelpers.bootstrap_group(actor_id, group_id, [
      "todo.read",
      "todo.write",
      "todo.*",
      "groupMember.*",
      "entityGroup.*"
    ])

    ActionHelpers.bootstrap_group(actor_id, other_group_id, ["todo.create"])

    hlc = TestHelpers.generate_hlc()

    action = %{
      "id" => "act_251_#{:erlang.unique_integer([:positive])}",
      "actor_id" => actor_id,
      "hlc" => hlc,
      "updates" => [
        %{
          "id" => "upd_251_#{:erlang.unique_integer([:positive])}",
          "subject_id" => todo_id,
          "subject_type" => "todo",
          "method" => "put",
          "data" => %{
            "fields" => %{
              "title" => %{"type" => "lww", "value" => "Snapshot", "hlc" => hlc}
            }
          }
        },
        entity_group_update(eg_id, todo_id, group_id, "put", hlc),
        entity_group_update(eg_other_id, todo_id, other_group_id, "put", hlc)
      ]
    }

    :ok = post!(action, actor_id)

    %{actor_id: actor_id, group_id: group_id, todo_id: todo_id, eg_id: eg_id}
  end

  defp entity_group_delete_action(actor_id, eg_id) do
    %{
      "id" => "act_251_del_#{:erlang.unique_integer([:positive])}",
      "actor_id" => actor_id,
      "hlc" => TestHelpers.generate_hlc(),
      "updates" => [entity_group_update(eg_id, nil, nil, "delete", TestHelpers.generate_hlc())]
    }
  end

  defp group_member_put_action(actor_id, member_actor_id, gm_id, group_id) do
    hlc = TestHelpers.generate_hlc()

    %{
      "id" => "act_251_gm_#{:erlang.unique_integer([:positive])}",
      "actor_id" => actor_id,
      "hlc" => hlc,
      "updates" => [
        %{
          "id" => gm_id,
          "subject_id" => gm_id,
          "subject_type" => "groupMember",
          "method" => "put",
          "data" => %{
            "fields" => %{
              "actor_id" => %{"type" => "lww", "value" => member_actor_id, "hlc" => hlc},
              "group_id" => %{"type" => "lww", "value" => group_id, "hlc" => hlc},
              "permissions" => %{"type" => "lww", "value" => ["todo.read"], "hlc" => hlc}
            }
          }
        }
      ]
    }
  end

  defp group_member_delete_action(actor_id, gm_id) do
    %{
      "id" => "act_251_gm_del_#{:erlang.unique_integer([:positive])}",
      "actor_id" => actor_id,
      "hlc" => TestHelpers.generate_hlc(),
      "updates" => [
        %{
          "id" => "upd_251_gm_del_#{:erlang.unique_integer([:positive])}",
          "subject_id" => gm_id,
          "subject_type" => "groupMember",
          "method" => "delete",
          "data" => nil
        }
      ]
    }
  end

  defp entity_group_update(eg_id, entity_id, group_id, method, hlc) do
    data =
      if method == "delete" do
        nil
      else
        %{
          "fields" => %{
            "entity_id" => %{"type" => "lww", "value" => entity_id, "hlc" => hlc},
            "group_id" => %{"type" => "lww", "value" => group_id, "hlc" => hlc}
          }
        }
      end

    %{
      "id" => "upd_251_eg_#{:erlang.unique_integer([:positive])}",
      "subject_id" => eg_id,
      "subject_type" => "entityGroup",
      "method" => method,
      "data" => data
    }
  end
end
