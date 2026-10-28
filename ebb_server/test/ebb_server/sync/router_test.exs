defmodule EbbServer.Sync.RouterTest do
  use ExUnit.Case, async: false
  use EbbServer.Integration.StorageCase, with_auth_mode: true

  import Plug.Test
  import Plug.Conn
  alias EbbServer.Storage.{CacheTables, EntityGroupCache, GroupCache, WatermarkTracker}
  alias EbbServer.Sync.Router

  defp post_presence(body, actor_id \\ "a_member") do
    conn(:post, "/sync/presence", Jason.encode!(body))
    |> put_req_header("content-type", "application/json")
    |> put_req_header("x-ebb-actor-id", actor_id)
    |> Router.call([])
  end

  defp setup_entity_group(entity_id, group_id) do
    eg_id = "eg_" <> Nanoid.generate()

    :ok =
      EntityGroupCache.put_entity_group(
        %{id: eg_id, entity_id: entity_id, group_id: group_id},
        entity_groups: CacheTables.entity_groups(),
        entity_groups_by_id: CacheTables.entity_groups_by_id(),
        entity_groups_by_group: CacheTables.entity_groups_by_group()
      )
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
      setup_entity_group(entity_id, group_id)

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

    test "404 for non-member - actor not in entity's group" do
      entity_id = "todo_xyz"
      group_id = "g_private"
      actor_id = "a_outsider"

      setup_group_membership("a_member", group_id)
      setup_entity_group(entity_id, group_id)

      conn =
        post_presence(
          %{
            "entity_id" => entity_id,
            "data" => %{"cursor" => %{"line" => 5, "col" => 12}}
          },
          actor_id
        )

      assert conn.status == 404
      {:ok, response} = Jason.decode(conn.resp_body)
      assert response["error"] == "entity_not_found"
    end

    test "a foreign entity and a missing entity are indistinguishable" do
      foreign_id = "todo_foreign"
      group_id = "g_someone_else"
      actor_id = "a_outsider"
      data = %{"data" => %{"cursor" => %{"line" => 5, "col" => 12}}}

      setup_group_membership("a_member", group_id)
      setup_entity_group(foreign_id, group_id)

      foreign = post_presence(Map.put(data, "entity_id", foreign_id), actor_id)
      missing = post_presence(Map.put(data, "entity_id", "todo_missing"), actor_id)

      assert {foreign.status, foreign.resp_body} == {missing.status, missing.resp_body}
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

  describe "GET /healthz" do
    test "200 with no auth headers at all" do
      conn = conn(:get, "/healthz") |> Router.call([])

      assert conn.status == 200
      assert Jason.decode!(conn.resp_body) == %{"status" => "ok"}
    end

    test "503 with no internals when the storage tree is not answering" do
      sqlite = Process.whereis(EbbServer.Storage.SQLite)
      assert is_pid(sqlite)

      :ok = :sys.suspend(sqlite)
      on_exit(fn -> if Process.alive?(sqlite), do: :sys.resume(sqlite) end)

      conn = conn(:get, "/healthz") |> Router.call([])

      assert conn.status == 503
      assert Jason.decode!(conn.resp_body) == %{"status" => "unavailable"}
    end

    test "503 with no internals when the probe reports a degraded state" do
      gsn_ref = :persistent_term.get({WatermarkTracker, :gsn_ref})
      invalid = :atomics.new(1, signed: true)
      :atomics.put(invalid, 1, -1)

      :persistent_term.put({WatermarkTracker, :gsn_ref}, invalid)
      on_exit(fn -> :persistent_term.put({WatermarkTracker, :gsn_ref}, gsn_ref) end)

      conn = conn(:get, "/healthz") |> Router.call([])

      assert conn.status == 503
      assert Jason.decode!(conn.resp_body) == %{"status" => "unavailable"}
    end

    test "503 with no internals when a probe raises" do
      gsn_ref = :persistent_term.get({WatermarkTracker, :gsn_ref})

      :persistent_term.put({WatermarkTracker, :gsn_ref}, :not_an_atomics)
      on_exit(fn -> :persistent_term.put({WatermarkTracker, :gsn_ref}, gsn_ref) end)

      conn = conn(:get, "/healthz") |> Router.call([])

      assert conn.status == 503
      assert Jason.decode!(conn.resp_body) == %{"status" => "unavailable"}
    end

    test "requires no actor header while /sync/handshake still does" do
      health = conn(:get, "/healthz") |> Router.call([])
      assert health.status == 200

      handshake =
        conn(:post, "/sync/handshake", Jason.encode!(%{}))
        |> put_req_header("content-type", "application/json")
        |> Router.call([])

      assert handshake.status == 401
    end
  end
end
