defmodule EbbServer.Sync.SSEHandlerTest do
  @moduledoc """
  Integration tests for SSEHandler and the /sync/live route.

  Uses EbbServer.Integration.StorageCase for test infrastructure.
  """

  use ExUnit.Case, async: false
  use EbbServer.Integration.StorageCase, with_auth_mode: true

  import Plug.Test
  import Plug.Conn

  alias EbbServer.Sync.Router

  describe "open_sse/4" do
    test "returns {:error, :not_member} when actor is not a member of the group" do
      cursor = 0

      result =
        EbbServer.Sync.SSEHandler.open_sse(self(), ["nonexistent_group"], cursor, "stranger")

      assert result == {:error, :not_member}
    end
  end

  describe "GET /sync/live" do
    test "returns 403 when actor is not a member of requested group", %{tmp_dir: _tmp_dir} do
      conn =
        conn(:get, "/sync/live?groups=some_group&cursor=0")
        |> put_req_header("x-ebb-actor-id", "outsider_actor")
        |> Router.call([])

      assert conn.status == 403
      {:ok, response} = Jason.decode(conn.resp_body)
      assert response == %{"error" => "not_member"}
    end

    test "returns 400 for invalid cursor param", %{tmp_dir: _tmp_dir} do
      actor_id = "a_test_#{:erlang.unique_integer([:positive])}"
      group_id = "g_test_#{:erlang.unique_integer([:positive])}"

      EbbServer.Storage.GroupCache.put_group_member(%{
        id: "gm_test",
        actor_id: actor_id,
        group_id: group_id,
        permissions: ["read"]
      })

      conn =
        conn(:get, "/sync/live?groups=#{group_id}&cursor=abc")
        |> put_req_header("x-ebb-actor-id", actor_id)
        |> Router.call([])

      assert conn.status == 400
      {:ok, response} = Jason.decode(conn.resp_body)
      assert response == %{"error" => "invalid_params"}
    end

    test "returns 400 when groups param is empty", %{tmp_dir: _tmp_dir} do
      actor_id = "a_test_#{:erlang.unique_integer([:positive])}"

      conn =
        conn(:get, "/sync/live?groups=&cursor=0")
        |> put_req_header("x-ebb-actor-id", actor_id)
        |> Router.call([])

      assert conn.status == 400
      {:ok, response} = Jason.decode(conn.resp_body)
      assert response == %{"error" => "invalid_params"}
    end
  end
end
