defmodule EbbServer.Storage.PermissionCheckerTest do
  use ExUnit.Case, async: false

  import EbbServer.TestHelpers
  alias EbbServer.Storage.PermissionChecker

  defp put_membership(tables, entity_id, group_id, id) do
    :ets.insert(
      tables.entity_groups,
      {entity_id, %{id: id, entity_id: entity_id, group_id: group_id}}
    )
  end

  defp put_group_member(tables, group_id, permissions, id \\ "gm_1") do
    :ets.insert(
      tables.group_members,
      {"a_1", %{id: id, group_id: group_id, permissions: permissions}}
    )
  end

  defp put_entity_group_by_id(tables, id, entity_id, group_id) do
    :ets.insert(
      tables.entity_groups_by_id,
      {id, %{id: id, entity_id: entity_id, group_id: group_id}}
    )
  end

  defp put_entity_type(tables, entity_id, type) do
    :ets.insert(tables.entity_types, {entity_id, type})
  end

  defp user_action(subject_id, method \\ "put") do
    sample_action(%{
      "updates" => [
        %{
          "id" => "upd_1",
          "subject_id" => subject_id,
          "subject_type" => "todo",
          "method" => method,
          "data" => %{"fields" => %{"title" => %{"value" => "Test"}}}
        }
      ]
    })
  end

  defp user_put_update(id, subject_id) do
    %{
      "id" => id,
      "subject_id" => subject_id,
      "subject_type" => "todo",
      "method" => "put",
      "data" => %{"fields" => %{"title" => %{"value" => "Test"}}}
    }
  end

  defp entity_group_put_update(id, entity_id, group_id) do
    %{
      "id" => id,
      "subject_id" => id,
      "subject_type" => "entityGroup",
      "method" => "put",
      "data" => %{
        "fields" => %{
          "entity_id" => %{"value" => entity_id},
          "group_id" => %{"value" => group_id}
        }
      }
    }
  end

  defp user_patch_update(id, subject_id) do
    %{
      "id" => id,
      "subject_id" => subject_id,
      "subject_type" => "todo",
      "method" => "patch",
      "data" => %{"fields" => %{"title" => %{"value" => "Test"}}}
    }
  end

  defp relationship_put_update(id, source_id, target_id) do
    %{
      "id" => id,
      "subject_id" => id,
      "subject_type" => "relationship",
      "method" => "put",
      "data" => %{
        "fields" => %{
          "source_id" => %{"value" => source_id},
          "target_id" => %{"value" => target_id}
        }
      }
    }
  end

  describe "authorize_updates/2" do
    test "group bootstrap allowed without prior permissions" do
      action = %{
        "id" => "act_1",
        "actor_id" => "a_1",
        "hlc" => generate_hlc(),
        "updates" => [
          %{
            "id" => "g_1",
            "subject_id" => "g_1",
            "subject_type" => "group",
            "method" => "put",
            "data" => %{"fields" => %{"name" => %{"value" => "Test Group"}}}
          },
          %{
            "id" => "gm_1",
            "subject_id" => "gm_1",
            "subject_type" => "groupMember",
            "method" => "put",
            "data" => %{
              "fields" => %{
                "actor_id" => %{"value" => "a_1"},
                "group_id" => %{"value" => "g_1"},
                "permissions" => %{"value" => ["todo.*"]}
              }
            }
          },
          %{
            "id" => "todo_1",
            "subject_id" => "todo_1",
            "subject_type" => "todo",
            "method" => "put",
            "data" => %{"fields" => %{"title" => %{"value" => "Test"}}}
          },
          %{
            "id" => "eg_1",
            "subject_id" => "eg_1",
            "subject_type" => "entityGroup",
            "method" => "put",
            "data" => %{
              "fields" => %{
                "entity_id" => %{"value" => "todo_1"},
                "group_id" => %{"value" => "g_1"}
              }
            }
          }
        ]
      }

      opts = auth_opts(create_isolated_tables())
      assert PermissionChecker.authorize_updates(action, "a_1", opts) == :ok
    end

    test "authorized user entity write" do
      tables = create_isolated_tables()
      opts = auth_opts(tables)

      put_group_member(tables, "g_1", ["todo.create", "todo.update"])
      put_membership(tables, "todo_1", "g_1", "eg_1")

      assert PermissionChecker.authorize_updates(user_action("todo_1"), "a_1", opts) == :ok
    end

    test "unauthorized write (not a member)" do
      tables = create_isolated_tables()
      opts = auth_opts(tables)

      put_membership(tables, "todo_1", "g_1", "eg_1")

      assert {:error, "not_authorized", _} =
               PermissionChecker.authorize_updates(user_action("todo_1"), "a_1", opts)
    end

    test "unauthorized write (wrong permissions)" do
      tables = create_isolated_tables()
      opts = auth_opts(tables)

      put_group_member(tables, "g_1", ["post.create"])
      put_membership(tables, "todo_1", "g_1", "eg_1")

      assert {:error, "not_authorized", _} =
               PermissionChecker.authorize_updates(user_action("todo_1"), "a_1", opts)
    end

    test "wildcard permission matches" do
      tables = create_isolated_tables()
      opts = auth_opts(tables)

      put_group_member(tables, "g_1", ["todo.*"])
      put_membership(tables, "todo_1", "g_1", "eg_1")

      assert PermissionChecker.authorize_updates(user_action("todo_1", "patch"), "a_1", opts) ==
               :ok
    end

    test "intra-action resolution" do
      tables = create_isolated_tables()
      opts = auth_opts(tables)

      put_group_member(tables, "g_1", ["todo.create"])

      action = %{
        "id" => "act_1",
        "actor_id" => "a_1",
        "hlc" => generate_hlc(),
        "updates" => [
          %{
            "id" => "upd_1",
            "subject_id" => "todo_new",
            "subject_type" => "todo",
            "method" => "put",
            "data" => %{"fields" => %{"title" => %{"value" => "Test"}}}
          },
          %{
            "id" => "eg_1",
            "subject_id" => "eg_new",
            "subject_type" => "entityGroup",
            "method" => "put",
            "data" => %{
              "fields" => %{
                "entity_id" => %{"value" => "todo_new"},
                "group_id" => %{"value" => "g_1"}
              }
            }
          }
        ]
      }

      assert PermissionChecker.authorize_updates(action, "a_1", opts) == :ok
    end

    test "system entity update authorized when actor holds groupMember.update" do
      tables = create_isolated_tables()
      opts = auth_opts(tables)

      put_group_member(tables, "g_1", ["groupMember.update"])

      action = %{
        "id" => "act_1",
        "actor_id" => "a_1",
        "hlc" => generate_hlc(),
        "updates" => [
          %{
            "id" => "gm_2",
            "subject_id" => "gm_2",
            "subject_type" => "groupMember",
            "method" => "patch",
            "data" => %{
              "fields" => %{
                "group_id" => %{"value" => "g_1"},
                "actor_id" => %{"value" => "a_2"},
                "permissions" => %{"value" => ["group.read"]}
              }
            }
          }
        ]
      }

      assert PermissionChecker.authorize_updates(action, "a_1", opts) == :ok
    end

    test "system entity update rejected when actor is not group member" do
      tables = create_isolated_tables()
      opts = auth_opts(tables)

      action = %{
        "id" => "act_1",
        "actor_id" => "a_1",
        "hlc" => generate_hlc(),
        "updates" => [
          %{
            "id" => "gm_1",
            "subject_id" => "gm_1",
            "subject_type" => "groupMember",
            "method" => "patch",
            "data" => %{
              "fields" => %{
                "group_id" => %{"value" => "g_1"},
                "actor_id" => %{"value" => "a_2"},
                "permissions" => %{"value" => ["group.read"]}
              }
            }
          }
        ]
      }

      assert {:error, "not_authorized", _} =
               PermissionChecker.authorize_updates(action, "a_1", opts)
    end
  end

  describe "validate_and_authorize/2" do
    test "full pipeline, mixed accepted and rejected" do
      tables = create_isolated_tables()
      opts = auth_opts(tables)

      put_group_member(tables, "g_1", ["todo.create"])
      put_membership(tables, "todo_1", "g_1", "eg_1")

      valid_action = %{
        "id" => "act_1",
        "actor_id" => "a_1",
        "hlc" => generate_hlc(),
        "updates" => [
          %{
            "id" => "upd_1",
            "subject_id" => "todo_1",
            "subject_type" => "todo",
            "method" => "put",
            "data" => %{"fields" => %{"title" => %{"value" => "Test"}}}
          }
        ]
      }

      invalid_action = %{
        "id" => "act_2",
        "actor_id" => "a_2",
        "hlc" => generate_hlc(),
        "updates" => [
          %{
            "id" => "upd_2",
            "subject_id" => "todo_1",
            "subject_type" => "todo",
            "method" => "put",
            "data" => %{"fields" => %{"title" => %{"value" => "Test"}}}
          }
        ]
      }

      {accepted, rejected} =
        PermissionChecker.validate_and_authorize([valid_action, invalid_action], "a_1", opts)

      assert length(accepted) == 1
      assert length(rejected) == 1

      validated = hd(accepted)
      assert is_integer(validated.hlc)
      assert validated.actor_id == "a_1"
      assert is_atom(hd(validated.updates).method)

      rejection = hd(rejected)
      assert rejection.reason == "actor_mismatch"
    end

    test "unowned create rejects with missing_ownership and is not accepted" do
      tables = create_isolated_tables()
      opts = auth_opts(tables)

      put_group_member(tables, "g_1", ["todo.create"])

      action =
        sample_action(%{
          "actor_id" => "a_1",
          "updates" => [
            %{
              "id" => "upd_1",
              "subject_id" => "todo_unowned",
              "subject_type" => "todo",
              "method" => "put",
              "data" => %{"fields" => %{"title" => %{"value" => "Test"}}}
            }
          ]
        })

      {accepted, rejected} = PermissionChecker.validate_and_authorize([action], "a_1", opts)

      assert accepted == []
      assert [rejection] = rejected
      assert rejection.reason == "missing_ownership"
      assert is_binary(rejection.details)
    end

    test "removing the last membership rejects with last_membership and is not accepted" do
      tables = create_isolated_tables()
      opts = auth_opts(tables)

      put_group_member(tables, "g_1", ["todo.update"])
      put_membership(tables, "todo_1", "g_1", "eg_1")
      put_entity_group_by_id(tables, "eg_1", "todo_1", "g_1")
      put_entity_type(tables, "todo_1", "todo")

      action =
        sample_action(%{
          "actor_id" => "a_1",
          "updates" => [
            %{
              "id" => "upd_del",
              "subject_id" => "eg_1",
              "subject_type" => "entityGroup",
              "method" => "delete",
              "data" => nil
            }
          ]
        })

      {accepted, rejected} = PermissionChecker.validate_and_authorize([action], "a_1", opts)

      assert accepted == []
      assert [rejection] = rejected
      assert rejection.reason == "last_membership"
      assert is_binary(rejection.details)
    end

    test "empty action list returns empty tuples" do
      tables = create_isolated_tables()
      opts = auth_opts(tables)

      {accepted, rejected} = PermissionChecker.validate_and_authorize([], "a_1", opts)

      assert accepted == []
      assert rejected == []
    end

    test "accepts a content write that rides a membership write into another group" do
      # Delivery, not authorization, keeps each Update in its own scope now
      # (#473): the pipeline lets a spanning Action through.
      tables = create_isolated_tables()
      opts = auth_opts(tables)

      put_group_member(tables, "g_a", ["todo.create"])
      put_group_member(tables, "g_b", ["todo.create"], "gm_b")
      put_entity_type(tables, "other_1", "todo")

      action = %{
        "id" => "act_mixed",
        "actor_id" => "a_1",
        "hlc" => generate_hlc(),
        "updates" => [
          user_put_update("upd_todo", "todo_new"),
          entity_group_put_update("upd_eg_a", "todo_new", "g_a"),
          entity_group_put_update("upd_eg_b", "other_1", "g_b")
        ]
      }

      {accepted, rejected} = PermissionChecker.validate_and_authorize([action], "a_1", opts)

      assert [%{id: "act_mixed"}] = accepted
      assert rejected == []
    end

    test "a multi-group content Action is accepted" do
      tables = create_isolated_tables()
      opts = auth_opts(tables)

      put_group_member(tables, "g_a", ["todo.create"])
      put_group_member(tables, "g_b", ["todo.create"], "gm_b")

      action = %{
        "id" => "act_multi",
        "actor_id" => "a_1",
        "hlc" => generate_hlc(),
        "updates" => [
          user_put_update("upd_todo", "todo_new"),
          entity_group_put_update("upd_eg_a", "todo_new", "g_a"),
          entity_group_put_update("upd_eg_b", "todo_new", "g_b")
        ]
      }

      {accepted, rejected} = PermissionChecker.validate_and_authorize([action], "a_1", opts)

      assert [%{id: "act_multi"}] = accepted
      assert rejected == []
    end

    test "a system-only membership delta that spans groups is accepted" do
      tables = create_isolated_tables()
      opts = auth_opts(tables)

      put_group_member(tables, "g_a", ["todo.update"])
      put_group_member(tables, "g_b", ["todo.create"], "gm_b")
      put_membership(tables, "todo_1", "g_a", "eg_a")
      put_entity_group_by_id(tables, "eg_a", "todo_1", "g_a")
      put_entity_type(tables, "todo_1", "todo")

      action = %{
        "id" => "act_set_groups",
        "actor_id" => "a_1",
        "hlc" => generate_hlc(),
        "updates" => [
          entity_group_put_update("upd_eg_b", "todo_1", "g_b"),
          %{
            "id" => "upd_eg_del",
            "subject_id" => "eg_a",
            "subject_type" => "entityGroup",
            "method" => "delete",
            "data" => nil
          }
        ]
      }

      {accepted, rejected} = PermissionChecker.validate_and_authorize([action], "a_1", opts)

      assert [%{id: "act_set_groups"}] = accepted
      assert rejected == []
    end

    test "accepts a relationship that follows an entity the same Action creates" do
      tables = create_isolated_tables()
      opts = auth_opts(tables)

      put_group_member(tables, "g_a", ["todo.create", "todo.update"])

      action = %{
        "id" => "act_rel_owned",
        "actor_id" => "a_1",
        "hlc" => generate_hlc(),
        "updates" => [
          user_put_update("upd_todo", "todo_1"),
          entity_group_put_update("upd_eg", "todo_1", "g_a"),
          relationship_put_update("upd_rel", "todo_1", "target_1")
        ]
      }

      {accepted, rejected} = PermissionChecker.validate_and_authorize([action], "a_1", opts)

      assert [%{id: "act_rel_owned"}] = accepted
      assert rejected == []
    end
  end

  describe "read authorization" do
    test "can_read?/3 allows an actor who is a member of one of the entity's groups" do
      tables = create_isolated_tables()
      opts = auth_opts(tables)

      put_membership(tables, "todo_1", "g_1", "eg_1")
      put_group_member(tables, "g_1", ["todo.read"])

      assert PermissionChecker.can_read?("todo_1", "a_1", opts)
    end

    test "can_read?/3 denies an actor who is a member of none of the entity's groups" do
      tables = create_isolated_tables()
      opts = auth_opts(tables)

      put_membership(tables, "todo_1", "g_1", "eg_1")
      put_group_member(tables, "g_2", ["todo.read"])

      refute PermissionChecker.can_read?("todo_1", "a_1", opts)
    end

    test "can_read?/3 allows through any one of the entity's groups" do
      tables = create_isolated_tables()
      opts = auth_opts(tables)

      put_membership(tables, "todo_1", "g_1", "eg_1")
      put_membership(tables, "todo_1", "g_2", "eg_2")
      put_group_member(tables, "g_2", ["todo.read"])

      assert PermissionChecker.can_read?("todo_1", "a_1", opts)
    end

    test "can_read?/3 denies an entity that belongs to no group" do
      tables = create_isolated_tables()
      opts = auth_opts(tables)

      put_group_member(tables, "g_1", ["todo.read"])

      refute PermissionChecker.can_read?("todo_unowned", "a_1", opts)
    end

    test "can_read?/3 denies once the membership is revoked" do
      tables = create_isolated_tables()
      opts = auth_opts(tables)

      put_membership(tables, "todo_1", "g_1", "eg_1")
      put_group_member(tables, "g_1", ["todo.read"])

      assert PermissionChecker.can_read?("todo_1", "a_1", opts)

      :ets.delete(tables.group_members, "a_1")

      refute PermissionChecker.can_read?("todo_1", "a_1", opts)
    end

    test "member_group_ids/3 returns only the groups the actor belongs to" do
      tables = create_isolated_tables()
      opts = auth_opts(tables)

      put_group_member(tables, "g_1", ["todo.read"])

      assert PermissionChecker.member_group_ids(["g_1", "g_2"], "a_1", opts) == ["g_1"]
    end

    test "member_of_all_groups?/3 requires membership in every group" do
      tables = create_isolated_tables()
      opts = auth_opts(tables)

      put_group_member(tables, "g_1", ["todo.read"])

      assert PermissionChecker.member_of_all_groups?(["g_1"], "a_1", opts)
      refute PermissionChecker.member_of_all_groups?(["g_1", "g_2"], "a_1", opts)
    end
  end
end
