defmodule EbbServer.Storage.AuthorizerTest do
  use ExUnit.Case, async: false

  import EbbServer.TestHelpers
  alias EbbServer.Storage.{AuthorizationContext, Authorizer}

  defp auth_context(tables) do
    AuthorizationContext.build(
      group_members: tables.group_members,
      group_members_by_id: tables.group_members_by_id,
      entity_groups: tables.entity_groups,
      entity_groups_by_id: tables.entity_groups_by_id,
      relationships_by_id: tables.relationships_by_id
    )
  end

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
            data: %{
              "fields" => %{
                "actor_id" => %{"value" => "a_1"},
                "group_id" => %{"value" => "g_1"},
                "permissions" => %{"value" => ["group.read"]}
              }
            }
          },
          %{
            id: "eg_1",
            subject_id: "eg_1",
            subject_type: "entityGroup",
            method: :put,
            data: %{
              "fields" => %{
                "entity_id" => %{"value" => "todo_1"},
                "group_id" => %{"value" => "g_1"}
              }
            }
          }
        ]
      }

      assert Authorizer.authorize([action], "a_1", ctx) == :ok
    end

    test "authorized user entity write" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_1", ["todo.create", "todo.update"])
      put_membership(tables, "todo_1", "g_1", "eg_1")

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

      put_membership(tables, "todo_1", "g_1", "eg_1")

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

      assert {:error, "not_authorized", _} = Authorizer.authorize([action], "a_1", ctx)
    end

    test "unauthorized write (wrong permissions)" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_1", ["post.create"])
      put_membership(tables, "todo_1", "g_1", "eg_1")

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

      assert {:error, "not_authorized", _} = Authorizer.authorize([action], "a_1", ctx)
    end

    test "wildcard permission matches" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_1", ["todo.*"])
      put_membership(tables, "todo_1", "g_1", "eg_1")

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

    test "union: a permission held in any one of the entity's groups is enough" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_1", ["todo.create"])
      put_group_member(tables, "g_2", ["todo.read"], "gm_2")

      put_membership(tables, "todo_1", "g_1", "eg_1")
      put_membership(tables, "todo_1", "g_2", "eg_2")

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

    test "intra-action resolution" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_1", ["todo.create"])

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
            id: "eg_1",
            subject_id: "eg_new",
            subject_type: "entityGroup",
            method: :put,
            data: %{
              "fields" => %{
                "entity_id" => %{"value" => "todo_new"},
                "group_id" => %{"value" => "g_1"}
              }
            }
          }
        ]
      }

      assert Authorizer.authorize([action], "a_1", ctx) == :ok
    end

    test "system entity update authorized when actor is group member" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_1", ["group.read"])

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

      assert {:error, "not_authorized", _} = Authorizer.authorize([action], "a_1", ctx)
    end

    test "empty action list returns ok" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      assert Authorizer.authorize([], "a_1", ctx) == :ok
    end
  end

  # System-entity deletes arrive on the wire with `data: nil` (the data
  # fields are dropped); the authorizer must recover the owning group
  # from the by-id index tables rather than from the wire envelope.
  describe "authorize/3 - system-entity delete with data:nil" do
    test "entityGroup delete resolves the target group from the by-id index" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_1", ["group.read"])

      :ets.insert(
        tables.entity_groups_by_id,
        {"eg_1", %{id: "eg_1", entity_id: "todo_1", group_id: "g_1"}}
      )

      action = %{
        id: "act_1",
        actor_id: "a_1",
        hlc: generate_hlc(),
        updates: [
          %{
            id: "upd_del",
            subject_id: "eg_1",
            subject_type: "entityGroup",
            method: :delete,
            data: nil
          }
        ]
      }

      assert Authorizer.authorize([action], "a_1", ctx) == :ok
    end

    test "entityGroup delete rejects an actor outside the target group" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      :ets.insert(
        tables.entity_groups_by_id,
        {"eg_1", %{id: "eg_1", entity_id: "todo_1", group_id: "g_1"}}
      )

      action = %{
        id: "act_1",
        actor_id: "a_1",
        hlc: generate_hlc(),
        updates: [
          %{
            id: "upd_del",
            subject_id: "eg_1",
            subject_type: "entityGroup",
            method: :delete,
            data: nil
          }
        ]
      }

      assert {:error, "not_authorized", _} = Authorizer.authorize([action], "a_1", ctx)
    end

    test "relationship delete resolves the source's membership after a put" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_1", ["relationship.update"])
      put_membership(tables, "todo_1", "g_1", "eg_1")

      :ets.insert(
        tables.relationships_by_id,
        {"rel_1",
         %{id: "rel_1", source_id: "todo_1", target_id: "col_1", type: "todo", field: "column"}}
      )

      action = %{
        id: "act_1",
        actor_id: "a_1",
        hlc: generate_hlc(),
        updates: [
          %{
            id: "upd_del",
            subject_id: "rel_1",
            subject_type: "relationship",
            method: :delete,
            data: nil
          }
        ]
      }

      assert Authorizer.authorize([action], "a_1", ctx) == :ok
    end

    test "relationship delete rejects actor not a member of the source's groups" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_membership(tables, "todo_1", "g_1", "eg_1")

      :ets.insert(
        tables.relationships_by_id,
        {"rel_1",
         %{id: "rel_1", source_id: "todo_1", target_id: "col_1", type: "todo", field: "column"}}
      )

      action = %{
        id: "act_1",
        actor_id: "a_1",
        hlc: generate_hlc(),
        updates: [
          %{
            id: "upd_del",
            subject_id: "rel_1",
            subject_type: "relationship",
            method: :delete,
            data: nil
          }
        ]
      }

      assert {:error, "not_authorized", _} = Authorizer.authorize([action], "a_1", ctx)
    end

    test "relationship delete rejects when the relationship is not in cache" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      action = %{
        id: "act_1",
        actor_id: "a_1",
        hlc: generate_hlc(),
        updates: [
          %{
            id: "upd_del",
            subject_id: "rel_unknown",
            subject_type: "relationship",
            method: :delete,
            data: nil
          }
        ]
      }

      assert {:error, "not_authorized", _} = Authorizer.authorize([action], "a_1", ctx)
    end

    test "groupMember delete resolves group_id from cache after a put" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_1", ["group.read"])

      :ets.insert(
        tables.group_members_by_id,
        {"gm_1", %{id: "gm_1", actor_id: "a_2", group_id: "g_1", permissions: ["group.read"]}}
      )

      action = %{
        id: "act_1",
        actor_id: "a_1",
        hlc: generate_hlc(),
        updates: [
          %{
            id: "upd_del",
            subject_id: "gm_1",
            subject_type: "groupMember",
            method: :delete,
            data: nil
          }
        ]
      }

      assert Authorizer.authorize([action], "a_1", ctx) == :ok
    end

    test "relationship put authorizes through the source's membership set, not target_id" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_source", ["relationship.update"])
      put_membership(tables, "todo_1", "g_source", "eg_1")

      action = %{
        id: "act_1",
        actor_id: "a_1",
        hlc: generate_hlc(),
        updates: [
          %{
            id: "upd_put",
            subject_id: "rel_1",
            subject_type: "relationship",
            method: :put,
            data: %{
              "fields" => %{
                "source_id" => %{"value" => "todo_1"},
                "target_id" => %{"value" => "col_other"},
                "type" => %{"value" => "todo"},
                "field" => %{"value" => "column"}
              }
            }
          }
        ]
      }

      assert Authorizer.authorize([action], "a_1", ctx) == :ok
    end

    test "relationship put rejects when only the target's group would authorize it" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_target", ["relationship.update"])

      action = %{
        id: "act_1",
        actor_id: "a_1",
        hlc: generate_hlc(),
        updates: [
          %{
            id: "upd_put",
            subject_id: "rel_1",
            subject_type: "relationship",
            method: :put,
            data: %{
              "fields" => %{
                "source_id" => %{"value" => "todo_1"},
                "target_id" => %{"value" => "g_target"},
                "type" => %{"value" => "todo"},
                "field" => %{"value" => "column"}
              }
            }
          }
        ]
      }

      assert {:error, "not_authorized", _} = Authorizer.authorize([action], "a_1", ctx)
    end
  end
end
