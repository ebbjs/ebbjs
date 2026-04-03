defmodule EbbServer.Storage.PermissionCheckerTest do
  use ExUnit.Case, async: false

  import EbbServer.TestHelpers
  alias EbbServer.Storage.PermissionChecker

  defp create_isolated_tables do
    uid = System.unique_integer([:positive])
    gm = :"test_gm_#{uid}"
    rel = :"test_rel_#{uid}"
    rbg = :"test_rbg_#{uid}"

    :ets.new(gm, [:bag, :public, :named_table])
    :ets.new(rel, [:set, :public, :named_table])
    :ets.new(rbg, [:bag, :public, :named_table])

    on_exit(fn ->
      for t <- [gm, rel, rbg] do
        try do
          :ets.delete(t)
        rescue
          _ -> :ok
        end
      end
    end)

    %{group_members: gm, relationships: rel, relationships_by_group: rbg}
  end

  defp auth_opts(tables) do
    [
      group_members: tables.group_members,
      relationships: tables.relationships,
      relationships_by_group: tables.relationships_by_group
    ]
  end

  describe "validate_structure/1" do
    test "valid action passes" do
      action = sample_action()
      assert PermissionChecker.validate_structure(action) == :ok
    end

    test "missing id rejected" do
      action = Map.delete(sample_action(), "id")
      assert {:error, "invalid_structure", _} = PermissionChecker.validate_structure(action)
    end

    test "empty id rejected" do
      action = Map.put(sample_action(), "id", "")
      assert {:error, "invalid_structure", _} = PermissionChecker.validate_structure(action)
    end

    test "missing actor_id rejected" do
      action = Map.delete(sample_action(), "actor_id")
      assert {:error, "invalid_structure", _} = PermissionChecker.validate_structure(action)
    end

    test "empty actor_id rejected" do
      action = Map.put(sample_action(), "actor_id", "")
      assert {:error, "invalid_structure", _} = PermissionChecker.validate_structure(action)
    end

    test "invalid method rejected" do
      action = sample_action(%{"updates" => [sample_update(%{"method" => "upsert"})]})
      assert {:error, "invalid_structure", _} = PermissionChecker.validate_structure(action)
    end

    test "empty updates rejected" do
      action = Map.put(sample_action(), "updates", [])
      assert {:error, "invalid_structure", _} = PermissionChecker.validate_structure(action)
    end

    test "system entity without data.fields passes" do
      action =
        sample_action(%{
          "updates" => [
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
        })

      assert PermissionChecker.validate_structure(action) == :ok
    end

    test "user entity without data.fields rejected" do
      action =
        sample_action(%{
          "updates" => [
            %{
              "id" => "upd_1",
              "subject_id" => "todo_1",
              "subject_type" => "todo",
              "method" => "put",
              "data" => %{}
            }
          ]
        })

      assert {:error, "invalid_structure", _} = PermissionChecker.validate_structure(action)
    end

    test "string HLC accepted" do
      action = Map.put(sample_action(), "hlc", "#{generate_hlc()}")
      assert PermissionChecker.validate_structure(action) == :ok
    end
  end

  describe "validate_actor/2" do
    test "matching actor passes" do
      assert PermissionChecker.validate_actor(%{"actor_id" => "a_1"}, "a_1") == :ok
    end

    test "mismatched actor rejected" do
      assert {:error, "actor_mismatch", _} =
               PermissionChecker.validate_actor(%{"actor_id" => "a_1"}, "a_2")
    end
  end

  describe "validate_hlc/1" do
    test "current HLC passes" do
      action = %{"hlc" => generate_hlc()}
      assert PermissionChecker.validate_hlc(action) == :ok
    end

    test "string HLC passes" do
      action = %{"hlc" => "#{generate_hlc()}"}
      assert PermissionChecker.validate_hlc(action) == :ok
    end

    test "future drift rejected" do
      future_hlc = hlc_from(System.os_time(:millisecond) + 200_000, 0)
      action = %{"hlc" => future_hlc}
      assert {:error, "hlc_future_drift", _} = PermissionChecker.validate_hlc(action)
    end

    test "stale HLC rejected" do
      stale_hlc = hlc_from(System.os_time(:millisecond) - 100_000_000, 0)
      action = %{"hlc" => stale_hlc}
      assert {:error, "hlc_stale", _} = PermissionChecker.validate_hlc(action)
    end

    test "negative HLC rejected" do
      action = %{"hlc" => -1}
      assert {:error, "invalid_hlc", _} = PermissionChecker.validate_hlc(action)
    end

    test "string non-integer HLC rejected" do
      action = %{"hlc" => "not_a_number"}
      assert {:error, "invalid_hlc", _} = PermissionChecker.validate_hlc(action)
    end
  end

  describe "authorize_updates/2" do
    test "group bootstrap allowed without prior permissions" do
      action = %{
        "id" => "act_1",
        "actor_id" => "a_1",
        "hlc" => generate_hlc(),
        "updates" => [
          %{
            "id" => "g_1",
            "subject_id" => "g_1",
            "subject_type" => "group",
            "method" => "put",
            "data" => %{"fields" => %{"name" => %{"value" => "Test Group"}}}
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
      }

      opts = auth_opts(create_isolated_tables())
      assert PermissionChecker.authorize_updates(action, "a_1", opts) == :ok
    end

    test "authorized user entity write" do
      tables = create_isolated_tables()
      opts = auth_opts(tables)

      :ets.insert(
        tables.group_members,
        {"a_1", %{id: "gm_1", group_id: "g_1", permissions: ["todo.create", "todo.update"]}}
      )

      :ets.insert(
        tables.relationships,
        {"todo_1", %{id: "rel_1", target_id: "g_1", type: "todo", field: "group"}}
      )

      action =
        sample_action(%{
          "updates" => [
            %{
              "id" => "upd_1",
              "subject_id" => "todo_1",
              "subject_type" => "todo",
              "method" => "put",
              "data" => %{"fields" => %{"title" => %{"value" => "Test"}}}
            }
          ]
        })

      assert PermissionChecker.authorize_updates(action, "a_1", opts) == :ok
    end

    test "unauthorized write (not a member)" do
      tables = create_isolated_tables()
      opts = auth_opts(tables)

      :ets.insert(
        tables.relationships,
        {"todo_1", %{id: "rel_1", target_id: "g_1", type: "todo", field: "group"}}
      )

      action =
        sample_action(%{
          "updates" => [
            %{
              "id" => "upd_1",
              "subject_id" => "todo_1",
              "subject_type" => "todo",
              "method" => "put",
              "data" => %{"fields" => %{"title" => %{"value" => "Test"}}}
            }
          ]
        })

      assert {:error, "not_authorized", _} =
               PermissionChecker.authorize_updates(action, "a_1", opts)
    end

    test "unauthorized write (wrong permissions)" do
      tables = create_isolated_tables()
      opts = auth_opts(tables)

      :ets.insert(
        tables.group_members,
        {"a_1", %{id: "gm_1", group_id: "g_1", permissions: ["post.create"]}}
      )

      :ets.insert(
        tables.relationships,
        {"todo_1", %{id: "rel_1", target_id: "g_1", type: "todo", field: "group"}}
      )

      action =
        sample_action(%{
          "updates" => [
            %{
              "id" => "upd_1",
              "subject_id" => "todo_1",
              "subject_type" => "todo",
              "method" => "put",
              "data" => %{"fields" => %{"title" => %{"value" => "Test"}}}
            }
          ]
        })

      assert {:error, "not_authorized", _} =
               PermissionChecker.authorize_updates(action, "a_1", opts)
    end

    test "wildcard permission matches" do
      tables = create_isolated_tables()
      opts = auth_opts(tables)

      :ets.insert(
        tables.group_members,
        {"a_1", %{id: "gm_1", group_id: "g_1", permissions: ["todo.*"]}}
      )

      :ets.insert(
        tables.relationships,
        {"todo_1", %{id: "rel_1", target_id: "g_1", type: "todo", field: "group"}}
      )

      action =
        sample_action(%{
          "updates" => [
            %{
              "id" => "upd_1",
              "subject_id" => "todo_1",
              "subject_type" => "todo",
              "method" => "patch",
              "data" => %{"fields" => %{"title" => %{"value" => "Test"}}}
            }
          ]
        })

      assert PermissionChecker.authorize_updates(action, "a_1", opts) == :ok
    end

    test "intra-action resolution" do
      tables = create_isolated_tables()
      opts = auth_opts(tables)

      :ets.insert(
        tables.group_members,
        {"a_1", %{id: "gm_1", group_id: "g_1", permissions: ["todo.create"]}}
      )

      action = %{
        "id" => "act_1",
        "actor_id" => "a_1",
        "hlc" => generate_hlc(),
        "updates" => [
          %{
            "id" => "upd_1",
            "subject_id" => "todo_new",
            "subject_type" => "todo",
            "method" => "put",
            "data" => %{"fields" => %{"title" => %{"value" => "Test"}}}
          },
          %{
            "id" => "rel_1",
            "subject_id" => "rel_new",
            "subject_type" => "relationship",
            "method" => "put",
            "data" => %{
              "source_id" => "todo_new",
              "target_id" => "g_1",
              "type" => "todo",
              "field" => "group"
            }
          }
        ]
      }

      assert PermissionChecker.authorize_updates(action, "a_1", opts) == :ok
    end

    test "system entity update authorized when actor is group member" do
      tables = create_isolated_tables()
      opts = auth_opts(tables)

      :ets.insert(
        tables.group_members,
        {"a_1", %{id: "gm_1", group_id: "g_1", permissions: ["group.read"]}}
      )

      action = %{
        "id" => "act_1",
        "actor_id" => "a_1",
        "hlc" => generate_hlc(),
        "updates" => [
          %{
            "id" => "gm_2",
            "subject_id" => "gm_2",
            "subject_type" => "groupMember",
            "method" => "patch",
            "data" => %{
              "fields" => %{
                "group_id" => %{"value" => "g_1"},
                "actor_id" => %{"value" => "a_2"},
                "permissions" => %{"value" => ["group.read"]}
              }
            }
          }
        ]
      }

      assert PermissionChecker.authorize_updates(action, "a_1", opts) == :ok
    end

    test "system entity update rejected when actor is not group member" do
      tables = create_isolated_tables()
      opts = auth_opts(tables)

      action = %{
        "id" => "act_1",
        "actor_id" => "a_1",
        "hlc" => generate_hlc(),
        "updates" => [
          %{
            "id" => "gm_1",
            "subject_id" => "gm_1",
            "subject_type" => "groupMember",
            "method" => "patch",
            "data" => %{
              "fields" => %{
                "group_id" => %{"value" => "g_1"},
                "actor_id" => %{"value" => "a_2"},
                "permissions" => %{"value" => ["group.read"]}
              }
            }
          }
        ]
      }

      assert {:error, "not_authorized", _} =
               PermissionChecker.authorize_updates(action, "a_1", opts)
    end
  end

  describe "validate_and_authorize/2" do
    test "full pipeline, mixed accepted and rejected" do
      tables = create_isolated_tables()
      opts = auth_opts(tables)

      :ets.insert(
        tables.group_members,
        {"a_1", %{id: "gm_1", group_id: "g_1", permissions: ["todo.create"]}}
      )

      :ets.insert(
        tables.relationships,
        {"todo_1", %{id: "rel_1", target_id: "g_1", type: "todo", field: "group"}}
      )

      valid_action = %{
        "id" => "act_1",
        "actor_id" => "a_1",
        "hlc" => generate_hlc(),
        "updates" => [
          %{
            "id" => "upd_1",
            "subject_id" => "todo_1",
            "subject_type" => "todo",
            "method" => "put",
            "data" => %{"fields" => %{"title" => %{"value" => "Test"}}}
          }
        ]
      }

      invalid_action = %{
        "id" => "act_2",
        "actor_id" => "a_2",
        "hlc" => generate_hlc(),
        "updates" => [
          %{
            "id" => "upd_2",
            "subject_id" => "todo_1",
            "subject_type" => "todo",
            "method" => "put",
            "data" => %{"fields" => %{"title" => %{"value" => "Test"}}}
          }
        ]
      }

      {accepted, rejected} =
        PermissionChecker.validate_and_authorize([valid_action, invalid_action], "a_1", opts)

      assert length(accepted) == 1
      assert length(rejected) == 1

      validated = hd(accepted)
      assert is_integer(validated.hlc)
      assert validated.actor_id == "a_1"
      assert is_atom(hd(validated.updates).method)

      rejection = hd(rejected)
      assert rejection.reason == "actor_mismatch"
    end

    test "empty action list returns empty tuples" do
      tables = create_isolated_tables()
      opts = auth_opts(tables)

      {accepted, rejected} = PermissionChecker.validate_and_authorize([], "a_1", opts)

      assert accepted == []
      assert rejected == []
    end
  end
end
