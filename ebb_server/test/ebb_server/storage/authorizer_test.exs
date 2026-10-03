defmodule EbbServer.Storage.AuthorizerTest do
  use ExUnit.Case, async: false

  import EbbServer.TestHelpers
  alias EbbServer.Storage.{AuthorizationContext, Authorizer}

  defp auth_context(tables) do
    AuthorizationContext.build(
      group_members: tables.group_members,
      group_members_by_id: tables.group_members_by_id,
      relationships: tables.relationships,
      relationships_by_group: tables.relationships_by_group,
      relationships_by_id: tables.relationships_by_id
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
            id: "rel_1",
            subject_id: "rel_1",
            subject_type: "relationship",
            method: :put,
            data: %{
              "fields" => %{
                "source_id" => %{"value" => "todo_1"},
                "target_id" => %{"value" => "g_1"},
                "type" => %{"value" => "todo"},
                "field" => %{"value" => "group"}
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

      :ets.insert(
        tables.group_members,
        {"a_1", %{id: "gm_1", group_id: "g_1", permissions: ["todo.create", "todo.update"]}}
      )

      :ets.insert(
        tables.relationships,
        {"todo_1",
         %{
           id: "rel_1",
           source_id: "todo_1",
           target_id: "g_1",
           type: "todo",
           field: "groups",
           kind: "member"
         }}
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
        {"todo_1",
         %{
           id: "rel_1",
           source_id: "todo_1",
           target_id: "g_1",
           type: "todo",
           field: "groups",
           kind: "member"
         }}
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

      assert {:error, "not_authorized", _} = Authorizer.authorize([action], "a_1", ctx)
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
        {"todo_1",
         %{
           id: "rel_1",
           source_id: "todo_1",
           target_id: "g_1",
           type: "todo",
           field: "groups",
           kind: "member"
         }}
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

      assert {:error, "not_authorized", _} = Authorizer.authorize([action], "a_1", ctx)
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
        {"todo_1",
         %{
           id: "rel_1",
           source_id: "todo_1",
           target_id: "g_1",
           type: "todo",
           field: "groups",
           kind: "member"
         }}
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

    test "union: a permission held in any one of the entity's groups is enough" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      :ets.insert(
        tables.group_members,
        {"a_1", %{id: "gm_1", group_id: "g_1", permissions: ["todo.create"]}}
      )

      :ets.insert(
        tables.group_members,
        {"a_1", %{id: "gm_2", group_id: "g_2", permissions: ["todo.read"]}}
      )

      :ets.insert(
        tables.relationships,
        {
          "todo_1",
          %{
            id: "rel_1",
            source_id: "todo_1",
            target_id: "g_1",
            type: "todo",
            field: "groups",
            kind: "member"
          }
        }
      )

      :ets.insert(
        tables.relationships,
        {
          "todo_1",
          %{
            id: "rel_2",
            source_id: "todo_1",
            target_id: "g_2",
            type: "todo",
            field: "groups",
            kind: "member"
          }
        }
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
              "fields" => %{
                "source_id" => %{"value" => "todo_new"},
                "target_id" => %{"value" => "g_1"},
                "type" => %{"value" => "todo"},
                "field" => %{"value" => "groups"},
                "kind" => %{"value" => "member"}
              }
            }
          }
        ]
      }

      assert Authorizer.authorize([action], "a_1", ctx) == :ok
    end

    test "unowned entity put is rejected as missing_ownership, not not_authorized" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      # The actor holds the create permission in a group, so the old
      # create fallback would have accepted this write. Without a
      # membership edge the entity would be materialized globally and
      # never indexed into any group, so it must be rejected.
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
            subject_id: "todo_1",
            subject_type: "todo",
            method: :put,
            data: %{"fields" => %{"title" => %{"value" => "Test"}}}
          }
        ]
      }

      assert {:error, "missing_ownership", details} =
               Authorizer.authorize([action], "a_1", ctx)

      assert details =~ "membership"
    end

    test "orphan entity patch is rejected as missing_ownership" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      # An orphan: the entity was materialized without any `kind: "member"`
      # edge, so the relationship cache has no group for it. The update
      # method does not matter to the empty-group branch; the actor's
      # `todo.update` permission must not resurrect the write.
      :ets.insert(
        tables.group_members,
        {"a_1", %{id: "gm_1", group_id: "g_1", permissions: ["todo.update"]}}
      )

      action = %{
        id: "act_1",
        actor_id: "a_1",
        hlc: generate_hlc(),
        updates: [
          %{
            id: "upd_1",
            subject_id: "todo_orphan_patch",
            subject_type: "todo",
            method: :patch,
            data: %{"fields" => %{"title" => %{"value" => "Test"}}}
          }
        ]
      }

      assert {:error, "missing_ownership", details} =
               Authorizer.authorize([action], "a_1", ctx)

      assert details =~ "membership"
    end

    test "orphan entity delete is rejected as missing_ownership" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      :ets.insert(
        tables.group_members,
        {"a_1", %{id: "gm_1", group_id: "g_1", permissions: ["todo.delete"]}}
      )

      action = %{
        id: "act_1",
        actor_id: "a_1",
        hlc: generate_hlc(),
        updates: [
          %{
            id: "upd_1",
            subject_id: "todo_orphan_delete",
            subject_type: "todo",
            method: :delete,
            data: nil
          }
        ]
      }

      assert {:error, "missing_ownership", details} =
               Authorizer.authorize([action], "a_1", ctx)

      assert details =~ "membership"
    end

    test "entity put with a same-action membership edge is accepted" do
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
            subject_id: "todo_1",
            subject_type: "todo",
            method: :put,
            data: %{"fields" => %{"title" => %{"value" => "Test"}}}
          },
          %{
            id: "rel_1",
            subject_id: "rel_1",
            subject_type: "relationship",
            method: :put,
            data: %{
              "fields" => %{
                "source_id" => %{"value" => "todo_1"},
                "target_id" => %{"value" => "g_1"},
                "type" => %{"value" => "todo"},
                "field" => %{"value" => "groups"},
                "kind" => %{"value" => "member"}
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
    test "relationship delete resolves the source's membership after a put" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      :ets.insert(
        tables.group_members,
        {"a_1", %{id: "gm_1", group_id: "g_1", permissions: ["relationship.update"]}}
      )

      :ets.insert(
        tables.relationships,
        {
          "todo_1",
          %{
            id: "rel_1",
            source_id: "todo_1",
            target_id: "g_1",
            type: "todo",
            field: "groups",
            kind: "member"
          }
        }
      )

      :ets.insert(
        tables.relationships_by_id,
        {"rel_1",
         %{
           id: "rel_1",
           source_id: "todo_1",
           target_id: "g_1",
           type: "todo",
           field: "groups",
           kind: "member"
         }}
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

      :ets.insert(
        tables.relationships,
        {
          "todo_1",
          %{
            id: "rel_1",
            source_id: "todo_1",
            target_id: "g_1",
            type: "todo",
            field: "groups",
            kind: "member"
          }
        }
      )

      :ets.insert(
        tables.relationships_by_id,
        {"rel_1",
         %{
           id: "rel_1",
           source_id: "todo_1",
           target_id: "g_1",
           type: "todo",
           field: "groups",
           kind: "member"
         }}
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

      :ets.insert(
        tables.group_members,
        {"a_1", %{id: "gm_2", group_id: "g_1", permissions: ["group.read"]}}
      )

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

      :ets.insert(
        tables.group_members,
        {"a_1", %{id: "gm_1", group_id: "g_source", permissions: ["relationship.update"]}}
      )

      :ets.insert(
        tables.relationships,
        {
          "todo_1",
          %{
            id: "rel_member",
            source_id: "todo_1",
            target_id: "g_source",
            type: "todo",
            field: "groups",
            kind: "member"
          }
        }
      )

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
                "field" => %{"value" => "column"},
                "kind" => %{"value" => "link"}
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

      :ets.insert(
        tables.group_members,
        {"a_1", %{id: "gm_1", group_id: "g_target", permissions: ["relationship.update"]}}
      )

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
                "field" => %{"value" => "group"},
                "kind" => %{"value" => "link"}
              }
            }
          }
        ]
      }

      assert {:error, "not_authorized", _} = Authorizer.authorize([action], "a_1", ctx)
    end
  end
end
