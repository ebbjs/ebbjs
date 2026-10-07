defmodule EbbServer.Storage.PermissionHelperTest do
  use ExUnit.Case, async: true

  alias EbbServer.Storage.PermissionHelper

  describe "method_to_permission/1" do
    test "put maps to create" do
      assert PermissionHelper.method_to_permission("put") == "create"
    end

    test "patch maps to update" do
      assert PermissionHelper.method_to_permission("patch") == "update"
    end

    test "delete maps to delete" do
      assert PermissionHelper.method_to_permission("delete") == "delete"
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
      perms = ["group.read", "group.write", "todo.*"]
      assert PermissionHelper.check_permission(perms, "todo", "delete") == true
      assert PermissionHelper.check_permission(perms, "group", "read") == true
      assert PermissionHelper.check_permission(perms, "post", "create") == false
    end
  end

  describe "bootstrap_group_permissions/3" do
    test "maps the groups the actor creates and joins to their declared permissions" do
      updates = [
        group_put("g_1"),
        group_member_put("gm_1", "a_1", "g_1", ["group.read", "todo.*"]),
        entity_group_put("eg_1", "todo_1", "g_1")
      ]

      assert PermissionHelper.bootstrap_group_permissions(updates, "a_1", fn _ -> false end) == %{
               "g_1" => ["group.read", "todo.*"]
             }
    end

    test "ignores a groupMember for a different actor" do
      updates = [
        group_put("g_1"),
        group_member_put("gm_1", "a_2", "g_1", ["*"])
      ]

      assert PermissionHelper.bootstrap_group_permissions(updates, "a_1", fn _ -> false end) ==
               %{}
    end

    test "ignores a groupMember in a group the action does not create" do
      updates = [group_member_put("gm_1", "a_1", "g_1", ["*"])]

      assert PermissionHelper.bootstrap_group_permissions(updates, "a_1", fn _ -> false end) ==
               %{}
    end

    test "empty updates returns an empty map" do
      assert PermissionHelper.bootstrap_group_permissions([], "a_1", fn _ -> false end) == %{}
    end

    test "drops a group the existence predicate reports as existing" do
      updates = [
        group_put("g_1"),
        group_member_put("gm_1", "a_1", "g_1", ["group.read", "todo.*"])
      ]

      assert PermissionHelper.bootstrap_group_permissions(updates, "a_1", &(&1 == "g_1")) ==
               %{}
    end

    test "keeps a new group while dropping an existing one" do
      updates = [
        group_put("g_old"),
        group_put("g_new"),
        group_member_put("gm_old", "a_1", "g_old", ["group.read"]),
        group_member_put("gm_new", "a_1", "g_new", ["todo.*"])
      ]

      result = PermissionHelper.bootstrap_group_permissions(updates, "a_1", &(&1 == "g_old"))

      assert result == %{"g_new" => ["todo.*"]}
    end
  end

  describe "created_subject_ids/2" do
    test "collects user entity puts only" do
      updates = [
        entity_put("todo_1", "todo"),
        entity_put("post_1", "post"),
        group_put("g_1"),
        group_member_put("gm_1", "a_1", "g_1", ["*"]),
        entity_group_put("eg_1", "todo_1", "g_1")
      ]

      assert PermissionHelper.created_subject_ids(updates, fn _ -> false end) ==
               MapSet.new(["todo_1", "post_1"])
    end

    test "ignores patches and deletes" do
      updates = [
        %{
          "id" => "todo_1",
          "subject_id" => "todo_1",
          "subject_type" => "todo",
          "method" => "patch",
          "data" => %{}
        }
      ]

      assert PermissionHelper.created_subject_ids(updates, fn _ -> false end) ==
               MapSet.new()
    end

    test "drops an id the existence predicate reports as existing" do
      updates = [
        entity_put("todo_new", "todo"),
        entity_put("todo_old", "todo")
      ]

      assert PermissionHelper.created_subject_ids(updates, &(&1 == "todo_old")) ==
               MapSet.new(["todo_new"])
    end
  end

  describe "created_entity_types/1" do
    test "maps created user entity ids to their type" do
      updates = [
        entity_put("todo_1", "todo"),
        entity_put("post_1", "post"),
        group_put("g_1")
      ]

      assert PermissionHelper.created_entity_types(updates) == %{
               "todo_1" => "todo",
               "post_1" => "post"
             }
    end
  end

  describe "bootstrap_update?/4" do
    setup do
      bootstrap = %{"g_1" => ["group.read", "todo.*"]}
      created = MapSet.new(["todo_1"])
      %{bootstrap: bootstrap, created: created}
    end

    test "exempts the group put", %{bootstrap: bootstrap, created: created} do
      update = group_put("g_1")
      assert PermissionHelper.bootstrap_update?(update, "a_1", bootstrap, created) == true
    end

    test "exempts the acting actor's own groupMember put", %{
      bootstrap: bootstrap,
      created: created
    } do
      update = group_member_put("gm_1", "a_1", "g_1", ["group.read"])
      assert PermissionHelper.bootstrap_update?(update, "a_1", bootstrap, created) == true
    end

    test "does not exempt a third party's groupMember put", %{
      bootstrap: bootstrap,
      created: created
    } do
      update = group_member_put("gm_2", "a_2", "g_1", ["*"])
      assert PermissionHelper.bootstrap_update?(update, "a_1", bootstrap, created) == false
    end

    test "exempts an entityGroup put for an entity the action creates", %{
      bootstrap: bootstrap,
      created: created
    } do
      update = entity_group_put("eg_1", "todo_1", "g_1")
      assert PermissionHelper.bootstrap_update?(update, "a_1", bootstrap, created) == true
    end

    test "does not exempt an entityGroup put for an entity the action does not create", %{
      bootstrap: bootstrap,
      created: created
    } do
      update = entity_group_put("eg_1", "todo_other", "g_1")
      assert PermissionHelper.bootstrap_update?(update, "a_1", bootstrap, created) == false
    end

    test "does not exempt an entityGroup put in a different group", %{
      bootstrap: bootstrap,
      created: created
    } do
      update = entity_group_put("eg_1", "todo_1", "g_other")
      assert PermissionHelper.bootstrap_update?(update, "a_1", bootstrap, created) == false
    end

    test "does not exempt a relationship put", %{bootstrap: bootstrap, created: created} do
      update = %{
        "id" => "rel_1",
        "subject_id" => "rel_1",
        "subject_type" => "relationship",
        "method" => "put",
        "data" => %{"fields" => %{"source_id" => %{"value" => "todo_1"}}}
      }

      assert PermissionHelper.bootstrap_update?(update, "a_1", bootstrap, created) == false
    end

    test "does not exempt a group patch", %{bootstrap: bootstrap, created: created} do
      update = %{
        "id" => "g_1",
        "subject_id" => "g_1",
        "subject_type" => "group",
        "method" => "patch",
        "data" => %{"fields" => %{"name" => %{"value" => "Renamed"}}}
      }

      assert PermissionHelper.bootstrap_update?(update, "a_1", bootstrap, created) == false
    end
  end

  defp group_put(id) do
    %{
      "id" => id,
      "subject_id" => id,
      "subject_type" => "group",
      "method" => "put",
      "data" => %{"fields" => %{"name" => %{"value" => "Test"}}}
    }
  end

  defp group_member_put(id, actor_id, group_id, permissions) do
    %{
      "id" => id,
      "subject_id" => id,
      "subject_type" => "groupMember",
      "method" => "put",
      "data" => %{
        "fields" => %{
          "actor_id" => %{"value" => actor_id},
          "group_id" => %{"value" => group_id},
          "permissions" => %{"value" => permissions}
        }
      }
    }
  end

  defp entity_put(id, type) do
    %{id: id, subject_id: id, subject_type: type, method: "put", data: %{"fields" => %{}}}
  end

  defp entity_group_put(id, entity_id, group_id) do
    %{
      "id" => id,
      "subject_id" => id,
      "subject_type" => "entityGroup",
      "method" => "put",
      "data" => %{
        "fields" => %{
          "entity_id" => %{"value" => entity_id},
          "group_id" => %{"value" => group_id}
        }
      }
    }
  end

  describe "build_intra_action_context/1" do
    test "extracts entityGroup puts into an entity => groups map" do
      updates = [
        %{
          "id" => "eg_1",
          "subject_type" => "entityGroup",
          "method" => "put",
          "data" => %{
            "fields" => %{
              "entity_id" => %{"value" => "todo_1"},
              "group_id" => %{"value" => "g_1"}
            }
          }
        },
        %{
          "id" => "eg_2",
          "subject_type" => "entityGroup",
          "method" => "put",
          "data" => %{
            "fields" => %{
              "entity_id" => %{"value" => "post_1"},
              "group_id" => %{"value" => "g_2"}
            }
          }
        }
      ]

      ctx = PermissionHelper.build_intra_action_context(updates)

      assert ctx == %{"todo_1" => ["g_1"], "post_1" => ["g_2"]}
    end

    test "collects several memberships for the same entity" do
      updates = [
        %{
          "id" => "eg_1",
          "subject_type" => "entityGroup",
          "method" => "put",
          "data" => %{
            "fields" => %{
              "entity_id" => %{"value" => "todo_1"},
              "group_id" => %{"value" => "g_1"}
            }
          }
        },
        %{
          "id" => "eg_2",
          "subject_type" => "entityGroup",
          "method" => "put",
          "data" => %{
            "fields" => %{
              "entity_id" => %{"value" => "todo_1"},
              "group_id" => %{"value" => "g_2"}
            }
          }
        }
      ]

      assert PermissionHelper.build_intra_action_context(updates) == %{
               "todo_1" => ["g_1", "g_2"]
             }
    end

    test "ignores domain relationship edges" do
      updates = [
        %{
          "id" => "rel_link",
          "subject_type" => "relationship",
          "method" => "put",
          "data" => %{
            "fields" => %{
              "source_id" => %{"value" => "todo_1"},
              "target_id" => %{"value" => "g_1"},
              "type" => %{"value" => "todo"},
              "field" => %{"value" => "owns"}
            }
          }
        }
      ]

      assert PermissionHelper.build_intra_action_context(updates) == %{}
    end

    test "ignores non-membership updates" do
      updates = [
        %{
          "id" => "todo_1",
          "subject_type" => "todo",
          "method" => "put",
          "data" => %{}
        },
        %{
          "id" => "eg_1",
          "subject_type" => "entityGroup",
          "method" => "put",
          "data" => %{
            "fields" => %{
              "entity_id" => %{"value" => "todo_1"},
              "group_id" => %{"value" => "g_1"}
            }
          }
        }
      ]

      ctx = PermissionHelper.build_intra_action_context(updates)

      assert ctx == %{"todo_1" => ["g_1"]}
    end

    test "ignores delete methods" do
      updates = [
        %{
          "id" => "eg_1",
          "subject_type" => "entityGroup",
          "method" => "delete",
          "data" => %{
            "fields" => %{
              "entity_id" => %{"value" => "todo_1"},
              "group_id" => %{"value" => "g_1"}
            }
          }
        }
      ]

      ctx = PermissionHelper.build_intra_action_context(updates)

      assert ctx == %{}
    end

    test "handles missing data" do
      updates = [
        %{
          "id" => "eg_1",
          "subject_type" => "entityGroup",
          "method" => "put",
          "data" => %{}
        }
      ]

      ctx = PermissionHelper.build_intra_action_context(updates)

      assert ctx == %{}
    end

    test "handles empty updates" do
      assert PermissionHelper.build_intra_action_context([]) == %{}
    end
  end

  describe "system_entity_types/0" do
    test "returns expected types" do
      types = PermissionHelper.system_entity_types()
      assert "group" in types
      assert "groupMember" in types
      assert "relationship" in types
      assert "entityGroup" in types
    end
  end

  describe "method_atoms/0" do
    test "returns method mapping" do
      atoms = PermissionHelper.method_atoms()
      assert atoms["put"] == :put
      assert atoms["patch"] == :patch
      assert atoms["delete"] == :delete
    end
  end
end
