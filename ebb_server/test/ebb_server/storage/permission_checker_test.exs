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
  end
end
