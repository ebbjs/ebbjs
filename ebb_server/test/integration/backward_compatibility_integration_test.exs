defmodule EbbServer.BackwardCompatibilityIntegrationTest do
  use ExUnit.Case, async: false
  use EbbServer.Integration.StorageCase

  import EbbServer.TestHelpers
  import EbbServer.Integration.ActionHelpers

  describe "backward compatibility" do
    setup do
      bootstrap_group("a_test", "g_test", ["todo.*", "post.*"])
      :ok
    end

    test "existing Slice 1 flows still work" do
      entity_id = "todo_compat_1"
      hlc = generate_hlc()

      action_body = %{
        "id" => "act_compat_" <> Nanoid.generate(),
        "actor_id" => "a_test",
        "hlc" => hlc,
        "updates" => [
          %{
            "id" => "upd_compat_" <> Nanoid.generate(),
            "subject_id" => entity_id,
            "subject_type" => "todo",
            "method" => "put",
            "data" => %{
              "fields" => %{
                "title" => %{"type" => "lww", "value" => "Compatibility Test", "hlc" => hlc}
              }
            }
          }
        ]
      }

      conn = post_actions(msgpack_encode!(%{"actions" => [action_body]}))
      assert conn.status == 200

      {:ok, response} = Jason.decode(conn.resp_body)
      assert response == %{"rejected" => []}

      conn = get_entity(entity_id)
      assert conn.status == 200

      {:ok, entity} = Jason.decode(conn.resp_body)
      assert entity["id"] == entity_id
      assert entity["data"]["fields"]["title"]["value"] == "Compatibility Test"
    end
  end
end
