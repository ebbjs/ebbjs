defmodule EbbServer.PermissionAuthorizationIntegrationTest do
  use ExUnit.Case, async: false
  use EbbServer.Integration.StorageCase

  import EbbServer.TestHelpers
  import EbbServer.Integration.ActionHelpers
  import Plug.Conn
  import Plug.Test

  alias EbbServer.Sync.Router

  describe "multi-group membership" do
    test "indexes a same-action multi-group create into every target group" do
      # Each target group is checked for the entity's own `todo.create`
      # (#121 "Add Entity to Group"), so the actor holds it in both. The
      # write must reach both groups' action streams. The union across an
      # entity's groups is covered by the user-entity authorizer tests.
      bootstrap_group("actor_1", "group_1", ["todo.create", "todo.read"])
      bootstrap_group("actor_1", "group_2", ["todo.create", "todo.read"])

      hlc = generate_hlc()
      entity_id = "todo_multi_#{Nanoid.generate()}"

      action = %{
        "id" => "act_multi_#{Nanoid.generate()}",
        "actor_id" => "actor_1",
        "hlc" => hlc,
        "updates" => [
          %{
            "id" => "upd_multi_#{Nanoid.generate()}",
            "subject_id" => entity_id,
            "subject_type" => "todo",
            "method" => "put",
            "data" => %{
              "fields" => %{"title" => %{"type" => "lww", "value" => "Multi", "hlc" => hlc}}
            }
          },
          entity_group_update(entity_id, "group_1", hlc),
          entity_group_update(entity_id, "group_2", hlc)
        ]
      }

      conn = post_actions(msgpack_encode!(%{"actions" => [action]}), "actor_1")
      assert conn.status == 200
      assert Jason.decode!(conn.resp_body) == %{"rejected" => []}

      Process.sleep(50)

      assert entity_id in action_ids("group_1", "actor_1")
      assert entity_id in action_ids("group_2", "actor_1")
    end
  end

  describe "authorized write" do
    setup do
      bootstrap_group("actor_1", "group_1", ["todo.create", "todo.read"])
      :ok
    end

    test "authorized write to actor's group accepted" do
      entity_id = "todo_auth_1"
      hlc = generate_hlc()

      action_body = %{
        "id" => "act_auth_" <> Nanoid.generate(),
        "actor_id" => "actor_1",
        "hlc" => hlc,
        "updates" => [
          %{
            "id" => "upd_auth_" <> Nanoid.generate(),
            "subject_id" => entity_id,
            "subject_type" => "todo",
            "method" => "put",
            "data" => %{
              "fields" => %{
                "title" => %{"type" => "lww", "value" => "Authorized Todo", "hlc" => hlc}
              }
            }
          },
          entity_group_update(entity_id, "group_1", hlc)
        ]
      }

      conn = post_actions(msgpack_encode!(%{"actions" => [action_body]}), "actor_1")
      assert conn.status == 200

      {:ok, response} = Jason.decode(conn.resp_body)
      assert response == %{"rejected" => []}

      conn = get_entity(entity_id, "actor_1")
      assert conn.status == 200

      {:ok, entity} = Jason.decode(conn.resp_body)
      assert entity["data"]["fields"]["title"]["value"] == "Authorized Todo"
    end

    test "intra-action resolution: new entity + entityGroup in same action" do
      bootstrap_group("actor_1", "group_1", ["todo.*", "post.*"])

      entity_id = "todo_intra_1"
      hlc = generate_hlc()

      action = %{
        "id" => "act_intra_" <> Nanoid.generate(),
        "actor_id" => "actor_1",
        "hlc" => hlc,
        "updates" => [
          %{
            "id" => "upd_intra_" <> Nanoid.generate(),
            "subject_id" => entity_id,
            "subject_type" => "todo",
            "method" => "put",
            "data" => %{
              "fields" => %{
                "title" => %{"type" => "lww", "value" => "Intra Action", "hlc" => hlc}
              }
            }
          },
          entity_group_update(entity_id, "group_1", hlc)
        ]
      }

      conn = post_actions(msgpack_encode!(%{"actions" => [action]}), "actor_1")
      assert conn.status == 200

      {:ok, response} = Jason.decode(conn.resp_body)
      assert response == %{"rejected" => []}

      conn = get_entity(entity_id, "actor_1")
      assert conn.status == 200

      {:ok, entity} = Jason.decode(conn.resp_body)
      assert entity["data"]["fields"]["title"]["value"] == "Intra Action"
    end
  end

  describe "unauthorized write rejection" do
    setup do
      bootstrap_group("actor_1", "group_1", ["todo.*", "post.*"])
      :ok
    end

    test "write to group actor does NOT belong to is rejected" do
      entity_id = "todo_unauth_1"
      hlc = generate_hlc()

      fields = %{
        "title" => %{"type" => "lww", "value" => "Unauthorized Todo", "hlc" => hlc}
      }

      conn = write_entity_in_group("actor_2", entity_id, "todo", "group_1", fields)
      assert conn.status == 200

      {:ok, response} = Jason.decode(conn.resp_body)
      assert response["rejected"] != []

      rejection = hd(response["rejected"])
      assert rejection["reason"] == "not_authorized"
    end

    test "create with no group membership is rejected as missing_ownership" do
      entity_id = "todo_unowned_1"
      hlc = generate_hlc()

      action = %{
        "id" => "act_unowned_" <> Nanoid.generate(),
        "actor_id" => "actor_1",
        "hlc" => hlc,
        "updates" => [
          %{
            "id" => "upd_unowned_" <> Nanoid.generate(),
            "subject_id" => entity_id,
            "subject_type" => "todo",
            "method" => "put",
            "data" => %{
              "fields" => %{
                "title" => %{"type" => "lww", "value" => "Unowned Todo", "hlc" => hlc}
              }
            }
          }
        ]
      }

      conn = post_actions(msgpack_encode!(%{"actions" => [action]}), "actor_1")
      assert conn.status == 200

      {:ok, response} = Jason.decode(conn.resp_body)
      rejection = hd(response["rejected"])
      assert rejection["reason"] == "missing_ownership"
      assert is_binary(rejection["details"])

      # The structural rejection must keep the unowned entity out of storage.
      assert get_entity(entity_id, "actor_1").status == 404
    end

    test "actor identity mismatch is rejected" do
      entity_id = "todo_mismatch_1"
      hlc = generate_hlc()

      action = %{
        "id" => "act_mismatch_" <> Nanoid.generate(),
        "actor_id" => "actor_1",
        "hlc" => hlc,
        "updates" => [
          %{
            "id" => "upd_mismatch_" <> Nanoid.generate(),
            "subject_id" => entity_id,
            "subject_type" => "todo",
            "method" => "put",
            "data" => %{
              "fields" => %{
                "title" => %{"type" => "lww", "value" => "Mismatch Test", "hlc" => hlc}
              }
            }
          }
        ]
      }

      conn = post_actions(msgpack_encode!(%{"actions" => [action]}), "actor_2")
      assert conn.status == 200

      {:ok, response} = Jason.decode(conn.resp_body)
      assert response["rejected"] != []

      rejection = hd(response["rejected"])
      assert rejection["reason"] == "actor_mismatch"
    end
  end

  defp action_ids(group_id, actor_id) do
    conn =
      conn(:get, "/sync/groups/#{group_id}")
      |> put_req_header("x-ebb-actor-id", actor_id)
      |> Router.call([])

    conn.resp_body
    |> Jason.decode!()
    |> Enum.flat_map(& &1["updates"])
    |> Enum.map(& &1["subject_id"])
  end
end
