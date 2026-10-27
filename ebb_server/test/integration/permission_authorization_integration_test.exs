defmodule EbbServer.PermissionAuthorizationIntegrationTest do
  use ExUnit.Case, async: false
  use EbbServer.Integration.StorageCase

  import EbbServer.TestHelpers
  import EbbServer.Integration.ActionHelpers
  import Plug.Conn
  import Plug.Test

  alias EbbServer.Storage.GroupCache
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

    test "delivers a spanning Action per Update scope, with no leak" do
      bootstrap_group("actor_1", "group_1", ["todo.create", "todo.read"])
      bootstrap_group("actor_1", "group_2", ["todo.create", "todo.read"])

      hlc = generate_hlc()
      other_id = "todo_other_#{Nanoid.generate()}"
      eg_other = "eg_#{Nanoid.generate()}"

      # An existing entity in group_2, so the second membership put below
      # authorizes on its own.
      seed = %{
        "id" => "act_seed_#{Nanoid.generate()}",
        "actor_id" => "actor_1",
        "hlc" => hlc,
        "updates" => [
          todo_put(other_id, hlc),
          entity_group_put(eg_other, other_id, "group_2", hlc)
        ]
      }

      assert %{"rejected" => []} = post_membership_action(seed)

      leaked_id = "todo_leak_#{Nanoid.generate()}"
      eg_leak = "eg_#{Nanoid.generate()}"
      # The membership row the seed already minted for `other_id`: re-putting
      # it is idempotent, a second row for a live pair is refused (#623).
      eg_other_2 = eg_other

      action = %{
        "id" => "act_leak_#{Nanoid.generate()}",
        "actor_id" => "actor_1",
        "hlc" => hlc,
        "updates" => [
          todo_put(leaked_id, hlc),
          entity_group_put(eg_leak, leaked_id, "group_1", hlc),
          entity_group_put(eg_other_2, other_id, "group_2", hlc)
        ]
      }

      # The spanning Action commits as one Action; only delivery is scoped.
      assert %{"rejected" => []} = post_membership_action(action)

      Process.sleep(50)

      assert leaked_id in action_ids("group_1", "actor_1")
      assert eg_leak in action_ids("group_1", "actor_1")

      # group_2 gets its own membership row, never the group_1 write.
      assert eg_other_2 in action_ids("group_2", "actor_1")
      refute leaked_id in action_ids("group_2", "actor_1")
      refute eg_leak in action_ids("group_2", "actor_1")
    end

    test "setGroups moving an entity delivers each Update to its own group" do
      bootstrap_group("actor_1", "group_1", ["todo.create", "todo.update", "todo.read"])
      bootstrap_group("actor_1", "group_2", ["todo.create", "todo.read"])

      hlc = generate_hlc()
      entity_id = "todo_move_#{Nanoid.generate()}"
      eg_old = "eg_#{Nanoid.generate()}"
      eg_new = "eg_#{Nanoid.generate()}"

      create = %{
        "id" => "act_move_create_#{Nanoid.generate()}",
        "actor_id" => "actor_1",
        "hlc" => hlc,
        "updates" => [
          todo_put(entity_id, hlc),
          entity_group_put(eg_old, entity_id, "group_1", hlc)
        ]
      }

      assert %{"rejected" => []} = post_membership_action(create)

      move = %{
        "id" => "act_move_#{Nanoid.generate()}",
        "actor_id" => "actor_1",
        "hlc" => hlc,
        "updates" => [
          entity_group_put(eg_new, entity_id, "group_2", hlc),
          %{
            "id" => "upd_move_#{Nanoid.generate()}",
            "subject_id" => eg_old,
            "subject_type" => "entityGroup",
            "method" => "delete",
            "data" => nil
          }
        ]
      }

      assert %{"rejected" => []} = post_membership_action(move)

      Process.sleep(50)

      # The group it left sees the delete, the group it joined sees the put.
      assert eg_old in action_ids("group_1", "actor_1")
      refute eg_new in action_ids("group_1", "actor_1")
      assert eg_new in action_ids("group_2", "actor_1")
      refute eg_old in action_ids("group_2", "actor_1")
    end
  end

  describe "per-Action outcomes" do
    test "an unauthorized Action does not reject its authorized sibling in the batch" do
      bootstrap_group("actor_1", "group_1", ["todo.*", "todo.read"])
      bootstrap_group("actor_2", "group_2", ["todo.*", "todo.read"])

      hlc = generate_hlc()
      ok_id = "todo_ok_#{Nanoid.generate()}"
      bad_id = "todo_bad_#{Nanoid.generate()}"

      authorized = %{
        "id" => "act_ok_#{Nanoid.generate()}",
        "actor_id" => "actor_1",
        "hlc" => hlc,
        "updates" => [
          todo_put(ok_id, hlc),
          entity_group_put("eg_#{Nanoid.generate()}", ok_id, "group_1", hlc)
        ]
      }

      # `actor_1` is not a member of `group_2`, so this Action fails
      # authorization while its sibling must still commit (#469).
      unauthorized = %{
        "id" => "act_bad_#{Nanoid.generate()}",
        "actor_id" => "actor_1",
        "hlc" => hlc,
        "updates" => [
          todo_put(bad_id, hlc),
          entity_group_put("eg_#{Nanoid.generate()}", bad_id, "group_2", hlc)
        ]
      }

      conn = post_actions(msgpack_encode!(%{"actions" => [unauthorized, authorized]}), "actor_1")
      assert conn.status == 200

      assert %{"rejected" => [rejection]} = Jason.decode!(conn.resp_body)
      assert rejection["id"] == unauthorized["id"]
      assert rejection["reason"] == "not_authorized"

      Process.sleep(50)

      assert get_entity(ok_id, "actor_1").status == 200
      assert ok_id in action_ids("group_1", "actor_1")
      assert get_entity(bad_id, "actor_1").status == 404
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
      # Filing an entity the read model already places in a group is a write
      # to that entity, so the owner needs `todo.update` where it lives
      # (#623) as well as `todo.create` in the target.
      bootstrap_group("actor_1", "group_1", ["todo.create", "todo.update", "todo.read"])
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

    test "a batch of two Actions cannot remove both of an entity's memberships" do
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

      assert [rejection] = response["rejected"]
      assert rejection["reason"] == "last_membership"

      # The first removal committed; the second was refused, so the
      # entity keeps a membership.
      assert get_entity(entity_id, "actor_1").status == 200
    end
  end

  describe "last group member" do
    test "refuses removing a group's last capable membership and leaves it committed" do
      bootstrap =
        bootstrap_group_action("actor_1", "group_1", [
          "groupMember.delete",
          "todo.create",
          "todo.read"
        ])

      gm_id = group_member_id(bootstrap)

      assert %{"rejected" => []} = post_membership_action(bootstrap)

      hlc = generate_hlc()

      remove = %{
        "id" => "act_gm_remove_#{Nanoid.generate()}",
        "actor_id" => "actor_1",
        "hlc" => hlc,
        "updates" => [
          %{
            "id" => "upd_gm_remove_#{Nanoid.generate()}",
            "subject_id" => gm_id,
            "subject_type" => "groupMember",
            "method" => "delete",
            "data" => nil
          }
        ]
      }

      response = post_membership_action(remove)
      assert [rejection] = response["rejected"]
      assert rejection["reason"] == "last_group_member"
      assert is_binary(rejection["details"])

      # The refusal is structural, so nothing was written: actor_1 still
      # holds the group and can still reach it.
      assert GroupCache.get_permissions("actor_1", "group_1") != nil
      assert [%{group_id: "group_1"}] = GroupCache.get_actor_groups("actor_1")
    end
  end

  describe "single-entity read authorization" do
    test "returns the entity to a member of one of its groups" do
      bootstrap_group("actor_1", "group_1", ["todo.create", "todo.read"])
      entity_id = "todo_read_#{Nanoid.generate()}"
      hlc = generate_hlc()

      assert write_entity_in_group("actor_1", entity_id, "todo", "group_1", %{
               "title" => %{"type" => "lww", "value" => "Readable", "hlc" => hlc}
             }).status == 200

      conn = get_entity(entity_id, "actor_1")
      assert conn.status == 200
      assert Jason.decode!(conn.resp_body)["data"]["fields"]["title"]["value"] == "Readable"
    end

    test "returns 404 to an authenticated non-member, indistinguishable from missing" do
      bootstrap_group("actor_1", "group_1", ["todo.create", "todo.read"])
      bootstrap_group("actor_2", "group_2", ["todo.create", "todo.read"])

      entity_id = "todo_secret_#{Nanoid.generate()}"
      hlc = generate_hlc()

      write_entity_in_group("actor_1", entity_id, "todo", "group_1", %{
        "title" => %{"type" => "lww", "value" => "Secret", "hlc" => hlc}
      })

      hidden = get_entity(entity_id, "actor_2")
      missing = get_entity("todo_missing_#{Nanoid.generate()}", "actor_2")

      assert hidden.status == 404
      assert missing.status == 404
      assert hidden.resp_body == missing.resp_body
    end
  end

  defp group_member_id(action) do
    action["updates"]
    |> Enum.find(&(&1["subject_type"] == "groupMember"))
    |> Map.fetch!("subject_id")
  end

  # #623: filing an existing entity into a group is the share/invite
  # primitive (the target group's `<type>.create` is the gate); the row it
  # is written through is not. These cover the row-identity vectors.
  describe "cross-tenant entityGroup row identity (#623)" do
    test "an outsider cannot file an entity in, and the owner's share lets them read it" do
      bootstrap_group("victim", "g_victim", ["todo.create", "todo.update", "todo.read"])
      bootstrap_group("attacker", "g_atk", ["todo.create", "todo.update", "groupMember.create"])

      hlc = generate_hlc()
      secret_id = "todo_secret_#{Nanoid.generate()}"

      create = %{
        "id" => "act_secret_#{Nanoid.generate()}",
        "actor_id" => "victim",
        "hlc" => hlc,
        "updates" => [
          todo_put(secret_id, hlc),
          entity_group_put("eg_#{Nanoid.generate()}", secret_id, "g_victim", hlc)
        ]
      }

      assert %{"rejected" => []} = submit(create, "victim")

      # The attacker holds `todo.create` in their own group and nothing in
      # the group the entity lives in. Before #623 this filed the entity in
      # and handed over read *and* write.
      graft = %{
        "id" => "act_graft_#{Nanoid.generate()}",
        "actor_id" => "attacker",
        "hlc" => hlc,
        "updates" => [entity_group_put("eg_#{Nanoid.generate()}", secret_id, "g_atk", hlc)]
      }

      assert %{"rejected" => [%{"reason" => "not_authorized"}]} = submit(graft, "attacker")
      assert get_entity(secret_id, "attacker").status == 404

      # The owner shares it into the group they now both belong to: update
      # where the entity lives, create in the target.
      added = add_group_member("attacker", "g_atk", "victim", ["todo.create"])
      assert Jason.decode!(added.resp_body) == %{"rejected" => []}

      share = %{
        "id" => "act_share_#{Nanoid.generate()}",
        "actor_id" => "victim",
        "hlc" => hlc,
        "updates" => [entity_group_put("eg_#{Nanoid.generate()}", secret_id, "g_atk", hlc)]
      }

      assert %{"rejected" => []} = submit(share, "victim")
      assert get_entity(secret_id, "attacker").status == 200
      assert get_entity(secret_id, "victim").status == 200
    end

    test "an outsider cannot re-point or patch a membership row" do
      bootstrap_group("victim", "g_victim", ["todo.create", "todo.update", "todo.read"])

      hlc = generate_hlc()
      secret_id = "todo_secret_#{Nanoid.generate()}"
      secret_eg = "eg_#{Nanoid.generate()}"

      create = %{
        "id" => "act_secret_#{Nanoid.generate()}",
        "actor_id" => "victim",
        "hlc" => hlc,
        "updates" => [
          todo_put(secret_id, hlc),
          entity_group_put(secret_eg, secret_id, "g_victim", hlc)
        ]
      }

      assert %{"rejected" => []} = submit(create, "victim")

      # The attacker owns this group and self-granted todo.create there.
      bootstrap_group("attacker", "g_atk", ["entityGroup.*", "todo.create", "todo.update"])

      # Positive control: the attacker may file their own entity, so the
      # rejections below are about the row, not an inert membership.
      own_id = "todo_own_#{Nanoid.generate()}"

      own = %{
        "id" => "act_own_#{Nanoid.generate()}",
        "actor_id" => "attacker",
        "hlc" => hlc,
        "updates" => [
          todo_put(own_id, hlc),
          entity_group_put("eg_#{Nanoid.generate()}", own_id, "g_atk", hlc)
        ]
      }

      assert %{"rejected" => []} = submit(own, "attacker")
      assert get_entity(own_id, "attacker").status == 200

      # Re-pointing the victim's membership row at the attacker's entity
      # would orphan the victim's entity and then let the ordinary graft
      # above through with an empty owner set.
      repoint = %{
        "id" => "act_repoint_#{Nanoid.generate()}",
        "actor_id" => "attacker",
        "hlc" => hlc,
        "updates" => [entity_group_put(secret_eg, own_id, "g_atk", hlc)]
      }

      assert %{"rejected" => [%{"reason" => "not_authorized"}]} = submit(repoint, "attacker")

      patch_graft = %{
        "id" => "act_graft_patch_#{Nanoid.generate()}",
        "actor_id" => "attacker",
        "hlc" => hlc,
        "updates" => [
          %{
            "id" => "upd_graft_patch_#{Nanoid.generate()}",
            "subject_id" => "eg_#{Nanoid.generate()}",
            "subject_type" => "entityGroup",
            "method" => "patch",
            "data" => %{
              "fields" => %{
                "entity_id" => %{"type" => "lww", "value" => secret_id, "hlc" => hlc},
                "group_id" => %{"type" => "lww", "value" => "g_atk", "hlc" => hlc}
              }
            }
          }
        ]
      }

      assert %{"rejected" => [%{"reason" => "not_authorized"}]} = submit(patch_graft, "attacker")

      assert get_entity(secret_id, "attacker").status == 404
      assert get_entity(secret_id, "victim").status == 200
    end
  end

  # #624: a write is authorized under the type the entity was committed
  # with, never the `subject_type` the client sends. Otherwise any
  # `<type>.create` in a group becomes a full overwrite and relabel of
  # every other type's entities there.
  describe "committed-type authorization (#624)" do
    test "an outsider cannot relabel or overwrite an entity through its wire type" do
      bootstrap_group("victim", "g_1", ["invoice.*", "todo.*", "groupMember.create"])

      hlc = generate_hlc()
      invoice_id = "invoice_#{Nanoid.generate()}"

      assert write_entity_in_group("victim", invoice_id, "invoice", "g_1", %{
               "amount" => %{"type" => "lww", "value" => 100, "hlc" => hlc}
             }).status == 200

      member = add_group_member("victim", "g_1", "actor_2", ["todo.*"])
      assert member.status == 200
      assert Jason.decode!(member.resp_body) == %{"rejected" => []}

      attack = %{
        "id" => "act_attack_#{Nanoid.generate()}",
        "actor_id" => "actor_2",
        "hlc" => hlc,
        "updates" => [
          %{
            "id" => "upd_attack_#{Nanoid.generate()}",
            "subject_id" => invoice_id,
            "subject_type" => "todo",
            "method" => "put",
            "data" => %{
              "fields" => %{
                "amount" => %{"type" => "lww", "value" => 999_999, "hlc" => hlc}
              }
            }
          }
        ]
      }

      assert %{"rejected" => [%{"reason" => "not_authorized"}]} = submit(attack, "actor_2")

      invoice = Jason.decode!(get_entity(invoice_id, "victim").resp_body)
      assert invoice["type"] == "invoice"
      assert invoice["data"]["fields"]["amount"]["value"] == 100

      # Positive control: the same actor's same-type write in the same
      # group still goes through. A new id has no committed type, so its
      # wire type stands.
      todo_id = "todo_own_#{Nanoid.generate()}"
      legit_hlc = generate_hlc()

      legit = %{
        "id" => "act_legit_#{Nanoid.generate()}",
        "actor_id" => "actor_2",
        "hlc" => legit_hlc,
        "updates" => [
          todo_put(todo_id, legit_hlc),
          entity_group_put("eg_#{Nanoid.generate()}", todo_id, "g_1", legit_hlc)
        ]
      }

      assert %{"rejected" => []} = submit(legit, "actor_2")
      assert Jason.decode!(get_entity(todo_id, "actor_2").resp_body)["type"] == "todo"
    end

    test "a refused patch or delete leaves the committed row untouched" do
      bootstrap_group("victim", "g_1", ["invoice.*", "groupMember.create"])

      member =
        add_group_member("victim", "g_1", "actor_2", ["todo.create", "todo.update", "todo.delete"])

      assert member.status == 200
      assert Jason.decode!(member.resp_body) == %{"rejected" => []}

      hlc = generate_hlc()
      invoice_id = "invoice_#{Nanoid.generate()}"

      assert write_entity_in_group("victim", invoice_id, "invoice", "g_1", %{
               "amount" => %{"type" => "lww", "value" => 100, "hlc" => hlc}
             }).status == 200

      fields = %{"amount" => %{"type" => "lww", "value" => 999_999, "hlc" => hlc}}

      for {method, data} <- [{"patch", %{"fields" => fields}}, {"delete", nil}] do
        update = %{
          "id" => "upd_#{method}_#{Nanoid.generate()}",
          "subject_id" => invoice_id,
          "subject_type" => "todo",
          "method" => method,
          "data" => data
        }

        attack = %{
          "id" => "act_#{method}_#{Nanoid.generate()}",
          "actor_id" => "actor_2",
          "hlc" => hlc,
          "updates" => [update]
        }

        assert %{"rejected" => [%{"reason" => "not_authorized"}]} = submit(attack, "actor_2")

        invoice = Jason.decode!(get_entity(invoice_id, "victim").resp_body)
        assert invoice["type"] == "invoice"
        assert invoice["data"]["fields"]["amount"]["value"] == 100
      end
    end

    test "a later Action cannot relabel an id an earlier Action of the same request created" do
      bootstrap_group("actor_2", "g_1", ["groupMember.create", "invoice.*", "todo.*"])

      hlc = generate_hlc()
      todo_id = "todo_#{Nanoid.generate()}"

      create = %{
        "id" => "act_create_#{Nanoid.generate()}",
        "actor_id" => "actor_2",
        "hlc" => hlc,
        "updates" => [
          todo_put(todo_id, hlc),
          entity_group_put("eg_#{Nanoid.generate()}", todo_id, "g_1", hlc)
        ]
      }

      # Nothing has committed `todo_id` yet when this Action is authorized, so
      # only the request simulation knows it is a `todo`.
      relabel = %{
        "id" => "act_relabel_#{Nanoid.generate()}",
        "actor_id" => "actor_2",
        "hlc" => hlc,
        "updates" => [
          %{
            "id" => "upd_relabel_#{Nanoid.generate()}",
            "subject_id" => todo_id,
            "subject_type" => "invoice",
            "method" => "put",
            "data" => %{
              "fields" => %{"amount" => %{"type" => "lww", "value" => 999_999, "hlc" => hlc}}
            }
          },
          entity_group_put("eg_#{Nanoid.generate()}", todo_id, "g_1", hlc)
        ]
      }

      conn = post_actions(msgpack_encode!(%{"actions" => [create, relabel]}), "actor_2")
      assert conn.status == 200

      assert %{"rejected" => [%{"id" => rejected_id, "reason" => "not_authorized"}]} =
               Jason.decode!(conn.resp_body)

      assert rejected_id == relabel["id"]

      todo = Jason.decode!(get_entity(todo_id, "actor_2").resp_body)
      assert todo["type"] == "todo"
      refute Map.has_key?(todo["data"]["fields"], "amount")
    end
  end

  # A relationship row fans out to its source's group set, so the wire
  # `source_id` may not move an existing row to another source.
  describe "relationship row identity (#624)" do
    test "an outsider cannot re-point a victim's edge" do
      bootstrap_group("victim", "g_victim", ["todo.*", "relationship.*"])
      bootstrap_group("attacker", "g_attacker", ["todo.*", "relationship.*"])

      hlc = generate_hlc()
      victim_id = "todo_victim_#{Nanoid.generate()}"
      victim_edge = "rel_victim_#{Nanoid.generate()}"

      victim_create = %{
        "id" => "act_victim_#{Nanoid.generate()}",
        "actor_id" => "victim",
        "hlc" => hlc,
        "updates" => [
          todo_put(victim_id, hlc),
          entity_group_put("eg_#{Nanoid.generate()}", victim_id, "g_victim", hlc),
          relationship_put(victim_edge, victim_id, "col_x", hlc)
        ]
      }

      assert %{"rejected" => []} = submit(victim_create, "victim")
      assert victim_edge in action_ids("g_victim", "victim")
      refute victim_edge in action_ids("g_attacker", "attacker")

      attacker_hlc = generate_hlc()
      attacker_id = "todo_attacker_#{Nanoid.generate()}"
      attacker_edge = "rel_attacker_#{Nanoid.generate()}"

      # Positive control: the attacker can create their own edge.
      attacker_create = %{
        "id" => "act_attacker_#{Nanoid.generate()}",
        "actor_id" => "attacker",
        "hlc" => attacker_hlc,
        "updates" => [
          todo_put(attacker_id, attacker_hlc),
          entity_group_put("eg_#{Nanoid.generate()}", attacker_id, "g_attacker", attacker_hlc),
          relationship_put(attacker_edge, attacker_id, "col_x", attacker_hlc)
        ]
      }

      assert %{"rejected" => []} = submit(attacker_create, "attacker")
      assert attacker_edge in action_ids("g_attacker", "attacker")

      repoint = %{
        "id" => "act_repoint_#{Nanoid.generate()}",
        "actor_id" => "attacker",
        "hlc" => hlc,
        "updates" => [relationship_put(victim_edge, attacker_id, "col_x", hlc)]
      }

      assert %{"rejected" => [%{"reason" => "not_authorized"}]} = submit(repoint, "attacker")

      # Nothing moved: the edge still fans out to the victim's group only,
      # and the victim can still write it.
      assert victim_edge in action_ids("g_victim", "victim")
      refute victim_edge in action_ids("g_attacker", "attacker")

      victim_write = %{
        "id" => "act_victim_write_#{Nanoid.generate()}",
        "actor_id" => "victim",
        "hlc" => hlc,
        "updates" => [relationship_patch(victim_edge, victim_id, "col_y", hlc)]
      }

      assert %{"rejected" => []} = submit(victim_write, "victim")
    end

    # The delete wire form may carry a `source_id`, but the row's source is
    # its identity: the scope comes from the stored row, so an attacker
    # cannot delete another group's edge by naming their own source.
    test "an outsider cannot delete a victim's edge by naming their own source" do
      bootstrap_group("victim", "g_victim", ["todo.*", "relationship.*"])
      bootstrap_group("attacker", "g_attacker", ["todo.*", "relationship.*"])

      hlc = generate_hlc()
      victim_id = "todo_victim_#{Nanoid.generate()}"
      victim_edge = "rel_victim_#{Nanoid.generate()}"

      victim_create = %{
        "id" => "act_victim_#{Nanoid.generate()}",
        "actor_id" => "victim",
        "hlc" => hlc,
        "updates" => [
          todo_put(victim_id, hlc),
          entity_group_put("eg_#{Nanoid.generate()}", victim_id, "g_victim", hlc),
          relationship_put(victim_edge, victim_id, "col_x", hlc)
        ]
      }

      assert %{"rejected" => []} = submit(victim_create, "victim")
      assert victim_edge in action_ids("g_victim", "victim")

      attacker_hlc = generate_hlc()
      attacker_id = "todo_attacker_#{Nanoid.generate()}"

      attacker_create = %{
        "id" => "act_attacker_#{Nanoid.generate()}",
        "actor_id" => "attacker",
        "hlc" => attacker_hlc,
        "updates" => [
          todo_put(attacker_id, attacker_hlc),
          entity_group_put("eg_#{Nanoid.generate()}", attacker_id, "g_attacker", attacker_hlc)
        ]
      }

      assert %{"rejected" => []} = submit(attacker_create, "attacker")

      attack = %{
        "id" => "act_attack_#{Nanoid.generate()}",
        "actor_id" => "attacker",
        "hlc" => hlc,
        "updates" => [relationship_delete(victim_edge, attacker_id, hlc)]
      }

      assert %{"rejected" => [%{"reason" => "not_authorized"}]} = submit(attack, "attacker")

      # The edge survives and still belongs to the victim's group only.
      assert victim_edge in action_ids("g_victim", "victim")
      refute victim_edge in action_ids("g_attacker", "attacker")

      victim_delete = %{
        "id" => "act_victim_delete_#{Nanoid.generate()}",
        "actor_id" => "victim",
        "hlc" => hlc,
        "updates" => [relationship_delete(victim_edge, nil, hlc)]
      }

      assert %{"rejected" => []} = submit(victim_delete, "victim")
    end

    # Moving an edge is a delete plus a put (#624). The delete is delivered
    # to the groups the stored row belonged to, the put to the new source's,
    # so neither group receives an Update it should not see.
    test "delete plus put moves an edge to another source, one scope per group" do
      bootstrap_group("owner", "g_victim", ["todo.*", "relationship.*"])
      bootstrap_group("owner", "g_new", ["todo.*", "relationship.*"])

      hlc = generate_hlc()
      victim_id = "todo_victim_#{Nanoid.generate()}"
      new_id = "todo_new_#{Nanoid.generate()}"
      edge = "rel_victim_#{Nanoid.generate()}"

      seed = %{
        "id" => "act_seed_#{Nanoid.generate()}",
        "actor_id" => "owner",
        "hlc" => hlc,
        "updates" => [
          todo_put(victim_id, hlc),
          entity_group_put("eg_#{Nanoid.generate()}", victim_id, "g_victim", hlc),
          todo_put(new_id, hlc),
          entity_group_put("eg_#{Nanoid.generate()}", new_id, "g_new", hlc),
          relationship_put(edge, victim_id, "col_x", hlc)
        ]
      }

      assert %{"rejected" => []} = submit(seed, "owner")

      move_id = "act_move_#{Nanoid.generate()}"

      move = %{
        "id" => move_id,
        "actor_id" => "owner",
        "hlc" => hlc,
        "updates" => [
          relationship_delete(edge, nil, hlc),
          relationship_put(edge, new_id, "col_x", hlc)
        ]
      }

      assert %{"rejected" => []} = submit(move, "owner")

      assert [%{"subject_id" => ^edge, "method" => "delete"}] =
               action_updates("g_victim", "owner", move_id)

      assert [%{"subject_id" => ^edge, "method" => "put"}] =
               action_updates("g_new", "owner", move_id)
    end
  end

  defp submit(action, actor_id) do
    conn = post_actions(msgpack_encode!(%{"actions" => [action]}), actor_id)
    assert conn.status == 200
    Jason.decode!(conn.resp_body)
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

  defp relationship_put(rel_id, source_id, target_id, hlc) do
    %{
      "id" => "upd_rel_#{Nanoid.generate()}",
      "subject_id" => rel_id,
      "subject_type" => "relationship",
      "method" => "put",
      "data" => %{
        "fields" => %{
          "source_id" => %{"type" => "lww", "value" => source_id, "hlc" => hlc},
          "target_id" => %{"type" => "lww", "value" => target_id, "hlc" => hlc},
          "type" => %{"type" => "lww", "value" => "todo", "hlc" => hlc},
          "field" => %{"type" => "lww", "value" => "column", "hlc" => hlc}
        }
      }
    }
  end

  defp relationship_patch(rel_id, source_id, target_id, hlc) do
    %{
      "id" => "upd_rel_patch_#{Nanoid.generate()}",
      "subject_id" => rel_id,
      "subject_type" => "relationship",
      "method" => "patch",
      "data" => %{
        "fields" => %{
          "source_id" => %{"type" => "lww", "value" => source_id, "hlc" => hlc},
          "target_id" => %{"type" => "lww", "value" => target_id, "hlc" => hlc}
        }
      }
    }
  end

  defp relationship_delete(rel_id, source_id, hlc) do
    %{
      "id" => "upd_rel_delete_#{Nanoid.generate()}",
      "subject_id" => rel_id,
      "subject_type" => "relationship",
      "method" => "delete",
      "data" => relationship_delete_data(source_id, hlc)
    }
  end

  # The delete wire form normally drops the data envelope; a caller may
  # still send fields, which is exactly the attack MF1 covers.
  defp relationship_delete_data(nil, _hlc), do: nil

  defp relationship_delete_data(source_id, hlc) do
    %{
      "fields" => %{"source_id" => %{"type" => "lww", "value" => source_id, "hlc" => hlc}}
    }
  end

  defp action_id_list(group_id, actor_id) do
    conn =
      conn(:get, "/sync/groups/#{group_id}")
      |> put_req_header("x-ebb-actor-id", actor_id)
      |> Router.call([])

    conn.resp_body |> Jason.decode!() |> Enum.map(& &1["id"])
  end

  # The Updates a group's stream carries for one Action: catch-up scopes
  # each Action to the Updates whose fan-out includes the group (#473).
  defp action_updates(group_id, actor_id, action_id) do
    conn =
      conn(:get, "/sync/groups/#{group_id}")
      |> put_req_header("x-ebb-actor-id", actor_id)
      |> Router.call([])

    case Enum.find(Jason.decode!(conn.resp_body), &(&1["id"] == action_id)) do
      nil -> []
      action -> action["updates"]
    end
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
