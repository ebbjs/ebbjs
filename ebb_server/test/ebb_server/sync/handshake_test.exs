defmodule EbbServer.Sync.HandshakeTest do
  use ExUnit.Case, async: false
  # Every test drives the real Writer and fan-out, so it needs the sync
  # tree's Registry alongside storage. Depending on one left behind by an
  # earlier test is what made this module flaky (ebbjs/ebbjs#653).
  use EbbServer.Integration.StorageCase, with_auth_mode: true

  import Plug.Test
  import Plug.Conn
  import EbbServer.TestHelpers
  alias EbbServer.Sync.Router

  defp post_handshake(body, actor_id \\ "a_test") do
    conn(:post, "/sync/handshake", Jason.encode!(body))
    |> put_req_header("content-type", "application/json")
    |> put_req_header("x-ebb-actor-id", actor_id)
    |> Router.call([])
  end

  defp post_actions(body, actor_id \\ "a_test") do
    owner = self()
    ref = make_ref()

    state = %{
      method: "POST",
      params: %{},
      req_body: body,
      chunks: nil,
      ref: ref,
      owner: owner,
      http_protocol: :"HTTP/1.1",
      peer_data: %{address: {127, 0, 0, 1}, port: 111_317, ssl_cert: nil},
      sock_data: %{address: {127, 0, 0, 1}, port: 111_318},
      ssl_data: nil
    }

    conn =
      %Plug.Conn{}
      |> Map.put(:method, "POST")
      |> Map.put(:path_info, ["sync", "actions"])
      |> Map.put(:request_path, "/sync/actions")
      |> Map.put(:query_string, "")
      |> Map.put(:query_params, %Plug.Conn.Unfetched{aspect: :query_params})
      |> Map.put(:body_params, %Plug.Conn.Unfetched{aspect: :body_params})
      |> Map.put(:params, %Plug.Conn.Unfetched{aspect: :params})
      |> Map.put(:req_headers, [
        {"content-type", "application/msgpack"},
        {"x-ebb-actor-id", actor_id}
      ])
      |> Map.put(:host, "www.example.com")
      |> Map.put(:port, 80)
      |> Map.put(:remote_ip, {127, 0, 0, 1})
      |> Map.put(:scheme, :http)
      |> Map.put(:adapter, {Plug.Adapters.Test.Conn, state})

    Router.call(conn, [])
  end

  defp msgpack_encode!(data) do
    data |> Msgpax.pack!() |> IO.iodata_to_binary()
  end

  defp bootstrap_group(actor_id, group_id, permissions) do
    hlc = generate_hlc()
    gm_id = "gm_" <> Nanoid.generate()

    action = %{
      "id" => "act_bootstrap_" <> Nanoid.generate(),
      "actor_id" => actor_id,
      "hlc" => hlc,
      "updates" => [
        %{
          "id" => "upd_group_" <> Nanoid.generate(),
          "subject_id" => group_id,
          "subject_type" => "group",
          "method" => "put",
          "data" => %{
            "fields" => %{"name" => %{"type" => "lww", "value" => "Test Group", "hlc" => hlc}}
          }
        },
        %{
          "id" => gm_id,
          "subject_id" => gm_id,
          "subject_type" => "groupMember",
          "method" => "put",
          "data" => %{
            "fields" => %{
              "actor_id" => %{"type" => "lww", "value" => actor_id, "hlc" => hlc},
              "group_id" => %{"type" => "lww", "value" => group_id, "hlc" => hlc},
              "permissions" => %{"type" => "lww", "value" => permissions, "hlc" => hlc}
            }
          }
        }
      ]
    }

    post_actions(msgpack_encode!(%{"actions" => [action]}), actor_id)
    :ok
  end

  describe "POST /sync/handshake" do
    test "handshake with no groups returns empty list" do
      conn = post_handshake(%{"cursors" => %{}, "schema_version" => 1}, "a_new")

      assert conn.status == 200
      {:ok, response} = Jason.decode(conn.resp_body)
      assert response["actor_id"] == "a_new"
      assert response["groups"] == []
    end

    test "handshake returns actor's groups after bootstrap" do
      bootstrap_group("a_test", "g_1", ["todo.create", "todo.update"])

      conn = post_handshake(%{"cursors" => %{}, "schema_version" => 1}, "a_test")

      assert conn.status == 200
      {:ok, response} = Jason.decode(conn.resp_body)
      assert response["actor_id"] == "a_test"
      assert length(response["groups"]) == 1
      assert response["groups"] |> hd() |> Map.get("id") == "g_1"

      assert response["groups"] |> hd() |> Map.get("permissions") == [
               "todo.create",
               "todo.update"
             ]
    end

    test "handshake with invalid JSON returns 422" do
      conn =
        conn(:post, "/sync/handshake", "not json")
        |> put_req_header("content-type", "application/json")
        |> put_req_header("x-ebb-actor-id", "a_test")
        |> Router.call([])

      assert conn.status == 422
      {:ok, response} = Jason.decode(conn.resp_body)
      assert response["error"] == "invalid_json"
    end

    test "handshake without auth returns 401" do
      conn =
        conn(:post, "/sync/handshake", Jason.encode!(%{}))
        |> put_req_header("content-type", "application/json")
        |> Router.call([])

      assert conn.status == 401
    end

    test "handshake accepts cursors (stub validation)" do
      conn = post_handshake(%{"cursors" => %{"g_1" => 100}, "schema_version" => 1}, "a_test")

      assert conn.status == 200
    end

    test "valid cursor at or below watermark returns cursor_valid true" do
      bootstrap_group("a_cursor_test", "g_valid", ["read"])

      conn =
        post_handshake(%{"cursors" => %{"g_valid" => 0}, "schema_version" => 1}, "a_cursor_test")

      assert conn.status == 200
      {:ok, response} = Jason.decode(conn.resp_body)
      assert length(response["groups"]) == 1

      group = hd(response["groups"])
      assert group["id"] == "g_valid"
      assert group["cursor_valid"] == true
      assert group["reason"] == nil
      assert group["cursor"] == 0
    end

    test "stale cursor above watermark returns cursor_valid false" do
      bootstrap_group("a_stale_test", "g_stale", ["read"])

      conn =
        post_handshake(
          %{"cursors" => %{"g_stale" => 999_999}, "schema_version" => 1},
          "a_stale_test"
        )

      assert conn.status == 200
      {:ok, response} = Jason.decode(conn.resp_body)

      group = hd(response["groups"])
      assert group["cursor_valid"] == false
      assert group["reason"] == "behind_watermark"
      assert is_integer(group["cursor"])
    end

    test "multiple groups with mixed cursor validity" do
      bootstrap_group("a_multi_test", "g_1", ["read"])
      bootstrap_group("a_multi_test", "g_2", ["read"])

      conn =
        post_handshake(
          %{"cursors" => %{"g_1" => 0, "g_2" => 999_999}, "schema_version" => 1},
          "a_multi_test"
        )

      assert conn.status == 200
      {:ok, response} = Jason.decode(conn.resp_body)
      assert length(response["groups"]) == 2

      groups = Enum.into(response["groups"], %{}, fn g -> {g["id"], g} end)

      assert groups["g_1"]["cursor_valid"] == true
      assert groups["g_1"]["reason"] == nil

      assert groups["g_2"]["cursor_valid"] == false
      assert groups["g_2"]["reason"] == "behind_watermark"
    end

    test "missing cursors defaults to 0 for all groups" do
      bootstrap_group("a_no_cursors", "g_default", ["read"])

      conn = post_handshake(%{}, "a_no_cursors")

      assert conn.status == 200
      {:ok, response} = Jason.decode(conn.resp_body)

      group = hd(response["groups"])
      assert group["cursor_valid"] == true
      assert group["cursor"] == 0
    end
  end
end
