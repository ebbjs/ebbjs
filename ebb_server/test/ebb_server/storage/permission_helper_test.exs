defmodule EbbServer.Storage.PermissionHelperTest do
  use ExUnit.Case, async: true

  alias EbbServer.Storage.PermissionHelper

  import EbbServer.TestHelpers, only: [validated_component: 3, validated_component: 4]

  describe "method_to_permission/1" do
    test "put maps to create" do
      assert PermissionHelper.method_to_permission(:put) == "create"
    end

    test "patch maps to update" do
      assert PermissionHelper.method_to_permission(:patch) == "update"
    end

    test "delete maps to delete" do
      assert PermissionHelper.method_to_permission(:delete) == "delete"
    end
  end

  describe "check_permission/3" do
    test "exact match returns true" do
      assert PermissionHelper.check_permission(["todo.create"], "todo", "create") == true
    end

    test "exact mismatch returns false" do
      assert PermissionHelper.check_permission(["todo.create"], "todo", "delete") == false
    end

    test "wildcard match returns true" do
      assert PermissionHelper.check_permission(["todo.*"], "todo", "create") == true
      assert PermissionHelper.check_permission(["todo.*"], "todo", "delete") == true
      assert PermissionHelper.check_permission(["todo.*"], "todo", "read") == true
    end

    test "empty permissions returns false" do
      assert PermissionHelper.check_permission([], "todo", "create") == false
    end

    test "multiple permissions checks any match" do
      perms = ["ebb/group.read", "ebb/group.write", "todo.*"]
      assert PermissionHelper.check_permission(perms, "todo", "delete") == true
      assert PermissionHelper.check_permission(perms, "ebb/group", "read") == true
      assert PermissionHelper.check_permission(perms, "post", "create") == false
    end
  end

  describe "bootstrap_group_permissions/3" do
    test "maps the groups the actor creates and joins to their declared permissions" do
      mutations = [
        group_put("g_1"),
        group_member_put("gm_1", "a_1", "g_1", ["ebb/group.read", "todo.*"]),
        entity_group_put("eg_1", "todo_1", "g_1")
      ]

      assert PermissionHelper.bootstrap_group_permissions(mutations, "a_1", fn _ -> false end) ==
               %{"g_1" => ["ebb/group.read", "todo.*"]}
    end

    test "ignores a groupMember for a different actor" do
      mutations = [
        group_put("g_1"),
        group_member_put("gm_1", "a_2", "g_1", ["*"])
      ]

      assert PermissionHelper.bootstrap_group_permissions(mutations, "a_1", fn _ -> false end) ==
               %{}
    end

    test "ignores a groupMember in a group the action does not create" do
      mutations = [group_member_put("gm_1", "a_1", "g_1", ["*"])]

      assert PermissionHelper.bootstrap_group_permissions(mutations, "a_1", fn _ -> false end) ==
               %{}
    end

    test "empty mutations returns an empty map" do
      assert PermissionHelper.bootstrap_group_permissions([], "a_1", fn _ -> false end) == %{}
    end

    test "drops a group the existence predicate reports as existing" do
      mutations = [
        group_put("g_1"),
        group_member_put("gm_1", "a_1", "g_1", ["ebb/group.read", "todo.*"])
      ]

      assert PermissionHelper.bootstrap_group_permissions(mutations, "a_1", &(&1 == "g_1")) ==
               %{}
    end

    test "keeps a new group while dropping an existing one" do
      mutations = [
        group_put("g_old"),
        group_put("g_new"),
        group_member_put("gm_old", "a_1", "g_old", ["ebb/group.read"]),
        group_member_put("gm_new", "a_1", "g_new", ["todo.*"])
      ]

      result = PermissionHelper.bootstrap_group_permissions(mutations, "a_1", &(&1 == "g_old"))

      assert result == %{"g_new" => ["todo.*"]}
    end
  end

  describe "created_subject_ids/2" do
    test "collects user entity puts only" do
      mutations = [
        entity_put("todo_1", "todo"),
        entity_put("post_1", "post"),
        group_put("g_1"),
        group_member_put("gm_1", "a_1", "g_1", ["*"]),
        entity_group_put("eg_1", "todo_1", "g_1")
      ]

      assert PermissionHelper.created_subject_ids(mutations, fn _ -> false end) ==
               MapSet.new(["todo_1", "post_1"])
    end

    test "ignores patches and deletes" do
      mutations = [
        mutation("todo_1", "todo", :patch, %{"title" => "Test"}),
        delete_mutation("todo_2", "todo")
      ]

      assert PermissionHelper.created_subject_ids(mutations, fn _ -> false end) ==
               MapSet.new()
    end

    test "drops an id the existence predicate reports as existing" do
      mutations = [
        entity_put("todo_new", "todo"),
        entity_put("todo_old", "todo")
      ]

      assert PermissionHelper.created_subject_ids(mutations, &(&1 == "todo_old")) ==
               MapSet.new(["todo_new"])
    end
  end

  describe "created_models/1" do
    test "maps created user entity ids to their model" do
      mutations = [
        entity_put("todo_1", "todo"),
        entity_put("post_1", "post"),
        group_put("g_1")
      ]

      assert PermissionHelper.created_models(mutations) == %{
               "todo_1" => "todo",
               "post_1" => "post"
             }
    end
  end

  describe "bootstrap_membership_row_ids/3" do
    test "collects the actor's own membership rows in the groups the action creates" do
      mutations = [
        group_put("g_1"),
        group_member_put("gm_1", "a_1", "g_1", ["ebb/group.read"]),
        group_member_put("gm_2", "a_2", "g_1", ["ebb/group.read"])
      ]

      assert PermissionHelper.bootstrap_membership_row_ids(mutations, "a_1", fn _ -> false end) ==
               MapSet.new(["gm_1"])
    end

    test "drops a row id the existence predicate reports as existing" do
      mutations = [
        group_put("g_1"),
        group_member_put("gm_new", "a_1", "g_1", ["ebb/group.read"]),
        group_member_put("gm_old", "a_1", "g_1", ["ebb/group.read"])
      ]

      assert PermissionHelper.bootstrap_membership_row_ids(mutations, "a_1", &(&1 == "gm_old")) ==
               MapSet.new(["gm_new"])
    end

    test "ignores a membership row in a group the action does not create" do
      mutations = [group_member_put("gm_1", "a_1", "g_1", ["ebb/group.read"])]

      assert PermissionHelper.bootstrap_membership_row_ids(mutations, "a_1", fn _ -> false end) ==
               MapSet.new()
    end
  end

  describe "bootstrap_update?/5" do
    setup do
      bootstrap = %{"g_1" => ["ebb/group.read", "todo.*"]}
      created = MapSet.new(["todo_1"])
      membership_rows = MapSet.new(["gm_1"])

      %{bootstrap: bootstrap, created: created, membership_rows: membership_rows}
    end

    test "exempts the group put", %{
      bootstrap: bootstrap,
      created: created,
      membership_rows: membership_rows
    } do
      row = group_put("g_1")

      assert PermissionHelper.bootstrap_update?(
               row,
               "a_1",
               bootstrap,
               created,
               membership_rows
             ) == true
    end

    test "exempts the acting actor's own groupMember put", %{
      bootstrap: bootstrap,
      created: created,
      membership_rows: membership_rows
    } do
      row = group_member_put("gm_1", "a_1", "g_1", ["ebb/group.read"])

      assert PermissionHelper.bootstrap_update?(
               row,
               "a_1",
               bootstrap,
               created,
               membership_rows
             ) == true
    end

    test "does not exempt a row the action is not creating", %{
      bootstrap: bootstrap,
      created: created,
      membership_rows: membership_rows
    } do
      row = group_member_put("gm_existing", "a_1", "g_1", ["ebb/group.read"])

      assert PermissionHelper.bootstrap_update?(
               row,
               "a_1",
               bootstrap,
               created,
               membership_rows
             ) == false
    end

    test "does not exempt a third party's groupMember put", %{
      bootstrap: bootstrap,
      created: created,
      membership_rows: membership_rows
    } do
      row = group_member_put("gm_2", "a_2", "g_1", ["*"])

      assert PermissionHelper.bootstrap_update?(
               row,
               "a_1",
               bootstrap,
               created,
               membership_rows
             ) == false
    end

    test "exempts an entityGroup put for an entity the action creates", %{
      bootstrap: bootstrap,
      created: created,
      membership_rows: membership_rows
    } do
      row = entity_group_put("eg_1", "todo_1", "g_1")

      assert PermissionHelper.bootstrap_update?(
               row,
               "a_1",
               bootstrap,
               created,
               membership_rows
             ) == true
    end

    test "does not exempt an entityGroup put for an entity the action does not create", %{
      bootstrap: bootstrap,
      created: created,
      membership_rows: membership_rows
    } do
      row = entity_group_put("eg_1", "todo_other", "g_1")

      assert PermissionHelper.bootstrap_update?(
               row,
               "a_1",
               bootstrap,
               created,
               membership_rows
             ) == false
    end

    test "does not exempt an entityGroup put in a different group", %{
      bootstrap: bootstrap,
      created: created,
      membership_rows: membership_rows
    } do
      row = entity_group_put("eg_1", "todo_1", "g_other")

      assert PermissionHelper.bootstrap_update?(
               row,
               "a_1",
               bootstrap,
               created,
               membership_rows
             ) == false
    end

    test "does not exempt a relationship put", %{
      bootstrap: bootstrap,
      created: created,
      membership_rows: membership_rows
    } do
      row =
        mutation("rel_1", "relationship", :put, %{"source_id" => "todo_1"})

      assert PermissionHelper.bootstrap_update?(
               row,
               "a_1",
               bootstrap,
               created,
               membership_rows
             ) == false
    end

    test "does not exempt a group patch", %{
      bootstrap: bootstrap,
      created: created,
      membership_rows: membership_rows
    } do
      row = mutation("g_1", "group", :patch, %{"name" => "Renamed"})

      assert PermissionHelper.bootstrap_update?(
               row,
               "a_1",
               bootstrap,
               created,
               membership_rows
             ) == false
    end
  end

  describe "build_intra_action_context/1" do
    test "extracts entityGroup puts into an entity => groups map" do
      mutations = [
        entity_group_put("eg_1", "todo_1", "g_1"),
        entity_group_put("eg_2", "post_1", "g_2")
      ]

      ctx = PermissionHelper.build_intra_action_context(mutations)

      assert ctx == %{"todo_1" => ["g_1"], "post_1" => ["g_2"]}
    end

    test "collects several memberships for the same entity" do
      mutations = [
        entity_group_put("eg_1", "todo_1", "g_1"),
        entity_group_put("eg_2", "todo_1", "g_2")
      ]

      assert PermissionHelper.build_intra_action_context(mutations) == %{
               "todo_1" => ["g_1", "g_2"]
             }
    end

    test "ignores domain relationship edges" do
      mutations = [
        mutation("rel_link", "relationship", :put, %{
          "source_id" => "todo_1",
          "target_id" => "g_1",
          "type" => "todo",
          "field" => "owns"
        })
      ]

      assert PermissionHelper.build_intra_action_context(mutations) == %{}
    end

    test "ignores non-membership mutations" do
      mutations = [
        entity_put("todo_1", "todo"),
        entity_group_put("eg_1", "todo_1", "g_1")
      ]

      ctx = PermissionHelper.build_intra_action_context(mutations)

      assert ctx == %{"todo_1" => ["g_1"]}
    end

    test "ignores delete methods" do
      mutations = [delete_mutation("eg_1", "entityGroup")]

      ctx = PermissionHelper.build_intra_action_context(mutations)

      assert ctx == %{}
    end

    test "handles missing data" do
      mutations = [%{mutation("eg_1", "entityGroup", :put) | data: nil}]

      ctx = PermissionHelper.build_intra_action_context(mutations)

      assert ctx == %{}
    end

    test "handles empty mutations" do
      assert PermissionHelper.build_intra_action_context([]) == %{}
    end
  end

  describe "build_intra_relationship_sources/1" do
    test "reads the source from the link's atomic value" do
      updates = [
        validated_component("rel_1", "ebb/link", %{
          "value" => %{
            "source_id" => "todo_1",
            "target_id" => "project_1",
            "type" => "project",
            "field" => "project"
          }
        })
      ]

      assert PermissionHelper.build_intra_relationship_sources(updates) == %{
               "rel_1" => "todo_1"
             }
    end

    test "a user component does not stand in for the source" do
      updates = [validated_component("rel_1", "todo/source_id", %{"value" => "project_1"})]

      assert PermissionHelper.build_intra_relationship_sources(updates) == %{}
    end

    test "maps one source per link row" do
      updates = [
        validated_component("rel_1", "ebb/link", %{"value" => %{"source_id" => "todo_1"}}),
        validated_component("rel_2", "ebb/link", %{"value" => %{"source_id" => "todo_2"}})
      ]

      assert PermissionHelper.build_intra_relationship_sources(updates) == %{
               "rel_1" => "todo_1",
               "rel_2" => "todo_2"
             }
    end

    test "ignores a delete, which names no component" do
      updates = [validated_component("rel_1", nil, nil, method: :delete)]

      assert PermissionHelper.build_intra_relationship_sources(updates) == %{}
    end
  end

  # A folded platform row carries a `kind` and one object value. Callers keep
  # the model-style label and `field => value` shape; this builds what the
  # engine now sees.
  @components %{
    "group" => {:group, "group"},
    "groupMember" => {:grant, "grant"},
    "entityGroup" => {:membership, "membership"},
    "relationship" => {:link, "link"}
  }

  defp mutation(subject_id, model, method, fields \\ %{}) do
    case Map.fetch(@components, model) do
      {:ok, {kind, field}} ->
        %{
          id: subject_id,
          subject_id: subject_id,
          model: "ebb",
          kind: kind,
          method: method,
          data: %{"fields" => %{field => %{"value" => fields}}}
        }

      :error ->
        %{
          id: subject_id,
          subject_id: subject_id,
          model: model,
          kind: nil,
          method: method,
          data: %{
            "fields" => Map.new(fields, fn {field, value} -> {field, %{"value" => value}} end)
          }
        }
    end
  end

  defp delete_mutation(subject_id, model) do
    %{
      id: subject_id,
      subject_id: subject_id,
      model: model,
      kind: nil,
      method: :delete,
      data: nil
    }
  end

  defp group_put(id) do
    mutation(id, "group", :put, %{"name" => "Test"})
  end

  defp group_member_put(id, actor_id, group_id, permissions) do
    mutation(id, "groupMember", :put, %{
      "actor_id" => actor_id,
      "group_id" => group_id,
      "permissions" => permissions
    })
  end

  defp entity_put(id, model) do
    mutation(id, model, :put)
  end

  defp entity_group_put(id, entity_id, group_id) do
    mutation(id, "entityGroup", :put, %{"entity_id" => entity_id, "group_id" => group_id})
  end
end
