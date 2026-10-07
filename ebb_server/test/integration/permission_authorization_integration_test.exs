defmodule EbbServer.PermissionAuthorizationIntegrationTest do
  use ExUnit.Case, async: false
  use EbbServer.Integration.StorageCase

  import EbbServer.TestHelpers
  import EbbServer.Integration.ActionHelpers
  import Plug.Conn
  import Plug.Test

  alias EbbServer.Sync.Router

  describe "multi-group membership" do
    test "indexes a same-action multi-group create into every target group" do
      # Each target group is checked for the entity's own `todo.create`
      # (#121 "Add Entity to Group"), so the actor holds it in both. The
      # write must reach both groups' action streams. The union across an
      # entity's groups is covered by the user-entity authorizer tests.
      bootstrap_group("actor_1", "group_1", ["todo.create", "todo.read"])
      bootstrap_group("actor_1", "group_2", ["todo.create", "todo.read"])

      hlc = generate_hlc()
      entity_id = "todo_multi_#{Nanoid.generate()}"

      action = %{
        "id" => "act_multi_#{Nanoid.generate()}",
        "actor_id" => "actor_1",
        "hlc" => hlc,
        "updates" => [
          %{
            "id" => "upd_multi_#{Nanoid.generate()}",
            "subject_id" => entity_id,
            "subject_type" => "todo",
            "method" => "put",
            "data" => %{
              "fields" => %{"title" => %{"type" => "lww", "value" => "Multi", "hlc" => hlc}}
            }
          },
          entity_group_update(entity_id, "group_1", hlc),
          entity_group_update(entity_id, "group_2", hlc)
        ]
      }

      conn = post_actions(msgpack_encode!(%{"actions" => [action]}), "actor_1")
      assert conn.status == 200
      assert Jason.decode!(conn.resp_body) == %{"rejected" => []}

      Process.sleep(50)

      assert entity_id in action_ids("group_1", "actor_1")
      assert entity_id in action_ids("group_2", "actor_1")
    end
  end

  describe "authorized write" do
    setup do
      bootstrap_group("actor_1", "group_1", ["todo.create", "todo.read"])
      :ok
    end

    test "authorized write to actor's group accepted" do
      entity_id = "todo_auth_1"
      hlc = generate_hlc()

      action_body = %{
        "id" => "act_auth_" <> Nanoid.generate(),
        "actor_id" => "actor_1",
        "hlc" => hlc,
        "updates" => [
          %{
            "id" => "upd_auth_" <> Nanoid.generate(),
            "subject_id" => entity_id,
            "subject_type" => "todo",
            "method" => "put",
            "data" => %{
              "fields" => %{
                "title" => %{"type" => "lww", "value" => "Authorized Todo", "hlc" => hlc}
              }
            }
          },
          entity_group_update(entity_id, "group_1", hlc)
        ]
      }

      conn = post_actions(msgpack_encode!(%{"actions" => [action_body]}), "actor_1")
      assert conn.status == 200

      {:ok, response} = Jason.decode(conn.resp_body)
      assert response == %{"rejected" => []}

      conn = get_entity(entity_id, "actor_1")
      assert conn.status == 200

      {:ok, entity} = Jason.decode(conn.resp_body)
      assert entity["data"]["fields"]["title"]["value"] == "Authorized Todo"
    end

    test "intra-action resolution: new entity + entityGroup in same action" do
      bootstrap_group("actor_1", "group_1", ["todo.*", "post.*"])

      entity_id = "todo_intra_1"
      hlc = generate_hlc()

      action = %{
        "id" => "act_intra_" <> Nanoid.generate(),
        "actor_id" => "actor_1",
        "hlc" => hlc,
        "updates" => [
          %{
            "id" => "upd_intra_" <> Nanoid.generate(),
            "subject_id" => entity_id,
            "subject_type" => "todo",
            "method" => "put",
            "data" => %{
              "fields" => %{
                "title" => %{"type" => "lww", "value" => "Intra Action", "hlc" => hlc}
              }
            }
          },
          entity_group_update(entity_id, "group_1", hlc)
        ]
      }

      conn = post_actions(msgpack_encode!(%{"actions" => [action]}), "actor_1")
      assert conn.status == 200

      {:ok, response} = Jason.decode(conn.resp_body)
      assert response == %{"rejected" => []}

      conn = get_entity(entity_id, "actor_1")
      assert conn.status == 200

      {:ok, entity} = Jason.decode(conn.resp_body)
      assert entity["data"]["fields"]["title"]["value"] == "Intra Action"
    end
  end

  describe "unauthorized write rejection" do
    setup do
      bootstrap_group("actor_1", "group_1", ["todo.*", "post.*"])
      :ok
    end

    test "write to group actor does NOT belong to is rejected" do
      entity_id = "todo_unauth_1"
      hlc = generate_hlc()

      fields = %{
        "title" => %{"type" => "lww", "value" => "Unauthorized Todo", "hlc" => hlc}
      }

      conn = write_entity_in_group("actor_2", entity_id, "todo", "group_1", fields)
      assert conn.status == 200

      {:ok, response} = Jason.decode(conn.resp_body)
      assert response["rejected"] != []

      rejection = hd(response["rejected"])
      assert rejection["reason"] == "not_authorized"
    end

    test "create with no group membership is rejected as missing_ownership" do
      entity_id = "todo_unowned_1"
      hlc = generate_hlc()

      action = %{
        "id" => "act_unowned_" <> Nanoid.generate(),
        "actor_id" => "actor_1",
        "hlc" => hlc,
        "updates" => [
          %{
            "id" => "upd_unowned_" <> Nanoid.generate(),
            "subject_id" => entity_id,
            "subject_type" => "todo",
            "method" => "put",
            "data" => %{
              "fields" => %{
                "title" => %{"type" => "lww", "value" => "Unowned Todo", "hlc" => hlc}
              }
            }
          }
        ]
      }

      conn = post_actions(msgpack_encode!(%{"actions" => [action]}), "actor_1")
      assert conn.status == 200

      {:ok, response} = Jason.decode(conn.resp_body)
      rejection = hd(response["rejected"])
      assert rejection["reason"] == "missing_ownership"
      assert is_binary(rejection["details"])

      # The structural rejection must keep the unowned entity out of storage.
      assert get_entity(entity_id, "actor_1").status == 404
    end

    test "patch of an unowned fabricated id is rejected as missing_ownership" do
      entity_id = "todo_patch_orphan_1"
      hlc = generate_hlc()

      action = %{
        "id" => "act_patch_orphan_" <> Nanoid.generate(),
        "actor_id" => "actor_1",
        "hlc" => hlc,
        "updates" => [
          %{
            "id" => "upd_patch_orphan_" <> Nanoid.generate(),
            "subject_id" => entity_id,
            "subject_type" => "todo",
            "method" => "patch",
            "data" => %{
              "fields" => %{
                "title" => %{"type" => "lww", "value" => "Patched Orphan", "hlc" => hlc}
              }
            }
          }
        ]
      }

      conn = post_actions(msgpack_encode!(%{"actions" => [action]}), "actor_1")
      assert conn.status == 200

      {:ok, response} = Jason.decode(conn.resp_body)
      rejection = hd(response["rejected"])
      assert rejection["reason"] == "missing_ownership"

      # A patch must not materialize a row for an id with no membership.
      assert get_entity(entity_id, "actor_1").status == 404
    end

    test "actor identity mismatch is rejected" do
      entity_id = "todo_mismatch_1"
      hlc = generate_hlc()

      action = %{
        "id" => "act_mismatch_" <> Nanoid.generate(),
        "actor_id" => "actor_1",
        "hlc" => hlc,
        "updates" => [
          %{
            "id" => "upd_mismatch_" <> Nanoid.generate(),
            "subject_id" => entity_id,
            "subject_type" => "todo",
            "method" => "put",
            "data" => %{
              "fields" => %{
                "title" => %{"type" => "lww", "value" => "Mismatch Test", "hlc" => hlc}
              }
            }
          }
        ]
      }

      conn = post_actions(msgpack_encode!(%{"actions" => [action]}), "actor_2")
      assert conn.status == 200

      {:ok, response} = Jason.decode(conn.resp_body)
      assert response["rejected"] != []

      rejection = hd(response["rejected"])
      assert rejection["reason"] == "actor_mismatch"
    end
  end

  # #264: membership mutation over the wire — add / remove / setGroups
  # delta, the last-membership refusal, and the cross-Action bypass.
  describe "membership mutation" do
    test "adds an existing entity to a second group" do
      bootstrap_group("actor_1", "group_1", ["todo.create", "todo.read"])
      bootstrap_group("actor_1", "group_2", ["todo.create"])

      hlc = generate_hlc()
      entity_id = "todo_add_#{Nanoid.generate()}"
      eg_1 = "eg_#{Nanoid.generate()}"

      create = %{
        "id" => "act_add_create_#{Nanoid.generate()}",
        "actor_id" => "actor_1",
        "hlc" => hlc,
        "updates" => [todo_put(entity_id, hlc), entity_group_put(eg_1, entity_id, "group_1", hlc)]
      }

      assert %{"rejected" => []} = post_membership_action(create)

      eg_2 = "eg_#{Nanoid.generate()}"

      add = %{
        "id" => "act_add_#{Nanoid.generate()}",
        "actor_id" => "actor_1",
        "hlc" => hlc,
        "updates" => [entity_group_put(eg_2, entity_id, "group_2", hlc)]
      }

      assert %{"rejected" => []} = post_membership_action(add)
      assert eg_2 in action_ids("group_2", "actor_1")
    end

    test "a batch resolves a type created by an earlier Action of the request" do
      bootstrap_group("actor_1", "group_1", ["todo.create", "todo.read"])
      bootstrap_group("actor_1", "group_2", ["todo.create", "todo.read"])

      hlc = generate_hlc()
      entity_id = "todo_batchtype_#{Nanoid.generate()}"
      eg_1 = "eg_#{Nanoid.generate()}"
      eg_2 = "eg_#{Nanoid.generate()}"

      # Neither the entity nor its type is committed when the request is
      # authorized, so the second Action has to resolve the type the
      # first Action introduced. This is the Outbox batch shape: separate
      # calls flushed together.
      create = %{
        "id" => "act_batchtype_create_#{Nanoid.generate()}",
        "actor_id" => "actor_1",
        "hlc" => hlc,
        "updates" => [
          todo_put(entity_id, hlc),
          entity_group_put(eg_1, entity_id, "group_1", hlc)
        ]
      }

      add = %{
        "id" => "act_batchtype_add_#{Nanoid.generate()}",
        "actor_id" => "actor_1",
        "hlc" => hlc,
        "updates" => [entity_group_put(eg_2, entity_id, "group_2", hlc)]
      }

      conn = post_actions(msgpack_encode!(%{"actions" => [create, add]}), "actor_1")
      assert conn.status == 200
      assert Jason.decode!(conn.resp_body) == %{"rejected" => []}

      Process.sleep(50)

      assert eg_2 in action_ids("group_2", "actor_1")
      assert get_entity(entity_id, "actor_1").status == 200
    end

    test "removes a non-last membership" do
      bootstrap_group("actor_1", "group_1", ["todo.create", "todo.update", "todo.read"])
      bootstrap_group("actor_1", "group_2", ["todo.create", "todo.update", "todo.read"])

      hlc = generate_hlc()
      entity_id = "todo_remove_#{Nanoid.generate()}"
      eg_1 = "eg_#{Nanoid.generate()}"
      eg_2 = "eg_#{Nanoid.generate()}"

      create = %{
        "id" => "act_remove_create_#{Nanoid.generate()}",
        "actor_id" => "actor_1",
        "hlc" => hlc,
        "updates" => [
          todo_put(entity_id, hlc),
          entity_group_put(eg_1, entity_id, "group_1", hlc),
          entity_group_put(eg_2, entity_id, "group_2", hlc)
        ]
      }

      assert %{"rejected" => []} = post_membership_action(create)

      remove = %{
        "id" => "act_remove_#{Nanoid.generate()}",
        "actor_id" => "actor_1",
        "hlc" => hlc,
        "updates" => [entity_group_delete(eg_2)]
      }

      assert %{"rejected" => []} = post_membership_action(remove)
      assert get_entity(entity_id, "actor_1").status == 200
    end

    test "refuses removing the last membership and does not orphan the entity" do
      bootstrap_group("actor_1", "group_1", ["todo.create", "todo.update", "todo.read"])

      hlc = generate_hlc()
      entity_id = "todo_last_#{Nanoid.generate()}"
      eg_1 = "eg_#{Nanoid.generate()}"

      create = %{
        "id" => "act_last_create_#{Nanoid.generate()}",
        "actor_id" => "actor_1",
        "hlc" => hlc,
        "updates" => [todo_put(entity_id, hlc), entity_group_put(eg_1, entity_id, "group_1", hlc)]
      }

      assert %{"rejected" => []} = post_membership_action(create)

      remove = %{
        "id" => "act_last_remove_#{Nanoid.generate()}",
        "actor_id" => "actor_1",
        "hlc" => hlc,
        "updates" => [entity_group_delete(eg_1)]
      }

      response = post_membership_action(remove)
      assert [rejection] = response["rejected"]
      assert rejection["reason"] == "last_membership"
      assert is_binary(rejection["details"])

      assert get_entity(entity_id, "actor_1").status == 200
    end

    test "swaps the last membership for a new group in one Action" do
      bootstrap_group("actor_1", "group_1", ["todo.create", "todo.update", "todo.read"])
      bootstrap_group("actor_1", "group_2", ["todo.create", "todo.read"])

      hlc = generate_hlc()
      entity_id = "todo_swap_#{Nanoid.generate()}"
      eg_old = "eg_#{Nanoid.generate()}"
      eg_new = "eg_#{Nanoid.generate()}"

      create = %{
        "id" => "act_swap_create_#{Nanoid.generate()}",
        "actor_id" => "actor_1",
        "hlc" => hlc,
        "updates" => [
          todo_put(entity_id, hlc),
          entity_group_put(eg_old, entity_id, "group_1", hlc)
        ]
      }

      assert %{"rejected" => []} = post_membership_action(create)

      swap_id = "act_swap_#{Nanoid.generate()}"

      swap = %{
        "id" => swap_id,
        "actor_id" => "actor_1",
        "hlc" => hlc,
        "updates" => [
          entity_group_put(eg_new, entity_id, "group_2", hlc),
          entity_group_delete(eg_old)
        ]
      }

      assert %{"rejected" => []} = post_membership_action(swap)

      # The delta indexes the Action into both the group it left and the
      # group it joined.
      assert swap_id in action_id_list("group_1", "actor_1")
      assert swap_id in action_id_list("group_2", "actor_1")
      assert get_entity(entity_id, "actor_1").status == 200
    end

    test "a batch of two Actions cannot each remove one of two memberships" do
      bootstrap_group("actor_1", "group_1", ["todo.create", "todo.update", "todo.read"])
      bootstrap_group("actor_1", "group_2", ["todo.create", "todo.update", "todo.read"])

      hlc = generate_hlc()
      entity_id = "todo_bypass_#{Nanoid.generate()}"
      eg_1 = "eg_#{Nanoid.generate()}"
      eg_2 = "eg_#{Nanoid.generate()}"

      create = %{
        "id" => "act_bypass_create_#{Nanoid.generate()}",
        "actor_id" => "actor_1",
        "hlc" => hlc,
        "updates" => [
          todo_put(entity_id, hlc),
          entity_group_put(eg_1, entity_id, "group_1", hlc),
          entity_group_put(eg_2, entity_id, "group_2", hlc)
        ]
      }

      assert %{"rejected" => []} = post_membership_action(create)

      remove_1 = %{
        "id" => "act_bypass_a_#{Nanoid.generate()}",
        "actor_id" => "actor_1",
        "hlc" => hlc,
        "updates" => [entity_group_delete(eg_1)]
      }

      remove_2 = %{
        "id" => "act_bypass_b_#{Nanoid.generate()}",
        "actor_id" => "actor_1",
        "hlc" => hlc,
        "updates" => [entity_group_delete(eg_2)]
      }

      response =
        post_actions(msgpack_encode!(%{"actions" => [remove_1, remove_2]}), "actor_1")
        |> Map.get(:resp_body)
        |> Jason.decode!()

      assert length(response["rejected"]) == 2
      assert Enum.all?(response["rejected"], &(&1["reason"] == "last_membership"))

      # The whole batch was refused, so the entity keeps a membership.
      assert get_entity(entity_id, "actor_1").status == 200
    end
  end

  defp post_membership_action(action) do
    conn = post_actions(msgpack_encode!(%{"actions" => [action]}), "actor_1")
    assert conn.status == 200
    Jason.decode!(conn.resp_body)
  end

  defp todo_put(entity_id, hlc) do
    %{
      "id" => "upd_todo_#{Nanoid.generate()}",
      "subject_id" => entity_id,
      "subject_type" => "todo",
      "method" => "put",
      "data" => %{
        "fields" => %{"title" => %{"type" => "lww", "value" => "Member", "hlc" => hlc}}
      }
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

  defp action_id_list(group_id, actor_id) do
    conn =
      conn(:get, "/sync/groups/#{group_id}")
      |> put_req_header("x-ebb-actor-id", actor_id)
      |> Router.call([])

    conn.resp_body |> Jason.decode!() |> Enum.map(& &1["id"])
  end

  defp action_ids(group_id, actor_id) do
    conn =
      conn(:get, "/sync/groups/#{group_id}")
      |> put_req_header("x-ebb-actor-id", actor_id)
      |> Router.call([])

    conn.resp_body
    |> Jason.decode!()
    |> Enum.flat_map(& &1["updates"])
    |> Enum.map(& &1["subject_id"])
  end
end
