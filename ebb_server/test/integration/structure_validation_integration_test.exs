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
            "subject_type" => "todo",
            "method" => "put",
            "data" => %{
              "fields" => %{
                "title" => %{"type" => "lww", "value" => "No ID Test", "hlc" => generate_hlc()}
              }
            }
          }
        ]
      }

      conn = post_actions(msgpack_encode!(%{"actions" => [action]}))
      assert conn.status == 200

      {:ok, response} = Jason.decode(conn.resp_body)
      assert response["rejected"] != []

      rejection = hd(response["rejected"])
      assert rejection["reason"] == "invalid_structure"
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
            "subject_type" => "todo",
            "method" => "upsert",
            "data" => %{
              "fields" => %{
                "title" => %{
                  "type" => "lww",
                  "value" => "Invalid Method",
                  "hlc" => generate_hlc()
                }
              }
            }
          }
        ]
      }

      conn = post_actions(msgpack_encode!(%{"actions" => [action]}))
      assert conn.status == 200

      {:ok, response} = Jason.decode(conn.resp_body)
      assert response["rejected"] != []

      rejection = hd(response["rejected"])
      assert rejection["reason"] == "invalid_structure"
    end
  end
end
