defmodule EbbServer.Storage.ActionValidatorTest do
  use ExUnit.Case, async: true

  import EbbServer.TestHelpers
  alias EbbServer.Storage.ActionValidator

  describe "validate/2 - full validation pipeline" do
    test "valid action passes validation" do
      action = sample_action()
      {accepted, rejected} = ActionValidator.validate([action], "a_test")

      assert accepted != []
      assert rejected == []
    end

    test "mismatched actor rejected" do
      action = sample_action()
      {accepted, rejected} = ActionValidator.validate([action], "different_actor")

      assert accepted == []
      assert rejected != []
      assert hd(rejected).reason == "actor_mismatch"
    end

    test "multiple actions - mixed accepted and rejected" do
      valid = sample_action(%{"id" => "act_valid"})
      invalid = sample_action(%{"id" => "act_invalid", "actor_id" => "wrong_actor"})

      {accepted, rejected} = ActionValidator.validate([valid, invalid], "a_test")

      assert accepted != []
      assert hd(accepted).id == "act_valid"
      assert rejected != []
      assert hd(rejected).reason == "actor_mismatch"
    end

    test "empty list returns empty tuples" do
      {accepted, rejected} = ActionValidator.validate([], "a_test")

      assert accepted == []
      assert rejected == []
    end
  end

  describe "validate_structure/1" do
    test "valid action passes" do
      action = sample_action()
      assert ActionValidator.validate_structure(action) == :ok
    end

    test "missing id rejected" do
      action = Map.delete(sample_action(), "id")
      assert {:error, "invalid_structure", _} = ActionValidator.validate_structure(action)
    end

    test "empty id rejected" do
      action = Map.put(sample_action(), "id", "")
      assert {:error, "invalid_structure", _} = ActionValidator.validate_structure(action)
    end

    test "missing actor_id rejected" do
      action = Map.delete(sample_action(), "actor_id")
      assert {:error, "invalid_structure", _} = ActionValidator.validate_structure(action)
    end

    test "empty actor_id rejected" do
      action = Map.put(sample_action(), "actor_id", "")
      assert {:error, "invalid_structure", _} = ActionValidator.validate_structure(action)
    end

    test "invalid method rejected" do
      action = sample_action(%{"updates" => [sample_update(%{"method" => "upsert"})]})
      assert {:error, "invalid_structure", _} = ActionValidator.validate_structure(action)
    end

    test "empty updates rejected" do
      action = Map.put(sample_action(), "updates", [])
      assert {:error, "invalid_structure", _} = ActionValidator.validate_structure(action)
    end

    test "a system component update passes" do
      action =
        sample_action(%{
          "updates" => [
            %{
              "id" => "rel_1",
              "subject_id" => "rel_1",
              "component" => "relationship/source_id",
              "method" => "merge",
              "data" => %{"value" => "todo_1"}
            }
          ]
        })

      assert ActionValidator.validate_structure(action) == :ok
    end

    test "a component update without a component is rejected" do
      action =
        sample_action(%{
          "updates" => [
            %{
              "id" => "upd_1",
              "subject_id" => "todo_1",
              "method" => "merge",
              "data" => %{"value" => "x"}
            }
          ]
        })

      assert {:error, "invalid_structure", _} = ActionValidator.validate_structure(action)
    end

    test "a component that is not <model>/<field> is rejected" do
      for component <- ["todo", "/title", "todo/", "todo/ti/tle", ""] do
        action =
          sample_action(%{
            "updates" => [
              %{
                "id" => "upd_1",
                "subject_id" => "todo_1",
                "component" => component,
                "method" => "merge",
                "data" => %{"value" => "x"}
              }
            ]
          })

        assert {:error, "invalid_structure", _} = ActionValidator.validate_structure(action)
      end
    end

    # A row has one model: the fold keeps the first component's prefix, so a
    # mixed Action would authorize and materialize a `note` row carrying an
    # `ebb/link`. An `ebb/*` overlay on a user row has no write path until
    # #819/#820, so the platform namespace is a prefix like any other here.
    test "one subject cannot mix model prefixes" do
      action =
        sample_action(%{
          "updates" => [
            %{
              "id" => "upd_1",
              "subject_id" => "note_1",
              "component" => "note/title",
              "method" => "merge",
              "data" => %{"value" => "x"}
            },
            %{
              "id" => "upd_2",
              "subject_id" => "note_1",
              "component" => "ebb/link",
              "method" => "replace",
              "data" => %{"value" => %{"source_id" => "note_1", "target_id" => "col_1"}}
            }
          ]
        })

      assert {:error, "invalid_structure", details} = ActionValidator.validate_structure(action)
      assert details =~ "one model"

      # Two subjects, each with its own model, are two rows.
      split = put_in(action, ["updates", Access.at(1), "subject_id"], "rel_1")
      assert ActionValidator.validate_structure(split) == :ok
    end

    # A platform row carries exactly one of the four atomic components: two
    # would make the row's kind — and so its cache projection — a guess.
    test "one subject cannot carry two platform components" do
      action =
        sample_action(%{
          "updates" => [
            %{
              "id" => "upd_1",
              "subject_id" => "ebb_1",
              "component" => "ebb/group",
              "method" => "replace",
              "data" => %{"value" => %{"name" => "Test"}}
            },
            %{
              "id" => "upd_2",
              "subject_id" => "ebb_1",
              "component" => "ebb/link",
              "method" => "replace",
              "data" => %{"value" => %{"source_id" => "note_1", "target_id" => "col_1"}}
            }
          ]
        })

      assert {:error, "invalid_structure", details} = ActionValidator.validate_structure(action)
      assert details =~ "one platform component"

      # The same component twice is the retried write of one row.
      repeated = update_in(action, ["updates"], &(Enum.take(&1, 1) ++ [hd(&1)]))
      assert ActionValidator.validate_structure(repeated) == :ok
    end

    test "a row-shaped data record is rejected" do
      action =
        sample_action(%{
          "updates" => [
            %{
              "id" => "upd_1",
              "subject_id" => "todo_1",
              "component" => "todo/title",
              "method" => "merge",
              "data" => %{"fields" => %{"title" => %{"value" => "x"}}}
            }
          ]
        })

      assert {:error, "invalid_structure", details} = ActionValidator.validate_structure(action)
      assert details =~ "fields record"
    end

    test "a per-update identity key is rejected" do
      update = sample_update() |> Map.put("subject_type", "todo")
      action = sample_action(%{"updates" => [update]})

      assert {:error, "invalid_structure", _} = ActionValidator.validate_structure(action)
    end

    test "a user entity with a well-formed keyed value passes" do
      action =
        sample_action(%{
          "updates" => [
            %{
              "id" => "upd_1",
              "subject_id" => "todo_1",
              "component" => "todo/content",
              "method" => "merge",
              "data" => %{
                "map" => %{
                  "a" => %{"value" => "hello", "update_id" => "u_a", "hlc" => "100"},
                  "nested" => %{
                    "map" => %{
                      "b" => %{"value" => 1, "update_id" => "u_b", "hlc" => "200"}
                    }
                  }
                }
              }
            }
          ]
        })

      assert ActionValidator.validate_structure(action) == :ok
    end

    test "map entry missing update_id rejected" do
      action =
        sample_action(%{
          "updates" => [
            %{
              "id" => "upd_1",
              "subject_id" => "todo_1",
              "component" => "todo/content",
              "method" => "merge",
              "data" => %{"map" => %{"a" => %{"value" => "hello", "hlc" => "100"}}}
            }
          ]
        })

      assert {:error, "invalid_structure", _} = ActionValidator.validate_structure(action)
    end

    test "nested map entry missing update_id rejected" do
      action =
        sample_action(%{
          "updates" => [
            %{
              "id" => "upd_1",
              "subject_id" => "todo_1",
              "component" => "todo/content",
              "method" => "merge",
              "data" => %{
                "map" => %{
                  "outer" => %{"map" => %{"inner" => %{"value" => "hello", "hlc" => "100"}}}
                }
              }
            }
          ]
        })

      assert {:error, "invalid_structure", _} = ActionValidator.validate_structure(action)
    end

    test "map discriminant that is not a map rejected" do
      action =
        sample_action(%{
          "updates" => [
            %{
              "id" => "upd_1",
              "subject_id" => "todo_1",
              "component" => "todo/content",
              "method" => "merge",
              "data" => %{"map" => "not a map"}
            }
          ]
        })

      assert {:error, "invalid_structure", _} = ActionValidator.validate_structure(action)
    end

    # The server stamps `update_id` on leaves itself, so a bare leaf stays
    # accepted without one; only map entries, which the client stamps, are
    # required to carry it.
    test "leaf without update_id still passes" do
      action =
        sample_action(%{
          "updates" => [
            %{
              "id" => "upd_1",
              "subject_id" => "todo_1",
              "component" => "todo/title",
              "method" => "replace",
              "data" => %{"value" => "Test"}
            }
          ]
        })

      assert ActionValidator.validate_structure(action) == :ok
    end

    test "replace with a keyed value is refused, naming the component" do
      action =
        sample_action(%{
          "updates" => [
            %{
              "id" => "upd_1",
              "subject_id" => "todo_1",
              "component" => "todo/content",
              "method" => "replace",
              "data" => %{"map" => %{"a" => %{"value" => 1, "update_id" => "u_a"}}}
            }
          ]
        })

      assert {:error, "invalid_structure", details} = ActionValidator.validate_structure(action)
      assert details =~ "todo/content"
      assert details =~ "replace is refused"
    end

    test "a delete carrying a component is rejected" do
      action =
        sample_action(%{
          "updates" => [
            %{
              "id" => "u_del",
              "subject_id" => "todo_1",
              "component" => "todo/title",
              "method" => "delete",
              "data" => nil
            }
          ]
        })

      assert {:error, "invalid_structure", _} = ActionValidator.validate_structure(action)
    end

    test "a delete carrying data is rejected" do
      action =
        sample_action(%{
          "updates" => [
            %{
              "id" => "u_del",
              "subject_id" => "todo_1",
              "method" => "delete",
              "data" => %{"value" => "x"}
            }
          ]
        })

      assert {:error, "invalid_structure", _} = ActionValidator.validate_structure(action)
    end

    test "a drop carrying data is rejected" do
      action =
        sample_action(%{
          "updates" => [
            %{
              "id" => "u_drop",
              "subject_id" => "todo_1",
              "component" => "todo/title",
              "method" => "drop",
              "data" => %{"value" => "x"}
            }
          ]
        })

      assert {:error, "invalid_structure", _} = ActionValidator.validate_structure(action)
    end

    test "a merge carrying no data is rejected" do
      action =
        sample_action(%{
          "updates" => [
            %{
              "id" => "upd_1",
              "subject_id" => "todo_1",
              "component" => "todo/title",
              "method" => "merge",
              "data" => nil
            }
          ]
        })

      assert {:error, "invalid_structure", _} = ActionValidator.validate_structure(action)
    end

    test "deletes name the row and pass" do
      for subject_id <- ["rel_1", "grp_1", "gm_1", "todo_1"] do
        action =
          sample_action(%{
            "updates" => [
              %{
                "id" => "u_del",
                "subject_id" => subject_id,
                "method" => "delete",
                "data" => nil
              }
            ]
          })

        assert ActionValidator.validate_structure(action) == :ok
      end
    end

    test "a drop names the row's component and passes" do
      action =
        sample_action(%{
          "updates" => [
            %{
              "id" => "u_drop",
              "subject_id" => "todo_1",
              "component" => "todo/title",
              "method" => "drop",
              "data" => nil
            }
          ]
        })

      assert ActionValidator.validate_structure(action) == :ok
    end

    test "string HLC accepted" do
      action = Map.put(sample_action(), "hlc", "#{generate_hlc()}")
      assert ActionValidator.validate_structure(action) == :ok
    end

    test "invalid update id rejected" do
      action = sample_action(%{"updates" => [sample_update(%{"id" => ""})]})
      assert {:error, "invalid_structure", _} = ActionValidator.validate_structure(action)
    end

    test "missing update subject_id rejected" do
      action = sample_action(%{"updates" => [Map.delete(sample_update(), "subject_id")]})
      assert {:error, "invalid_structure", _} = ActionValidator.validate_structure(action)
    end

    test "missing update component rejected" do
      action = sample_action(%{"updates" => [Map.delete(sample_update(), "component")]})
      assert {:error, "invalid_structure", _} = ActionValidator.validate_structure(action)
    end
  end

  describe "validate_actor/2" do
    test "matching actor passes" do
      assert ActionValidator.validate_actor(%{"actor_id" => "a_1"}, "a_1") == :ok
    end

    test "mismatched actor rejected" do
      assert {:error, "actor_mismatch", _} =
               ActionValidator.validate_actor(%{"actor_id" => "a_1"}, "a_2")
    end
  end

  describe "validate_hlc/2" do
    test "current HLC passes" do
      action = %{"hlc" => generate_hlc()}
      assert ActionValidator.validate_hlc(action) == :ok
    end

    test "string HLC passes" do
      action = %{"hlc" => "#{generate_hlc()}"}
      assert ActionValidator.validate_hlc(action) == :ok
    end

    test "future drift rejected" do
      future_hlc = hlc_from(System.os_time(:millisecond) + 200_000, 0)
      action = %{"hlc" => future_hlc}
      assert {:error, "hlc_future_drift", _} = ActionValidator.validate_hlc(action)
    end

    test "negative HLC rejected" do
      action = %{"hlc" => -1}
      assert {:error, "invalid_hlc", _} = ActionValidator.validate_hlc(action)
    end

    test "string non-integer HLC rejected" do
      action = %{"hlc" => "not_a_number"}
      assert {:error, "invalid_hlc", _} = ActionValidator.validate_hlc(action)
    end

    test "zero HLC rejected" do
      action = %{"hlc" => 0}
      assert {:error, "invalid_hlc", _} = ActionValidator.validate_hlc(action)
    end

    test "validates with custom now_ms for deterministic testing" do
      now = System.os_time(:millisecond)
      current_hlc = hlc_from(now, 0)
      action = %{"hlc" => current_hlc}

      assert ActionValidator.validate_hlc(action, now) == :ok
    end
  end

  describe "validate/3 - field leaf HLC bounds" do
    setup do
      now = System.os_time(:millisecond)
      %{now: now, action_hlc: hlc_from(now, 0)}
    end

    test "top-level leaf HLC beyond the drift window is rejected", %{
      now: now,
      action_hlc: action_hlc
    } do
      leaf_hlc = hlc_from(now + 1_000_000_000, 0)
      action = component_action(action_hlc, %{"value" => "pwned", "hlc" => leaf_hlc})

      assert {[], [rejection]} = ActionValidator.validate([action], "a_test")
      assert rejection.action_id == action["id"]
      assert rejection.reason == "invalid_field_hlc"
      assert rejection.details == "todo/title.hlc is more than 120s in the future"
    end

    test "a leaf at the drift boundary is accepted", %{now: now, action_hlc: action_hlc} do
      boundary = hlc_from(now + 120_000, 0)
      action = component_action(action_hlc, %{"value" => "edge", "hlc" => boundary})

      assert {[_], []} = ActionValidator.validate([action], "a_test", now_ms: now)
    end

    test "a leaf one millisecond past the drift boundary is rejected", %{
      now: now,
      action_hlc: action_hlc
    } do
      past = hlc_from(now + 120_001, 0)
      action = component_action(action_hlc, %{"value" => "pwned", "hlc" => past})

      assert {[], [rejection]} = ActionValidator.validate([action], "a_test", now_ms: now)
      assert rejection.reason == "invalid_field_hlc"
    end

    test "a leaf past the window is rejected even when the Action is current", %{
      now: now,
      action_hlc: action_hlc
    } do
      leaf_hlc = hlc_from(now + 121_000, 0)
      action = component_action(action_hlc, %{"value" => "pwned", "hlc" => leaf_hlc})

      assert {[], [rejection]} = ActionValidator.validate([action], "a_test")
      assert rejection.reason == "invalid_field_hlc"
    end

    test "a replace with a far-future leaf HLC is rejected", %{
      now: now,
      action_hlc: action_hlc
    } do
      leaf_hlc = hlc_from(now + 1_000_000_000, 0)

      action =
        component_action(action_hlc, %{"value" => "pwned", "hlc" => leaf_hlc}, "replace")

      assert {[], [rejection]} = ActionValidator.validate([action], "a_test")
      assert rejection.reason == "invalid_field_hlc"
    end

    test "nested map leaf HLC beyond the drift window is rejected", %{
      now: now,
      action_hlc: action_hlc
    } do
      leaf_hlc = hlc_from(now + 1_000_000_000, 0)

      value = %{
        "map" => %{
          "run_1" => %{"value" => "pwned", "update_id" => "u_run_1", "hlc" => leaf_hlc}
        }
      }

      assert {[], [rejection]} =
               ActionValidator.validate(
                 [component_action(action_hlc, value, "merge", "todo/content")],
                 "a_test"
               )

      assert rejection.reason == "invalid_field_hlc"

      assert rejection.details ==
               "todo/content.map.run_1.hlc is more than 120s in the future"
    end

    test "leaf HLC newer than the Action but inside the window is accepted", %{
      now: now,
      action_hlc: action_hlc
    } do
      leaf_hlc = hlc_from(now + 1_000, 0)
      action = component_action(action_hlc, %{"value" => "copy", "hlc" => leaf_hlc})

      assert {[_], []} = ActionValidator.validate([action], "a_test")
    end

    test "leaf HLC equal to the action HLC is accepted", %{action_hlc: action_hlc} do
      action = component_action(action_hlc, %{"value" => "ok", "hlc" => action_hlc})

      assert {[_], []} = ActionValidator.validate([action], "a_test")
    end

    test "decimal-string leaf HLC equal to the action HLC is accepted", %{action_hlc: action_hlc} do
      action = component_action(action_hlc, %{"value" => "ok", "hlc" => "#{action_hlc}"})

      assert {[_], []} = ActionValidator.validate([action], "a_test")
    end

    test "leaf HLC older than the action HLC is accepted", %{now: now, action_hlc: action_hlc} do
      leaf_hlc = hlc_from(now - 60_000, 0)
      action = component_action(action_hlc, %{"value" => "stale", "hlc" => leaf_hlc})

      assert {[_], []} = ActionValidator.validate([action], "a_test")
    end

    test "leaf without an HLC is accepted", %{action_hlc: action_hlc} do
      absent = component_action(action_hlc, %{"value" => "absent"})

      explicit_nil = component_action(action_hlc, %{"value" => "nil", "hlc" => nil})

      assert {[_, _], []} = ActionValidator.validate([absent, explicit_nil], "a_test")
    end

    test "unparseable leaf HLC is rejected", %{action_hlc: action_hlc} do
      action =
        component_action(action_hlc, %{"value" => "bad", "hlc" => "not-a-number"})

      assert {[], [rejection]} = ActionValidator.validate([action], "a_test")
      assert rejection.reason == "invalid_field_hlc"
      assert rejection.details == "todo/title.hlc must be a positive integer"
    end

    test "non-positive leaf HLC is rejected", %{action_hlc: action_hlc} do
      zero = component_action(action_hlc, %{"value" => "zero", "hlc" => 0})
      negative = component_action(action_hlc, %{"value" => "negative", "hlc" => -1})

      assert {[], rejections} = ActionValidator.validate([zero, negative], "a_test")
      assert Enum.map(rejections, & &1.reason) == ["invalid_field_hlc", "invalid_field_hlc"]
    end

    test "system component leaf HLC is validated", %{now: now, action_hlc: action_hlc} do
      action =
        sample_action(%{
          "hlc" => action_hlc,
          "updates" => [
            %{
              "id" => "gm_1",
              "subject_id" => "gm_1",
              "component" => "groupMember/actor_id",
              "method" => "merge",
              "data" => %{"value" => "a_test", "hlc" => hlc_from(now + 1_000_000_000, 0)}
            }
          ]
        })

      assert {[], [rejection]} = ActionValidator.validate([action], "a_test")
      assert rejection.reason == "invalid_field_hlc"
    end

    test "a drop carries no leaf, so no HLC is validated", %{action_hlc: action_hlc} do
      action =
        sample_action(%{
          "hlc" => action_hlc,
          "updates" => [
            %{
              "id" => "upd_drop",
              "subject_id" => "todo_1",
              "component" => "todo/title",
              "method" => "drop",
              "data" => nil
            }
          ]
        })

      assert {[_], []} = ActionValidator.validate([action], "a_test")
    end
  end

  describe "normalize_hlc/1" do
    test "integer passes through" do
      assert ActionValidator.normalize_hlc(1_700_000_000_000) == 1_700_000_000_000
    end

    test "valid string parses" do
      assert ActionValidator.normalize_hlc("1700000000000") == 1_700_000_000_000
    end

    test "invalid string returns nil" do
      assert ActionValidator.normalize_hlc("not_a_number") == nil
    end

    test "zero is valid (checked separately in validate_hlc)" do
      assert ActionValidator.normalize_hlc(0) == 0
    end

    test "negative string returns nil" do
      assert ActionValidator.normalize_hlc("-1") == nil
    end

    test "nil returns nil" do
      assert ActionValidator.normalize_hlc(nil) == nil
    end

    test "float returns nil" do
      assert ActionValidator.normalize_hlc(1.5) == nil
    end
  end

  describe "validate/3 - per-Action caps" do
    test "an Action with more than 1000 Updates is rejected" do
      action = action_with_updates(1_001)

      assert {[], [rejection]} = ActionValidator.validate([action], "a_test")
      assert rejection.action_id == action["id"]
      assert rejection.reason == "too_many_updates"
      assert rejection.details == "action has 1001 updates; the limit is 1000"
    end

    test "an Action with exactly 1000 Updates is accepted" do
      action = action_with_updates(1_000)

      assert {[accepted], []} = ActionValidator.validate([action], "a_test")
      assert length(accepted.updates) == 1_000
    end

    test "an Action over 1 MiB encoded is rejected" do
      action = action_with_bytes(1_100_000)
      assert :erlang.external_size(action) > 1_048_576

      assert {[], [rejection]} = ActionValidator.validate([action], "a_test")
      assert rejection.action_id == action["id"]
      assert rejection.reason == "action_too_large"
      assert rejection.details =~ "bytes encoded; the limit is 1048576"
    end

    test "a near-cap 2-Update Action is accepted" do
      action =
        sample_action(%{"updates" => [sample_update(), padded_update(1_000_000)]})

      size = :erlang.external_size(action)
      assert size > 1_000_000 and size <= 1_048_576

      assert {[accepted], []} = ActionValidator.validate([action], "a_test")
      assert length(accepted.updates) == 2
    end

    test "a mixed batch keeps the in-cap Actions" do
      valid = sample_action(%{"id" => "act_valid"})
      too_many = %{action_with_updates(1_001) | "id" => "act_too_many"}
      too_big = %{action_with_bytes(1_100_000) | "id" => "act_too_big"}

      assert {[accepted], [first, second]} =
               ActionValidator.validate([too_many, valid, too_big], "a_test")

      assert accepted.id == "act_valid"
      assert {first.action_id, first.reason} == {"act_too_many", "too_many_updates"}
      assert {second.action_id, second.reason} == {"act_too_big", "action_too_large"}
    end

    test "the Update count is checked before the encoded size" do
      action =
        sample_action(%{
          "updates" => [
            padded_update(1_100_000) | Enum.map(1..1_000, fn _ -> sample_update() end)
          ]
        })

      assert :erlang.external_size(action) > 1_048_576
      assert {[], [rejection]} = ActionValidator.validate([action], "a_test")
      assert rejection.reason == "too_many_updates"
    end
  end

  describe "to_validated_action/1" do
    test "converts raw action to validated format" do
      action = sample_action()
      validated = ActionValidator.to_validated_action(action)

      assert validated.id == action["id"]
      assert validated.actor_id == action["actor_id"]
      assert is_integer(validated.hlc)
      assert is_list(validated.updates)
    end

    test "method is converted to atom" do
      action = sample_action()
      validated = ActionValidator.to_validated_action(action)

      assert is_atom(hd(validated.updates).method)
    end
  end

  defp action_with_updates(count) do
    sample_action(%{"updates" => Enum.map(1..count, fn _ -> sample_update() end)})
  end

  defp action_with_bytes(payload_bytes) do
    sample_action(%{"updates" => [padded_update(payload_bytes)]})
  end

  defp padded_update(payload_bytes) do
    sample_update(%{"data" => %{"value" => String.duplicate("x", payload_bytes)}})
  end

  defp component_action(action_hlc, data, method \\ "merge", component \\ "todo/title") do
    sample_action(%{
      "hlc" => action_hlc,
      "updates" => [
        sample_update(%{"component" => component, "method" => method, "data" => data})
      ]
    })
  end
end
