defmodule EbbServer.Storage.AuthorizerTest do
  use ExUnit.Case, async: false

  import EbbServer.TestHelpers
  alias EbbServer.Storage.{AuthorizationContext, Authorizer}

  defp auth_context(tables) do
    AuthorizationContext.build(
      grants: tables.grants,
      grants_by_id: tables.grants_by_id,
      grants_by_group: tables.grants_by_group,
      memberships: tables.memberships,
      memberships_by_id: tables.memberships_by_id,
      entity_models: tables.entity_models
    )
  end

  defp put_entity_model(tables, entity_id, type) do
    :ets.insert(tables.entity_models, {entity_id, type})
  end

  defp put_membership(tables, entity_id, group_id, id) do
    :ets.insert(
      tables.memberships,
      {entity_id, %{id: id, entity_id: entity_id, group_id: group_id}}
    )
  end

  # The actor's own membership, indexed everywhere the guard reads: the
  # permission table (`grants`), the by-id row lookup
  # (`grants_by_id`) and the by-group enumeration.
  defp put_grant(tables, group_id, permissions, id \\ "gm_1") do
    row = %{id: id, actor_id: "a_1", group_id: group_id, permissions: permissions}
    :ets.insert(tables.grants, {"a_1", row})
    :ets.insert(tables.grants_by_id, {id, row})
    :ets.insert(tables.grants_by_group, {{group_id, id}})
  end

  defp put_grant_by_id(tables, id, actor_id, group_id, permissions) do
    row = %{id: id, actor_id: actor_id, group_id: group_id, permissions: permissions}
    :ets.insert(tables.grants_by_id, {id, row})
    :ets.insert(tables.grants_by_group, {{group_id, id}})
  end

  defp put_membership_by_id(tables, id, entity_id, group_id) do
    :ets.insert(
      tables.memberships_by_id,
      {id, %{id: id, entity_id: entity_id, group_id: group_id}}
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
    [
      validated_create(id, "ebb", id: "#{id}_create"),
      component_update(id, id, "ebb/group", :replace, %{"value" => %{"name" => "Test Group"}})
    ]
  end

  # A platform row carries exactly one atomic component, so its fixture is one
  # Update whose value is the whole object.
  defp grant_put(id, actor_id, group_id, permissions) do
    [
      validated_create(id, "ebb", id: "#{id}_create"),
      component_update(id, id, "ebb/grant", :replace, %{
        "value" => %{
          "actor_id" => actor_id,
          "group_id" => group_id,
          "permissions" => permissions
        }
      })
    ]
  end

  defp grant_patch(id, group_id, permissions, actor_id \\ nil) do
    value = %{"group_id" => group_id, "permissions" => permissions}
    value = if actor_id, do: Map.put(value, "actor_id", actor_id), else: value

    component_update("#{id}_patch", id, "ebb/grant", :replace, %{"value" => value})
  end

  # An atomic grant value is the whole row, so a value that omits
  # `permissions` states an empty permission list.
  defp grant_patch_without_permissions(id, group_id) do
    component_update("#{id}_patch", id, "ebb/grant", :replace, %{
      "value" => %{"group_id" => group_id}
    })
  end

  defp entity_put(id, model) do
    [
      validated_create(id, model, id: "#{id}_create"),
      component_update(id, id, "#{model}/title", :replace, %{"value" => "Test"})
    ]
  end

  defp entity_patch(id, model) do
    component_update("#{id}_patch", id, "#{model}/title", :merge, %{"value" => "Patched"})
  end

  defp entity_delete(id, _model) do
    delete_update("#{id}_delete", id)
  end

  defp membership_put(id, entity_id, group_id) do
    [
      validated_create(id, "ebb", id: "#{id}_create"),
      component_update(id, id, "ebb/membership", :replace, %{
        "value" => %{"entity_id" => entity_id, "group_id" => group_id}
      })
    ]
  end

  defp membership_delete(id), do: delete_update(id, id)

  defp grant_delete(id), do: delete_update(id, id)

  # An edge is a keyed component of its source: `field`, then `type`, then
  # target id, and only the leaf carries presence.
  defp link_update(id, source_id, field, type, target_id) do
    component_update(id, source_id, "ebb/link", :merge, link_patch(field, type, target_id, true))
  end

  # Removing one edge is a merge whose leaf is the tombstone, never a delete:
  # a `delete` names the row and would detach the whole source.
  defp link_remove(id, source_id, field, type, target_id) do
    component_update(id, source_id, "ebb/link", :merge, link_patch(field, type, target_id, nil))
  end

  defp link_patch(field, type, target_id, value) do
    %{
      "map" => %{
        field => %{
          "map" => %{
            type => %{
              "map" => %{target_id => %{"value" => value, "hlc" => generate_hlc()}}
            }
          }
        }
      }
    }
  end

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
    "grant" => "ebb/grant",
    "membership" => "ebb/membership"
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
          grant_put("gm_1", "a_1", "g_1", ["todo.*"]),
          entity_put("todo_1", "todo"),
          membership_put("eg_1", "todo_1", "g_1")
        ])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "authorized user entity write" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_grant(tables, "g_1", ["todo.create", "todo.update"])
      put_membership(tables, "todo_1", "g_1", "eg_1")
      put_entity_model(tables, "todo_1", "todo")

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

      put_grant(tables, "g_1", ["post.create"])
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

      put_grant(tables, "g_1", ["todo.*"])
      put_membership(tables, "todo_1", "g_1", "eg_1")
      put_entity_model(tables, "todo_1", "todo")

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

      put_grant(tables, "g_1", ["todo.update"])
      put_grant(tables, "g_2", ["todo.read"], "gm_2")

      put_membership(tables, "todo_1", "g_1", "eg_1")
      put_membership(tables, "todo_1", "g_2", "eg_2")
      put_entity_model(tables, "todo_1", "todo")

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

      put_grant(tables, "g_1", ["todo.create"])

      action =
        build_action([
          entity_put("todo_new", "todo"),
          membership_put("eg_new", "todo_new", "g_1")
        ])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "system component update authorized when actor holds grant.update" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_grant(tables, "g_1", ["ebb/grant.update"])
      put_grant_by_id(tables, "gm_2", "a_2", "g_1", ["ebb/group.read"])

      action =
        build_action([
          component_updates("gm_2_patch", "gm_2", "grant", :merge, %{
            "group_id" => "g_1",
            "actor_id" => "a_2",
            "permissions" => ["ebb/group.read"]
          })
        ])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "system component update rejected when actor is not group member" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      action =
        build_action([
          component_updates("gm_1_patch", "gm_1", "grant", :merge, %{
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
    test "membership delete resolves the entity, type, and group from the indexes" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_grant(tables, "g_1", ["todo.update"])
      put_membership(tables, "todo_1", "g_1", "eg_1")
      put_membership(tables, "todo_1", "g_2", "eg_2")
      put_membership_by_id(tables, "eg_1", "todo_1", "g_1")
      put_entity_model(tables, "todo_1", "todo")

      action = build_action([membership_delete("eg_1")])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "membership delete rejects an actor outside the target group" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_membership_by_id(tables, "eg_1", "todo_1", "g_1")
      put_membership(tables, "todo_1", "g_1", "eg_1")
      put_entity_model(tables, "todo_1", "todo")

      action = build_action([membership_delete("eg_1")])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    test "grant delete is refused when nothing can model the row" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_grant(tables, "g_1", ["ebb/grant.delete"], "gm_actor")

      action = build_action([grant_delete("gm_ghost")])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "missing_ownership")
    end

    test "grant delete resolves group_id from cache after a put" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      # The actor's own capable row is what authorizes the delete and
      # what keeps the group administered afterwards, so it must be a
      # different row from the one being deleted.
      put_grant(tables, "g_1", ["ebb/grant.delete"], "gm_actor")
      put_grant_by_id(tables, "gm_1", "a_2", "g_1", ["ebb/group.read"])

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
          grant_put("gm_1", "a_1", "g_1", ["ebb/group.read", "todo.*"]),
          entity_put("todo_1", "todo"),
          membership_put("eg_1", "todo_1", "g_1")
        ])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "the actor's declared bootstrap permissions authorize a link edge" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      # An edge's subject is the platform component, so the declared
      # permissions have to cover `ebb/link`; a model grant over the source's
      # data does not.
      action =
        build_action([
          group_put("g_1"),
          grant_put("gm_1", "a_1", "g_1", ["todo.*", "ebb.*"]),
          entity_put("todo_1", "todo"),
          membership_put("eg_1", "todo_1", "g_1"),
          link_update("upd_link", "todo_1", "blocked_by", "todo", "other_1")
        ])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "a model grant over the source's data does not authorize an edge" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      action =
        build_action([
          group_put("g_1"),
          grant_put("gm_1", "a_1", "g_1", ["todo.*"]),
          entity_put("todo_1", "todo"),
          membership_put("eg_1", "todo_1", "g_1"),
          link_update("upd_link", "todo_1", "blocked_by", "todo", "other_1")
        ])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    test "a third-party grant in a bootstrap action is rejected" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      action =
        build_action([
          group_put("g_1"),
          grant_put("gm_1", "a_1", "g_1", ["ebb/group.read"]),
          grant_put("gm_2", "a_2", "g_1", ["*"])
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
          grant_put("gm_1", "a_1", "g_1", ["todo.*"]),
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
      put_entity_model(tables, "todo_other", "todo")

      action =
        build_action([
          group_put("g_1"),
          grant_put("gm_1", "a_1", "g_1", ["ebb/group.read", "todo.create"]),
          membership_put("eg_graft", "todo_other", "g_1")
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
          grant_put("gm_1", "a_1", "g_1", ["ebb/group.read"]),
          grant_put("gm_2", "a_2", "g_1", ["*"]),
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

    test "an actor holding grant.create may add another actor" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_grant(tables, "g_1", ["ebb/grant.create"])

      action = build_action([grant_put("gm_2", "a_2", "g_1", ["*"])])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end
  end

  # #245: a user-entity write that resolves to no group set is a
  # structural rejection, not a permission failure.
  describe "authorize/3 - writes require ownership" do
    test "rejects an unowned put even when the actor could create the type elsewhere" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_grant(tables, "g_1", ["todo.create"])

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
          grant_put("gm_1", "a_1", "g_1", ["todo.*"]),
          entity_put("todo_1", "todo"),
          membership_put("eg_1", "todo_1", "g_1")
        ])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "a same-Action membership edge satisfies ownership" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_grant(tables, "g_1", ["todo.create"])

      action =
        build_action([
          entity_put("todo_new", "todo"),
          membership_put("eg_new", "todo_new", "g_1")
        ])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "cached membership satisfies ownership" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_grant(tables, "g_1", ["todo.update"])
      put_membership(tables, "todo_1", "g_1", "eg_1")
      put_entity_model(tables, "todo_1", "todo")

      action = build_action([entity_patch("todo_1", "todo")])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "rejects an unowned patch and delete" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_grant(tables, "g_1", ["todo.update", "todo.delete"])

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

      put_grant(tables, "g_1", ["todo.*"])
      put_membership(tables, "invoice_1", "g_1", "eg_1")
      put_entity_model(tables, "invoice_1", "invoice")

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

    test "authorizes a genuinely new id under its wire type" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_grant(tables, "g_1", ["todo.create"])

      action =
        build_action([
          entity_put("todo_new", "todo"),
          membership_put("eg_new", "todo_new", "g_1")
        ])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "an id the same Action or request created keeps its own type" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_grant(tables, "g_1", ["todo.*"])

      same_action =
        build_action([
          entity_put("todo_1", "todo"),
          membership_put("eg_1", "todo_1", "g_1"),
          entity_patch("todo_1", "todo")
        ])

      assert_accepted(Authorizer.authorize([same_action], "a_1", ctx))

      # The index has not seen `todo_2` yet, so the later Action's type
      # resolves from the request simulation.
      earlier_action =
        build_action([
          entity_put("todo_2", "todo"),
          membership_put("eg_2", "todo_2", "g_1")
        ])

      # Re-putting the row the earlier Action minted: the pair is already
      # in the simulation, and naming that row keeps it one row.
      later_action = build_action([membership_put("eg_2", "todo_2", "g_1")])

      assert_accepted(Authorizer.authorize([earlier_action, later_action], "a_1", ctx))
    end

    test "rejects a later Action that relabels an id an earlier Action created" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_grant(tables, "g_1", ["todo.*", "invoice.*"])

      created =
        build_action([
          entity_put("x_1", "todo"),
          membership_put("eg_x_1", "x_1", "g_1")
        ])

      relabel =
        build_action([
          entity_put("x_1", "invoice"),
          membership_put("eg_x_1_again", "x_1", "g_1")
        ])

      assert {[accepted], [rejection]} = Authorizer.authorize([created, relabel], "a_1", ctx)
      assert accepted == created
      assert rejection.action == relabel
      assert rejection.reason == "not_authorized"
    end

    test "a later Action still uses the type an earlier Action created" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_grant(tables, "g_1", ["invoice.create", "todo.*"])

      created =
        build_action([
          entity_put("x_1", "todo"),
          membership_put("eg_x_1", "x_1", "g_1")
        ])

      # Filing the entity again resolves its type from the request
      # simulation; a brand-new id still takes its wire type.
      filed = build_action([membership_put("eg_x_1", "x_1", "g_1")])

      fresh =
        build_action([
          entity_put("invoice_1", "invoice"),
          membership_put("eg_3", "invoice_1", "g_1")
        ])

      assert {accepted, []} = Authorizer.authorize([created, filed, fresh], "a_1", ctx)
      assert accepted == [created, filed, fresh]
    end

    test "refuses a write whose type is unresolvable but whose entity owns a group" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_grant(tables, "g_1", ["todo.*"])
      put_membership(tables, "todo_own", "g_1", "eg_own")
      put_entity_model(tables, "todo_own", "todo")

      # The entity-model cache lags the membership cache it is rebuilt from,
      # leaving nothing that can type `invoice_1`, so no wire type can be
      # checked against it.
      put_membership(tables, "invoice_1", "g_1", "eg_invoice")

      assert_rejected(
        Authorizer.authorize([build_action([entity_put("invoice_1", "todo")])], "a_1", ctx),
        "not_authorized"
      )
    end

    test "a lagging model index still authorizes a system row its by-id cache types" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_grant(tables, "g_1", ["ebb/grant.update"])
      put_grant_by_id(tables, "gm_2", "a_2", "g_1", ["*"])

      action = build_action([grant_patch("gm_2", "g_1", ["*"])])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "rejects an membership put naming a committed user entity as its row" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_grant(tables, "g_1", ["todo.create"])
      put_membership(tables, "todo_1", "g_1", "eg_1")
      put_entity_model(tables, "todo_1", "todo")

      # The row is otherwise writable — it owns a group and is typed like any
      # committed entity — so only the type identity stands in the way.
      put_membership(tables, "todo_own", "g_2", "eg_own")
      put_entity_model(tables, "todo_own", "todo")

      action = build_action([membership_put("todo_1", "todo_own", "g_1")])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    # A deleted id keeps its entity-type entry but loses its rows, so only
    # its own type may be committed again; a relabel stays refused (#624).
    test "a tombstoned id may only be re-put under its own type" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_grant(tables, "g_1", ["invoice.*", "todo.*"])
      put_entity_model(tables, "invoice_1", "invoice")

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

      put_grant(tables, "g_1", ["todo.*", "invoice.update"])
      put_membership(tables, "invoice_1", "g_1", "eg_1")
      put_entity_model(tables, "invoice_1", "invoice")

      relabel = build_action([entity_patch("invoice_1", "todo")])
      same_type = build_action([entity_patch("invoice_1", "invoice")])

      assert {[accepted], [rejection]} =
               Authorizer.authorize([relabel, same_type], "a_1", ctx)

      assert rejection.reason == "not_authorized"
      assert accepted == same_type
      assert [{_, "invoice"}] = :ets.lookup(tables.entity_models, "invoice_1")
    end
  end

  # #803: the subject a write names is the component on the wire, and grants
  # match by ancestry — so `note.*` still covers every field of a note, while
  # a field grant covers only itself. Creates and deletes name the model.
  describe "authorize/3 - per-component permissions (#803)" do
    setup do
      tables = create_isolated_tables()
      put_membership(tables, "note_1", "g_1", "eg_1")
      put_entity_model(tables, "note_1", "note")

      %{tables: tables, ctx: auth_context(tables)}
    end

    defp note_update(fields, subject_id \\ "note_1") do
      component_updates("#{subject_id}_upd", subject_id, "note", :merge, fields)
    end

    test "a field grant authorizes its own component", %{tables: tables, ctx: ctx} do
      put_grant(tables, "g_1", ["note/title.*"])

      action = build_action(note_update(%{"title" => "New title"}))

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "a field grant does not authorize a sibling component", %{tables: tables, ctx: ctx} do
      put_grant(tables, "g_1", ["note/title.*"])

      action = build_action(note_update(%{"body" => "New body"}))

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    test "every component named on the wire must be authorized", %{tables: tables, ctx: ctx} do
      put_grant(tables, "g_1", ["note/title.*"])

      action = build_action(note_update(%{"title" => "New title", "body" => "New body"}))

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    test "a drop is authorized against the component it names", %{tables: tables, ctx: ctx} do
      put_grant(tables, "g_1", ["note/title.*"])

      drop = fn id, field ->
        build_action([component_update(id, "note_1", "note/#{field}", :drop, nil)])
      end

      assert_accepted(Authorizer.authorize([drop.("note_1_drop_title", "title")], "a_1", ctx))

      assert_rejected(
        Authorizer.authorize([drop.("note_1_drop_body", "body")], "a_1", ctx),
        "not_authorized"
      )
    end

    test "a create names the model, not the component", %{tables: tables, ctx: ctx} do
      put_grant(tables, "g_1", ["note.create", "note/title.update"])

      action =
        build_action([
          validated_create("note_new", "note", id: "note_new_create"),
          component_updates("note_new", "note_new", "note", :replace, %{"title" => "Test"}),
          membership_put("eg_new", "note_new", "g_1")
        ])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "a component grant does not authorize a row create", %{tables: tables, ctx: ctx} do
      put_grant(tables, "g_1", ["note/title.create", "note/title.update"])

      action =
        build_action([
          validated_create("note_new", "note", id: "note_new_create"),
          component_updates("note_new", "note_new", "note", :replace, %{"title" => "Test"}),
          membership_put("eg_new", "note_new", "g_1")
        ])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    test "a delete names the model, not the component", %{tables: tables, ctx: ctx} do
      put_grant(tables, "g_1", ["note.delete"])

      action = build_action([entity_delete("note_1", "note")])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "a field delete does not authorize a delete", %{tables: tables, ctx: ctx} do
      put_grant(tables, "g_1", ["note/title.delete"])

      action = build_action([entity_delete("note_1", "note")])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    # The server holds no schema, so it cannot know `note/madeup` is not a
    # declared component. The client refuses the write; the server accepts it
    # under the ancestor grant (the accepted residual of #803).
    test "an undeclared component is authorized by the model grant", %{
      tables: tables,
      ctx: ctx
    } do
      put_grant(tables, "g_1", ["note.*"])

      action = build_action(note_update(%{"madeup" => "value"}))

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end
  end

  # An edge is a keyed component of its source (decision 13, #820). The
  # Update's subject *is* the source, so the write is scoped and delivered
  # exactly as that row is, an idempotent re-write is not a re-point, and the
  # permission subject is`ebb/link.<verb>` in the source's group set.
  describe "authorize/3 - an edge is a component of its source (#820)" do
    test "authorizes as ebb/link.update in the source's group set" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_grant(tables, "g_source", ["ebb/link.update"])
      put_membership(tables, "todo_1", "g_source", "eg_1")
      put_entity_model(tables, "todo_1", "todo")

      action = build_action([link_update("upd_link", "todo_1", "blocked_by", "todo", "col_1")])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "a row delete bundled with an edge write still needs the model delete" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_grant(tables, "g_source", ["ebb/link.*"])
      put_membership(tables, "todo_1", "g_source", "eg_1")
      put_entity_model(tables, "todo_1", "todo")

      action =
        build_action([
          delete_update("upd_delete", "todo_1"),
          link_update("upd_link", "todo_1", "blocked_by", "todo", "col_1")
        ])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    test "a grant on the source's model does not authorize the edge" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_grant(tables, "g_source", ["todo.*"])
      put_membership(tables, "todo_1", "g_source", "eg_1")
      put_entity_model(tables, "todo_1", "todo")

      action = build_action([link_update("upd_link", "todo_1", "blocked_by", "todo", "col_1")])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    test "ebb.* covers every edge write" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_grant(tables, "g_source", ["ebb.*"])
      put_membership(tables, "todo_1", "g_source", "eg_1")

      action =
        build_action([
          link_update("upd_link", "todo_1", "blocked_by", "todo", "col_1"),
          link_remove("upd_unlink", "todo_1", "blocked_by", "todo", "col_1")
        ])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "the target's group set is not consulted" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_grant(tables, "g_target", ["ebb/link.update"])
      put_membership(tables, "todo_1", "g_source", "eg_1")
      put_membership(tables, "g_target", "g_target", "eg_target")
      put_entity_model(tables, "todo_1", "todo")

      action = build_action([link_update("upd_link", "todo_1", "blocked_by", "todo", "g_target")])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    test "the wire type label is descriptive and never a permission" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      # The actor holds the edge permission, not any model's: the `type` key
      # names a model the actor cannot write and must not change the subject.
      put_grant(tables, "g_source", ["ebb/link.update"])
      put_membership(tables, "todo_1", "g_source", "eg_1")
      put_entity_model(tables, "todo_1", "todo")

      action = build_action([link_update("upd_link", "todo_1", "blocked_by", "comment", "col_1")])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "an unowned source is a structural rejection, not a permission miss" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_grant(tables, "g_1", ["ebb/link.*"])

      action = build_action([link_update("upd_link", "todo_1", "blocked_by", "todo", "col_1")])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "missing_ownership")
    end

    test "a source the same request created carries its edge" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      action =
        build_action([
          group_put("g_1"),
          grant_put("gm_1", "a_1", "g_1", ["todo.*", "ebb/link.*"]),
          entity_put("todo_1", "todo"),
          membership_put("eg_1", "todo_1", "g_1"),
          link_update("upd_link", "todo_1", "blocked_by", "todo", "other_1")
        ])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    # A create names the row's model, and the model grant covers every user
    # component of the row it creates — but an `ebb/*` overlay is its own
    # subject, so the create's Action needs both.
    # A create names the row's model, and the model grant covers every user
    # component of the row it creates — but an `ebb/*` overlay is its own
    # subject, so the create's Action needs the overlay's verb too.
    test "an edge riding a create needs the overlay's verb as well" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      action =
        build_action([
          group_put("g_1"),
          grant_put("gm_1", "a_1", "g_1", ["todo.*"]),
          entity_put("todo_1", "todo"),
          membership_put("eg_1", "todo_1", "g_1"),
          link_update("upd_link", "todo_1", "blocked_by", "todo", "other_1")
        ])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    # The committed model stays authoritative for a row's own components, but
    # an overlay names no model of the row's: it is added to a row it does not
    # re-model, so it is authorized even when the committed model is
    # unresolvable rather than refused as a relabel would be.
    test "an edge on a row whose committed model is unresolvable is authorized" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_grant(tables, "g_1", ["ebb/link.update"])
      put_membership(tables, "todo_1", "g_1", "eg_1")

      action = build_action([link_update("upd_link", "todo_1", "blocked_by", "todo", "col_1")])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end
  end

  # #121 "Add Entity to Group": a same-Action entity create filed into
  # several groups is authorized per target group, not by the union of
  # the entity's group set.
  describe "authorize/3 - membership put target group" do
    test "requires <type>.create in the target group, not the entity's whole set" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_grant(tables, "g_2", ["todo.create"])

      action =
        build_action([
          entity_put("todo_multi", "todo"),
          membership_put("eg_1", "todo_multi", "g_1"),
          membership_put("eg_2", "todo_multi", "g_2")
        ])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    test "accepts when the actor holds <type>.create in each target group" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_grant(tables, "g_1", ["todo.create"])
      put_grant(tables, "g_2", ["todo.create"], "gm_2")

      action =
        build_action([
          entity_put("todo_multi", "todo"),
          membership_put("eg_1", "todo_multi", "g_1"),
          membership_put("eg_2", "todo_multi", "g_2")
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

      put_grant(tables, "g_2", ["ebb/membership.create"])
      put_membership(tables, "todo_1", "g_1", "eg_1")
      put_entity_model(tables, "todo_1", "todo")

      action = build_action([membership_put("eg_new", "todo_1", "g_2")])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    test "adding an existing entity needs <type>.update where it already lives, not only the target" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      # The graft: `create` in the caller's own group, no permission in
      # the group the entity lives in. Filing it would hand the caller
      # read *and* write over the entity (#623).
      put_grant(tables, "g_2", ["todo.create"])
      put_membership(tables, "todo_1", "g_1", "eg_1")
      put_entity_model(tables, "todo_1", "todo")

      action = build_action([membership_put("eg_new", "todo_1", "g_2")])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    test "adding an existing entity is allowed with <type>.update in a current group and create in the target" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_grant(tables, "g_1", ["todo.update"])
      put_grant(tables, "g_2", ["todo.create"], "gm_2")
      put_membership(tables, "todo_1", "g_1", "eg_1")
      put_entity_model(tables, "todo_1", "todo")

      action = build_action([membership_put("eg_new", "todo_1", "g_2")])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "a multi-group entity is shared by a write permission in any one of its groups" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_grant(tables, "g_2", ["todo.update"])
      put_grant(tables, "g_3", ["todo.create"], "gm_3")
      put_membership(tables, "todo_1", "g_1", "eg_1")
      put_membership(tables, "todo_1", "g_2", "eg_2")
      put_entity_model(tables, "todo_1", "todo")

      action = build_action([membership_put("eg_new", "todo_1", "g_3")])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "a bootstrapped actor cannot self-grant the source side" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_membership(tables, "todo_1", "g_victim", "eg_victim")
      put_entity_model(tables, "todo_1", "todo")

      # One Action mints a group, the caller's membership in it with
      # every permission, and files the victim's entity into it. The
      # declared permissions stand in for the membership this Action
      # creates — never for ownership of an entity that already exists.
      action =
        build_action([
          group_put("g_new"),
          grant_put("gm_new", "a_1", "g_new", ["todo.create", "todo.update"]),
          membership_put("eg_new", "todo_1", "g_new")
        ])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    test "a type an earlier Action of the request created resolves a later membership add" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_grant(tables, "g_1", ["todo.create"])
      put_grant(tables, "g_2", ["todo.create"], "gm_2")

      # Neither `todo_new` nor its type is committed yet: the second
      # Action must resolve the type the first Action introduced.
      actions = [
        build_action([
          entity_put("todo_new", "todo"),
          membership_put("eg_1", "todo_new", "g_1")
        ]),
        build_action([membership_put("eg_2", "todo_new", "g_2")])
      ]

      assert_accepted(Authorizer.authorize(actions, "a_1", ctx))
    end

    test "fails closed when an existing entity's type cannot be resolved" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      # The actor holds the system-entity permission, which used to stand
      # in for the entity's type. It must not.
      put_grant(tables, "g_2", ["ebb/membership.create", "ebb/membership.*", "*"])
      put_membership(tables, "todo_unknown", "g_1", "eg_1")

      action = build_action([membership_put("eg_new", "todo_unknown", "g_2")])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    test "a same-Action create is authorized by <type>.create, not membership.create" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_grant(tables, "g_1", ["ebb/membership.create"])

      action =
        build_action([
          entity_put("todo_new", "todo"),
          membership_put("eg_new", "todo_new", "g_1")
        ])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    test "removing a membership requires <type>.update, not membership.delete" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_grant(tables, "g_1", ["ebb/membership.delete"])
      put_membership(tables, "todo_1", "g_1", "eg_1")
      put_membership(tables, "todo_1", "g_2", "eg_2")
      put_membership_by_id(tables, "eg_1", "todo_1", "g_1")
      put_entity_model(tables, "todo_1", "todo")

      action = build_action([membership_delete("eg_1")])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    test "removing a membership is allowed with <type>.update in any current group" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      # The permission is held in g_2; the removed row is in g_1. Union
      # semantics: the actor may update the entity in any of its groups.
      put_grant(tables, "g_2", ["todo.update"])
      put_membership(tables, "todo_1", "g_1", "eg_1")
      put_membership(tables, "todo_1", "g_2", "eg_2")
      put_membership_by_id(tables, "eg_1", "todo_1", "g_1")
      put_entity_model(tables, "todo_1", "todo")

      action = build_action([membership_delete("eg_1")])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "a bootstrap does not exempt adding an existing entity" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_membership(tables, "todo_existing", "g_other", "eg_other")
      put_entity_model(tables, "todo_existing", "todo")

      action =
        build_action([
          group_put("g_new"),
          grant_put("gm_1", "a_1", "g_new", ["ebb/group.read"]),
          membership_put("eg_graft", "todo_existing", "g_new")
        ])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end
  end

  # #264: an entity must keep at least one owning group. The check is a
  # net delta over the whole request, not per-Action (see the batch case).
  describe "authorize/3 - last membership" do
    setup do
      tables = create_isolated_tables()

      put_grant(tables, "g_1", ["todo.create", "todo.update"])
      put_grant(tables, "g_2", ["todo.create", "todo.update"], "gm_2")

      %{tables: tables, ctx: auth_context(tables)}
    end

    test "deleting the only membership is refused", %{tables: tables, ctx: ctx} do
      put_membership(tables, "todo_1", "g_1", "eg_1")
      put_membership_by_id(tables, "eg_1", "todo_1", "g_1")
      put_entity_model(tables, "todo_1", "todo")

      action = build_action([membership_delete("eg_1")])

      rejection =
        assert_rejected(Authorizer.authorize([action], "a_1", ctx), "last_membership")

      assert is_binary(rejection.details)
    end

    test "deleting one of two memberships is allowed", %{tables: tables, ctx: ctx} do
      put_membership(tables, "todo_1", "g_1", "eg_1")
      put_membership(tables, "todo_1", "g_2", "eg_2")
      put_membership_by_id(tables, "eg_1", "todo_1", "g_1")
      put_entity_model(tables, "todo_1", "todo")

      action = build_action([membership_delete("eg_1")])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "swapping the last membership for a new group in one Action is allowed", %{
      tables: tables,
      ctx: ctx
    } do
      put_membership(tables, "todo_1", "g_1", "eg_1")
      put_membership_by_id(tables, "eg_1", "todo_1", "g_1")
      put_entity_model(tables, "todo_1", "todo")

      action =
        build_action([
          membership_put("eg_new", "todo_1", "g_2"),
          membership_delete("eg_1")
        ])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "a batch of two Actions cannot remove both memberships", %{
      tables: tables,
      ctx: ctx
    } do
      put_membership(tables, "todo_1", "g_1", "eg_1")
      put_membership(tables, "todo_1", "g_2", "eg_2")
      put_membership_by_id(tables, "eg_1", "todo_1", "g_1")
      put_membership_by_id(tables, "eg_2", "todo_1", "g_2")
      put_entity_model(tables, "todo_1", "todo")

      # Each Action is valid against the cache snapshot, but together
      # they net to zero. The running delta must reject the second while
      # the first still commits.
      actions = [
        build_action([membership_delete("eg_1")]),
        build_action([membership_delete("eg_2")])
      ]

      assert {[_accepted], [rejection]} = Authorizer.authorize(actions, "a_1", ctx)
      assert rejection.reason == "last_membership"
    end

    test "re-putting the same group as a new row while deleting the old row is allowed", %{
      tables: tables,
      ctx: ctx
    } do
      put_membership(tables, "todo_1", "g_1", "eg_1")
      put_membership_by_id(tables, "eg_1", "todo_1", "g_1")
      put_entity_model(tables, "todo_1", "todo")

      # Membership is per row: the stale row is replaced by a fresh row
      # for the same group, so the entity still owns `g_1`.
      action =
        build_action([
          membership_put("eg_new", "todo_1", "g_1"),
          membership_delete("eg_1")
        ])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "re-putting the same group then deleting the old row across two Actions is refused", %{
      tables: tables,
      ctx: ctx
    } do
      put_membership(tables, "todo_1", "g_1", "eg_1")
      put_membership_by_id(tables, "eg_1", "todo_1", "g_1")
      put_entity_model(tables, "todo_1", "todo")
      put_grant(tables, "g_1", ["todo.*"])

      # One Action is the unit: the first Action on its own mints a second
      # row for a pair that still has one, so the pair has two rows until
      # the second Action lands.
      actions = [
        build_action([membership_put("eg_new", "todo_1", "g_1")]),
        build_action([membership_delete("eg_1")])
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
      action = build_action([membership_delete("eg_unknown")])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "missing_ownership")
    end
  end

  # #479: a group must keep at least one membership holding a non-empty
  # permission list, because permissions live only on `grant` rows
  # and an empty list grants nothing. The check is a net delta over the
  # whole request, like `last_membership`.
  describe "authorize/3 - last group member" do
    setup do
      tables = create_isolated_tables()
      %{tables: tables, ctx: auth_context(tables)}
    end

    test "deleting a group's only capable membership is refused", %{tables: tables, ctx: ctx} do
      put_grant(tables, "g_1", ["ebb/grant.delete"], "gm_actor")

      action = build_action([grant_delete("gm_actor")])

      rejection =
        assert_rejected(Authorizer.authorize([action], "a_1", ctx), "last_grant")

      assert is_binary(rejection.details)
    end

    test "a member with an empty permission list does not keep the group alive", %{
      tables: tables,
      ctx: ctx
    } do
      put_grant(tables, "g_1", ["ebb/grant.delete"], "gm_actor")
      put_grant_by_id(tables, "gm_1", "a_2", "g_1", [])

      action = build_action([grant_delete("gm_actor")])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "last_grant")
    end

    test "deleting one of two capable memberships is allowed", %{tables: tables, ctx: ctx} do
      put_grant(tables, "g_1", ["ebb/grant.delete"], "gm_actor")
      put_grant_by_id(tables, "gm_1", "a_2", "g_1", ["ebb/group.read"])

      action = build_action([grant_delete("gm_1")])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "a batch of two Actions that each drop one capable membership is refused", %{
      tables: tables,
      ctx: ctx
    } do
      put_grant(tables, "g_1", ["ebb/grant.delete"], "gm_actor")
      put_grant_by_id(tables, "gm_1", "a_2", "g_1", ["ebb/group.read"])

      # Each Action is valid against the cache snapshot, but together
      # they net to zero. The running delta must catch the second.
      actions = [
        build_action([grant_delete("gm_1")]),
        build_action([grant_delete("gm_actor")])
      ]

      # The first Action is accepted against the snapshot, the second is
      # rejected: the running delta catches the pair netting to zero.
      assert {_accepted, [rejection]} = Authorizer.authorize(actions, "a_1", ctx)
      assert rejection.reason == "last_grant"
    end

    test "patching the only capable permission list to empty is refused", %{
      tables: tables,
      ctx: ctx
    } do
      put_grant(tables, "g_1", ["ebb/grant.update"], "gm_actor")

      action = build_action([grant_patch("gm_actor", "g_1", [])])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "last_grant")
    end

    test "patching one of two capable permission lists to empty is allowed", %{
      tables: tables,
      ctx: ctx
    } do
      put_grant(tables, "g_1", ["ebb/grant.update"], "gm_actor")
      put_grant_by_id(tables, "gm_1", "a_2", "g_1", ["ebb/group.read"])

      action = build_action([grant_patch("gm_1", "g_1", [])])

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
      put_grant(tables, "g_1", ["ebb/grant.update"], "gm_actor")

      action = build_action([grant_patch_without_permissions("gm_actor", "g_1")])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "last_grant")
    end

    test "a patch to a row the same Action put resolves against the request", %{ctx: ctx} do
      # The group, the capable row and the patch to it all ride one Action,
      # so the row exists only in the request's own delta. Reading the empty
      # cache instead would drop the permissions the put declared and refuse
      # the Action as a lockout.
      action =
        build_action([
          group_put("g_new"),
          grant_put("gm_own", "a_1", "g_new", ["ebb/grant.update"]),
          grant_patch("gm_own", "g_new", ["ebb/grant.update"], "a_1")
        ])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "deleting the same membership row twice in one Action counts once", %{
      tables: tables,
      ctx: ctx
    } do
      put_grant(tables, "g_1", ["ebb/grant.delete"], "gm_actor")
      put_grant_by_id(tables, "gm_1", "a_2", "g_1", ["ebb/group.read"])

      # The retried delete names a row the request has already removed, so
      # the delta has nothing left to subtract and must not read the row as
      # still present.
      action =
        build_action([
          grant_delete("gm_1"),
          %{grant_delete("gm_1") | id: "upd_gm_1_retry"}
        ])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "a by-group entry whose row is no longer cached is not counted", %{
      tables: tables,
      ctx: ctx
    } do
      put_grant(tables, "g_1", ["ebb/grant.update"], "gm_actor")
      put_grant_by_id(tables, "gm_1", "a_2", "g_1", ["ebb/group.read"])

      # The by-group index can lag the by-id cache; an id it still lists but
      # nothing resolves must be skipped rather than counted or crash.
      :ets.insert(tables.grants_by_group, {{"g_1", "gm_ghost"}})

      action = build_action([grant_patch("gm_1", "g_1", ["ebb/group.read"])])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "transferring the last membership within one Action is allowed", %{
      tables: tables,
      ctx: ctx
    } do
      put_grant(
        tables,
        "g_1",
        ["ebb/grant.delete", "ebb/grant.create"],
        "gm_actor"
      )

      action =
        build_action([
          grant_delete("gm_actor"),
          grant_put("gm_new", "a_2", "g_1", ["ebb/group.read"])
        ])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "a write that empties the permission list is a lockout", %{tables: tables, ctx: ctx} do
      put_grant(tables, "g_1", ["ebb/grant.*"], "gm_actor")

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
        "last_grant"
      )
    end

    test "moving a membership between groups is refused even when both groups authorize", %{
      tables: tables,
      ctx: ctx
    } do
      # Decision 13: a grant's `group_id` is its identity, so moving an actor
      # between groups is a delete plus a create, never a re-point. Holding
      # the permission on both sides is not enough.
      put_grant(tables, "g_2", ["ebb/grant.update"], "gm_actor")
      put_grant(tables, "g_1", ["ebb/grant.update"], "gm_actor_1")
      put_grant_by_id(tables, "gm_1", "a_2", "g_1", ["ebb/group.read"])

      action = build_action([grant_patch("gm_1", "g_2", ["ebb/group.read"])])

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
      put_grant(tables, "g_2", ["ebb/grant.update"], "gm_actor")
      put_grant_by_id(tables, "gm_1", "a_2", "g_1", ["ebb/group.read"])

      action = build_action([grant_patch("gm_1", "g_2", ["ebb/group.read"])])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    test "moving the last capable membership is refused even when both groups authorize", %{
      tables: tables,
      ctx: ctx
    } do
      # An atomic grant's group is immutable, so the move is refused as a
      # re-point before the last-member guard can even see it.
      put_grant(tables, "g_1", ["ebb/grant.update"], "gm_actor")
      put_grant(tables, "g_2", ["ebb/grant.update"], "gm_actor_2")

      action = build_action([grant_patch("gm_actor", "g_2", ["ebb/grant.update"])])

      rejection =
        assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")

      assert rejection.details == "an ebb/grant row cannot be re-pointed at another group"
    end
  end

  # #625: a `grant` mutation is bound to the group its row already
  # belongs to. Authorizing against the group on the wire lets an actor
  # with a self-granted `grant.*` in their own group re-key a row
  # that lives in somebody else's.
  describe "authorize/3 - grant rows are bound to their group" do
    setup do
      tables = create_isolated_tables()

      # The victim's row in `g_victim`; the actor holds permission only in
      # the group they bootstrapped. `gm_victim_2` keeps the group capable
      # so the last-member guard is not what refuses the move.
      put_grant_by_id(tables, "gm_victim", "a_victim", "g_victim", ["ebb/group.read"])
      put_grant_by_id(tables, "gm_victim_2", "a_victim_2", "g_victim", ["ebb/group.read"])
      put_grant(tables, "g_attacker", ["ebb/grant.*"])

      %{tables: tables, ctx: auth_context(tables)}
    end

    test "re-putting an existing row with permission only in the destination group is refused", %{
      ctx: ctx
    } do
      action =
        build_action([
          grant_put("gm_victim", "a_1", "g_attacker", ["ebb/group.read"])
        ])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    test "patching an existing row with permission only in the destination group is refused", %{
      ctx: ctx
    } do
      action = build_action([grant_patch("gm_victim", "g_attacker", ["ebb/group.read"])])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    # The model index retains tombstones, so an id it knows but the by-id
    # cache no longer places is not a fresh row: re-filing it would let a
    # deleted membership id be reused as a bootstrap.
    test "a row id known only to the model index is refused, not re-filed" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_grant(tables, "g_1", ["ebb/grant.*"])
      put_entity_model(tables, "gm_tombstone", "grant")

      action = build_action([grant_put("gm_tombstone", "a_1", "g_1", ["todo.read"])])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    test "a bootstrap that re-puts an existing row id is refused", %{ctx: ctx} do
      action =
        build_action([
          group_put("g_new"),
          grant_put("gm_own", "a_1", "g_new", ["ebb/grant.*"]),
          grant_put("gm_victim", "a_1", "g_new", ["ebb/group.read"])
        ])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end
  end

  describe "authorize/3 - grant changes authorized in the row's group" do
    setup do
      tables = create_isolated_tables()

      put_grant_by_id(tables, "gm_1", "a_2", "g_1", ["ebb/group.read"])
      put_grant(tables, "g_1", ["ebb/grant.*"], "gm_actor")

      %{tables: tables, ctx: auth_context(tables)}
    end

    test "re-putting a row inside its own group is allowed", %{ctx: ctx} do
      action =
        build_action([grant_put("gm_1", "a_2", "g_1", ["ebb/group.read", "todo.*"])])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "patching a row inside its own group is allowed", %{ctx: ctx} do
      action = build_action([grant_patch("gm_1", "g_1", ["ebb/group.read"])])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "moving a row between groups is refused rather than authorized", %{
      tables: tables,
      ctx: ctx
    } do
      # Decision 13 makes `group_id` the row's identity: a move is a delete
      # plus a create, so no permission set authorizes a re-point in place.
      put_grant(tables, "g_2", ["ebb/grant.update"], "gm_actor_2")

      action = build_action([grant_patch("gm_1", "g_2", ["ebb/group.read"])])

      rejection =
        assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")

      assert rejection.details == "an ebb/grant row cannot be re-pointed at another group"
    end
  end

  # #623: an `membership` write is authorized against the entity and group
  # it names, never against the caller's own group alone. A membership row
  # for an id nothing models cannot be filed, whatever permission the caller
  # holds.
  describe "authorize/3 - membership writes are bound to the entity" do
    setup do
      tables = create_isolated_tables()

      put_grant(tables, "g_atk", ["ebb/membership.*"])

      %{tables: tables, ctx: auth_context(tables)}
    end

    test "is rejected even when the actor holds membership.update in the target group", %{
      ctx: ctx
    } do
      update =
        component_updates("eg_fresh_patch", "eg_fresh", "membership", :merge, %{
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

    test "a bootstrap membership put cannot re-point an existing membership row" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_membership_by_id(tables, "eg_victim", "todo_victim", "g_victim")

      action =
        build_action([
          group_put("g_new"),
          grant_put("gm_own", "a_1", "g_new", ["ebb/membership.*", "todo.create"]),
          entity_put("todo_new", "todo"),
          membership_put("eg_victim", "todo_new", "g_new")
        ])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    # Two deletes can share an update id. Resolving deletes by that id
    # collapses them, authorizing one against the other's entity and hiding
    # the removal from the last-membership guard (#623).
    test "duplicate update ids do not borrow another delete's authorization" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_grant(tables, "g_atk", ["todo.update"])
      put_entity_model(tables, "todo_attacker", "todo")
      put_membership(tables, "todo_attacker", "g_atk", "eg_attacker")
      put_membership_by_id(tables, "eg_attacker", "todo_attacker", "g_atk")
      put_entity_model(tables, "todo_victim", "todo")
      put_membership(tables, "todo_victim", "g_victim", "eg_victim")
      put_membership_by_id(tables, "eg_victim", "todo_victim", "g_victim")

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
      put_grant(tables, "g_atk", ["todo.create"])
      put_entity_model(tables, "todo_attacker", "todo")
      put_membership(tables, "todo_attacker", "g_atk", "eg_attacker")

      action = build_action([membership_put("eg_new", "todo_attacker", ["g_atk"])])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    test "a put cannot re-point another entity's membership row", %{tables: tables, ctx: ctx} do
      put_grant(tables, "g_atk", ["todo.create"], "gm_atk")
      put_entity_model(tables, "todo_attacker", "todo")
      put_membership(tables, "todo_attacker", "g_atk", "eg_attacker")
      put_membership_by_id(tables, "eg_victim", "todo_victim", "g_victim")

      action = build_action([membership_put("eg_victim", "todo_attacker", "g_atk")])

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
      put_grant(tables, "g_atk", ["todo.create", "todo.update"], "gm_atk")
      put_entity_model(tables, "todo_attacker", "todo")
      put_membership(tables, "todo_attacker", "g_atk", "eg_attacker")
      put_membership_by_id(tables, "eg_attacker", "todo_attacker", "g_atk")
      put_entity_model(tables, "todo_victim", "todo")
      put_membership(tables, "todo_victim", "g_victim", "eg_victim")
      put_membership_by_id(tables, "eg_victim", "todo_victim", "g_victim")

      re_point =
        component_updates("eg_victim_merge", "eg_victim", "membership", :merge, %{
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
      put_grant(tables, "g_victim", ["todo.create"], "gm_victim")

      keep =
        component_updates("eg_victim_merge_2", "eg_victim", "membership", :merge, %{
          "entity_id" => "todo_victim",
          "group_id" => "g_victim"
        })

      assert_accepted(Authorizer.authorize([build_action([keep])], "a_1", ctx))
    end

    test "a put cannot move a membership row to another group", %{tables: tables, ctx: ctx} do
      # `(entity_id, group_id)` is the membership row's identity (decision
      # 13): a move is a delete plus a create.
      put_grant(tables, "g_2", ["todo.create"], "gm_2")
      put_grant(tables, "g_1", ["todo.update"], "gm_g1")
      put_entity_model(tables, "todo_1", "todo")
      put_membership(tables, "todo_1", "g_1", "eg_old")
      put_membership_by_id(tables, "eg_old", "todo_1", "g_1")

      action = build_action([membership_put("eg_old", "todo_1", "g_2")])

      rejection =
        assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")

      assert rejection.details ==
               "an ebb/membership row cannot be re-pointed at another entity or group"
    end

    test "a put cannot claim an entity the index knows but no group owns" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_grant(tables, "g_atk", ["todo.create"])
      put_entity_model(tables, "todo_orphan", "todo")

      action = build_action([membership_put("eg_new", "todo_orphan", "g_atk")])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    test "put is refused with <type>.create in the target group alone",
         %{
           tables: tables,
           ctx: ctx
         } do
      put_grant(tables, "g_2", ["todo.create"], "gm_2")
      put_entity_model(tables, "todo_1", "todo")
      put_membership(tables, "todo_1", "g_1", "eg_1")

      action = build_action([membership_put("eg_new", "todo_1", "g_2")])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    test "put is authorized by <type>.update where the entity lives plus create in the target",
         %{
           tables: tables,
           ctx: ctx
         } do
      put_grant(tables, "g_1", ["todo.update"], "gm_g1")
      put_grant(tables, "g_2", ["todo.create"], "gm_2")
      put_entity_model(tables, "todo_1", "todo")
      put_membership(tables, "todo_1", "g_1", "eg_1")

      action = build_action([membership_put("eg_new", "todo_1", "g_2")])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    # Two devices sharing one entity into one group must converge on one
    # row: a second row survives the unshare that deletes the first, so
    # the owner's revocation silently fails (#623).
    test "a put cannot mint a second row for a live (entity, group) pair", %{
      tables: tables,
      ctx: ctx
    } do
      put_grant(tables, "g_1", ["todo.update"], "gm_g1")
      put_grant(tables, "g_2", ["todo.create"], "gm_2")
      put_entity_model(tables, "todo_1", "todo")
      put_membership(tables, "todo_1", "g_1", "eg_1")
      put_membership(tables, "todo_1", "g_2", "eg_old")

      action = build_action([membership_put("eg_new", "todo_1", "g_2")])

      rejection =
        assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")

      assert rejection.details =~ "already filed"
    end

    test "re-putting the pair's live row is idempotent", %{
      tables: tables,
      ctx: ctx
    } do
      put_grant(tables, "g_1", ["todo.update"], "gm_g1")
      put_grant(tables, "g_2", ["todo.create"], "gm_2")
      put_entity_model(tables, "todo_1", "todo")
      put_membership(tables, "todo_1", "g_1", "eg_1")
      put_membership(tables, "todo_1", "g_2", "eg_old")

      action = build_action([membership_put("eg_old", "todo_1", "g_2")])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "a second row for a pair the same Action creates is refused", %{
      tables: tables,
      ctx: ctx
    } do
      put_grant(tables, "g_2", ["todo.create"], "gm_2")

      # A bootstrap can file one entity into one group once; the caches
      # cannot catch the second put, so the check reads the Action.
      action =
        build_action([
          entity_put("todo_new", "todo"),
          membership_put("eg_a", "todo_new", "g_2"),
          membership_put("eg_b", "todo_new", "g_2")
        ])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    test "delete is still authorized by the entity's <type>.update in a current group", %{
      tables: tables,
      ctx: ctx
    } do
      put_grant(tables, "g_2", ["todo.update"], "gm_2")
      put_entity_model(tables, "todo_1", "todo")
      put_membership(tables, "todo_1", "g_1", "eg_1")
      put_membership(tables, "todo_1", "g_2", "eg_2")
      put_membership_by_id(tables, "eg_1", "todo_1", "g_1")

      action = build_action([membership_delete("eg_1")])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end
  end

  # #289: the bootstrap self-grant is gated on the entity actually being
  # created — a group id the entity-model cache already knows, or an entity
  # the Action does not create, falls through to the permission table.
  # Existing-id puts are authorized against the table, not rejected with a
  # new reason.
  describe "authorize/3 - bootstrap existence" do
    test "a bootstrap may not re-put an existing group id and self-grant" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      # The group was committed earlier, so the model index knows it.
      put_entity_model(tables, "g_existing", "group")

      action =
        build_action([
          group_put("g_existing"),
          grant_put("gm_1", "a_1", "g_existing", ["*"])
        ])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    test "a bootstrap may not file an existing entity even when it self-grants the type" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_entity_model(tables, "todo_existing", "todo")
      put_membership(tables, "todo_existing", "g_other", "eg_other")

      # The declared `todo.create` is the self-grant: the existing entity
      # may not borrow it for the `membership` put.
      action =
        build_action([
          group_put("g_1"),
          grant_put("gm_1", "a_1", "g_1", ["todo.create", "ebb/group.read"]),
          entity_put("todo_existing", "todo"),
          membership_put("eg_graft", "todo_existing", "g_1")
        ])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    test "a genuine new-group self-bootstrap still succeeds" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      action =
        build_action([
          group_put("g_new"),
          grant_put("gm_1", "a_1", "g_new", ["ebb/group.read", "todo.*"]),
          entity_put("todo_new", "todo"),
          membership_put("eg_new", "todo_new", "g_new")
        ])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end

    test "an existing group re-put by a member holding ebb/group.create still succeeds" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      # A platform row commits under `ebb`, the model its create names.
      put_entity_model(tables, "g_1", "ebb")
      put_grant(tables, "g_1", ["ebb/group.create", "ebb/group.update"])

      # A committed group's re-create is an ordinary write against the
      # permission table: the bootstrap exemption covers only a group the
      # existence index does not already know.
      assert_accepted(Authorizer.authorize([build_action(group_put("g_1"))], "a_1", ctx))
    end

    test "an existing group's create is not bootstrap-exempt" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_entity_model(tables, "g_1", "ebb")
      put_grant(tables, "g_1", ["ebb/group.update"])

      assert_rejected(
        Authorizer.authorize([build_action(group_put("g_1"))], "a_1", ctx),
        "not_authorized"
      )
    end

    test "filing an existing entity into a group the actor really belongs to still works" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_entity_model(tables, "todo_1", "todo")
      put_grant(tables, "g_2", ["todo.create"])
      put_grant(tables, "g_1", ["todo.update"], "gm_g1")
      put_membership(tables, "todo_1", "g_1", "eg_1")

      action = build_action([membership_put("eg_new", "todo_1", "g_2")])

      assert_accepted(Authorizer.authorize([action], "a_1", ctx))
    end
  end

  # #246: an actor with only `group.read` in a group must not mutate the
  # group's system-entity rows.
  describe "authorize/3 - group.read-only member" do
    setup do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_grant(tables, "g_1", ["ebb/group.read"])
      put_membership(tables, "todo_1", "g_1", "eg_1")

      %{tables: tables, ctx: ctx}
    end

    test "cannot create a grant", %{ctx: ctx} do
      action = build_action([grant_put("gm_2", "a_2", "g_1", ["*"])])
      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    test "cannot update a grant", %{ctx: ctx} do
      update =
        component_updates("upd_gm_patch", "gm_2", "grant", :merge, %{
          "group_id" => "g_1",
          "actor_id" => "a_2",
          "permissions" => ["*"]
        })

      assert_rejected(
        Authorizer.authorize([build_action([update])], "a_1", ctx),
        "not_authorized"
      )
    end

    test "cannot delete a grant", %{tables: tables, ctx: ctx} do
      put_grant_by_id(tables, "gm_2", "a_2", "g_1", ["*"])

      update = delete_update("upd_gm", "gm_2")

      assert_rejected(
        Authorizer.authorize([build_action([update])], "a_1", ctx),
        "not_authorized"
      )
    end

    test "cannot add an edge", %{ctx: ctx} do
      action = build_action([link_update("upd_link", "todo_1", "blocked_by", "todo", "col_1")])
      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    test "cannot remove an edge", %{ctx: ctx} do
      action = build_action([link_remove("upd_link", "todo_1", "blocked_by", "todo", "col_1")])

      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    test "cannot create an membership for an existing entity", %{tables: tables, ctx: ctx} do
      put_membership(tables, "todo_existing", "g_1", "eg_existing")

      action = build_action([membership_put("eg_new", "todo_existing", "g_1")])
      assert_rejected(Authorizer.authorize([action], "a_1", ctx), "not_authorized")
    end

    test "cannot update an membership", %{tables: tables, ctx: ctx} do
      put_membership_by_id(tables, "eg_1", "todo_1", "g_1")

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

    test "cannot delete an membership", %{tables: tables, ctx: ctx} do
      put_membership_by_id(tables, "eg_1", "todo_1", "g_1")

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

      put_grant(tables, "g_1", ["todo.update"])
      put_membership(tables, "todo_ok", "g_1", "eg_ok")
      put_membership(tables, "todo_bad", "g_2", "eg_bad")
      put_entity_model(tables, "todo_ok", "todo")
      put_entity_model(tables, "todo_bad", "todo")

      bad = build_action([entity_patch("todo_bad", "todo")]) |> Map.put(:id, "act_bad")
      ok = build_action([entity_patch("todo_ok", "todo")]) |> Map.put(:id, "act_ok")

      assert {[accepted], [rejection]} = Authorizer.authorize([bad, ok], "a_1", ctx)
      assert accepted.id == "act_ok"
      assert rejection.action.id == "act_bad"
      assert rejection.reason == "not_authorized"
    end

    test "a rejected Action's created type is not visible to a later Action" do
      tables = create_isolated_tables()
      ctx = auth_context(tables)

      put_grant(tables, "g_1", ["todo.read"])

      # The first Action creates `todo_new` but the actor cannot create
      # the type, so the Action is rejected and must not seed the request
      # simulation with `todo_new`'s type.
      create =
        build_action([
          entity_put("todo_new", "todo"),
          membership_put("eg_1", "todo_new", "g_1")
        ])
        |> Map.put(:id, "act_create")

      add = build_action([membership_put("eg_2", "todo_new", "g_1")])

      assert {[], [create_rejection, add_rejection]} =
               Authorizer.authorize([create, add], "a_1", ctx)

      assert create_rejection.reason == "not_authorized"
      assert add_rejection.reason == "not_authorized"
      assert add_rejection.details =~ "cannot resolve the model"
    end
  end
end
