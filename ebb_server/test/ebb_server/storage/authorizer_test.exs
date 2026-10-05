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

  defp put_group_member_by_id(tables, id, actor_id, group_id, permissions) do
    :ets.insert(
      tables.group_members_by_id,
      {id, %{id: id, actor_id: actor_id, group_id: group_id, permissions: permissions}}
    )
  end

  defp put_entity_group_by_id(tables, id, entity_id, group_id) do
    :ets.insert(
      tables.entity_groups_by_id,
      {id, %{id: id, entity_id: entity_id, group_id: group_id}}
    )
  end

  defp put_relationship_by_id(tables, id, source_id) do
    :ets.insert(
      tables.relationships_by_id,
      {id, %{id: id, source_id: source_id, target_id: "target", type: "todo", field: "column"}}
    )
  end

  defp build_action(updates, actor_id \\ "a_1") do
    %{id: "act_test", actor_id: actor_id, hlc: generate_hlc(), updates: updates}
  end

  defp group_put(id) do
    %{
      id: id,
      subject_id: id,
      subject_type: "group",
      method: :put,
      data: %{"fields" => %{"name" => %{"value" => "Test Group"}}}
    }
  end

  defp group_member_put(id, actor_id, group_id, permissions) do
    %{
      id: id,
      subject_id: id,
      subject_type: "groupMember",
      method: :put,
      data: %{
        "fields" => %{
          "actor_id" => %{"value" => actor_id},
          "group_id" => %{"value" => group_id},
          "permissions" => %{"value" => permissions}
        }
      }
    }
  end

  defp entity_put(id, type) do
    %{id: id, subject_id: id, subject_type: type, method: :put, data: %{"fields" => %{}}}
  end

  defp entity_group_put(id, entity_id, group_id) do
    %{
      id: id,
      subject_id: id,
      subject_type: "entityGroup",
      method: :put,
      data: %{
        "fields" => %{
          "entity_id" => %{"value" => entity_id},
          "group_id" => %{"value" => group_id}
        }
      }
    }
  end

  defp relationship_put(id, source_id, target_id, source_type) do
    %{
      id: id,
      subject_id: id,
      subject_type: "relationship",
      method: :put,
      data: %{
        "fields" => %{
          "source_id" => %{"value" => source_id},
          "target_id" => %{"value" => target_id},
          "type" => %{"value" => source_type},
          "field" => %{"value" => "column"}
        }
      }
    }
  end

  describe "authorize/3 - full authorization pipeline" do
    test "group bootstrap allowed without prior permissions" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      action =
        build_action([
          group_put("g_1"),
          group_member_put("gm_1", "a_1", "g_1", ["todo.*"]),
          entity_put("todo_1", "todo"),
          entity_group_put("eg_1", "todo_1", "g_1")
        ])

      assert Authorizer.authorize([action], "a_1", ctx) == :ok
    end

    test "authorized user entity write" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_1", ["todo.create", "todo.update"])
      put_membership(tables, "todo_1", "g_1", "eg_1")

      action =
        build_action([
          %{
            id: "upd_1",
            subject_id: "todo_1",
            subject_type: "todo",
            method: :put,
            data: %{"fields" => %{"title" => %{"value" => "Test"}}}
          }
        ])

      assert Authorizer.authorize([action], "a_1", ctx) == :ok
    end

    test "unauthorized write (not a member)" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_membership(tables, "todo_1", "g_1", "eg_1")

      action =
        build_action([
          %{
            id: "upd_1",
            subject_id: "todo_1",
            subject_type: "todo",
            method: :put,
            data: %{"fields" => %{"title" => %{"value" => "Test"}}}
          }
        ])

      assert {:error, "not_authorized", _} = Authorizer.authorize([action], "a_1", ctx)
    end

    test "unauthorized write (wrong permissions)" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_1", ["post.create"])
      put_membership(tables, "todo_1", "g_1", "eg_1")

      action =
        build_action([
          %{
            id: "upd_1",
            subject_id: "todo_1",
            subject_type: "todo",
            method: :put,
            data: %{"fields" => %{"title" => %{"value" => "Test"}}}
          }
        ])

      assert {:error, "not_authorized", _} = Authorizer.authorize([action], "a_1", ctx)
    end

    test "wildcard permission matches" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_1", ["todo.*"])
      put_membership(tables, "todo_1", "g_1", "eg_1")

      action =
        build_action([
          %{
            id: "upd_1",
            subject_id: "todo_1",
            subject_type: "todo",
            method: :patch,
            data: %{"fields" => %{"title" => %{"value" => "Test"}}}
          }
        ])

      assert Authorizer.authorize([action], "a_1", ctx) == :ok
    end

    test "union: a permission held in any one of the entity's groups is enough" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_1", ["todo.create"])
      put_group_member(tables, "g_2", ["todo.read"], "gm_2")

      put_membership(tables, "todo_1", "g_1", "eg_1")
      put_membership(tables, "todo_1", "g_2", "eg_2")

      action =
        build_action([
          %{
            id: "upd_1",
            subject_id: "todo_1",
            subject_type: "todo",
            method: :put,
            data: %{"fields" => %{"title" => %{"value" => "Test"}}}
          }
        ])

      assert Authorizer.authorize([action], "a_1", ctx) == :ok
    end

    test "intra-action resolution" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_1", ["todo.create"])

      action =
        build_action([
          entity_put("todo_new", "todo"),
          entity_group_put("eg_new", "todo_new", "g_1")
        ])

      assert Authorizer.authorize([action], "a_1", ctx) == :ok
    end

    test "system entity update authorized when actor holds groupMember.update" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_1", ["groupMember.update"])

      action =
        build_action([
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
        ])

      assert Authorizer.authorize([action], "a_1", ctx) == :ok
    end

    test "system entity update rejected when actor is not group member" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      action =
        build_action([
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
        ])

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

      put_group_member(tables, "g_1", ["entityGroup.delete"])
      put_entity_group_by_id(tables, "eg_1", "todo_1", "g_1")

      action =
        build_action([
          %{
            id: "upd_del",
            subject_id: "eg_1",
            subject_type: "entityGroup",
            method: :delete,
            data: nil
          }
        ])

      assert Authorizer.authorize([action], "a_1", ctx) == :ok
    end

    test "entityGroup delete rejects an actor outside the target group" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_entity_group_by_id(tables, "eg_1", "todo_1", "g_1")

      action =
        build_action([
          %{
            id: "upd_del",
            subject_id: "eg_1",
            subject_type: "entityGroup",
            method: :delete,
            data: nil
          }
        ])

      assert {:error, "not_authorized", _} = Authorizer.authorize([action], "a_1", ctx)
    end

    test "relationship delete resolves the source's membership after a put" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_1", ["relationship.delete"])
      put_membership(tables, "todo_1", "g_1", "eg_1")
      put_relationship_by_id(tables, "rel_1", "todo_1")

      action =
        build_action([
          %{
            id: "upd_del",
            subject_id: "rel_1",
            subject_type: "relationship",
            method: :delete,
            data: nil
          }
        ])

      assert Authorizer.authorize([action], "a_1", ctx) == :ok
    end

    test "relationship delete rejects actor not a member of the source's groups" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_membership(tables, "todo_1", "g_1", "eg_1")
      put_relationship_by_id(tables, "rel_1", "todo_1")

      action =
        build_action([
          %{
            id: "upd_del",
            subject_id: "rel_1",
            subject_type: "relationship",
            method: :delete,
            data: nil
          }
        ])

      assert {:error, "not_authorized", _} = Authorizer.authorize([action], "a_1", ctx)
    end

    test "relationship delete rejects when the relationship is not in cache" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      action =
        build_action([
          %{
            id: "upd_del",
            subject_id: "rel_unknown",
            subject_type: "relationship",
            method: :delete,
            data: nil
          }
        ])

      assert {:error, "not_authorized", _} = Authorizer.authorize([action], "a_1", ctx)
    end

    test "groupMember delete resolves group_id from cache after a put" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_1", ["groupMember.delete"])
      put_group_member_by_id(tables, "gm_1", "a_2", "g_1", ["group.read"])

      action =
        build_action([
          %{
            id: "upd_del",
            subject_id: "gm_1",
            subject_type: "groupMember",
            method: :delete,
            data: nil
          }
        ])

      assert Authorizer.authorize([action], "a_1", ctx) == :ok
    end

    test "relationship put authorizes through the source's membership set, not target_id" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_source", ["todo.update"])
      put_membership(tables, "todo_1", "g_source", "eg_1")

      action = build_action([relationship_put("rel_1", "todo_1", "col_other", "todo")])

      assert Authorizer.authorize([action], "a_1", ctx) == :ok
    end

    test "relationship put rejects when only the target's group would authorize it" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_target", ["todo.update"])

      action = build_action([relationship_put("rel_1", "todo_1", "g_target", "todo")])

      assert {:error, "not_authorized", _} = Authorizer.authorize([action], "a_1", ctx)
    end
  end

  # #246: the bootstrap exemption must cover only the acting actor's own
  # membership and the initial entity it files into the new group. Every
  # other update is checked against the #121 table.
  describe "authorize/3 - bootstrap hardening" do
    test "self-bootstrap with an initial entity and its memberhip edge succeeds" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      action =
        build_action([
          group_put("g_1"),
          group_member_put("gm_1", "a_1", "g_1", ["group.read", "todo.*"]),
          entity_put("todo_1", "todo"),
          entity_group_put("eg_1", "todo_1", "g_1")
        ])

      assert Authorizer.authorize([action], "a_1", ctx) == :ok
    end

    test "the actor's declared bootstrap permissions authorize a link edge" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      action =
        build_action([
          group_put("g_1"),
          group_member_put("gm_1", "a_1", "g_1", ["todo.*"]),
          entity_put("todo_1", "todo"),
          entity_group_put("eg_1", "todo_1", "g_1"),
          relationship_put("rel_1", "todo_1", "other_1", "todo")
        ])

      assert Authorizer.authorize([action], "a_1", ctx) == :ok
    end

    test "a third-party groupMember in a bootstrap action is rejected" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      action =
        build_action([
          group_put("g_1"),
          group_member_put("gm_1", "a_1", "g_1", ["group.read"]),
          group_member_put("gm_2", "a_2", "g_1", ["*"])
        ])

      assert {:error, "not_authorized", _} = Authorizer.authorize([action], "a_1", ctx)
    end

    test "an arbitrary user-entity update in a bootstrap action is rejected" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_membership(tables, "todo_other", "g_other", "eg_other")

      action =
        build_action([
          group_put("g_1"),
          group_member_put("gm_1", "a_1", "g_1", ["todo.*"]),
          %{
            id: "upd_other",
            subject_id: "todo_other",
            subject_type: "todo",
            method: :patch,
            data: %{"fields" => %{"title" => %{"value" => "hax"}}}
          }
        ])

      assert {:error, "not_authorized", _} = Authorizer.authorize([action], "a_1", ctx)
    end

    test "bootstrap membership may not file an entity the action does not create" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_membership(tables, "todo_other", "g_other", "eg_other")

      action =
        build_action([
          group_put("g_1"),
          group_member_put("gm_1", "a_1", "g_1", ["group.read"]),
          entity_group_put("eg_graft", "todo_other", "g_1")
        ])

      assert {:error, "not_authorized", _} = Authorizer.authorize([action], "a_1", ctx)
    end

    test "the #246 repro: bootstrap + third party + arbitrary entity update is rejected" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_membership(tables, "todo_victim", "g_victim", "eg_victim")

      action =
        build_action([
          group_put("g_1"),
          group_member_put("gm_1", "a_1", "g_1", ["group.read"]),
          group_member_put("gm_2", "a_2", "g_1", ["*"]),
          %{
            id: "upd_victim",
            subject_id: "todo_victim",
            subject_type: "todo",
            method: :patch,
            data: %{"fields" => %{"title" => %{"value" => "hax"}}}
          }
        ])

      assert {:error, "not_authorized", _} = Authorizer.authorize([action], "a_1", ctx)
    end

    test "an actor holding groupMember.create may add another actor" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_1", ["groupMember.create"])

      action = build_action([group_member_put("gm_2", "a_2", "g_1", ["*"])])

      assert Authorizer.authorize([action], "a_1", ctx) == :ok
    end
  end

  # #121 "Add Entity to Group": a same-Action entity create filed into
  # several groups is authorized per target group, not by the union of
  # the entity's group set.
  describe "authorize/3 - entityGroup put target group" do
    test "requires <type>.create in the target group, not the entity's whole set" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_2", ["todo.create"])

      action =
        build_action([
          entity_put("todo_multi", "todo"),
          entity_group_put("eg_1", "todo_multi", "g_1"),
          entity_group_put("eg_2", "todo_multi", "g_2")
        ])

      assert {:error, "not_authorized", _} = Authorizer.authorize([action], "a_1", ctx)
    end

    test "accepts when the actor holds <type>.create in each target group" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_1", ["todo.create"])
      put_group_member(tables, "g_2", ["todo.create"], "gm_2")

      action =
        build_action([
          entity_put("todo_multi", "todo"),
          entity_group_put("eg_1", "todo_multi", "g_1"),
          entity_group_put("eg_2", "todo_multi", "g_2")
        ])

      assert Authorizer.authorize([action], "a_1", ctx) == :ok
    end
  end

  # #246 known limitations: `AuthorizationContext` carries no group/entity
  # existence signal, so these stay open until one is plumbed in. The tests
  # below characterize the current, unfixed behaviour — they are not an
  # endorsement. See the `Authorizer` moduledoc "Residuals".
  describe "authorize/3 - known limitations" do
    # Known limitation: `bootstrap_group_permissions/2` checks only that the
    # Action `put`s the group id, so an id that already names a group can be
    # re-bootstrapped and self-granted.
    test "characterization: a bootstrap can re-put an existing group id and self-grant" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      action =
        build_action([
          group_put("g_existing"),
          group_member_put("gm_1", "a_1", "g_existing", ["*"])
        ])

      assert Authorizer.authorize([action], "a_1", ctx) == :ok
    end

    # Known limitation: `created_subject_ids/1` counts every user-entity
    # `put` id as created without checking existence, so a bootstrap
    # `entityGroup` put can ride the exemption for an entity that already
    # exists.
    test "characterization: a same-Action put files an existing entity via the bootstrap" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_membership(tables, "todo_existing", "g_other", "eg_other")
      put_group_member(tables, "g_other", ["todo.create"])

      action =
        build_action([
          group_put("g_1"),
          group_member_put("gm_1", "a_1", "g_1", ["group.read"]),
          entity_put("todo_existing", "todo"),
          entity_group_put("eg_graft", "todo_existing", "g_1")
        ])

      assert Authorizer.authorize([action], "a_1", ctx) == :ok
    end
  end

  # #246: an actor with only `group.read` in a group must not mutate the
  # group's system-entity rows.
  describe "authorize/3 - group.read-only member" do
    setup do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_1", ["group.read"])
      put_membership(tables, "todo_1", "g_1", "eg_1")

      %{tables: tables, ctx: ctx}
    end

    test "cannot create a groupMember", %{ctx: ctx} do
      action = build_action([group_member_put("gm_2", "a_2", "g_1", ["*"])])
      assert {:error, "not_authorized", _} = Authorizer.authorize([action], "a_1", ctx)
    end

    test "cannot update a groupMember", %{ctx: ctx} do
      update = %{
        id: "upd_gm",
        subject_id: "gm_2",
        subject_type: "groupMember",
        method: :patch,
        data: %{
          "fields" => %{
            "group_id" => %{"value" => "g_1"},
            "actor_id" => %{"value" => "a_2"},
            "permissions" => %{"value" => ["*"]}
          }
        }
      }

      assert {:error, "not_authorized", _} =
               Authorizer.authorize([build_action([update])], "a_1", ctx)
    end

    test "cannot delete a groupMember", %{tables: tables, ctx: ctx} do
      put_group_member_by_id(tables, "gm_2", "a_2", "g_1", ["*"])

      update = %{
        id: "upd_gm",
        subject_id: "gm_2",
        subject_type: "groupMember",
        method: :delete,
        data: nil
      }

      assert {:error, "not_authorized", _} =
               Authorizer.authorize([build_action([update])], "a_1", ctx)
    end

    test "cannot create a link relationship", %{ctx: ctx} do
      action = build_action([relationship_put("rel_link", "todo_1", "col_1", "todo")])
      assert {:error, "not_authorized", _} = Authorizer.authorize([action], "a_1", ctx)
    end

    test "cannot patch a relationship", %{tables: tables, ctx: ctx} do
      put_relationship_by_id(tables, "rel_1", "todo_1")

      update = %{
        id: "upd_rel",
        subject_id: "rel_1",
        subject_type: "relationship",
        method: :patch,
        data: %{"fields" => %{"source_id" => %{"value" => "todo_1"}}}
      }

      assert {:error, "not_authorized", _} =
               Authorizer.authorize([build_action([update])], "a_1", ctx)
    end

    test "cannot delete a relationship", %{tables: tables, ctx: ctx} do
      put_relationship_by_id(tables, "rel_1", "todo_1")

      update = %{
        id: "upd_rel",
        subject_id: "rel_1",
        subject_type: "relationship",
        method: :delete,
        data: nil
      }

      assert {:error, "not_authorized", _} =
               Authorizer.authorize([build_action([update])], "a_1", ctx)
    end

    test "cannot create an entityGroup for an existing entity", %{tables: tables, ctx: ctx} do
      put_membership(tables, "todo_existing", "g_1", "eg_existing")

      action = build_action([entity_group_put("eg_new", "todo_existing", "g_1")])
      assert {:error, "not_authorized", _} = Authorizer.authorize([action], "a_1", ctx)
    end

    test "cannot update an entityGroup", %{tables: tables, ctx: ctx} do
      put_entity_group_by_id(tables, "eg_1", "todo_1", "g_1")

      update = %{
        id: "upd_eg",
        subject_id: "eg_1",
        subject_type: "entityGroup",
        method: :patch,
        data: %{"fields" => %{"group_id" => %{"value" => "g_1"}}}
      }

      assert {:error, "not_authorized", _} =
               Authorizer.authorize([build_action([update])], "a_1", ctx)
    end

    test "cannot delete an entityGroup", %{tables: tables, ctx: ctx} do
      put_entity_group_by_id(tables, "eg_1", "todo_1", "g_1")

      update = %{
        id: "upd_eg",
        subject_id: "eg_1",
        subject_type: "entityGroup",
        method: :delete,
        data: nil
      }

      assert {:error, "not_authorized", _} =
               Authorizer.authorize([build_action([update])], "a_1", ctx)
    end
  end
end
