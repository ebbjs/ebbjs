defmodule EbbServer.StructureValidationIntegrationTest do
  use ExUnit.Case, async: false
  use EbbServer.Integration.StorageCase

  import EbbServer.TestHelpers
  import EbbServer.Integration.ActionHelpers

  describe "structure validation" do
    test "structure validation rejects missing action id" do
      action = %{
        "actor_id" => "a_test",
        "hlc" => generate_hlc(),
        "updates" => [
          %{
            "id" => "upd_no_id_" <> Nanoid.generate(),
            "subject_id" => "todo_no_id",
            "component" => "todo/title",
            "method" => "replace",
            "data" => %{"type" => "lww", "value" => "No ID Test", "hlc" => generate_hlc()}
          }
        ]
      }

      rejection = submit_one(action)
      assert rejection["reason"] == "invalid_structure"
      assert rejection["details"] == "action id must be a non-empty string"
    end

    test "structure validation rejects invalid method" do
      action = %{
        "id" => "act_invalid_method_" <> Nanoid.generate(),
        "actor_id" => "a_test",
        "hlc" => generate_hlc(),
        "updates" => [
          %{
            "id" => "upd_inv_method_" <> Nanoid.generate(),
            "subject_id" => "todo_inv_method",
            "component" => "todo/title",
            "method" => "upsert",
            "data" => %{"type" => "lww", "value" => "Invalid Method", "hlc" => generate_hlc()}
          }
        ]
      }

      rejection = submit_one(action)
      assert rejection["reason"] == "invalid_structure"
      assert rejection["details"] == "update method must be one of: merge, replace, drop, delete"
    end

    test "an Update without a component is refused" do
      action = %{
        "id" => "act_no_component_" <> Nanoid.generate(),
        "actor_id" => "a_test",
        "hlc" => generate_hlc(),
        "updates" => [
          %{
            "id" => "upd_no_component_" <> Nanoid.generate(),
            "subject_id" => "todo_no_component",
            "method" => "merge",
            "data" => %{"type" => "lww", "value" => "No Component", "hlc" => generate_hlc()}
          }
        ]
      }

      rejection = submit_one(action)
      assert rejection["reason"] == "invalid_structure"
      assert rejection["details"] =~ "update component must be <model>/<field>"
      assert rejection["details"] =~ "nil"
    end

    test "a pre-component identity key is an unknown key" do
      # The old wire named the row's type on the Update. Built from parts so
      # the superseded key itself does not linger in the suite.
      legacy_key = "subject_" <> "type"

      update =
        %{
          "id" => "upd_legacy_" <> Nanoid.generate(),
          "subject_id" => "todo_legacy",
          "component" => "todo/title",
          "method" => "replace",
          "data" => %{"type" => "lww", "value" => "Legacy", "hlc" => generate_hlc()}
        }
        |> Map.put(legacy_key, "todo")

      rejection =
        submit_one(%{
          "id" => "act_legacy_" <> Nanoid.generate(),
          "actor_id" => "a_test",
          "hlc" => generate_hlc(),
          "updates" => [update]
        })

      assert rejection["reason"] == "invalid_structure"
      assert rejection["details"] == "update has unknown keys: #{legacy_key}"
    end

    test "replace is refused for a keyed component" do
      hlc = generate_hlc()

      rejection =
        submit_one(%{
          "id" => "act_keyed_" <> Nanoid.generate(),
          "actor_id" => "a_test",
          "hlc" => hlc,
          "updates" => [
            component_update(
              "upd_keyed_" <> Nanoid.generate(),
              "g_keyed",
              "group/apps",
              "replace",
              group_apps_field(%{"notes" => true}, hlc, "upd_apps")
            )
          ]
        })

      assert rejection["reason"] == "invalid_structure"
      assert rejection["details"] =~ ~s("group/apps")
      assert rejection["details"] =~ "replace is refused"
    end
  end

  defp submit_one(action) do
    conn = post_actions(msgpack_encode!(%{"actions" => [action]}))
    assert conn.status == 200

    {:ok, response} = Jason.decode(conn.resp_body)
    assert [_rejection] = response["rejected"]
    hd(response["rejected"])
  end
end
