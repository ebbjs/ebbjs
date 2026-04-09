defmodule EbbServer.Storage.AuthorizerTest do
  use ExUnit.Case, async: false

  import EbbServer.TestHelpers
  alias EbbServer.Storage.{AuthorizationContext, Authorizer}

  defp auth_context(tables) do
    AuthorizationContext.build(
      group_members: tables.group_members,
      relationships: tables.relationships,
      relationships_by_group: tables.relationships_by_group
    )
  end

  describe "authorize/3 - full authorization pipeline" do
    test "group bootstrap allowed without prior permissions" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      action = %{
        id: "act_1",
        actor_id: "a_1",
        hlc: generate_hlc(),
        updates: [
          %{
            id: "g_1",
            subject_id: "g_1",
            subject_type: "group",
            method: :put,
            data: %{"fields" => %{"name" => %{"value" => "Test Group"}}}
          },
          %{
            id: "gm_1",
            subject_id: "gm_1",
            subject_type: "groupMember",
            method: :put,
            data: %{"actor_id" => "a_1", "group_id" => "g_1", "permissions" => ["group.read"]}
          },
          %{
            id: "rel_1",
            subject_id: "rel_1",
            subject_type: "relationship",
            method: :put,
            data: %{
              "source_id" => "todo_1",
              "target_id" => "g_1",
              "type" => "todo",
              "field" => "group"
            }
          }
        ]
      }

      assert Authorizer.authorize([action], "a_1", ctx) == :ok
    end

    test "authorized user entity write" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      :ets.insert(
        tables.group_members,
        {"a_1", %{id: "gm_1", group_id: "g_1", permissions: ["todo.create", "todo.update"]}}
      )

      :ets.insert(
        tables.relationships,
        {"todo_1", %{id: "rel_1", target_id: "g_1", type: "todo", field: "group"}}
      )

      action = %{
        id: "act_1",
        actor_id: "a_1",
        hlc: generate_hlc(),
        updates: [
          %{
            id: "upd_1",
            subject_id: "todo_1",
            subject_type: "todo",
            method: :put,
            data: %{"fields" => %{"title" => %{"value" => "Test"}}}
          }
        ]
      }

      assert Authorizer.authorize([action], "a_1", ctx) == :ok
    end

    test "unauthorized write (not a member)" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      :ets.insert(
        tables.relationships,
        {"todo_1", %{id: "rel_1", target_id: "g_1", type: "todo", field: "group"}}
      )

      action = %{
        id: "act_1",
        actor_id: "a_1",
        hlc: generate_hlc(),
        updates: [
          %{
            id: "upd_1",
            subject_id: "todo_1",
            subject_type: "todo",
            method: :put,
            data: %{"fields" => %{"title" => %{"value" => "Test"}}}
          }
        ]
      }

      assert {:error, "not_authorized", _} =
               Authorizer.authorize([action], "a_1", ctx)
    end

    test "unauthorized write (wrong permissions)" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      :ets.insert(
        tables.group_members,
        {"a_1", %{id: "gm_1", group_id: "g_1", permissions: ["post.create"]}}
      )

      :ets.insert(
        tables.relationships,
        {"todo_1", %{id: "rel_1", target_id: "g_1", type: "todo", field: "group"}}
      )

      action = %{
        id: "act_1",
        actor_id: "a_1",
        hlc: generate_hlc(),
        updates: [
          %{
            id: "upd_1",
            subject_id: "todo_1",
            subject_type: "todo",
            method: :put,
            data: %{"fields" => %{"title" => %{"value" => "Test"}}}
          }
        ]
      }

      assert {:error, "not_authorized", _} =
               Authorizer.authorize([action], "a_1", ctx)
    end

    test "wildcard permission matches" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      :ets.insert(
        tables.group_members,
        {"a_1", %{id: "gm_1", group_id: "g_1", permissions: ["todo.*"]}}
      )

      :ets.insert(
        tables.relationships,
        {"todo_1", %{id: "rel_1", target_id: "g_1", type: "todo", field: "group"}}
      )

      action = %{
        id: "act_1",
        actor_id: "a_1",
        hlc: generate_hlc(),
        updates: [
          %{
            id: "upd_1",
            subject_id: "todo_1",
            subject_type: "todo",
            method: :patch,
            data: %{"fields" => %{"title" => %{"value" => "Test"}}}
          }
        ]
      }

      assert Authorizer.authorize([action], "a_1", ctx) == :ok
    end

    test "intra-action resolution" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      :ets.insert(
        tables.group_members,
        {"a_1", %{id: "gm_1", group_id: "g_1", permissions: ["todo.create"]}}
      )

      action = %{
        id: "act_1",
        actor_id: "a_1",
        hlc: generate_hlc(),
        updates: [
          %{
            id: "upd_1",
            subject_id: "todo_new",
            subject_type: "todo",
            method: :put,
            data: %{"fields" => %{"title" => %{"value" => "Test"}}}
          },
          %{
            id: "rel_1",
            subject_id: "rel_new",
            subject_type: "relationship",
            method: :put,
            data: %{
              "source_id" => "todo_new",
              "target_id" => "g_1",
              "type" => "todo",
              "field" => "group"
            }
          }
        ]
      }

      assert Authorizer.authorize([action], "a_1", ctx) == :ok
    end

    test "system entity update authorized when actor is group member" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      :ets.insert(
        tables.group_members,
        {"a_1", %{id: "gm_1", group_id: "g_1", permissions: ["group.read"]}}
      )

      action = %{
        id: "act_1",
        actor_id: "a_1",
        hlc: generate_hlc(),
        updates: [
          %{
            id: "gm_2",
            subject_id: "gm_2",
            subject_type: "groupMember",
            method: :patch,
            data: %{
              "fields" => %{
                "group_id" => %{"value" => "g_1"},
                "actor_id" => %{"value" => "a_2"},
                "permissions" => %{"value" => ["group.read"]}
              }
            }
          }
        ]
      }

      assert Authorizer.authorize([action], "a_1", ctx) == :ok
    end

    test "system entity update rejected when actor is not group member" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      action = %{
        id: "act_1",
        actor_id: "a_1",
        hlc: generate_hlc(),
        updates: [
          %{
            id: "gm_1",
            subject_id: "gm_1",
            subject_type: "groupMember",
            method: :patch,
            data: %{
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
               Authorizer.authorize([action], "a_1", ctx)
    end

    test "empty action list returns ok" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      assert Authorizer.authorize([], "a_1", ctx) == :ok
    end
  end
end
