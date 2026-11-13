defmodule EbbServer.Sync.GroupsChangedFanOutTest do
  @moduledoc """
  Live fan-out of the `groups_changed` control event (#734).

  A committed, applied Action that changes an actor's group view pushes
  `event: control` with `{"groups_changed": true, "reason": "membership"}`
  to every live connection of every affected actor. The event carries no
  delta: the client re-handshakes, which reads `GroupCache`. These tests
  drive the real Writer and fan-out, so the event's arrival also pins the
  post-apply ordering — a control that raced ahead of the cache write
  would let a client handshake into the old state.
  """

  use ExUnit.Case, async: false
  use EbbServer.Integration.StorageCase

  import EbbServer.SSEHelpers, only: [receive_sse_data: 0]
  import EbbServer.TestHelpers, only: [generate_hlc: 0]

  alias EbbServer.Integration.ActionHelpers
  alias EbbServer.Storage.GroupCache
  alias EbbServer.Sync.{FanOutRouter, SSEConnection}

  @control %{"groups_changed" => true, "reason" => "membership"}

  describe "membership writes" do
    test "an own membership put pushes one control event to the actor's connection" do
      actor_id = unique("a")
      group_id = unique("g")
      bootstrap!(actor_id, group_id, ["todo.*", "ebb/grant.*"], unique("gm"))

      {:ok, sse_pid} = subscribe(group_id, actor_id)

      put_member!(actor_id, group_id, actor_id, ["todo.read"], unique("gm"))

      receive_sse_data()
      assert_control()
      refute_control()

      :ok = FanOutRouter.unsubscribe(sse_pid)
    end

    test "a third-party membership put reaches only the added actor's connection" do
      owner_id = unique("a")
      member_id = unique("a")
      group_id = unique("g")
      bootstrap!(owner_id, group_id, ["todo.*", "ebb/grant.*"], unique("gm"))

      {:ok, owner_conn} = subscribe_as(:owner, group_id, owner_id)
      {:ok, member_conn} = subscribe_as(:member, group_id, member_id)

      put_member!(owner_id, group_id, member_id, ["todo.read"], unique("gm"))

      assert_receive {:owner, :data, _bytes}, 5_000
      assert_receive {:member, :data, _bytes}, 5_000
      assert_receive {:member, :control, payload}, 5_000
      assert Jason.decode!(payload) == @control
      refute_receive {:owner, :control, _payload}, 300

      :ok = FanOutRouter.unsubscribe(owner_conn)
      :ok = FanOutRouter.unsubscribe(member_conn)
    end

    test "a membership delete pushes the control event" do
      owner_id = unique("a")
      group_id = unique("g")
      gm_owner = unique("gm")
      bootstrap!(owner_id, group_id, ["todo.*", "ebb/grant.*"], gm_owner)
      # A second capable member keeps the #479 last-capable-member guard
      # from refusing the owner's own delete.
      put_member!(owner_id, group_id, unique("a"), ["ebb/grant.*"], unique("gm"))

      {:ok, sse_pid} = subscribe(group_id, owner_id)

      post!(%{
        "id" => unique("act"),
        "actor_id" => owner_id,
        "hlc" => generate_hlc(),
        "updates" => [
          %{
            "id" => unique("upd"),
            "subject_id" => gm_owner,
            "method" => "delete",
            "data" => nil
          }
        ]
      })

      # The delete's wire `data` is nil, so the actor is only known from
      # the row the delete removes. An event here proves the Writer
      # resolved it before deleting it.
      receive_sse_data()
      assert_control()

      :ok = FanOutRouter.unsubscribe(sse_pid)
    end

    test "a re-put of the row the cache already holds pushes nothing" do
      actor_id = unique("a")
      group_id = unique("g")
      gm_id = unique("gm")
      permissions = ["todo.*", "ebb/grant.*"]
      bootstrap!(actor_id, group_id, permissions, gm_id)

      {:ok, sse_pid} = subscribe(group_id, actor_id)

      # Same id, same actor, same group, same permissions: the group view
      # did not change, so the actor has nothing to re-handshake for.
      put_member!(actor_id, group_id, actor_id, permissions, gm_id)

      receive_sse_data()
      refute_control()

      :ok = FanOutRouter.unsubscribe(sse_pid)
    end

    test "a permissions-only patch pushes the control event" do
      actor_id = unique("a")
      group_id = unique("g")
      gm_id = unique("gm")
      bootstrap!(actor_id, group_id, ["todo.*", "ebb/grant.*"], gm_id)

      {:ok, sse_pid} = subscribe(group_id, actor_id)

      hlc = generate_hlc()

      post!(%{
        "id" => unique("act"),
        "actor_id" => actor_id,
        "hlc" => hlc,
        "updates" => [
          %{
            "id" => unique("upd"),
            "subject_id" => gm_id,
            "component" => "ebb/grant",
            "method" => "replace",
            "data" => %{
              "value" => %{
                "actor_id" => actor_id,
                "group_id" => group_id,
                "permissions" => ["todo.read"]
              },
              "hlc" => hlc
            }
          }
        ]
      })

      receive_sse_data()
      assert_control()

      :ok = FanOutRouter.unsubscribe(sse_pid)
    end

    test "re-keying a membership row to another actor reaches both actors" do
      owner_id = unique("a")
      old_actor = unique("a")
      new_actor = unique("a")
      group_id = unique("g")
      gm_id = unique("gm")
      bootstrap!(owner_id, group_id, ["todo.*", "ebb/grant.*"], unique("gm"))
      put_member!(owner_id, group_id, old_actor, ["todo.read"], gm_id)

      {:ok, old_conn} = subscribe_as(:old, group_id, old_actor)
      {:ok, new_conn} = subscribe_as(:new, group_id, new_actor)

      # The same row id now names the new actor; GroupCache drops the
      # stale row, so the old actor's group view changed too.
      put_member!(owner_id, group_id, new_actor, ["todo.read"], gm_id)

      assert_receive {:old, :control, _payload}, 5_000
      assert_receive {:new, :control, _payload}, 5_000

      :ok = FanOutRouter.unsubscribe(old_conn)
      :ok = FanOutRouter.unsubscribe(new_conn)
    end

    test "a commit that changes several rows for one actor pushes one event" do
      owner_id = unique("a")
      group_id = unique("g")
      bootstrap!(owner_id, group_id, ["todo.*", "ebb/grant.*"], unique("gm"))

      {:ok, sse_pid} = subscribe(group_id, owner_id)

      hlc = generate_hlc()

      post!(%{
        "id" => unique("act"),
        "actor_id" => owner_id,
        "hlc" => hlc,
        "updates" =>
          List.flatten([
            member_update(unique("gm"), owner_id, group_id, ["todo.read"], hlc),
            member_update(unique("gm"), owner_id, group_id, ["todo.write"], hlc)
          ])
      })

      receive_sse_data()
      assert_control()
      refute_control(400)

      :ok = FanOutRouter.unsubscribe(sse_pid)
    end
  end

  describe "live connections outside the changing group" do
    test "an added actor following another group still gets the event" do
      owner_id = unique("a")
      member_id = unique("a")
      group_id = unique("g")
      other_group = unique("g")
      bootstrap!(owner_id, group_id, ["todo.*", "ebb/grant.*"], unique("gm"))

      # The membership row is scoped to `group_id`, so nothing is pushed to
      # this connection; the actor earns the wake-up from its identity, not
      # from a group it happens to share with the commit.
      {:ok, member_conn} = subscribe_as(:member, other_group, member_id)

      put_member!(owner_id, group_id, member_id, ["todo.read"], unique("gm"))

      assert_receive {:member, :control, payload}, 5_000
      assert Jason.decode!(payload) == @control
      refute_receive {:member, :data, _bytes}, 100

      :ok = FanOutRouter.unsubscribe(member_conn)
    end
  end

  describe "unaffected writes" do
    test "an Action that touches no groupMember pushes no control event" do
      actor_id = unique("a")
      group_id = unique("g")
      bootstrap!(actor_id, group_id, ["todo.*", "ebb/grant.*"], unique("gm"))

      {:ok, sse_pid} = subscribe(group_id, actor_id)

      assert ActionHelpers.write_entity_in_group(
               actor_id,
               unique("todo"),
               "todo",
               group_id,
               %{"title" => %{"type" => "lww", "value" => "x", "hlc" => generate_hlc()}}
             ).status == 200

      receive_sse_data()
      refute_control()

      :ok = FanOutRouter.unsubscribe(sse_pid)
    end

    test "a changed actor with no live connection pushes no control event" do
      owner_id = unique("a")
      group_id = unique("g")
      bootstrap!(owner_id, group_id, ["todo.*", "ebb/grant.*"], unique("gm"))

      {:ok, sse_pid} = subscribe(group_id, owner_id)

      put_member!(owner_id, group_id, unique("a"), ["todo.read"], unique("gm"))

      receive_sse_data()
      refute_control()

      :ok = FanOutRouter.unsubscribe(sse_pid)
    end
  end

  describe "ordering" do
    test "the cache already holds the new membership when the control event arrives" do
      owner_id = unique("a")
      member_id = unique("a")
      group_id = unique("g")
      bootstrap!(owner_id, group_id, ["todo.*", "ebb/grant.*"], unique("gm"))

      {:ok, member_conn} = subscribe_as(:member, group_id, member_id)

      put_member!(owner_id, group_id, member_id, ["todo.read"], unique("gm"))

      assert_receive {:member, :control, _payload}, 5_000
      # The event is a wake-up for a handshake that reads GroupCache, so
      # it must never arrive before the membership is visible.
      assert GroupCache.get_permissions(member_id, group_id) == ["todo.read"]

      # The range's data frames reach the same connection in the same
      # release; SSE is a stream, so their arrival is asserted, not their
      # interleaving with the control cast.
      assert_receive {:member, :data, _bytes}, 5_000

      :ok = FanOutRouter.unsubscribe(member_conn)
    end
  end

  defp bootstrap!(actor_id, group_id, permissions, gm_id) do
    hlc = generate_hlc()

    post!(%{
      "id" => unique("act"),
      "actor_id" => actor_id,
      "hlc" => hlc,
      "updates" =>
        [
          %{
            "id" => unique("upd"),
            "subject_id" => group_id,
            "component" => "ebb/group",
            "method" => "replace",
            "data" => %{"value" => %{"name" => "Test Group"}, "hlc" => hlc}
          }
        ] ++ member_update(gm_id, actor_id, group_id, permissions, hlc)
    })
  end

  defp put_member!(actor_id, group_id, member_actor_id, permissions, gm_id) do
    hlc = generate_hlc()

    post!(%{
      "id" => unique("act"),
      "actor_id" => actor_id,
      "hlc" => hlc,
      "updates" => member_update(gm_id, member_actor_id, group_id, permissions, hlc)
    })
  end

  defp member_update(gm_id, member_actor_id, group_id, permissions, hlc) do
    [
      %{
        "id" => "#{gm_id}_grant",
        "subject_id" => gm_id,
        "component" => "ebb/grant",
        "method" => "replace",
        "data" => %{
          "value" => %{
            "actor_id" => member_actor_id,
            "group_id" => group_id,
            "permissions" => permissions
          },
          "hlc" => hlc
        }
      }
    ]
  end

  defp post!(action) do
    conn =
      ActionHelpers.post_actions(
        ActionHelpers.msgpack_encode!(%{"actions" => [action]}),
        action["actor_id"]
      )

    assert conn.status == 200
    assert conn.resp_body == ~s({"rejected":[]})
    conn
  end

  # The test process owns the connection, so chunks land in its mailbox.
  defp subscribe(group_id, actor_id) do
    {:ok, sse_pid} = SSEConnection.start_link(self(), [group_id], %{group_id => 0})
    :ok = FanOutRouter.subscribe([group_id], sse_pid, actor_id)
    {:ok, sse_pid}
  end

  # A tagged collector lets one test observe several connections without
  # confusing their chunks.
  defp subscribe_as(tag, group_id, actor_id) do
    test = self()
    conn = spawn_link(fn -> forward_chunks(test, tag) end)

    {:ok, sse_pid} = SSEConnection.start_link(conn, [group_id], %{group_id => 0})
    :ok = FanOutRouter.subscribe([group_id], sse_pid, actor_id)
    {:ok, sse_pid}
  end

  defp forward_chunks(test, tag) do
    receive do
      {:sse_data, bytes} -> send(test, {tag, :data, bytes})
      {:sse_data, bytes, _meta} -> send(test, {tag, :data, bytes})
      {:sse_chunk, "control", payload} -> send(test, {tag, :control, payload})
      _other -> :ok
    end

    forward_chunks(test, tag)
  end

  defp assert_control(timeout \\ 5_000) do
    assert_receive {:sse_chunk, "control", payload}, timeout
    assert Jason.decode!(payload) == @control
  end

  defp refute_control(timeout \\ 300) do
    refute_receive {:sse_chunk, "control", _payload}, timeout
  end

  defp unique(prefix), do: "#{prefix}_#{:erlang.unique_integer([:positive])}"
end
