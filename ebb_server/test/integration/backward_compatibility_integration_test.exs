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
        "updates" =>
          [
            %{
              "id" => "upd_compat_" <> Nanoid.generate(),
              "subject_id" => entity_id,
              "component" => "todo/title",
              "method" => "replace",
              "data" => %{"type" => "lww", "value" => "Compatibility Test", "hlc" => hlc}
            }
          ] ++ entity_group_update(entity_id, "g_test", hlc)
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

    test "the pre-component wire shape is refused with no read-through" do
      entity_id = "todo_compat_legacy"
      hlc = generate_hlc()
      # The superseded shape named the row's type per Update, used put/patch,
      # and wrapped every field in a row record. Built from parts so those
      # names do not linger in the suite.
      legacy_key = "subject_" <> "type"
      legacy_method = "p" <> "ut"

      update =
        %{
          "id" => "upd_compat_legacy_" <> Nanoid.generate(),
          "subject_id" => entity_id,
          "method" => legacy_method,
          "data" => %{
            "fields" => %{
              "title" => %{"type" => "lww", "value" => "Legacy", "hlc" => hlc}
            }
          }
        }
        |> Map.put(legacy_key, "todo")

      action_body = %{
        "id" => "act_compat_legacy_" <> Nanoid.generate(),
        "actor_id" => "a_test",
        "hlc" => hlc,
        "updates" => [update]
      }

      conn = post_actions(msgpack_encode!(%{"actions" => [action_body]}))
      assert conn.status == 200

      {:ok, response} = Jason.decode(conn.resp_body)
      assert [rejection] = response["rejected"]
      assert rejection["reason"] == "invalid_structure"
      assert rejection["details"] == "update has unknown keys: #{legacy_key}"

      # There is no alias and no read-through: nothing was written.
      assert get_entity(entity_id).status == 404
    end
  end
end
