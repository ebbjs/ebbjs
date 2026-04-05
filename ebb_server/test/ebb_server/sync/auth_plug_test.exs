defmodule EbbServer.Sync.AuthPlugTest do
  use ExUnit.Case, async: false

  import Plug.Test
  alias EbbServer.Sync.AuthPlug

  setup do
    original_mode = Application.get_env(:ebb_server, :auth_mode)
    original_url = Application.get_env(:ebb_server, :auth_url)

    on_exit(fn ->
      if original_mode,
        do: Application.put_env(:ebb_server, :auth_mode, original_mode),
        else: Application.delete_env(:ebb_server, :auth_mode)

      if original_url,
        do: Application.put_env(:ebb_server, :auth_url, original_url),
        else: Application.delete_env(:ebb_server, :auth_url)
    end)

    :ok
  end

  defmodule MockAuthServer do
    use Plug.Router
    plug(:match)
    plug(:dispatch)

    post "/auth" do
      conn
      |> put_resp_content_type("application/json")
      |> send_resp(200, Jason.encode!(%{"actor_id" => "ext_actor"}))
    end
  end

  defmodule MockAuthServer401 do
    use Plug.Router
    plug(:match)
    plug(:dispatch)

    post "/auth" do
      conn
      |> put_resp_content_type("application/json")
      |> send_resp(401, Jason.encode!(%{"error" => "unauthorized"}))
    end
  end

  describe "bypass mode" do
    test "valid header assigns actor_id" do
      Application.put_env(:ebb_server, :auth_mode, :bypass)

      conn =
        conn(:post, "/")
        |> Map.put(:req_headers, [{"x-ebb-actor-id", "actor_123"}])
        |> AuthPlug.call([])

      assert conn.assigns.actor_id == "actor_123"
      refute conn.halted
    end

    test "missing header returns 401" do
      Application.put_env(:ebb_server, :auth_mode, :bypass)

      conn =
        conn(:post, "/")
        |> AuthPlug.call([])

      assert conn.status == 401
      assert conn.halted
    end

    test "empty header returns 401" do
      Application.put_env(:ebb_server, :auth_mode, :bypass)

      conn =
        conn(:post, "/")
        |> Map.put(:req_headers, [{"x-ebb-actor-id", ""}])
        |> AuthPlug.call([])

      assert conn.status == 401
      assert conn.halted
    end
  end

  describe "external mode" do
    test "missing auth_url returns 500" do
      Application.put_env(:ebb_server, :auth_mode, :external)
      Application.delete_env(:ebb_server, :auth_url)

      conn =
        conn(:post, "/")
        |> AuthPlug.call([])

      assert conn.status == 500
      assert conn.halted
    end

    test "successful auth with mock server" do
      {:ok, server_pid} = Bandit.start_link(plug: MockAuthServer, port: 0, scheme: :http)
      {:ok, {_ip, port}} = ThousandIsland.listener_info(server_pid)

      on_exit(fn ->
        if Process.alive?(server_pid), do: Process.exit(server_pid, :normal)
      end)

      Application.put_env(:ebb_server, :auth_mode, :external)
      Application.put_env(:ebb_server, :auth_url, "http://localhost:#{port}/auth")

      conn =
        conn(:post, "/")
        |> Map.put(:req_headers, [{"authorization", "Bearer token123"}])
        |> AuthPlug.call([])

      assert conn.assigns.actor_id == "ext_actor"
      refute conn.halted
    end

    test "auth server returns 401" do
      {:ok, server_pid} = Bandit.start_link(plug: MockAuthServer401, port: 0, scheme: :http)
      {:ok, {_ip, port}} = ThousandIsland.listener_info(server_pid)

      on_exit(fn ->
        if Process.alive?(server_pid), do: Process.exit(server_pid, :normal)
      end)

      Application.put_env(:ebb_server, :auth_mode, :external)
      Application.put_env(:ebb_server, :auth_url, "http://localhost:#{port}/auth")

      conn =
        conn(:post, "/")
        |> Map.put(:req_headers, [{"authorization", "Bearer token123"}])
        |> AuthPlug.call([])

      assert conn.status == 401
      assert conn.halted
    end
  end
end
