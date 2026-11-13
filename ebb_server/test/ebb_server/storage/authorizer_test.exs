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
    %{id: "act_test", actor_id: actor_id, hlc: generate_hlc(), updates: List.flatten(updates)}
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
    component_update(id, id, "ebb/group", :replace, %{"value" => %{"name" => "Test Group"}})
  end

  # A platform row carries exactly one atomic component, so its fixture is one
  # Update whose value is the whole object.
  defp group_member_put(id, actor_id, group_id, permissions) do
    component_update(id, id, "ebb/grant", :replace, %{
      "value" => %{
        "actor_id" => actor_id,
        "group_id" => group_id,
        "permissions" => permissions
      }
    })
  end

  defp group_member_patch(id, group_id, permissions, actor_id \\ nil) do
    value = %{"group_id" => group_id, "permissions" => permissions}
    value = if actor_id, do: Map.put(value, "actor_id", actor_id), else: value

    component_update("#{id}_patch", id, "ebb/grant", :replace, %{"value" => value})
  end

  # An atomic grant value is the whole row, so a value that omits
  # `permissions` states an empty permission list.
  defp group_member_patch_without_permissions(id, group_id) do
    component_update("#{id}_patch", id, "ebb/grant", :replace, %{
      "value" => %{"group_id" => group_id}
    })
  end

  defp entity_put(id, model) do
    component_update(id, id, "#{model}/title", :replace, %{"value" => "Test"})
  end

  defp entity_patch(id, model) do
    component_update("#{id}_patch", id, "#{model}/title", :merge, %{"value" => "Patched"})
  end

  defp entity_delete(id, _model) do
    delete_update("#{id}_delete", id)
  end

  defp entity_group_put(id, entity_id, group_id) do
    component_update(id, id, "ebb/membership", :replace, %{
      "value" => %{"entity_id" => entity_id, "group_id" => group_id}
    })
  end

  defp entity_group_delete(id), do: delete_update(id, id)

  defp group_member_delete(id), do: delete_update(id, id)

  defp relationship_put(id, source_id, target_id, source_type) do
    component_update(id, id, "ebb/link", :replace, %{
      "value" => %{
        "source_id" => source_id,
        "target_id" => target_id,
        "type" => source_type,
        "field" => "column"
      }
    })
  end

  defp relationship_patch(id, source_id, target_id) do
    component_update("#{id}_patch", id, "ebb/link", :replace, %{
      "value" => %{"source_id" => source_id, "target_id" => target_id}
    })
  end

  # A delete names the row and no component, so it carries no wire source;
  # the stored row is the delete's scope.
  defp relationship_delete(id, _source_id \\ nil), do: delete_update("#{id}_delete", id)

  defp component_update(id, subject_id, component, method, data) do
    [model, field] = :binary.split(component, "/")

    %{
      id: id,
      subject_id: subject_id,
      component: component,
      model: model,
      field: field,
      method: method,
      data: data
    }
  end

  # A user row is one component per field; a platform row is one atomic
  # component whose value is the whole object, so its fields collapse into a
  # single Update.
  @system_components %{
    "group" => "ebb/group",
    "groupMember" => "ebb/grant",
    "entityGroup" => "ebb/membership",
    "relationship" => "ebb/link"
  }

  defp component_updates(id, subject_id, component, method, fields) do
    case Map.fetch(@system_components, component) do
      {:ok, atomic} ->
        [component_update(id, subject_id, atomic, replace(method), %{"value" => fields})]

      :error ->
        fields
        |> Enum.with_index()
        |> Enum.map(fn {{field, value}, index} ->
          component_update("#{id}_#{index}", subject_id, "#{component}/#{field}", method, %{
            "value" => value
          })
        end)
    end
  end

  # `merge` and `replace` are the same write for an atomic component, and the
  # wire names `replace` for one.
  defp replace(:merge), do: :replace
  defp replace(method), do: method

  defp delete_update(id, subject_id) do
    %{
      id: id,
      subject_id: subject_id,
      component: nil,
      model: nil,
      field: nil,
      method: :delete,
      data: nil
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
      put_entity_type(tables, "todo_1", "todo")

      action =
        build_action([
          %{
            id: "upd_1",
            subject_id: "todo_1",
            component: "todo/title",
            model: "todo",
            field: "title",
            method: :replace,
            data: %{"value" => "Test"}
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
            component: "todo/title",
            model: "todo",
            field: "title",
            method: :replace,
            data: %{"value" => "Test"}
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
            component: "todo/title",
            model: "todo",
            field: "title",
            method: :replace,
            data: %{"value" => "Test"}
          }
        ])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    test "wildcard permission matches" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_1", ["todo.*"])
      put_membership(tables, "todo_1", "g_1", "eg_1")
      put_entity_type(tables, "todo_1", "todo")

      action =
        build_action([
          %{
            id: "upd_1",
            subject_id: "todo_1",
            component: "todo/title",
            model: "todo",
            field: "title",
            method: :replace,
            data: %{"value" => "Test"}
          }
        ])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "union: a permission held in any one of the entity's groups is enough" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_1", ["todo.update"])
      put_group_member(tables, "g_2", ["todo.read"], "gm_2")

      put_membership(tables, "todo_1", "g_1", "eg_1")
      put_membership(tables, "todo_1", "g_2", "eg_2")
      put_entity_type(tables, "todo_1", "todo")

      action =
        build_action([
          %{
            id: "upd_1",
            subject_id: "todo_1",
            component: "todo/title",
            model: "todo",
            field: "title",
            method: :replace,
            data: %{"value" => "Test"}
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

      put_group_member(tables, "g_1", ["ebb/grant.update"])
      put_group_member_by_id(tables, "gm_2", "a_2", "g_1", ["ebb/group.read"])

      action =
        build_action([
          component_updates("gm_2_patch", "gm_2", "groupMember", :merge, %{
            "group_id" => "g_1",
            "actor_id" => "a_2",
            "permissions" => ["ebb/group.read"]
          })
        ])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "system entity update rejected when actor is not group member" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      action =
        build_action([
          component_updates("gm_1_patch", "gm_1", "groupMember", :merge, %{
            "group_id" => "g_1",
            "actor_id" => "a_2",
            "permissions" => ["ebb/group.read"]
          })
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

      put_group_member(tables, "g_1", ["ebb/link.delete"])
      put_membership(tables, "todo_1", "g_1", "eg_1")
      put_relationship_by_id(tables, "rel_1", "todo_1")

      action =
        build_action([
          %{
            id: "upd_del",
            subject_id: "rel_1",
            component: nil,
            model: nil,
            field: nil,
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
            component: nil,
            model: nil,
            field: nil,
            method: :delete,
            data: nil
          }
        ])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    test "relationship delete is refused when nothing can model the row" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      # A delete names no component, so the committed model is the only way
      # to place it as a relationship. Nothing places this id, and resolving
      # no group at all would be no check.
      action = build_action([relationship_delete("rel_unknown")])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "missing_ownership")
    end

    test "groupMember delete is refused when nothing can model the row" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_1", ["ebb/grant.delete"], "gm_actor")

      action = build_action([group_member_delete("gm_ghost")])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "missing_ownership")
    end

    test "groupMember delete resolves group_id from cache after a put" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      # The actor's own capable row is what authorizes the delete and
      # what keeps the group administered afterwards, so it must be a
      # different row from the one being deleted.
      put_group_member(tables, "g_1", ["ebb/grant.delete"], "gm_actor")
      put_group_member_by_id(tables, "gm_1", "a_2", "g_1", ["ebb/group.read"])

      action =
        build_action([
          %{
            id: "upd_del",
            subject_id: "gm_1",
            component: nil,
            model: nil,
            field: nil,
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
          group_member_put("gm_1", "a_1", "g_1", ["ebb/group.read", "todo.*"]),
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
          group_member_put("gm_1", "a_1", "g_1", ["ebb/group.read"]),
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
            component: "todo/title",
            model: "todo",
            field: "title",
            method: :merge,
            data: %{"value" => "hax"}
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
          group_member_put("gm_1", "a_1", "g_1", ["ebb/group.read", "todo.create"]),
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
          group_member_put("gm_1", "a_1", "g_1", ["ebb/group.read"]),
          group_member_put("gm_2", "a_2", "g_1", ["*"]),
          %{
            id: "upd_victim",
            subject_id: "todo_victim",
            component: "todo/title",
            model: "todo",
            field: "title",
            method: :merge,
            data: %{"value" => "hax"}
          }
        ])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    test "an actor holding groupMember.create may add another actor" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_1", ["ebb/grant.create"])

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

      put_group_member(tables, "g_1", ["todo.update"])
      put_membership(tables, "todo_1", "g_1", "eg_1")
      put_entity_type(tables, "todo_1", "todo")

      action = build_action([entity_put("todo_1", "todo")])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "rejects an unowned patch and delete" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_1", ["todo.update", "todo.delete"])

      patch =
        component_update("upd_patch", "todo_orphan", "todo/title", :merge, %{"value" => "x"})

      delete = delete_update("upd_delete", "todo_orphan_2")

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

  # #624: a component's model prefix is client input, while the model an id
  # was committed under is authoritative. Without this check, a permission on
  # any model in the group authorizes a relabel and a full overwrite of every
  # other model's entities there.
  describe "authorize/3 - writes use the committed model" do
    test "rejects a put, patch and delete that relabel an existing entity" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_1", ["todo.*"])
      put_membership(tables, "invoice_1", "g_1", "eg_1")
      put_entity_type(tables, "invoice_1", "invoice")

      for update <- [
            entity_put("invoice_1", "todo"),
            entity_patch("invoice_1", "todo"),
            entity_delete("invoice_1", "todo")
          ] do
        assert_rejected(
          Authorizer.authorize([build_action([update])], "a_1", ctx),
          "not_authorized"
        )
      end
    end

    test "rejects a system wire type naming an existing user entity id" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      # The relationship branch authorizes the wire source only, so the
      # victim's id as the edge subject would overwrite a user entity.
      put_group_member(tables, "g_1", ["todo.update"])
      put_membership(tables, "todo_own", "g_1", "eg_own")
      put_entity_type(tables, "todo_own", "todo")
      put_entity_type(tables, "invoice_1", "invoice")

      action = build_action([relationship_put("invoice_1", "todo_own", "col_1", "todo")])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    test "rejects a user wire type naming an existing system entity id" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_1", ["todo.create"])
      put_membership(tables, "group_1", "g_1", "eg_1")
      put_entity_type(tables, "group_1", "group")

      action = build_action([entity_put("group_1", "todo")])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    test "rejects a system wire type naming a committed row of another system type" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_1", ["todo.update"])
      put_membership(tables, "todo_own", "g_1", "eg_own")
      put_entity_type(tables, "todo_own", "todo")
      put_entity_type(tables, "eg_1", "entityGroup")

      action = build_action([relationship_put("eg_1", "todo_own", "col_1", "todo")])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    test "authorizes a genuinely new id under its wire type" do
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

    test "an id the same Action or request created keeps its own type" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_1", ["todo.*"])

      same_action =
        build_action([
          entity_put("todo_1", "todo"),
          entity_group_put("eg_1", "todo_1", "g_1"),
          entity_patch("todo_1", "todo")
        ])

      assert_accepted(Authorizer.authorize([same_action], "a_1", ctx))

      # The index has not seen `todo_2` yet, so the later Action's type
      # resolves from the request simulation.
      earlier_action =
        build_action([
          entity_put("todo_2", "todo"),
          entity_group_put("eg_2", "todo_2", "g_1")
        ])

      # Re-putting the row the earlier Action minted: the pair is already
      # in the simulation, and naming that row keeps it one row.
      later_action = build_action([entity_group_put("eg_2", "todo_2", "g_1")])

      assert_accepted(Authorizer.authorize([earlier_action, later_action], "a_1", ctx))
    end

    test "rejects a later Action that relabels an id an earlier Action created" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_1", ["todo.*", "invoice.*"])

      created =
        build_action([
          entity_put("x_1", "todo"),
          entity_group_put("eg_x_1", "x_1", "g_1")
        ])

      relabel =
        build_action([
          entity_put("x_1", "invoice"),
          entity_group_put("eg_x_1_again", "x_1", "g_1")
        ])

      assert {[accepted], [rejection]} = Authorizer.authorize([created, relabel], "a_1", ctx)
      assert accepted == created
      assert rejection.action == relabel
      assert rejection.reason == "not_authorized"
    end

    test "a later Action still uses the type an earlier Action created" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_1", ["invoice.create", "todo.*"])

      created =
        build_action([
          entity_put("x_1", "todo"),
          entity_group_put("eg_x_1", "x_1", "g_1")
        ])

      # Filing the entity again resolves its type from the request
      # simulation; a brand-new id still takes its wire type.
      filed = build_action([entity_group_put("eg_x_1", "x_1", "g_1")])

      fresh =
        build_action([
          entity_put("invoice_1", "invoice"),
          entity_group_put("eg_3", "invoice_1", "g_1")
        ])

      assert {accepted, []} = Authorizer.authorize([created, filed, fresh], "a_1", ctx)
      assert accepted == [created, filed, fresh]
    end

    test "refuses a write whose type is unresolvable but whose entity owns a group" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_1", ["todo.*"])
      put_membership(tables, "todo_own", "g_1", "eg_own")
      put_entity_type(tables, "todo_own", "todo")

      # The entity-type index lags the membership cache it is rebuilt from,
      # leaving nothing that can type `invoice_1`, so no wire type can be
      # checked against it. The relationship branch would otherwise let the
      # edge overwrite a user entity here.
      put_membership(tables, "invoice_1", "g_1", "eg_invoice")

      for update <- [
            entity_put("invoice_1", "todo"),
            relationship_put("invoice_1", "todo_own", "col_1", "todo")
          ] do
        assert_rejected(
          Authorizer.authorize([build_action([update])], "a_1", ctx),
          "not_authorized"
        )
      end
    end

    test "a lagging type index still authorizes a system row its by-id cache types" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_1", ["ebb/grant.update"])
      put_group_member_by_id(tables, "gm_2", "a_2", "g_1", ["*"])

      action = build_action([group_member_patch("gm_2", "g_1", ["*"])])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "rejects an entityGroup put naming a committed user entity as its row" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_1", ["todo.create"])
      put_membership(tables, "todo_1", "g_1", "eg_1")
      put_entity_type(tables, "todo_1", "todo")

      # The row is otherwise writable — it owns a group and is typed like any
      # committed entity — so only the type identity stands in the way.
      put_membership(tables, "todo_own", "g_2", "eg_own")
      put_entity_type(tables, "todo_own", "todo")

      action = build_action([entity_group_put("todo_1", "todo_own", "g_1")])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    # A deleted id keeps its entity-type entry but loses its rows, so only
    # its own type may be committed again; a relabel stays refused (#624).
    test "a tombstoned id may only be re-put under its own type" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_1", ["invoice.*", "todo.*"])
      put_entity_type(tables, "invoice_1", "invoice")

      assert_rejected(
        Authorizer.authorize([build_action([entity_put("invoice_1", "todo")])], "a_1", ctx),
        "not_authorized"
      )

      # Its own type is not a relabel: the write is refused later, by the
      # missing ownership, not by the type identity.
      assert_rejected(
        Authorizer.authorize([build_action([entity_put("invoice_1", "invoice")])], "a_1", ctx),
        "missing_ownership"
      )
    end

    test "a rejected relabel leaves the committed type untouched" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_1", ["todo.*", "invoice.update"])
      put_membership(tables, "invoice_1", "g_1", "eg_1")
      put_entity_type(tables, "invoice_1", "invoice")

      relabel = build_action([entity_patch("invoice_1", "todo")])
      same_type = build_action([entity_patch("invoice_1", "invoice")])

      assert {[accepted], [rejection]} =
               Authorizer.authorize([relabel, same_type], "a_1", ctx)

      assert rejection.reason == "not_authorized"
      assert accepted == same_type
      assert [{_, "invoice"}] = :ets.lookup(tables.entity_types, "invoice_1")
    end
  end

  # A relationship row fans out to its source's group set, so the source
  # is row identity, like an `entityGroup` row's entity (#623). The wire
  # `source_id` may not move an existing row to another source.
  describe "authorize/3 - relationship rows are bound to their source (#624)" do
    test "refuses a put that re-points a victim's edge at the attacker's entity" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      # The attacker holds every permission the wire source needs in their
      # own group, so only the stored row's source stands in the way.
      put_group_member(tables, "g_attacker", ["todo.*", "ebb/link.*"])
      put_membership(tables, "todo_attacker", "g_attacker", "eg_attacker")
      put_entity_type(tables, "todo_attacker", "todo")
      put_membership(tables, "todo_victim", "g_victim", "eg_victim")
      put_entity_type(tables, "todo_victim", "todo")
      put_relationship_by_id(tables, "rel_victim", "todo_victim")

      action = build_action([relationship_put("rel_victim", "todo_attacker", "col_x", "todo")])

      rejection = assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
      assert rejection.details == "an ebb/link row cannot be re-pointed at another source"
    end

    test "refuses a patch that changes the source of an existing row" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_attacker", ["todo.*", "ebb/link.*"])
      put_membership(tables, "todo_attacker", "g_attacker", "eg_attacker")
      put_membership(tables, "todo_victim", "g_victim", "eg_victim")
      put_relationship_by_id(tables, "rel_victim", "todo_victim")

      action = build_action([relationship_patch("rel_victim", "todo_attacker", "col_x")])

      rejection = assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
      assert rejection.details == "an ebb/link row cannot be re-pointed at another source"
    end

    test "accepts a put that keeps the row's source and changes its target" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_victim", ["todo.*", "ebb/link.update"])
      put_membership(tables, "todo_victim", "g_victim", "eg_victim")
      put_entity_type(tables, "todo_victim", "todo")
      put_relationship_by_id(tables, "rel_victim", "todo_victim")

      action = build_action([relationship_put("rel_victim", "todo_victim", "col_y", "todo")])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "accepts a patch that keeps the row's source" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_victim", ["ebb/link.update"])
      put_membership(tables, "todo_victim", "g_victim", "eg_victim")
      put_relationship_by_id(tables, "rel_victim", "todo_victim")

      action = build_action([relationship_patch("rel_victim", "todo_victim", "col_y")])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "refuses a put that names no source" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      # The actor is a group member, so the refusal is not a plain
      # permission miss.
      put_group_member(tables, "g_1", ["ebb/link.*"])

      # A put with no source has no group set to authorize against, and
      # falling back to the row's own groups would authorize an edge nobody
      # owns.
      update = %{
        id: "upd_rel",
        subject_id: "rel_1",
        component: "ebb/link",
        model: "ebb",
        field: "link",
        method: :replace,
        data: %{"value" => %{"target_id" => "col_2"}}
      }

      rejection =
        assert_rejected(
          Authorizer.authorize([build_action([update])], "a_1", ctx),
          "not_authorized"
        )

      assert rejection.details == "ebb/link source model is unresolvable"
    end

    test "accepts a brand-new relationship row" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_victim", ["todo.*"])
      put_membership(tables, "todo_victim", "g_victim", "eg_victim")
      put_entity_type(tables, "todo_victim", "todo")

      action = build_action([relationship_put("rel_new", "todo_victim", "col_x", "todo")])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    # A patch that omits the source cannot be applied — the mutation
    # planner drops it — so it is not a re-point and the stored row's
    # groups authorize it as before.
    test "a patch that omits the source is not a mismatch" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_attacker", ["ebb/link.update"])
      put_membership(tables, "todo_victim", "g_victim", "eg_victim")
      put_relationship_by_id(tables, "rel_victim", "todo_victim")

      sourceless_patch = %{
        id: "rel_victim_patch",
        subject_id: "rel_victim",
        component: "ebb/link",
        model: "ebb",
        field: "link",
        method: :replace,
        data: %{"value" => %{"target_id" => "col_y"}}
      }

      rejection =
        assert_rejected(
          Authorizer.authorize([build_action([sourceless_patch])], "a_1", ctx),
          "not_authorized"
        )

      assert rejection.details == "missing required permission"

      put_group_member(tables, "g_victim", ["ebb/link.update"], "gm_victim")

      assert_accepted(Authorizer.authorize([build_action([sourceless_patch])], "a_1", ctx))
    end

    # The row check runs before the bootstrap exemption, so a bootstrap
    # cannot carry a re-point any more than it can carry an `entityGroup`
    # re-point (#623).
    test "a bootstrap cannot re-point an existing edge" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_membership(tables, "todo_victim", "g_victim", "eg_victim")
      put_relationship_by_id(tables, "rel_victim", "todo_victim")

      action =
        build_action([
          group_put("g_1"),
          group_member_put("gm_1", "a_1", "g_1", ["todo.*"]),
          entity_put("todo_new", "todo"),
          entity_group_put("eg_1", "todo_new", "g_1"),
          relationship_put("rel_victim", "todo_new", "col_x", "todo")
        ])

      rejection = assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
      assert rejection.details == "an ebb/link row cannot be re-pointed at another source"
    end

    # A delete's group scope comes from the stored row, never from the wire
    # `source_id`, so holding `relationship.*` in another group does not
    # reach an edge that belongs to a source in somebody else's group.
    test "refuses a delete that carries a foreign wire source" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_attacker", ["todo.*", "ebb/link.*"])
      put_membership(tables, "todo_attacker", "g_attacker", "eg_attacker")
      put_entity_type(tables, "todo_attacker", "todo")
      put_membership(tables, "todo_victim", "g_victim", "eg_victim")
      put_relationship_by_id(tables, "rel_victim", "todo_victim")

      action = build_action([relationship_delete("rel_victim", "todo_attacker")])

      rejection = assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
      assert rejection.details == "missing required permission"
    end

    test "accepts the source owner's delete that carries no wire source" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_victim", ["ebb/link.delete"])
      put_membership(tables, "todo_victim", "g_victim", "eg_victim")
      put_relationship_by_id(tables, "rel_victim", "todo_victim")

      assert_accepted(
        Authorizer.authorize([build_action([relationship_delete("rel_victim")])], "a_1", ctx)
      )
    end

    # A delete of a row with no committed row has nothing to bind to: the
    # row was either created earlier in the request or already tombstoned,
    # and in both cases the wire source is the only scope there is. That is
    # also why an absent by-id row is not treated as a refusal (#624).
    test "a delete with no committed row and no sibling write has no scope" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_victim", ["ebb/link.*"])
      put_membership(tables, "todo_victim", "g_victim", "eg_victim")

      # A delete names no component, so a row nothing committed has neither a
      # model nor a wire source to scope it; its only scope is a put for the
      # same row in the same Action (`:intra_relationship_sources`).
      action = build_action([relationship_delete("rel_new", "todo_victim")])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "missing_ownership")
    end

    # Moving an edge is a delete plus a put (#624's prescribed remedy). The
    # request's own delete leaves the row with no committed source, so the
    # put is a create in the new source's groups. The delete is still
    # authorized against the stored row's groups, and the put against the
    # new source's: two different group sets in one Action.
    test "accepts a delete plus a put that moves an edge to another source" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_victim", ["ebb/link.*"], "gm_victim")
      put_group_member(tables, "g_new", ["todo.*", "ebb/link.*"], "gm_new")
      put_membership(tables, "todo_victim", "g_victim", "eg_victim")
      put_entity_type(tables, "todo_victim", "todo")
      put_membership(tables, "todo_new", "g_new", "eg_new")
      put_entity_type(tables, "todo_new", "todo")
      put_relationship_by_id(tables, "rel_victim", "todo_victim")

      action =
        build_action([
          relationship_delete("rel_victim"),
          relationship_put("rel_victim", "todo_new", "col_x", "todo")
        ])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "accepts a delete and a move-put in two Actions of one request" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_victim", ["ebb/link.*"], "gm_victim")
      put_group_member(tables, "g_new", ["todo.*", "ebb/link.*"], "gm_new")
      put_membership(tables, "todo_victim", "g_victim", "eg_victim")
      put_entity_type(tables, "todo_victim", "todo")
      put_membership(tables, "todo_new", "g_new", "eg_new")
      put_entity_type(tables, "todo_new", "todo")
      put_relationship_by_id(tables, "rel_victim", "todo_victim")

      delete_action = %{build_action([relationship_delete("rel_victim")]) | id: "act_delete"}

      put_action = %{
        build_action([relationship_put("rel_victim", "todo_new", "col_x", "todo")])
        | id: "act_put"
      }

      assert {[^delete_action, ^put_action], []} =
               Authorizer.authorize([delete_action, put_action], "a_1", ctx)
    end

    # The prescribed remedy is not a way around the delete's own
    # authorization: naming the row as deleted only releases the source
    # binding, and the delete still has to pass against the stored row's
    # groups. The put is accepted here, so the refusal comes from the
    # delete — not from the re-point check.
    test "refuses a put-then-delete re-point the actor may not delete" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_attacker", ["todo.*", "ebb/link.*"], "gm_attacker")
      put_membership(tables, "todo_attacker", "g_attacker", "eg_attacker")
      put_entity_type(tables, "todo_attacker", "todo")
      put_membership(tables, "todo_victim", "g_victim", "eg_victim")
      put_relationship_by_id(tables, "rel_victim", "todo_victim")

      action =
        build_action([
          relationship_put("rel_victim", "todo_attacker", "col_x", "todo"),
          relationship_delete("rel_victim")
        ])

      rejection = assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
      assert rejection.details == "missing required permission"
    end

    # Only an **accepted** delete releases the binding: a refused delete
    # leaves the row bound to its stored source, so the put in a later
    # Action of the same request is still a re-point.
    test "a refused delete in an earlier Action does not release the binding" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_attacker", ["todo.*", "ebb/link.*"], "gm_attacker")
      put_membership(tables, "todo_attacker", "g_attacker", "eg_attacker")
      put_entity_type(tables, "todo_attacker", "todo")
      put_membership(tables, "todo_victim", "g_victim", "eg_victim")
      put_relationship_by_id(tables, "rel_victim", "todo_victim")

      delete_action = %{build_action([relationship_delete("rel_victim")]) | id: "act_delete"}

      put_action = %{
        build_action([relationship_put("rel_victim", "todo_attacker", "col_x", "todo")])
        | id: "act_put"
      }

      assert {[], [delete_rejection, put_rejection]} =
               Authorizer.authorize([delete_action, put_action], "a_1", ctx)

      assert delete_rejection.details == "missing required permission"
      assert put_rejection.details == "an ebb/link row cannot be re-pointed at another source"
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

      put_group_member(tables, "g_2", ["ebb/membership.create"])
      put_membership(tables, "todo_1", "g_1", "eg_1")
      put_entity_type(tables, "todo_1", "todo")

      action = build_action([entity_group_put("eg_new", "todo_1", "g_2")])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    test "adding an existing entity needs <type>.update where it already lives, not only the target" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      # The graft: `create` in the caller's own group, no permission in
      # the group the entity lives in. Filing it would hand the caller
      # read *and* write over the entity (#623).
      put_group_member(tables, "g_2", ["todo.create"])
      put_membership(tables, "todo_1", "g_1", "eg_1")
      put_entity_type(tables, "todo_1", "todo")

      action = build_action([entity_group_put("eg_new", "todo_1", "g_2")])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    test "adding an existing entity is allowed with <type>.update in a current group and create in the target" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_1", ["todo.update"])
      put_group_member(tables, "g_2", ["todo.create"], "gm_2")
      put_membership(tables, "todo_1", "g_1", "eg_1")
      put_entity_type(tables, "todo_1", "todo")

      action = build_action([entity_group_put("eg_new", "todo_1", "g_2")])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "a multi-group entity is shared by a write permission in any one of its groups" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_2", ["todo.update"])
      put_group_member(tables, "g_3", ["todo.create"], "gm_3")
      put_membership(tables, "todo_1", "g_1", "eg_1")
      put_membership(tables, "todo_1", "g_2", "eg_2")
      put_entity_type(tables, "todo_1", "todo")

      action = build_action([entity_group_put("eg_new", "todo_1", "g_3")])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "a bootstrapped actor cannot self-grant the source side" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_membership(tables, "todo_1", "g_victim", "eg_victim")
      put_entity_type(tables, "todo_1", "todo")

      # One Action mints a group, the caller's membership in it with
      # every permission, and files the victim's entity into it. The
      # declared permissions stand in for the membership this Action
      # creates — never for ownership of an entity that already exists.
      action =
        build_action([
          group_put("g_new"),
          group_member_put("gm_new", "a_1", "g_new", ["todo.create", "todo.update"]),
          entity_group_put("eg_new", "todo_1", "g_new")
        ])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
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
      put_group_member(tables, "g_2", ["ebb/membership.create", "ebb/membership.*", "*"])
      put_membership(tables, "todo_unknown", "g_1", "eg_1")

      action = build_action([entity_group_put("eg_new", "todo_unknown", "g_2")])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    test "a same-Action create is authorized by <type>.create, not entityGroup.create" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_1", ["ebb/membership.create"])

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

      put_group_member(tables, "g_1", ["ebb/membership.delete"])
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
          group_member_put("gm_1", "a_1", "g_new", ["ebb/group.read"]),
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

    test "re-putting the same group then deleting the old row across two Actions is refused", %{
      tables: tables,
      ctx: ctx
    } do
      put_membership(tables, "todo_1", "g_1", "eg_1")
      put_entity_group_by_id(tables, "eg_1", "todo_1", "g_1")
      put_entity_type(tables, "todo_1", "todo")
      put_group_member(tables, "g_1", ["todo.*"])

      # One Action is the unit: the first Action on its own mints a second
      # row for a pair that still has one, so the pair has two rows until
      # the second Action lands.
      actions = [
        build_action([entity_group_put("eg_new", "todo_1", "g_1")]),
        build_action([entity_group_delete("eg_1")])
      ]

      assert {[], rejected} = Authorizer.authorize(actions, "a_1", ctx)
      assert [rejection | rest] = rejected
      assert rejection.action == List.first(actions)
      assert rejection.reason == "not_authorized"
      assert rejection.details =~ "already filed"
      # The delete then strands an entity with no owning group, so it is
      # refused on its own terms rather than riding the failed put.
      assert Enum.all?(rest, &(&1.reason == "last_membership"))
    end

    test "an unresolvable membership delete is refused", %{ctx: ctx} do
      action = build_action([entity_group_delete("eg_unknown")])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "missing_ownership")
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
      put_group_member(tables, "g_1", ["ebb/grant.delete"], "gm_actor")

      action = build_action([group_member_delete("gm_actor")])

      rejection =
        assert_rejected(Authorizer.authorize([action], "a_1", ctx), "last_group_member")

      assert is_binary(rejection.details)
    end

    test "a member with an empty permission list does not keep the group alive", %{
      tables: tables,
      ctx: ctx
    } do
      put_group_member(tables, "g_1", ["ebb/grant.delete"], "gm_actor")
      put_group_member_by_id(tables, "gm_1", "a_2", "g_1", [])

      action = build_action([group_member_delete("gm_actor")])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "last_group_member")
    end

    test "deleting one of two capable memberships is allowed", %{tables: tables, ctx: ctx} do
      put_group_member(tables, "g_1", ["ebb/grant.delete"], "gm_actor")
      put_group_member_by_id(tables, "gm_1", "a_2", "g_1", ["ebb/group.read"])

      action = build_action([group_member_delete("gm_1")])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "a batch of two Actions that each drop one capable membership is refused", %{
      tables: tables,
      ctx: ctx
    } do
      put_group_member(tables, "g_1", ["ebb/grant.delete"], "gm_actor")
      put_group_member_by_id(tables, "gm_1", "a_2", "g_1", ["ebb/group.read"])

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
      put_group_member(tables, "g_1", ["ebb/grant.update"], "gm_actor")

      action = build_action([group_member_patch("gm_actor", "g_1", [])])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "last_group_member")
    end

    test "patching one of two capable permission lists to empty is allowed", %{
      tables: tables,
      ctx: ctx
    } do
      put_group_member(tables, "g_1", ["ebb/grant.update"], "gm_actor")
      put_group_member_by_id(tables, "gm_1", "a_2", "g_1", ["ebb/group.read"])

      action = build_action([group_member_patch("gm_1", "g_1", [])])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "a value that names no permissions empties the row's list", %{
      tables: tables,
      ctx: ctx
    } do
      # An atomic value is the whole row: omitting `permissions` states an
      # empty list rather than leaving the stored one alone, so the actor's
      # own row — the group's only capable membership — would lock the group
      # out.
      put_group_member(tables, "g_1", ["ebb/grant.update"], "gm_actor")

      action = build_action([group_member_patch_without_permissions("gm_actor", "g_1")])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "last_group_member")
    end

    test "a patch to a row the same Action put resolves against the request", %{ctx: ctx} do
      # The group, the capable row and the patch to it all ride one Action,
      # so the row exists only in the request's own delta. Reading the empty
      # cache instead would drop the permissions the put declared and refuse
      # the Action as a lockout.
      action =
        build_action([
          group_put("g_new"),
          group_member_put("gm_own", "a_1", "g_new", ["ebb/grant.update"]),
          group_member_patch("gm_own", "g_new", ["ebb/grant.update"], "a_1")
        ])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "deleting the same membership row twice in one Action counts once", %{
      tables: tables,
      ctx: ctx
    } do
      put_group_member(tables, "g_1", ["ebb/grant.delete"], "gm_actor")
      put_group_member_by_id(tables, "gm_1", "a_2", "g_1", ["ebb/group.read"])

      # The retried delete names a row the request has already removed, so
      # the delta has nothing left to subtract and must not read the row as
      # still present.
      action =
        build_action([
          group_member_delete("gm_1"),
          %{group_member_delete("gm_1") | id: "upd_gm_1_retry"}
        ])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "a by-group entry whose row is no longer cached is not counted", %{
      tables: tables,
      ctx: ctx
    } do
      put_group_member(tables, "g_1", ["ebb/grant.update"], "gm_actor")
      put_group_member_by_id(tables, "gm_1", "a_2", "g_1", ["ebb/group.read"])

      # The by-group index can lag the by-id cache; an id it still lists but
      # nothing resolves must be skipped rather than counted or crash.
      :ets.insert(tables.group_members_by_group, {{"g_1", "gm_ghost"}})

      action = build_action([group_member_patch("gm_1", "g_1", ["ebb/group.read"])])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "transferring the last membership within one Action is allowed", %{
      tables: tables,
      ctx: ctx
    } do
      put_group_member(
        tables,
        "g_1",
        ["ebb/grant.delete", "ebb/grant.create"],
        "gm_actor"
      )

      action =
        build_action([
          group_member_delete("gm_actor"),
          group_member_put("gm_new", "a_2", "g_1", ["ebb/group.read"])
        ])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "a write that empties the permission list is a lockout", %{tables: tables, ctx: ctx} do
      put_group_member(tables, "g_1", ["ebb/grant.*"], "gm_actor")

      # The value writes an empty permission list, so the group would be left
      # with no member that can administer it.
      update = %{
        id: "upd_gm",
        subject_id: "gm_actor",
        component: "ebb/grant",
        model: "ebb",
        field: "grant",
        method: :replace,
        data: %{"value" => %{"actor_id" => "a_1", "group_id" => "g_1", "permissions" => []}}
      }

      assert_rejected(
        Authorizer.authorize([build_action([update])], "a_1", ctx),
        "last_group_member"
      )
    end

    test "moving a membership between groups is refused even when both groups authorize", %{
      tables: tables,
      ctx: ctx
    } do
      # Decision 13: a grant's `group_id` is its identity, so moving an actor
      # between groups is a delete plus a create, never a re-point. Holding
      # the permission on both sides is not enough.
      put_group_member(tables, "g_2", ["ebb/grant.update"], "gm_actor")
      put_group_member(tables, "g_1", ["ebb/grant.update"], "gm_actor_1")
      put_group_member_by_id(tables, "gm_1", "a_2", "g_1", ["ebb/group.read"])

      action = build_action([group_member_patch("gm_1", "g_2", ["ebb/group.read"])])

      rejection =
        assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")

      assert rejection.details == "an ebb/grant row cannot be re-pointed at another group"
    end

    test "moving a group's only capable membership out of it is refused", %{
      tables: tables,
      ctx: ctx
    } do
      # The actor authorizes the patch in the destination group, but the
      # row is bound to the origin group, where they hold nothing (#625).
      put_group_member(tables, "g_2", ["ebb/grant.update"], "gm_actor")
      put_group_member_by_id(tables, "gm_1", "a_2", "g_1", ["ebb/group.read"])

      action = build_action([group_member_patch("gm_1", "g_2", ["ebb/group.read"])])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    test "moving the last capable membership is refused even when both groups authorize", %{
      tables: tables,
      ctx: ctx
    } do
      # An atomic grant's group is immutable, so the move is refused as a
      # re-point before the last-member guard can even see it.
      put_group_member(tables, "g_1", ["ebb/grant.update"], "gm_actor")
      put_group_member(tables, "g_2", ["ebb/grant.update"], "gm_actor_2")

      action = build_action([group_member_patch("gm_actor", "g_2", ["ebb/grant.update"])])

      rejection =
        assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")

      assert rejection.details == "an ebb/grant row cannot be re-pointed at another group"
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
      put_group_member_by_id(tables, "gm_victim", "a_victim", "g_victim", ["ebb/group.read"])
      put_group_member_by_id(tables, "gm_victim_2", "a_victim_2", "g_victim", ["ebb/group.read"])
      put_group_member(tables, "g_attacker", ["ebb/grant.*"])

      %{tables: tables, ctx: auth_context(tables)}
    end

    test "re-putting an existing row with permission only in the destination group is refused", %{
      ctx: ctx
    } do
      action =
        build_action([
          group_member_put("gm_victim", "a_1", "g_attacker", ["ebb/group.read"])
        ])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    test "patching an existing row with permission only in the destination group is refused", %{
      ctx: ctx
    } do
      action = build_action([group_member_patch("gm_victim", "g_attacker", ["ebb/group.read"])])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    # The type index retains tombstones, so an id it knows but the by-id
    # cache no longer places is not a fresh row: re-filing it would let a
    # deleted membership id be reused as a bootstrap.
    test "a row id known only to the type index is refused, not re-filed" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_1", ["ebb/grant.*"])
      put_entity_type(tables, "gm_tombstone", "groupMember")

      action = build_action([group_member_put("gm_tombstone", "a_1", "g_1", ["todo.read"])])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    test "a bootstrap that re-puts an existing row id is refused", %{ctx: ctx} do
      action =
        build_action([
          group_put("g_new"),
          group_member_put("gm_own", "a_1", "g_new", ["ebb/grant.*"]),
          group_member_put("gm_victim", "a_1", "g_new", ["ebb/group.read"])
        ])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end
  end

  describe "authorize/3 - groupMember changes authorized in the row's group" do
    setup do
      tables = create_isolated_tables()

      put_group_member_by_id(tables, "gm_1", "a_2", "g_1", ["ebb/group.read"])
      put_group_member(tables, "g_1", ["ebb/grant.*"], "gm_actor")

      %{tables: tables, ctx: auth_context(tables)}
    end

    test "re-putting a row inside its own group is allowed", %{ctx: ctx} do
      action =
        build_action([group_member_put("gm_1", "a_2", "g_1", ["ebb/group.read", "todo.*"])])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "patching a row inside its own group is allowed", %{ctx: ctx} do
      action = build_action([group_member_patch("gm_1", "g_1", ["ebb/group.read"])])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "moving a row between groups is refused rather than authorized", %{
      tables: tables,
      ctx: ctx
    } do
      # Decision 13 makes `group_id` the row's identity: a move is a delete
      # plus a create, so no permission set authorizes a re-point in place.
      put_group_member(tables, "g_2", ["ebb/grant.update"], "gm_actor_2")

      action = build_action([group_member_patch("gm_1", "g_2", ["ebb/group.read"])])

      rejection =
        assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")

      assert rejection.details == "an ebb/grant row cannot be re-pointed at another group"
    end
  end

  # #623: an `entityGroup` write is authorized against the entity and group
  # it names, never against the caller's own group alone. A membership row
  # for an id nothing models cannot be filed, whatever permission the caller
  # holds.
  describe "authorize/3 - entityGroup writes are bound to the entity" do
    setup do
      tables = create_isolated_tables()

      put_group_member(tables, "g_atk", ["ebb/membership.*"])

      %{tables: tables, ctx: auth_context(tables)}
    end

    test "is rejected even when the actor holds entityGroup.update in the target group", %{
      ctx: ctx
    } do
      update =
        component_updates("eg_fresh_patch", "eg_fresh", "entityGroup", :merge, %{
          "entity_id" => "todo_victim",
          "group_id" => "g_atk"
        })

      rejection =
        assert_rejected(
          Authorizer.authorize([build_action([update])], "a_1", ctx),
          "not_authorized"
        )

      assert rejection.details =~ "cannot resolve the model of the entity"
    end

    test "a bootstrap entityGroup put cannot re-point an existing membership row" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_entity_group_by_id(tables, "eg_victim", "todo_victim", "g_victim")

      action =
        build_action([
          group_put("g_new"),
          group_member_put("gm_own", "a_1", "g_new", ["ebb/membership.*", "todo.create"]),
          entity_put("todo_new", "todo"),
          entity_group_put("eg_victim", "todo_new", "g_new")
        ])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    # Two deletes can share an update id. Resolving deletes by that id
    # collapses them, authorizing one against the other's entity and hiding
    # the removal from the last-membership guard (#623).
    test "duplicate update ids do not borrow another delete's authorization" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_atk", ["todo.update"])
      put_entity_type(tables, "todo_attacker", "todo")
      put_membership(tables, "todo_attacker", "g_atk", "eg_attacker")
      put_entity_group_by_id(tables, "eg_attacker", "todo_attacker", "g_atk")
      put_entity_type(tables, "todo_victim", "todo")
      put_membership(tables, "todo_victim", "g_victim", "eg_victim")
      put_entity_group_by_id(tables, "eg_victim", "todo_victim", "g_victim")

      duplicate = %{
        id: "dup_update",
        component: nil,
        model: nil,
        field: nil,
        method: :delete,
        data: nil
      }

      action =
        build_action([
          Map.put(duplicate, :subject_id, "eg_victim"),
          Map.put(duplicate, :subject_id, "eg_attacker")
        ])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    test "a put cannot carry a non-string group id", %{tables: tables, ctx: ctx} do
      put_group_member(tables, "g_atk", ["todo.create"])
      put_entity_type(tables, "todo_attacker", "todo")
      put_membership(tables, "todo_attacker", "g_atk", "eg_attacker")

      action = build_action([entity_group_put("eg_new", "todo_attacker", ["g_atk"])])

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

    # #623: an existing membership row's write folds to `:patch`, so the row
    # identity check has to cover both verbs. Otherwise a caller holding
    # `<model>.create` and `<model>.update` in their own group can merge a
    # victim's row id onto another entity and steal the membership, silently
    # stripping the victim of its last group.
    test "a merge cannot re-point a live membership row at another entity", %{
      tables: tables,
      ctx: ctx
    } do
      # The attacker is fully authorized for their own pair, so a rejection
      # here can only come from the row-identity check.
      put_group_member(tables, "g_atk", ["todo.create", "todo.update"], "gm_atk")
      put_entity_type(tables, "todo_attacker", "todo")
      put_membership(tables, "todo_attacker", "g_atk", "eg_attacker")
      put_entity_group_by_id(tables, "eg_attacker", "todo_attacker", "g_atk")
      put_entity_type(tables, "todo_victim", "todo")
      put_membership(tables, "todo_victim", "g_victim", "eg_victim")
      put_entity_group_by_id(tables, "eg_victim", "todo_victim", "g_victim")

      re_point =
        component_updates("eg_victim_merge", "eg_victim", "entityGroup", :merge, %{
          "entity_id" => "todo_attacker",
          "group_id" => "g_atk"
        })

      rejection =
        assert_rejected(
          Authorizer.authorize([build_action([re_point])], "a_1", ctx),
          "not_authorized"
        )

      assert rejection.details ==
               "an ebb/membership row cannot be re-pointed at another entity or group"

      # The same merge naming the row's own entity is an ordinary write: the
      # check is identity, not a refusal of membership merges.
      put_group_member(tables, "g_victim", ["todo.create"], "gm_victim")

      keep =
        component_updates("eg_victim_merge_2", "eg_victim", "entityGroup", :merge, %{
          "entity_id" => "todo_victim",
          "group_id" => "g_victim"
        })

      assert_accepted(Authorizer.authorize([build_action([keep])], "a_1", ctx))
    end

    test "a put cannot move a membership row to another group", %{tables: tables, ctx: ctx} do
      # `(entity_id, group_id)` is the membership row's identity (decision
      # 13): a move is a delete plus a create.
      put_group_member(tables, "g_2", ["todo.create"], "gm_2")
      put_group_member(tables, "g_1", ["todo.update"], "gm_g1")
      put_entity_type(tables, "todo_1", "todo")
      put_membership(tables, "todo_1", "g_1", "eg_old")
      put_entity_group_by_id(tables, "eg_old", "todo_1", "g_1")

      action = build_action([entity_group_put("eg_old", "todo_1", "g_2")])

      rejection =
        assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")

      assert rejection.details ==
               "an ebb/membership row cannot be re-pointed at another entity or group"
    end

    test "a put cannot claim an entity the index knows but no group owns" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_group_member(tables, "g_atk", ["todo.create"])
      put_entity_type(tables, "todo_orphan", "todo")

      action = build_action([entity_group_put("eg_new", "todo_orphan", "g_atk")])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    test "put is refused with <type>.create in the target group alone",
         %{
           tables: tables,
           ctx: ctx
         } do
      put_group_member(tables, "g_2", ["todo.create"], "gm_2")
      put_entity_type(tables, "todo_1", "todo")
      put_membership(tables, "todo_1", "g_1", "eg_1")

      action = build_action([entity_group_put("eg_new", "todo_1", "g_2")])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    test "put is authorized by <type>.update where the entity lives plus create in the target",
         %{
           tables: tables,
           ctx: ctx
         } do
      put_group_member(tables, "g_1", ["todo.update"], "gm_g1")
      put_group_member(tables, "g_2", ["todo.create"], "gm_2")
      put_entity_type(tables, "todo_1", "todo")
      put_membership(tables, "todo_1", "g_1", "eg_1")

      action = build_action([entity_group_put("eg_new", "todo_1", "g_2")])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    # Two devices sharing one entity into one group must converge on one
    # row: a second row survives the unshare that deletes the first, so
    # the owner's revocation silently fails (#623).
    test "a put cannot mint a second row for a live (entity, group) pair", %{
      tables: tables,
      ctx: ctx
    } do
      put_group_member(tables, "g_1", ["todo.update"], "gm_g1")
      put_group_member(tables, "g_2", ["todo.create"], "gm_2")
      put_entity_type(tables, "todo_1", "todo")
      put_membership(tables, "todo_1", "g_1", "eg_1")
      put_membership(tables, "todo_1", "g_2", "eg_old")

      action = build_action([entity_group_put("eg_new", "todo_1", "g_2")])

      rejection =
        assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")

      assert rejection.details =~ "already filed"
    end

    test "re-putting the pair's live row is idempotent", %{
      tables: tables,
      ctx: ctx
    } do
      put_group_member(tables, "g_1", ["todo.update"], "gm_g1")
      put_group_member(tables, "g_2", ["todo.create"], "gm_2")
      put_entity_type(tables, "todo_1", "todo")
      put_membership(tables, "todo_1", "g_1", "eg_1")
      put_membership(tables, "todo_1", "g_2", "eg_old")

      action = build_action([entity_group_put("eg_old", "todo_1", "g_2")])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "a second row for a pair the same Action creates is refused", %{
      tables: tables,
      ctx: ctx
    } do
      put_group_member(tables, "g_2", ["todo.create"], "gm_2")

      # A bootstrap can file one entity into one group once; the caches
      # cannot catch the second put, so the check reads the Action.
      action =
        build_action([
          entity_put("todo_new", "todo"),
          entity_group_put("eg_a", "todo_new", "g_2"),
          entity_group_put("eg_b", "todo_new", "g_2")
        ])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
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
          group_member_put("gm_1", "a_1", "g_1", ["todo.create", "ebb/group.read"]),
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
          group_member_put("gm_1", "a_1", "g_new", ["ebb/group.read", "todo.*"]),
          entity_put("todo_new", "todo"),
          entity_group_put("eg_new", "todo_new", "g_new")
        ])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "an existing group re-put by a member with group.update still succeeds" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_entity_type(tables, "g_1", "group")
      put_group_member(tables, "g_1", ["ebb/group.update"])

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

      put_group_member(tables, "g_1", ["ebb/group.read"])
      put_membership(tables, "todo_1", "g_1", "eg_1")

      %{tables: tables, ctx: ctx}
    end

    test "cannot create a groupMember", %{ctx: ctx} do
      action = build_action([group_member_put("gm_2", "a_2", "g_1", ["*"])])
      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    test "cannot update a groupMember", %{ctx: ctx} do
      update =
        component_updates("upd_gm_patch", "gm_2", "groupMember", :merge, %{
          "group_id" => "g_1",
          "actor_id" => "a_2",
          "permissions" => ["*"]
        })

      assert_rejected(
        Authorizer.authorize([build_action([update])], "a_1", ctx),
        "not_authorized"
      )
    end

    test "cannot delete a groupMember", %{tables: tables, ctx: ctx} do
      put_group_member_by_id(tables, "gm_2", "a_2", "g_1", ["*"])

      update = delete_update("upd_gm", "gm_2")

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
        component: "ebb/link",
        model: "ebb",
        field: "link",
        method: :replace,
        data: %{"value" => %{"source_id" => "todo_1", "target_id" => "column_1"}}
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
        component: nil,
        model: nil,
        field: nil,
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
        component: "ebb/membership",
        model: "ebb",
        field: "membership",
        method: :replace,
        data: %{"value" => %{"entity_id" => "todo_1", "group_id" => "g_1"}}
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
        component: nil,
        model: nil,
        field: nil,
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

      put_group_member(tables, "g_1", ["todo.update"])
      put_membership(tables, "todo_ok", "g_1", "eg_ok")
      put_membership(tables, "todo_bad", "g_2", "eg_bad")
      put_entity_type(tables, "todo_ok", "todo")
      put_entity_type(tables, "todo_bad", "todo")

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
      assert add_rejection.details =~ "cannot resolve the model"
    end
  end
end
