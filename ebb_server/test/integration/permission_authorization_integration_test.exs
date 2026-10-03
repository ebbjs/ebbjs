defmodule EbbServer.PermissionAuthorizationIntegrationTest do
  use ExUnit.Case, async: false
  use EbbServer.Integration.StorageCase

  import EbbServer.TestHelpers
  import EbbServer.Integration.ActionHelpers
  import Plug.Conn
  import Plug.Test

  alias EbbServer.Storage.SQLite
  alias EbbServer.Sync.Router

  describe "multi-group membership" do
    test "authorizes by union and indexes the action into every group" do
      # The actor holds `todo.create` only in group_2; the write must be
      # authorized by the union across group_1 and group_2, and must reach
      # both groups' action streams.
      bootstrap_group("actor_1", "group_1", ["todo.read"])
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
          member_edge(entity_id, "group_1", hlc),
          member_edge(entity_id, "group_2", hlc)
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

      conn =
        write_entity_in_group("actor_1", entity_id, "todo", "group_1", %{
          "title" => %{"type" => "lww", "value" => "Authorized Todo", "hlc" => hlc}
        })

      assert conn.status == 200

      {:ok, response} = Jason.decode(conn.resp_body)
      assert response == %{"rejected" => []}

      conn = get_entity(entity_id, "actor_1")
      assert conn.status == 200

      {:ok, entity} = Jason.decode(conn.resp_body)
      assert entity["data"]["fields"]["title"]["value"] == "Authorized Todo"
    end

    test "intra-action resolution: new entity + relationship in same action" do
      bootstrap_group("actor_1", "group_1", ["todo.*", "post.*"])

      entity_id = "todo_intra_1"
      hlc = generate_hlc()
      rel_id = "rel_intra_" <> Nanoid.generate()

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
          %{
            "id" => rel_id,
            "subject_id" => rel_id,
            "subject_type" => "relationship",
            "method" => "put",
            "data" => %{
              "fields" => %{
                "source_id" => %{"type" => "lww", "value" => entity_id, "hlc" => hlc},
                "target_id" => %{"type" => "lww", "value" => "group_1", "hlc" => hlc},
                "type" => %{"type" => "lww", "value" => "todo", "hlc" => hlc},
                "field" => %{"type" => "lww", "value" => "group", "hlc" => hlc},
                "kind" => %{"type" => "lww", "value" => "member", "hlc" => hlc}
              }
            }
          }
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

    test "entity put with no membership is rejected as missing_ownership" do
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
                "title" => %{"type" => "lww", "value" => "Unowned", "hlc" => hlc}
              }
            }
          }
        ]
      }

      conn = post_actions(msgpack_encode!(%{"actions" => [action]}), "actor_1")
      assert conn.status == 200

      rejection = conn.resp_body |> Jason.decode!() |> Map.fetch!("rejected") |> hd()
      assert rejection["reason"] == "missing_ownership"
      assert rejection["details"] =~ "membership"

      # The rejection precedes materialization: the entity must not exist
      # in storage, the symptom #245 is fixing.
      assert SQLite.get_entity(entity_id) == :not_found
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

  defp member_edge(entity_id, group_id, hlc) do
    rel_id = "rel_#{Nanoid.generate()}"

    %{
      "id" => rel_id,
      "subject_id" => rel_id,
      "subject_type" => "relationship",
      "method" => "put",
      "data" => %{
        "fields" => %{
          "source_id" => %{"type" => "lww", "value" => entity_id, "hlc" => hlc},
          "target_id" => %{"type" => "lww", "value" => group_id, "hlc" => hlc},
          "type" => %{"type" => "lww", "value" => "todo", "hlc" => hlc},
          "field" => %{"type" => "lww", "value" => "group", "hlc" => hlc},
          "kind" => %{"type" => "lww", "value" => "member", "hlc" => hlc}
        }
      }
    }
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
