defmodule EbbServer.Storage.PermissionHelperTest do
  use ExUnit.Case, async: true

  alias EbbServer.Storage.PermissionHelper

  import EbbServer.TestHelpers, only: [validated_component: 3, validated_component: 4]

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

    test "a field grant covers only its own component" do
      assert PermissionHelper.check_permission(["note/title.*"], "note/title", "update") == true
      assert PermissionHelper.check_permission(["note/title.*"], "note/body", "update") == false

      assert PermissionHelper.check_permission(["note/title.update"], "note/body", "update") ==
               false
    end

    test "a field grant does not cover its model" do
      assert PermissionHelper.check_permission(["note/title.*"], "note", "update") == false
    end

    test "ancestry matches whole path segments" do
      assert PermissionHelper.check_permission(["note/title.*"], "note/titlelong", "update") ==
               false

      assert PermissionHelper.check_permission(["note.*"], "notebook", "update") == false
    end

    test "ebb.* covers the platform components" do
      assert PermissionHelper.check_permission(["ebb.*"], "ebb/grant", "create") == true
      assert PermissionHelper.check_permission(["ebb.*"], "ebb/membership", "delete") == true
    end
  end

  describe "bootstrap_group_permissions/3" do
    test "maps the groups the actor creates and joins to their declared permissions" do
      mutations = [
        group_create("g_1"),
        grant_create("gm_1", "a_1", "g_1", ["ebb/group.read", "todo.*"]),
        membership_write("eg_1", "todo_1", "g_1")
      ]

      assert PermissionHelper.bootstrap_group_permissions(mutations, "a_1", fn _ -> false end) ==
               %{"g_1" => ["ebb/group.read", "todo.*"]}
    end

    test "ignores a grant for a different actor" do
      mutations = [
        group_create("g_1"),
        grant_create("gm_1", "a_2", "g_1", ["*"])
      ]

      assert PermissionHelper.bootstrap_group_permissions(mutations, "a_1", fn _ -> false end) ==
               %{}
    end

    test "ignores a grant in a group the action does not create" do
      mutations = [grant_create("gm_1", "a_1", "g_1", ["*"])]

      assert PermissionHelper.bootstrap_group_permissions(mutations, "a_1", fn _ -> false end) ==
               %{}
    end

    test "empty mutations returns an empty map" do
      assert PermissionHelper.bootstrap_group_permissions([], "a_1", fn _ -> false end) == %{}
    end

    test "drops a group the existence predicate reports as existing" do
      mutations = [
        group_create("g_1"),
        grant_create("gm_1", "a_1", "g_1", ["ebb/group.read", "todo.*"])
      ]

      assert PermissionHelper.bootstrap_group_permissions(mutations, "a_1", &(&1 == "g_1")) ==
               %{}
    end

    test "keeps a new group while dropping an existing one" do
      mutations = [
        group_create("g_old"),
        group_create("g_new"),
        grant_create("gm_old", "a_1", "g_old", ["ebb/group.read"]),
        grant_create("gm_new", "a_1", "g_new", ["todo.*"])
      ]

      result = PermissionHelper.bootstrap_group_permissions(mutations, "a_1", &(&1 == "g_old"))

      assert result == %{"g_new" => ["todo.*"]}
    end
  end

  describe "created_subject_ids/2" do
    test "collects user entity creates only" do
      mutations = [
        entity_create("todo_1", "todo"),
        entity_create("post_1", "post"),
        group_create("g_1"),
        grant_create("gm_1", "a_1", "g_1", ["*"]),
        membership_write("eg_1", "todo_1", "g_1")
      ]

      assert PermissionHelper.created_subject_ids(mutations, fn _ -> false end) ==
               MapSet.new(["todo_1", "post_1"])
    end

    test "ignores writes to existing rows and deletes" do
      mutations = [
        mutation("todo_1", "todo", false, %{"title" => "Test"}),
        delete_mutation("todo_2", "todo")
      ]

      assert PermissionHelper.created_subject_ids(mutations, fn _ -> false end) ==
               MapSet.new()
    end

    test "drops an id the existence predicate reports as existing" do
      mutations = [
        entity_create("todo_new", "todo"),
        entity_create("todo_old", "todo")
      ]

      assert PermissionHelper.created_subject_ids(mutations, &(&1 == "todo_old")) ==
               MapSet.new(["todo_new"])
    end
  end

  describe "created_models/1" do
    test "maps created user entity ids to their model" do
      mutations = [
        entity_create("todo_1", "todo"),
        entity_create("post_1", "post"),
        group_create("g_1")
      ]

      assert PermissionHelper.created_models(mutations) == %{
               "todo_1" => "todo",
               "post_1" => "post"
             }
    end
  end

  describe "bootstrap_grant_row_ids/3" do
    test "collects the actor's own grant rows in the groups the action creates" do
      mutations = [
        group_create("g_1"),
        grant_create("gm_1", "a_1", "g_1", ["ebb/group.read"]),
        grant_create("gm_2", "a_2", "g_1", ["ebb/group.read"])
      ]

      assert PermissionHelper.bootstrap_grant_row_ids(mutations, "a_1", fn _ -> false end) ==
               MapSet.new(["gm_1"])
    end

    test "drops a row id the existence predicate reports as existing" do
      mutations = [
        group_create("g_1"),
        grant_create("gm_new", "a_1", "g_1", ["ebb/group.read"]),
        grant_create("gm_old", "a_1", "g_1", ["ebb/group.read"])
      ]

      assert PermissionHelper.bootstrap_grant_row_ids(mutations, "a_1", &(&1 == "gm_old")) ==
               MapSet.new(["gm_new"])
    end

    test "ignores a membership row in a group the action does not create" do
      mutations = [grant_create("gm_1", "a_1", "g_1", ["ebb/group.read"])]

      assert PermissionHelper.bootstrap_grant_row_ids(mutations, "a_1", fn _ -> false end) ==
               MapSet.new()
    end
  end

  describe "bootstrap_update?/5" do
    setup do
      bootstrap = %{"g_1" => ["ebb/group.read", "todo.*"]}
      created = MapSet.new(["todo_1"])
      grant_rows = MapSet.new(["gm_1"])

      %{bootstrap: bootstrap, created: created, grant_rows: grant_rows}
    end

    test "exempts the group create", %{
      bootstrap: bootstrap,
      created: created,
      grant_rows: grant_rows
    } do
      row = group_create("g_1")

      assert PermissionHelper.bootstrap_update?(
               row,
               "a_1",
               bootstrap,
               created,
               grant_rows
             ) == true
    end

    test "exempts the acting actor's own grant create", %{
      bootstrap: bootstrap,
      created: created,
      grant_rows: grant_rows
    } do
      row = grant_create("gm_1", "a_1", "g_1", ["ebb/group.read"])

      assert PermissionHelper.bootstrap_update?(
               row,
               "a_1",
               bootstrap,
               created,
               grant_rows
             ) == true
    end

    test "does not exempt a row the action is not creating", %{
      bootstrap: bootstrap,
      created: created,
      grant_rows: grant_rows
    } do
      row = grant_create("gm_existing", "a_1", "g_1", ["ebb/group.read"])

      assert PermissionHelper.bootstrap_update?(
               row,
               "a_1",
               bootstrap,
               created,
               grant_rows
             ) == false
    end

    test "does not exempt a third party's grant create", %{
      bootstrap: bootstrap,
      created: created,
      grant_rows: grant_rows
    } do
      row = grant_create("gm_2", "a_2", "g_1", ["*"])

      assert PermissionHelper.bootstrap_update?(
               row,
               "a_1",
               bootstrap,
               created,
               grant_rows
             ) == false
    end

    test "exempts an membership write for an entity the action creates", %{
      bootstrap: bootstrap,
      created: created,
      grant_rows: grant_rows
    } do
      row = membership_write("eg_1", "todo_1", "g_1")

      assert PermissionHelper.bootstrap_update?(
               row,
               "a_1",
               bootstrap,
               created,
               grant_rows
             ) == true
    end

    test "does not exempt an membership write for an entity the action does not create", %{
      bootstrap: bootstrap,
      created: created,
      grant_rows: grant_rows
    } do
      row = membership_write("eg_1", "todo_other", "g_1")

      assert PermissionHelper.bootstrap_update?(
               row,
               "a_1",
               bootstrap,
               created,
               grant_rows
             ) == false
    end

    test "does not exempt an membership write in a different group", %{
      bootstrap: bootstrap,
      created: created,
      grant_rows: grant_rows
    } do
      row = membership_write("eg_1", "todo_1", "g_other")

      assert PermissionHelper.bootstrap_update?(
               row,
               "a_1",
               bootstrap,
               created,
               grant_rows
             ) == false
    end

    test "does not exempt a relationship create", %{
      bootstrap: bootstrap,
      created: created,
      grant_rows: grant_rows
    } do
      row =
        mutation("rel_1", "relationship", true, %{"source_id" => "todo_1"})

      assert PermissionHelper.bootstrap_update?(
               row,
               "a_1",
               bootstrap,
               created,
               grant_rows
             ) == false
    end

    test "does not exempt a write to an existing group", %{
      bootstrap: bootstrap,
      created: created,
      grant_rows: grant_rows
    } do
      row = mutation("g_1", "group", false, %{"name" => "Renamed"})

      assert PermissionHelper.bootstrap_update?(
               row,
               "a_1",
               bootstrap,
               created,
               grant_rows
             ) == false
    end
  end

  describe "build_intra_action_context/1" do
    test "extracts membership writes into an entity => groups map" do
      mutations = [
        membership_write("eg_1", "todo_1", "g_1"),
        membership_write("eg_2", "post_1", "g_2")
      ]

      ctx = PermissionHelper.build_intra_action_context(mutations)

      assert ctx == %{"todo_1" => ["g_1"], "post_1" => ["g_2"]}
    end

    # Filing an entity into a second group writes an existing membership row;
    # that write is part of the Action's membership context just like a create.
    test "counts a write to an existing membership row" do
      mutations = [membership_write("eg_1", "todo_1", "g_1", false)]

      assert PermissionHelper.build_intra_action_context(mutations) == %{"todo_1" => ["g_1"]}
    end

    test "collects several memberships for the same entity" do
      mutations = [
        membership_write("eg_1", "todo_1", "g_1"),
        membership_write("eg_2", "todo_1", "g_2")
      ]

      assert PermissionHelper.build_intra_action_context(mutations) == %{
               "todo_1" => ["g_1", "g_2"]
             }
    end

    test "ignores domain relationship edges" do
      mutations = [
        mutation("rel_link", "relationship", true, %{
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
        entity_create("todo_1", "todo"),
        membership_write("eg_1", "todo_1", "g_1")
      ]

      ctx = PermissionHelper.build_intra_action_context(mutations)

      assert ctx == %{"todo_1" => ["g_1"]}
    end

    test "ignores deletes" do
      mutations = [delete_mutation("eg_1", "membership")]

      ctx = PermissionHelper.build_intra_action_context(mutations)

      assert ctx == %{}
    end

    test "handles missing data" do
      mutations = [%{mutation("eg_1", "membership", true) | data: nil}]

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
    "grant" => {:grant, "grant"},
    "membership" => {:membership, "membership"},
    "relationship" => {:link, "link"}
  }

  defp mutation(subject_id, model, created?, fields \\ %{}) do
    case Map.fetch(@components, model) do
      {:ok, {kind, field}} ->
        %{
          id: subject_id,
          subject_id: subject_id,
          model: "ebb",
          kind: kind,
          created?: created?,
          deleted?: false,
          data: %{"fields" => %{field => %{"value" => fields}}}
        }

      :error ->
        %{
          id: subject_id,
          subject_id: subject_id,
          model: model,
          kind: nil,
          created?: created?,
          deleted?: false,
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
      created?: false,
      deleted?: true,
      data: nil
    }
  end

  defp group_create(id) do
    mutation(id, "group", true, %{"name" => "Test"})
  end

  defp grant_create(id, actor_id, group_id, permissions) do
    mutation(id, "grant", true, %{
      "actor_id" => actor_id,
      "group_id" => group_id,
      "permissions" => permissions
    })
  end

  defp entity_create(id, model) do
    mutation(id, model, true)
  end

  defp membership_write(id, entity_id, group_id, created? \\ true) do
    mutation(id, "membership", created?, %{"entity_id" => entity_id, "group_id" => group_id})
  end
end
