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

      assert ActionValidator.validate_structure(action) == :ok
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

      assert {:error, "invalid_structure", _} = ActionValidator.validate_structure(action)
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

    test "missing update subject_type rejected" do
      action = sample_action(%{"updates" => [Map.delete(sample_update(), "subject_type")]})
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

    test "stale HLC rejected" do
      stale_hlc = hlc_from(System.os_time(:millisecond) - 100_000_000, 0)
      action = %{"hlc" => stale_hlc}
      assert {:error, "hlc_stale", _} = ActionValidator.validate_hlc(action)
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
end
