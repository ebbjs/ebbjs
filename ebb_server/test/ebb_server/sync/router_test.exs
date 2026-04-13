defmodule EbbServer.Sync.RouterTest do
  use ExUnit.Case, async: false
  use EbbServer.Integration.StorageCase, with_auth_mode: true

  import Plug.Test
  import Plug.Conn
  alias EbbServer.Sync.Router
  alias EbbServer.Storage.{GroupCache, RelationshipCache}

  defp post_presence(body, actor_id \\ "a_member") do
    conn(:post, "/sync/presence", Jason.encode!(body))
    |> put_req_header("content-type", "application/json")
    |> put_req_header("x-ebb-actor-id", actor_id)
    |> Router.call([])
  end

  defp setup_entity_relationship(entity_id, group_id) do
    rel_id = "rel_" <> Nanoid.generate()

    :ok =
      RelationshipCache.put_relationship(%{
        id: rel_id,
        source_id: entity_id,
        target_id: group_id,
        type: "todo",
        field: "group"
      })
  end

  defp setup_group_membership(actor_id, group_id, permissions \\ ["read", "write"]) do
    gm_id = "gm_" <> Nanoid.generate()

    :ok =
      GroupCache.put_group_member(%{
        id: gm_id,
        actor_id: actor_id,
        group_id: group_id,
        permissions: permissions
      })
  end

  describe "POST /sync/presence" do
    test "204 on success - valid presence broadcast for entity in subscribed group" do
      entity_id = "todo_xyz"
      group_id = "g_test"
      actor_id = "a_member"

      setup_group_membership(actor_id, group_id)
      setup_entity_relationship(entity_id, group_id)

      conn =
        post_presence(
          %{
            "entity_id" => entity_id,
            "data" => %{"cursor" => %{"line" => 5, "col" => 12}}
          },
          actor_id
        )

      assert conn.status == 204
    end

    test "404 for unknown entity - entity belongs to no group" do
      conn =
        post_presence(
          %{
            "entity_id" => "unknown_entity",
            "data" => %{"cursor" => %{"line" => 1, "col" => 1}}
          },
          "a_member"
        )

      assert conn.status == 404
      {:ok, response} = Jason.decode(conn.resp_body)
      assert response["error"] == "entity_not_found"
    end

    test "403 for non-member - actor not in entity's group" do
      entity_id = "todo_xyz"
      group_id = "g_private"
      actor_id = "a_outsider"

      setup_group_membership("a_member", group_id)
      setup_entity_relationship(entity_id, group_id)

      conn =
        post_presence(
          %{
            "entity_id" => entity_id,
            "data" => %{"cursor" => %{"line" => 5, "col" => 12}}
          },
          actor_id
        )

      assert conn.status == 403
      {:ok, response} = Jason.decode(conn.resp_body)
      assert response["error"] == "not_member"
    end

    test "422 for missing entity_id" do
      conn =
        post_presence(
          %{
            "data" => %{"cursor" => %{"line" => 5, "col" => 12}}
          },
          "a_member"
        )

      assert conn.status == 422
      {:ok, response} = Jason.decode(conn.resp_body)
      assert response["error"] == "validation_failed"
    end

    test "422 for empty entity_id" do
      conn =
        post_presence(
          %{
            "entity_id" => "",
            "data" => %{"cursor" => %{"line" => 5, "col" => 12}}
          },
          "a_member"
        )

      assert conn.status == 422
      {:ok, response} = Jason.decode(conn.resp_body)
      assert response["error"] == "validation_failed"
    end

    test "422 for invalid JSON" do
      conn =
        conn(:post, "/sync/presence", "not json")
        |> put_req_header("content-type", "application/json")
        |> put_req_header("x-ebb-actor-id", "a_member")
        |> Router.call([])

      assert conn.status == 422
      {:ok, response} = Jason.decode(conn.resp_body)
      assert response["error"] == "invalid_json"
    end

    test "422 when entity_id is not a string" do
      conn =
        post_presence(
          %{
            "entity_id" => 123,
            "data" => %{"cursor" => %{"line" => 5, "col" => 12}}
          },
          "a_member"
        )

      assert conn.status == 422
    end
  end
end
