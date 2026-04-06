defmodule EbbServer.Sync.HandshakeTest do
  use ExUnit.Case, async: false

  import Plug.Test
  import Plug.Conn
  import EbbServer.TestHelpers
  alias EbbServer.Storage.SystemCache
  alias EbbServer.Sync.Router

  setup do
    if pid = Process.whereis(EbbServer.Storage.Supervisor) do
      GenServer.stop(pid)
      :timer.sleep(200)
    end

    tmp_dir =
      tmp_dir(%{module: __MODULE__, test: "handshake_#{:erlang.unique_integer([:positive])}"})

    Application.put_env(:ebb_server, :data_dir, tmp_dir)

    case EbbServer.Storage.Supervisor.start_link(data_dir: tmp_dir) do
      {:ok, _pid} -> :ok
      {:error, {:already_started, _pid}} -> :ok
    end

    on_exit(fn ->
      try do
        if pid = Process.whereis(EbbServer.Storage.Supervisor) do
          :ok = GenServer.stop(pid, :normal, 5000)
        end
      catch
        _, _ -> :ok
      end

      Application.delete_env(:ebb_server, :data_dir)
    end)

    %{tmp_dir: tmp_dir}
  end

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
    rel_id = "rel_" <> Nanoid.generate()

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
            "actor_id" => actor_id,
            "group_id" => group_id,
            "permissions" => permissions
          }
        },
        %{
          "id" => rel_id,
          "subject_id" => rel_id,
          "subject_type" => "relationship",
          "method" => "put",
          "data" => %{
            "source_id" => "todo_bootstrap",
            "target_id" => group_id,
            "type" => "todo",
            "field" => "group"
          }
        }
      ]
    }

    post_actions(msgpack_encode!(%{"actions" => [action]}), actor_id)
    :ok
  end

  describe "POST /sync/handshake" do
    test "handshake with no groups returns empty list" do
      Application.put_env(:ebb_server, :auth_mode, :bypass)

      conn = post_handshake(%{"cursors" => %{}, "schema_version" => 1}, "a_new")

      assert conn.status == 200
      {:ok, response} = Jason.decode(conn.resp_body)
      assert response["actor_id"] == "a_new"
      assert response["groups"] == []
    end

    test "handshake returns actor's groups after bootstrap" do
      Application.put_env(:ebb_server, :auth_mode, :bypass)

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
      Application.put_env(:ebb_server, :auth_mode, :bypass)

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
      Application.put_env(:ebb_server, :auth_mode, :bypass)

      conn =
        conn(:post, "/sync/handshake", Jason.encode!(%{}))
        |> put_req_header("content-type", "application/json")
        |> Router.call([])

      assert conn.status == 401
    end

    test "handshake accepts cursors (stub validation)" do
      Application.put_env(:ebb_server, :auth_mode, :bypass)

      conn = post_handshake(%{"cursors" => %{"g_1" => 100}, "schema_version" => 1}, "a_test")

      assert conn.status == 200
    end
  end
end
