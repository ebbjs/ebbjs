defmodule EbbServer.Storage.PermissionCheckerTest do
  use ExUnit.Case, async: false

  import EbbServer.TestHelpers
  alias EbbServer.Storage.PermissionChecker

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
            "data" => %{"actor_id" => "a_1", "group_id" => "g_1", "permissions" => ["group.read"]}
          },
          %{
            "id" => "rel_1",
            "subject_id" => "rel_1",
            "subject_type" => "relationship",
            "method" => "put",
            "data" => %{
              "source_id" => "todo_1",
              "target_id" => "g_1",
              "type" => "todo",
              "field" => "group"
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

      :ets.insert(
        tables.group_members,
        {"a_1", %{id: "gm_1", group_id: "g_1", permissions: ["todo.create", "todo.update"]}}
      )

      :ets.insert(
        tables.relationships,
        {"todo_1", %{id: "rel_1", target_id: "g_1", type: "todo", field: "group"}}
      )

      action =
        sample_action(%{
          "updates" => [
            %{
              "id" => "upd_1",
              "subject_id" => "todo_1",
              "subject_type" => "todo",
              "method" => "put",
              "data" => %{"fields" => %{"title" => %{"value" => "Test"}}}
            }
          ]
        })

      assert PermissionChecker.authorize_updates(action, "a_1", opts) == :ok
    end

    test "unauthorized write (not a member)" do
      tables = create_isolated_tables()
      opts = auth_opts(tables)

      :ets.insert(
        tables.relationships,
        {"todo_1", %{id: "rel_1", target_id: "g_1", type: "todo", field: "group"}}
      )

      action =
        sample_action(%{
          "updates" => [
            %{
              "id" => "upd_1",
              "subject_id" => "todo_1",
              "subject_type" => "todo",
              "method" => "put",
              "data" => %{"fields" => %{"title" => %{"value" => "Test"}}}
            }
          ]
        })

      assert {:error, "not_authorized", _} =
               PermissionChecker.authorize_updates(action, "a_1", opts)
    end

    test "unauthorized write (wrong permissions)" do
      tables = create_isolated_tables()
      opts = auth_opts(tables)

      :ets.insert(
        tables.group_members,
        {"a_1", %{id: "gm_1", group_id: "g_1", permissions: ["post.create"]}}
      )

      :ets.insert(
        tables.relationships,
        {"todo_1", %{id: "rel_1", target_id: "g_1", type: "todo", field: "group"}}
      )

      action =
        sample_action(%{
          "updates" => [
            %{
              "id" => "upd_1",
              "subject_id" => "todo_1",
              "subject_type" => "todo",
              "method" => "put",
              "data" => %{"fields" => %{"title" => %{"value" => "Test"}}}
            }
          ]
        })

      assert {:error, "not_authorized", _} =
               PermissionChecker.authorize_updates(action, "a_1", opts)
    end

    test "wildcard permission matches" do
      tables = create_isolated_tables()
      opts = auth_opts(tables)

      :ets.insert(
        tables.group_members,
        {"a_1", %{id: "gm_1", group_id: "g_1", permissions: ["todo.*"]}}
      )

      :ets.insert(
        tables.relationships,
        {"todo_1", %{id: "rel_1", target_id: "g_1", type: "todo", field: "group"}}
      )

      action =
        sample_action(%{
          "updates" => [
            %{
              "id" => "upd_1",
              "subject_id" => "todo_1",
              "subject_type" => "todo",
              "method" => "patch",
              "data" => %{"fields" => %{"title" => %{"value" => "Test"}}}
            }
          ]
        })

      assert PermissionChecker.authorize_updates(action, "a_1", opts) == :ok
    end

    test "intra-action resolution" do
      tables = create_isolated_tables()
      opts = auth_opts(tables)

      :ets.insert(
        tables.group_members,
        {"a_1", %{id: "gm_1", group_id: "g_1", permissions: ["todo.create"]}}
      )

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
            "id" => "rel_1",
            "subject_id" => "rel_new",
            "subject_type" => "relationship",
            "method" => "put",
            "data" => %{
              "source_id" => "todo_new",
              "target_id" => "g_1",
              "type" => "todo",
              "field" => "group"
            }
          }
        ]
      }

      assert PermissionChecker.authorize_updates(action, "a_1", opts) == :ok
    end

    test "system entity update authorized when actor is group member" do
      tables = create_isolated_tables()
      opts = auth_opts(tables)

      :ets.insert(
        tables.group_members,
        {"a_1", %{id: "gm_1", group_id: "g_1", permissions: ["group.read"]}}
      )

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

      :ets.insert(
        tables.group_members,
        {"a_1", %{id: "gm_1", group_id: "g_1", permissions: ["todo.create"]}}
      )

      :ets.insert(
        tables.relationships,
        {"todo_1", %{id: "rel_1", target_id: "g_1", type: "todo", field: "group"}}
      )

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

    test "empty action list returns empty tuples" do
      tables = create_isolated_tables()
      opts = auth_opts(tables)

      {accepted, rejected} = PermissionChecker.validate_and_authorize([], "a_1", opts)

      assert accepted == []
      assert rejected == []
    end
  end
end
