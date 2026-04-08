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

  describe "group_bootstrap?/2" do
    test "valid bootstrap returns true" do
      updates = [
        %{
          "id" => "g_1",
          "subject_id" => "g_1",
          "subject_type" => "group",
          "method" => "put",
          "data" => %{"fields" => %{"name" => %{"value" => "Test"}}}
        },
        %{
          "id" => "gm_1",
          "subject_id" => "gm_1",
          "subject_type" => "groupMember",
          "method" => "put",
          "data" => %{"actor_id" => "a_1", "group_id" => "g_1", "permissions" => ["group.read"]}
        },
        %{
          "id" => "rel_1",
          "subject_id" => "rel_1",
          "subject_type" => "relationship",
          "method" => "put",
          "data" => %{
            "source_id" => "todo_1",
            "target_id" => "g_1",
            "type" => "todo",
            "field" => "group"
          }
        }
      ]

      assert PermissionHelper.group_bootstrap?(updates, "a_1") == true
    end

    test "missing groupMember returns false" do
      updates = [
        %{
          "id" => "g_1",
          "subject_id" => "g_1",
          "subject_type" => "group",
          "method" => "put",
          "data" => %{}
        },
        %{
          "id" => "rel_1",
          "subject_id" => "rel_1",
          "subject_type" => "relationship",
          "method" => "put",
          "data" => %{"source_id" => "todo_1", "target_id" => "g_1"}
        }
      ]

      assert PermissionHelper.group_bootstrap?(updates, "a_1") == false
    end

    test "missing relationship returns false" do
      updates = [
        %{
          "id" => "g_1",
          "subject_id" => "g_1",
          "subject_type" => "group",
          "method" => "put",
          "data" => %{}
        },
        %{
          "id" => "gm_1",
          "subject_id" => "gm_1",
          "subject_type" => "groupMember",
          "method" => "put",
          "data" => %{"actor_id" => "a_1", "group_id" => "g_1"}
        }
      ]

      assert PermissionHelper.group_bootstrap?(updates, "a_1") == false
    end

    test "empty updates returns false" do
      assert PermissionHelper.group_bootstrap?([], "a_1") == false
    end

    test "no group puts returns false" do
      updates = [
        %{
          "id" => "gm_1",
          "subject_id" => "gm_1",
          "subject_type" => "groupMember",
          "method" => "put",
          "data" => %{"actor_id" => "a_1", "group_id" => "g_1"}
        }
      ]

      assert PermissionHelper.group_bootstrap?(updates, "a_1") == false
    end

    test "actor_id in groupMember must match actor" do
      updates = [
        %{
          "id" => "g_1",
          "subject_id" => "g_1",
          "subject_type" => "group",
          "method" => "put",
          "data" => %{}
        },
        %{
          "id" => "gm_1",
          "subject_id" => "gm_1",
          "subject_type" => "groupMember",
          "method" => "put",
          "data" => %{"actor_id" => "a_different_actor", "group_id" => "g_1"}
        },
        %{
          "id" => "rel_1",
          "subject_id" => "rel_1",
          "subject_type" => "relationship",
          "method" => "put",
          "data" => %{"target_id" => "g_1"}
        }
      ]

      assert PermissionHelper.group_bootstrap?(updates, "a_1") == false
    end

    test "relationship target must match group_id" do
      updates = [
        %{
          "id" => "g_1",
          "subject_id" => "g_1",
          "subject_type" => "group",
          "method" => "put",
          "data" => %{}
        },
        %{
          "id" => "gm_1",
          "subject_id" => "gm_1",
          "subject_type" => "groupMember",
          "method" => "put",
          "data" => %{"actor_id" => "a_1", "group_id" => "g_1"}
        },
        %{
          "id" => "rel_1",
          "subject_id" => "rel_1",
          "subject_type" => "relationship",
          "method" => "put",
          "data" => %{"target_id" => "different_group"}
        }
      ]

      assert PermissionHelper.group_bootstrap?(updates, "a_1") == false
    end
  end

  describe "build_intra_action_context/1" do
    test "extracts relationship puts into map" do
      updates = [
        %{
          "id" => "rel_1",
          "subject_type" => "relationship",
          "method" => "put",
          "data" => %{"source_id" => "todo_1", "target_id" => "g_1"}
        },
        %{
          "id" => "rel_2",
          "subject_type" => "relationship",
          "method" => "put",
          "data" => %{"source_id" => "post_1", "target_id" => "g_2"}
        }
      ]

      ctx = PermissionHelper.build_intra_action_context(updates)

      assert ctx == %{"todo_1" => "g_1", "post_1" => "g_2"}
    end

    test "ignores non-relationship updates" do
      updates = [
        %{
          "id" => "todo_1",
          "subject_type" => "todo",
          "method" => "put",
          "data" => %{}
        },
        %{
          "id" => "rel_1",
          "subject_type" => "relationship",
          "method" => "put",
          "data" => %{"source_id" => "todo_1", "target_id" => "g_1"}
        }
      ]

      ctx = PermissionHelper.build_intra_action_context(updates)

      assert ctx == %{"todo_1" => "g_1"}
    end

    test "ignores delete methods" do
      updates = [
        %{
          "id" => "rel_1",
          "subject_type" => "relationship",
          "method" => "delete",
          "data" => %{"source_id" => "todo_1", "target_id" => "g_1"}
        }
      ]

      ctx = PermissionHelper.build_intra_action_context(updates)

      assert ctx == %{}
    end

    test "handles missing data" do
      updates = [
        %{
          "id" => "rel_1",
          "subject_type" => "relationship",
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
