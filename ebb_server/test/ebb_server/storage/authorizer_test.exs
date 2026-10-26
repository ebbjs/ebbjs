defmodule EbbServer.Storage.AuthorizerTest do
  use ExUnit.Case, async: false

  import EbbServer.TestHelpers
  alias EbbServer.Storage.{AuthorizationContext, Authorizer}

  defp auth_context(tables) do
    AuthorizationContext.build(
      group_members: tables.group_members,
      group_members_by_id: tables.group_members_by_id,
      group_members_by_group: tables.group_members_by_group,
      entity_groups: tables.entity_groups,
      entity_groups_by_id: tables.entity_groups_by_id,
      entity_types: tables.entity_types,
      relationships_by_id: tables.relationships_by_id
    )
  end

  defp put_entity_type(tables, entity_id, type) do
    :ets.insert(tables.entity_types, {entity_id, type})
  end

  defp put_membership(tables, entity_id, group_id, id) do
    :ets.insert(
      tables.entity_groups,
      {entity_id, %{id: id, entity_id: entity_id, group_id: group_id}}
    )
  end

  # The actor's own membership, indexed everywhere the guard reads: the
  # permission table (`group_members`), the by-id row lookup
  # (`group_members_by_id`) and the by-group enumeration.
  defp put_group_member(tables, group_id, permissions, id \\ "gm_1") do
    row = %{id: id, actor_id: "a_1", group_id: group_id, permissions: permissions}
    :ets.insert(tables.group_members, {"a_1", row})
    :ets.insert(tables.group_members_by_id, {id, row})
    :ets.insert(tables.group_members_by_group, {{group_id, id}})
  end

  defp put_group_member_by_id(tables, id, actor_id, group_id, permissions) do
    row = %{id: id, actor_id: actor_id, group_id: group_id, permissions: permissions}
    :ets.insert(tables.group_members_by_id, {id, row})
    :ets.insert(tables.group_members_by_group, {{group_id, id}})
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

  defp assert_accepted(result) do
    assert {accepted, []} = result
    accepted
  end

  defp assert_rejected(result, reason) do
    assert {[], [rejection]} = result
    assert rejection.reason == reason
    rejection
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

  defp entity_group_delete(id) do
    %{id: id, subject_id: id, subject_type: "entityGroup", method: :delete, data: nil}
  end

  defp group_member_delete(id) do
    %{id: id, subject_id: id, subject_type: "groupMember", method: :delete, data: nil}
  end

  defp group_member_patch(id, group_id, permissions) do
    %{
      id: id,
      subject_id: id,
      subject_type: "groupMember",
      method: :patch,
      data: %{
        "fields" => %{
          "group_id" => %{"value" => group_id},
          "permissions" => %{"value" => permissions}
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

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
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

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
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

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
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

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
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

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
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

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
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

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
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

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
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

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    test "empty action list returns ok" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      assert_accepted(Authorizer.authorize([], "a_1", ctx))
    end
  end

  # System-entity deletes arrive on the wire with `data: nil` (the data
  # fields are dropped); the authorizer must recover the owning group
  # from the by-id index tables rather than from the wire envelope.
  describe "authorize/3 - system-entity delete with data:nil" do
    test "entityGroup delete resolves the entity, type, and group from the indexes" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_1", ["todo.update"])
      put_membership(tables, "todo_1", "g_1", "eg_1")
      put_membership(tables, "todo_1", "g_2", "eg_2")
      put_entity_group_by_id(tables, "eg_1", "todo_1", "g_1")
      put_entity_type(tables, "todo_1", "todo")

      action = build_action([entity_group_delete("eg_1")])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "entityGroup delete rejects an actor outside the target group" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_entity_group_by_id(tables, "eg_1", "todo_1", "g_1")
      put_membership(tables, "todo_1", "g_1", "eg_1")
      put_entity_type(tables, "todo_1", "todo")

      action = build_action([entity_group_delete("eg_1")])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
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

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
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

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
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

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    test "groupMember delete resolves group_id from cache after a put" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      # The actor's own capable row is what authorizes the delete and
      # what keeps the group administered afterwards, so it must be a
      # different row from the one being deleted.
      put_group_member(tables, "g_1", ["groupMember.delete"], "gm_actor")
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

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "relationship put authorizes through the source's membership set, not target_id" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_source", ["todo.update"])
      put_membership(tables, "todo_1", "g_source", "eg_1")
      put_entity_type(tables, "todo_1", "todo")

      action = build_action([relationship_put("rel_1", "todo_1", "col_other", "todo")])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "relationship put rejects when only the target's group would authorize it" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_target", ["todo.update"])
      put_entity_type(tables, "todo_1", "todo")

      action = build_action([relationship_put("rel_1", "todo_1", "g_target", "todo")])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    test "relationship put ignores a forged wire type and checks the source's true type" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      # The actor holds `comment.update` in the group but the source is
      # really a `todo`; the wire `type` claims otherwise (#323).
      put_group_member(tables, "g_source", ["comment.update"])
      put_membership(tables, "todo_1", "g_source", "eg_1")
      put_entity_type(tables, "todo_1", "todo")

      action = build_action([relationship_put("rel_1", "todo_1", "other_1", "comment")])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    test "relationship put authorizes a source type the same request created" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      action =
        build_action([
          group_put("g_1"),
          group_member_put("gm_1", "a_1", "g_1", ["todo.*"]),
          entity_put("todo_1", "todo"),
          entity_group_put("eg_1", "todo_1", "g_1"),
          # The forged label disagrees with the created entity's type.
          relationship_put("rel_1", "todo_1", "other_1", "comment")
        ])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
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

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
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

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
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

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
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

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    test "bootstrap membership may not file an entity the action does not create" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_membership(tables, "todo_other", "g_other", "eg_other")
      put_entity_type(tables, "todo_other", "todo")

      action =
        build_action([
          group_put("g_1"),
          group_member_put("gm_1", "a_1", "g_1", ["group.read", "todo.create"]),
          entity_group_put("eg_graft", "todo_other", "g_1")
        ])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
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

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    test "an actor holding groupMember.create may add another actor" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_1", ["groupMember.create"])

      action = build_action([group_member_put("gm_2", "a_2", "g_1", ["*"])])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end
  end

  # #245: a user-entity write that resolves to no group set is a
  # structural rejection, not a permission failure.
  describe "authorize/3 - writes require ownership" do
    test "rejects an unowned put even when the actor could create the type elsewhere" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_1", ["todo.create"])

      action = build_action([entity_put("todo_orphan", "todo")])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "missing_ownership")
    end

    test "rejects an unowned put regardless of the actor's permissions" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      action = build_action([entity_put("todo_orphan", "todo")])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "missing_ownership")
    end

    test "a bootstrap self-create with its membership edge still succeeds" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      action =
        build_action([
          group_put("g_1"),
          group_member_put("gm_1", "a_1", "g_1", ["todo.*"]),
          entity_put("todo_1", "todo"),
          entity_group_put("eg_1", "todo_1", "g_1")
        ])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "a same-Action membership edge satisfies ownership" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_1", ["todo.create"])

      action =
        build_action([
          entity_put("todo_new", "todo"),
          entity_group_put("eg_new", "todo_new", "g_1")
        ])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "cached membership satisfies ownership" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_1", ["todo.create"])
      put_membership(tables, "todo_1", "g_1", "eg_1")

      action = build_action([entity_put("todo_1", "todo")])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "rejects an unowned patch and delete" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_1", ["todo.update", "todo.delete"])

      patch = %{
        id: "upd_patch",
        subject_id: "todo_orphan",
        subject_type: "todo",
        method: :patch,
        data: %{"fields" => %{}}
      }

      delete = %{
        id: "upd_delete",
        subject_id: "todo_orphan_2",
        subject_type: "todo",
        method: :delete,
        data: nil
      }

      assert_rejected(
        Authorizer.authorize([build_action([patch])], "a_1", ctx),
        "missing_ownership"
      )

      assert_rejected(
        Authorizer.authorize([build_action([delete])], "a_1", ctx),
        "missing_ownership"
      )
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

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
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

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end
  end

  # #264 Option A: membership mutations are gated by the entity's own
  # `<type>.create` / `<type>.update`, resolved from the entity-type
  # index when the entity is not created in the same Action.
  describe "authorize/3 - membership permissions" do
    test "adding an existing entity requires <type>.create in the target group" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_2", ["entityGroup.create"])
      put_membership(tables, "todo_1", "g_1", "eg_1")
      put_entity_type(tables, "todo_1", "todo")

      action = build_action([entity_group_put("eg_new", "todo_1", "g_2")])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    test "adding an existing entity is allowed with <type>.create in the target and <type>.update where it lives" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_2", ["todo.create"])
      put_group_member(tables, "g_1", ["todo.update"], "gm_g1")
      put_membership(tables, "todo_1", "g_1", "eg_1")
      put_entity_type(tables, "todo_1", "todo")

      action = build_action([entity_group_put("eg_new", "todo_1", "g_2")])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "a type an earlier Action of the request created resolves a later membership add" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_1", ["todo.create"])
      put_group_member(tables, "g_2", ["todo.create"], "gm_2")

      # Neither `todo_new` nor its type is committed yet: the second
      # Action must resolve the type the first Action introduced.
      actions = [
        build_action([
          entity_put("todo_new", "todo"),
          entity_group_put("eg_1", "todo_new", "g_1")
        ]),
        build_action([entity_group_put("eg_2", "todo_new", "g_2")])
      ]

      assert_accepted(Authorizer.authorize(actions, "a_1", ctx))
    end

    test "fails closed when an existing entity's type cannot be resolved" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      # The actor holds the system-entity permission, which used to stand
      # in for the entity's type. It must not.
      put_group_member(tables, "g_2", ["entityGroup.create", "entityGroup.*", "*"])
      put_membership(tables, "todo_unknown", "g_1", "eg_1")

      action = build_action([entity_group_put("eg_new", "todo_unknown", "g_2")])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    test "a same-Action create is authorized by <type>.create, not entityGroup.create" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_1", ["entityGroup.create"])

      action =
        build_action([
          entity_put("todo_new", "todo"),
          entity_group_put("eg_new", "todo_new", "g_1")
        ])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    test "removing a membership requires <type>.update, not entityGroup.delete" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_1", ["entityGroup.delete"])
      put_membership(tables, "todo_1", "g_1", "eg_1")
      put_membership(tables, "todo_1", "g_2", "eg_2")
      put_entity_group_by_id(tables, "eg_1", "todo_1", "g_1")
      put_entity_type(tables, "todo_1", "todo")

      action = build_action([entity_group_delete("eg_1")])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    test "removing a membership is allowed with <type>.update in any current group" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      # The permission is held in g_2; the removed row is in g_1. Union
      # semantics: the actor may update the entity in any of its groups.
      put_group_member(tables, "g_2", ["todo.update"])
      put_membership(tables, "todo_1", "g_1", "eg_1")
      put_membership(tables, "todo_1", "g_2", "eg_2")
      put_entity_group_by_id(tables, "eg_1", "todo_1", "g_1")
      put_entity_type(tables, "todo_1", "todo")

      action = build_action([entity_group_delete("eg_1")])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "a bootstrap does not exempt adding an existing entity" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_membership(tables, "todo_existing", "g_other", "eg_other")
      put_entity_type(tables, "todo_existing", "todo")

      action =
        build_action([
          group_put("g_new"),
          group_member_put("gm_1", "a_1", "g_new", ["group.read"]),
          entity_group_put("eg_graft", "todo_existing", "g_new")
        ])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end
  end

  # #264: an entity must keep at least one owning group. The check is a
  # net delta over the whole request, not per-Action (see the batch case).
  describe "authorize/3 - last membership" do
    setup do
      tables = create_isolated_tables()

      put_group_member(tables, "g_1", ["todo.create", "todo.update"])
      put_group_member(tables, "g_2", ["todo.create", "todo.update"], "gm_2")

      %{tables: tables, ctx: auth_context(tables)}
    end

    test "deleting the only membership is refused", %{tables: tables, ctx: ctx} do
      put_membership(tables, "todo_1", "g_1", "eg_1")
      put_entity_group_by_id(tables, "eg_1", "todo_1", "g_1")
      put_entity_type(tables, "todo_1", "todo")

      action = build_action([entity_group_delete("eg_1")])

      rejection =
        assert_rejected(Authorizer.authorize([action], "a_1", ctx), "last_membership")

      assert is_binary(rejection.details)
    end

    test "deleting one of two memberships is allowed", %{tables: tables, ctx: ctx} do
      put_membership(tables, "todo_1", "g_1", "eg_1")
      put_membership(tables, "todo_1", "g_2", "eg_2")
      put_entity_group_by_id(tables, "eg_1", "todo_1", "g_1")
      put_entity_type(tables, "todo_1", "todo")

      action = build_action([entity_group_delete("eg_1")])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "swapping the last membership for a new group in one Action is allowed", %{
      tables: tables,
      ctx: ctx
    } do
      put_membership(tables, "todo_1", "g_1", "eg_1")
      put_entity_group_by_id(tables, "eg_1", "todo_1", "g_1")
      put_entity_type(tables, "todo_1", "todo")

      action =
        build_action([
          entity_group_put("eg_new", "todo_1", "g_2"),
          entity_group_delete("eg_1")
        ])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "a batch of two Actions cannot remove both memberships", %{
      tables: tables,
      ctx: ctx
    } do
      put_membership(tables, "todo_1", "g_1", "eg_1")
      put_membership(tables, "todo_1", "g_2", "eg_2")
      put_entity_group_by_id(tables, "eg_1", "todo_1", "g_1")
      put_entity_group_by_id(tables, "eg_2", "todo_1", "g_2")
      put_entity_type(tables, "todo_1", "todo")

      # Each Action is valid against the cache snapshot, but together
      # they net to zero. The running delta must reject the second while
      # the first still commits.
      actions = [
        build_action([entity_group_delete("eg_1")]),
        build_action([entity_group_delete("eg_2")])
      ]

      assert {[_accepted], [rejection]} = Authorizer.authorize(actions, "a_1", ctx)
      assert rejection.reason == "last_membership"
    end

    test "re-putting the same group as a new row while deleting the old row is allowed", %{
      tables: tables,
      ctx: ctx
    } do
      put_membership(tables, "todo_1", "g_1", "eg_1")
      put_entity_group_by_id(tables, "eg_1", "todo_1", "g_1")
      put_entity_type(tables, "todo_1", "todo")

      # Membership is per row: the stale row is replaced by a fresh row
      # for the same group, so the entity still owns `g_1`.
      action =
        build_action([
          entity_group_put("eg_new", "todo_1", "g_1"),
          entity_group_delete("eg_1")
        ])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "re-putting the same group then deleting the old row across two Actions is allowed", %{
      tables: tables,
      ctx: ctx
    } do
      put_membership(tables, "todo_1", "g_1", "eg_1")
      put_entity_group_by_id(tables, "eg_1", "todo_1", "g_1")
      put_entity_type(tables, "todo_1", "todo")

      actions = [
        build_action([entity_group_put("eg_new", "todo_1", "g_1")]),
        build_action([entity_group_delete("eg_1")])
      ]

      assert_accepted(Authorizer.authorize(actions, "a_1", ctx))
    end

    test "an unresolvable membership delete is not_authorized", %{ctx: ctx} do
      action = build_action([entity_group_delete("eg_unknown")])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end
  end

  # #479: a group must keep at least one membership holding a non-empty
  # permission list, because permissions live only on `groupMember` rows
  # and an empty list grants nothing. The check is a net delta over the
  # whole request, like `last_membership`.
  describe "authorize/3 - last group member" do
    setup do
      tables = create_isolated_tables()
      %{tables: tables, ctx: auth_context(tables)}
    end

    test "deleting a group's only capable membership is refused", %{tables: tables, ctx: ctx} do
      put_group_member(tables, "g_1", ["groupMember.delete"], "gm_actor")

      action = build_action([group_member_delete("gm_actor")])

      rejection =
        assert_rejected(Authorizer.authorize([action], "a_1", ctx), "last_group_member")

      assert is_binary(rejection.details)
    end

    test "a member with an empty permission list does not keep the group alive", %{
      tables: tables,
      ctx: ctx
    } do
      put_group_member(tables, "g_1", ["groupMember.delete"], "gm_actor")
      put_group_member_by_id(tables, "gm_1", "a_2", "g_1", [])

      action = build_action([group_member_delete("gm_actor")])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "last_group_member")
    end

    test "deleting one of two capable memberships is allowed", %{tables: tables, ctx: ctx} do
      put_group_member(tables, "g_1", ["groupMember.delete"], "gm_actor")
      put_group_member_by_id(tables, "gm_1", "a_2", "g_1", ["group.read"])

      action = build_action([group_member_delete("gm_1")])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "a batch of two Actions that each drop one capable membership is refused", %{
      tables: tables,
      ctx: ctx
    } do
      put_group_member(tables, "g_1", ["groupMember.delete"], "gm_actor")
      put_group_member_by_id(tables, "gm_1", "a_2", "g_1", ["group.read"])

      # Each Action is valid against the cache snapshot, but together
      # they net to zero. The running delta must catch the second.
      actions = [
        build_action([group_member_delete("gm_1")]),
        build_action([group_member_delete("gm_actor")])
      ]

      # The first Action is accepted against the snapshot, the second is
      # rejected: the running delta catches the pair netting to zero.
      assert {_accepted, [rejection]} = Authorizer.authorize(actions, "a_1", ctx)
      assert rejection.reason == "last_group_member"
    end

    test "patching the only capable permission list to empty is refused", %{
      tables: tables,
      ctx: ctx
    } do
      put_group_member(tables, "g_1", ["groupMember.update"], "gm_actor")

      action = build_action([group_member_patch("gm_actor", "g_1", [])])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "last_group_member")
    end

    test "patching one of two capable permission lists to empty is allowed", %{
      tables: tables,
      ctx: ctx
    } do
      put_group_member(tables, "g_1", ["groupMember.update"], "gm_actor")
      put_group_member_by_id(tables, "gm_1", "a_2", "g_1", ["group.read"])

      action = build_action([group_member_patch("gm_1", "g_1", [])])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "transferring the last membership within one Action is allowed", %{
      tables: tables,
      ctx: ctx
    } do
      put_group_member(
        tables,
        "g_1",
        ["groupMember.delete", "groupMember.create"],
        "gm_actor"
      )

      action =
        build_action([
          group_member_delete("gm_actor"),
          group_member_put("gm_new", "a_2", "g_1", ["group.read"])
        ])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "a put without a wire group is a no-op, not a lockout", %{tables: tables, ctx: ctx} do
      put_group_member(tables, "g_1", ["groupMember.*"], "gm_actor")

      # No `group_id` on the wire, so the Writer drops the update; the
      # guard must not read that as emptying the cached row.
      update = %{
        id: "upd_gm",
        subject_id: "gm_actor",
        subject_type: "groupMember",
        method: :put,
        data: %{"fields" => %{"permissions" => %{"value" => []}}}
      }

      assert_accepted(Authorizer.authorize([build_action([update])], "a_1", ctx))
    end

    test "moving a membership out of a group that keeps a capable row is allowed", %{
      tables: tables,
      ctx: ctx
    } do
      put_group_member(tables, "g_2", ["groupMember.update"], "gm_actor")
      put_group_member(tables, "g_1", ["groupMember.update"], "gm_actor_1")
      put_group_member_by_id(tables, "gm_1", "a_2", "g_1", ["group.read"])

      action = build_action([group_member_patch("gm_1", "g_2", ["group.read"])])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "moving a group's only capable membership out of it is refused", %{
      tables: tables,
      ctx: ctx
    } do
      # The actor authorizes the patch in the destination group, but the
      # row is bound to the origin group, where they hold nothing (#625).
      put_group_member(tables, "g_2", ["groupMember.update"], "gm_actor")
      put_group_member_by_id(tables, "gm_1", "a_2", "g_1", ["group.read"])

      action = build_action([group_member_patch("gm_1", "g_2", ["group.read"])])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    test "moving the last capable membership is refused even when both groups authorize", %{
      tables: tables,
      ctx: ctx
    } do
      # The actor may write both groups, so the move passes authorization;
      # only the last-member guard stops the origin from being emptied.
      put_group_member(tables, "g_1", ["groupMember.update"], "gm_actor")
      put_group_member(tables, "g_2", ["groupMember.update"], "gm_actor_2")

      action = build_action([group_member_patch("gm_actor", "g_2", ["groupMember.update"])])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "last_group_member")
    end
  end

  # #625: a `groupMember` mutation is bound to the group its row already
  # belongs to. Authorizing against the group on the wire lets an actor
  # with a self-granted `groupMember.*` in their own group re-key a row
  # that lives in somebody else's.
  describe "authorize/3 - groupMember rows are bound to their group" do
    setup do
      tables = create_isolated_tables()

      # The victim's row in `g_victim`; the actor holds permission only in
      # the group they bootstrapped. `gm_victim_2` keeps the group capable
      # so the last-member guard is not what refuses the move.
      put_group_member_by_id(tables, "gm_victim", "a_victim", "g_victim", ["group.read"])
      put_group_member_by_id(tables, "gm_victim_2", "a_victim_2", "g_victim", ["group.read"])
      put_group_member(tables, "g_attacker", ["groupMember.*"])

      %{tables: tables, ctx: auth_context(tables)}
    end

    test "re-putting an existing row with permission only in the destination group is refused", %{
      ctx: ctx
    } do
      action =
        build_action([
          group_member_put("gm_victim", "a_1", "g_attacker", ["group.read"])
        ])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    test "patching an existing row with permission only in the destination group is refused", %{
      ctx: ctx
    } do
      action = build_action([group_member_patch("gm_victim", "g_attacker", ["group.read"])])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    # The type index retains tombstones, so an id it knows but the by-id
    # cache no longer places is not a fresh row: re-filing it would let a
    # deleted membership id be reused as a bootstrap.
    test "a row id known only to the type index is refused, not re-filed", %{ctx: ctx} do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_1", ["groupMember.*"])
      put_entity_type(tables, "gm_tombstone", "groupMember")

      action = build_action([group_member_put("gm_tombstone", "a_1", "g_1", ["todo.read"])])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    test "a bootstrap that re-puts an existing row id is refused", %{ctx: ctx} do
      action =
        build_action([
          group_put("g_new"),
          group_member_put("gm_own", "a_1", "g_new", ["groupMember.*"]),
          group_member_put("gm_victim", "a_1", "g_new", ["group.read"])
        ])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end
  end

  describe "authorize/3 - groupMember changes authorized in the row's group" do
    setup do
      tables = create_isolated_tables()

      put_group_member_by_id(tables, "gm_1", "a_2", "g_1", ["group.read"])
      put_group_member(tables, "g_1", ["groupMember.*"], "gm_actor")

      %{tables: tables, ctx: auth_context(tables)}
    end

    test "re-putting a row inside its own group is allowed", %{ctx: ctx} do
      action = build_action([group_member_put("gm_1", "a_2", "g_1", ["group.read", "todo.*"])])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "patching a row inside its own group is allowed", %{ctx: ctx} do
      action = build_action([group_member_patch("gm_1", "g_1", ["group.read"])])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "moving a row is allowed when the actor holds the permission in both groups", %{
      tables: tables,
      ctx: ctx
    } do
      put_group_member(tables, "g_2", ["groupMember.update"], "gm_actor_2")

      action = build_action([group_member_patch("gm_1", "g_2", ["group.read"])])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end
  end

  # #623: an `entityGroup` patch is authorized against the group named on
  # the wire and writes a membership row when the row id is unknown, so it
  # can file any entity id into the caller's group. The server refuses the
  # method until it is bound to the row; put and delete are unchanged.
  describe "authorize/3 - entityGroup patch" do
    setup do
      tables = create_isolated_tables()

      put_group_member(tables, "g_atk", ["entityGroup.*"])

      %{tables: tables, ctx: auth_context(tables)}
    end

    test "is rejected even when the actor holds entityGroup.update in the wire group", %{
      ctx: ctx
    } do
      update = %{
        id: "eg_fresh",
        subject_id: "eg_fresh",
        subject_type: "entityGroup",
        method: :patch,
        data: %{
          "fields" => %{
            "entity_id" => %{"value" => "todo_victim"},
            "group_id" => %{"value" => "g_atk"}
          }
        }
      }

      rejection =
        assert_rejected(
          Authorizer.authorize([build_action([update])], "a_1", ctx),
          "not_authorized"
        )

      assert rejection.details =~ "patch"
    end

    test "a bootstrap entityGroup put cannot re-point an existing membership row", %{ctx: ctx} do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_entity_group_by_id(tables, "eg_victim", "todo_victim", "g_victim")

      action =
        build_action([
          group_put("g_new"),
          group_member_put("gm_own", "a_1", "g_new", ["entityGroup.*", "todo.create"]),
          entity_put("todo_new", "todo"),
          entity_group_put("eg_victim", "todo_new", "g_new")
        ])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    test "a put cannot re-point another entity's membership row", %{tables: tables, ctx: ctx} do
      put_group_member(tables, "g_atk", ["todo.create"], "gm_atk")
      put_entity_type(tables, "todo_attacker", "todo")
      put_membership(tables, "todo_attacker", "g_atk", "eg_attacker")
      put_entity_group_by_id(tables, "eg_victim", "todo_victim", "g_victim")

      action = build_action([entity_group_put("eg_victim", "todo_attacker", "g_atk")])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    test "a put may move a membership row it names to another group", %{tables: tables, ctx: ctx} do
      put_group_member(tables, "g_2", ["todo.create"], "gm_2")
      put_group_member(tables, "g_1", ["todo.update"], "gm_g1")
      put_entity_type(tables, "todo_1", "todo")
      put_membership(tables, "todo_1", "g_1", "eg_old")
      put_entity_group_by_id(tables, "eg_old", "todo_1", "g_1")

      action = build_action([entity_group_put("eg_old", "todo_1", "g_2")])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "a put cannot claim an entity the index knows but no group owns", %{ctx: ctx} do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_atk", ["todo.create"])
      put_entity_type(tables, "todo_orphan", "todo")

      action = build_action([entity_group_put("eg_new", "todo_orphan", "g_atk")])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    test "put is authorized by <type>.create in the target group and <type>.update where the entity lives",
         %{
           tables: tables,
           ctx: ctx
         } do
      put_group_member(tables, "g_2", ["todo.create"], "gm_2")
      put_group_member(tables, "g_1", ["todo.update"], "gm_g1")
      put_entity_type(tables, "todo_1", "todo")
      put_membership(tables, "todo_1", "g_1", "eg_1")

      action = build_action([entity_group_put("eg_new", "todo_1", "g_2")])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    # #623: `<type>.create` in a group the actor bootstrapped is
    # self-grantable, so on its own it would let the actor file another
    # tenant's entity into that group and then read or write it.
    test "put cannot graft an entity owned by a group the actor cannot write", %{
      tables: tables,
      ctx: ctx
    } do
      put_group_member(tables, "g_2", ["todo.create"], "gm_2")
      put_entity_type(tables, "todo_1", "todo")
      put_membership(tables, "todo_1", "g_1", "eg_1")

      action = build_action([entity_group_put("eg_new", "todo_1", "g_2")])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    test "put may re-file an entity into a group it already belongs to", %{
      tables: tables,
      ctx: ctx
    } do
      put_group_member(tables, "g_2", ["todo.create"], "gm_2")
      put_entity_type(tables, "todo_1", "todo")
      put_membership(tables, "todo_1", "g_2", "eg_old")

      action = build_action([entity_group_put("eg_new", "todo_1", "g_2")])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "delete is still authorized by the entity's <type>.update in a current group", %{
      tables: tables,
      ctx: ctx
    } do
      put_group_member(tables, "g_2", ["todo.update"], "gm_2")
      put_entity_type(tables, "todo_1", "todo")
      put_membership(tables, "todo_1", "g_1", "eg_1")
      put_membership(tables, "todo_1", "g_2", "eg_2")
      put_entity_group_by_id(tables, "eg_1", "todo_1", "g_1")

      action = build_action([entity_group_delete("eg_1")])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end
  end

  # #289: the bootstrap self-grant is gated on the entity actually being
  # created — a group id the entity-type index already knows, or an entity
  # the Action does not create, falls through to the permission table.
  # Existing-id puts are authorized against the table, not rejected with a
  # new reason.
  describe "authorize/3 - bootstrap existence" do
    test "a bootstrap may not re-put an existing group id and self-grant" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      # The group was committed earlier, so the type index knows it.
      put_entity_type(tables, "g_existing", "group")

      action =
        build_action([
          group_put("g_existing"),
          group_member_put("gm_1", "a_1", "g_existing", ["*"])
        ])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    test "a bootstrap may not file an existing entity even when it self-grants the type" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_entity_type(tables, "todo_existing", "todo")
      put_membership(tables, "todo_existing", "g_other", "eg_other")

      # The declared `todo.create` is the self-grant: the existing entity
      # may not borrow it for the `entityGroup` put.
      action =
        build_action([
          group_put("g_1"),
          group_member_put("gm_1", "a_1", "g_1", ["todo.create", "group.read"]),
          entity_put("todo_existing", "todo"),
          entity_group_put("eg_graft", "todo_existing", "g_1")
        ])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    test "a genuine new-group self-bootstrap still succeeds" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      action =
        build_action([
          group_put("g_new"),
          group_member_put("gm_1", "a_1", "g_new", ["group.read", "todo.*"]),
          entity_put("todo_new", "todo"),
          entity_group_put("eg_new", "todo_new", "g_new")
        ])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "an existing group re-put by a member with group.create still succeeds" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_entity_type(tables, "g_1", "group")
      put_group_member(tables, "g_1", ["group.create"])

      assert_accepted(Authorizer.authorize([build_action([group_put("g_1")])], "a_1", ctx))
    end

    test "filing an existing entity into a group the actor really belongs to still works" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_entity_type(tables, "todo_1", "todo")
      put_group_member(tables, "g_2", ["todo.create"])
      put_group_member(tables, "g_1", ["todo.update"], "gm_g1")
      put_membership(tables, "todo_1", "g_1", "eg_1")

      action = build_action([entity_group_put("eg_new", "todo_1", "g_2")])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
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
      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
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

      assert_rejected(
        Authorizer.authorize([build_action([update])], "a_1", ctx),
        "not_authorized"
      )
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

      assert_rejected(
        Authorizer.authorize([build_action([update])], "a_1", ctx),
        "not_authorized"
      )
    end

    test "cannot create a link relationship", %{ctx: ctx} do
      action = build_action([relationship_put("rel_link", "todo_1", "col_1", "todo")])
      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
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

      assert_rejected(
        Authorizer.authorize([build_action([update])], "a_1", ctx),
        "not_authorized"
      )
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

      assert_rejected(
        Authorizer.authorize([build_action([update])], "a_1", ctx),
        "not_authorized"
      )
    end

    test "cannot create an entityGroup for an existing entity", %{tables: tables, ctx: ctx} do
      put_membership(tables, "todo_existing", "g_1", "eg_existing")

      action = build_action([entity_group_put("eg_new", "todo_existing", "g_1")])
      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
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

      assert_rejected(
        Authorizer.authorize([build_action([update])], "a_1", ctx),
        "not_authorized"
      )
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

      assert_rejected(
        Authorizer.authorize([build_action([update])], "a_1", ctx),
        "not_authorized"
      )
    end
  end

  # #469: authorization decides per Action. One bad Action must not drag
  # its siblings down, and a rejected Action leaves the request's
  # simulation untouched so it cannot authorize a later Action.
  describe "authorize/3 - per-Action outcomes" do
    test "an unauthorized Action does not reject its authorized sibling" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_1", ["todo.create"])
      put_membership(tables, "todo_ok", "g_1", "eg_ok")
      put_membership(tables, "todo_bad", "g_2", "eg_bad")

      bad = build_action([entity_put("todo_bad", "todo")]) |> Map.put(:id, "act_bad")
      ok = build_action([entity_put("todo_ok", "todo")]) |> Map.put(:id, "act_ok")

      assert {[accepted], [rejection]} = Authorizer.authorize([bad, ok], "a_1", ctx)
      assert accepted.id == "act_ok"
      assert rejection.action.id == "act_bad"
      assert rejection.reason == "not_authorized"
    end

    test "a rejected Action's created type is not visible to a later Action" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_1", ["todo.read"])

      # The first Action creates `todo_new` but the actor cannot create
      # the type, so the Action is rejected and must not seed the request
      # simulation with `todo_new`'s type.
      create =
        build_action([
          entity_put("todo_new", "todo"),
          entity_group_put("eg_1", "todo_new", "g_1")
        ])
        |> Map.put(:id, "act_create")

      add = build_action([entity_group_put("eg_2", "todo_new", "g_1")])

      assert {[], [create_rejection, add_rejection]} =
               Authorizer.authorize([create, add], "a_1", ctx)

      assert create_rejection.reason == "not_authorized"
      assert add_rejection.reason == "not_authorized"
      assert add_rejection.details =~ "cannot resolve the type"
    end
  end
end
