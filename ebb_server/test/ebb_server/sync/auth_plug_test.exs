defmodule EbbServer.Sync.AuthPlugTest do
  @moduledoc """
  Behavioral tests for AuthPlug - HTTP authentication middleware.

  AuthPlug extracts or validates actor identity from incoming requests.
  It operates in two modes:

  - `:bypass` - reads actor_id directly from x-ebb-actor-id header
  - `:external` - forwards auth to a configured external auth URL

  ## Key Behaviors Tested

  - Bypass mode: accepts/rejects based on header presence
  - External mode: delegates to auth server, handles success/failure
  - Missing headers: returns 401 appropriately
  - Proper assigns: actor_id is set in conn.assigns
  """

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

  defmodule MockAuthServer500 do
    use Plug.Router
    plug(:match)
    plug(:dispatch)

    post "/auth" do
      conn
      |> put_resp_content_type("application/json")
      |> send_resp(500, Jason.encode!(%{"error" => "internal"}))
    end
  end

  defmodule MockAuthServerInvalidBody do
    use Plug.Router
    plug(:match)
    plug(:dispatch)

    # 200 OK but the response body does not contain a string `actor_id`,
    # which `call_auth_url/2` rejects with `{:error, "invalid auth response"}`.
    post "/auth" do
      conn
      |> put_resp_content_type("application/json")
      |> send_resp(200, Jason.encode!(%{"status" => "ok"}))
    end
  end

  # Records every received request so a test can assert on forwarded
  # headers. Stores the request in an Agent for thread-safe read.
  defmodule HeaderCaptureAgent do
    use Agent

    def start, do: Agent.start_link(fn -> [] end, name: __MODULE__)
    def reset(pid), do: Agent.update(pid, fn _ -> [] end)
    def record(pid, req), do: Agent.update(pid, &(&1 ++ [req]))
    def all(pid), do: Agent.get(pid, & &1)
  end

  defmodule MockAuthServerCapturing do
    use Plug.Router
    plug(:match)
    plug(:dispatch)

    post "/auth" do
      HeaderCaptureAgent.record(:capture, %{
        headers: Enum.into(conn.req_headers, %{}),
        body: conn.body_params
      })

      conn
      |> put_resp_content_type("application/json")
      |> send_resp(200, Jason.encode!(%{"actor_id" => "captured_actor"}))
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

    test "auth server returns 500" do
      {:ok, server_pid} = Bandit.start_link(plug: MockAuthServer500, port: 0, scheme: :http)
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
      # The 401 body should mention "500" so operators can distinguish
      # auth-server-down from a client-side bad-credentials case.
      assert conn.resp_body =~ "500"
    end

    test "auth server returns 200 with invalid body" do
      {:ok, server_pid} =
        Bandit.start_link(plug: MockAuthServerInvalidBody, port: 0, scheme: :http)

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
      assert conn.resp_body =~ "invalid auth response"
    end

    test "auth URL unreachable (connection refused)" do
      # Reserve a free port by opening then closing a server; the OS
      # may reuse it but the request will likely race and fail with
      # `:econnrefused`. Either way, the call_auth_url path must surface
      # an error rather than assign an actor.
      {:ok, server_pid} = Bandit.start_link(plug: MockAuthServer, port: 0, scheme: :http)
      {:ok, {_ip, port}} = ThousandIsland.listener_info(server_pid)
      Process.exit(server_pid, :normal)
      Process.sleep(50)

      Application.put_env(:ebb_server, :auth_mode, :external)
      Application.put_env(:ebb_server, :auth_url, "http://localhost:#{port}/auth")

      conn =
        conn(:post, "/")
        |> Map.put(:req_headers, [{"authorization", "Bearer token123"}])
        |> AuthPlug.call([])

      assert conn.status == 401
      assert conn.halted
      assert conn.resp_body =~ "auth request failed"
    end

    test "forwards authorization, cookie, and x-ebb-token headers" do
      {:ok, agent_pid} = HeaderCaptureAgent.start()
      # Rename the agent for this test (so multiple test runs don't
      # trip on the global name).
      Agent.stop(agent_pid)

      {:ok, agent_pid} =
        Agent.start_link(fn -> [] end, name: :capture)

      on_exit(fn -> if Process.alive?(agent_pid), do: Agent.stop(agent_pid) end)

      {:ok, server_pid} =
        Bandit.start_link(plug: MockAuthServerCapturing, port: 0, scheme: :http)

      {:ok, {_ip, port}} = ThousandIsland.listener_info(server_pid)

      on_exit(fn ->
        if Process.alive?(server_pid), do: Process.exit(server_pid, :normal)
      end)

      Application.put_env(:ebb_server, :auth_mode, :external)
      Application.put_env(:ebb_server, :auth_url, "http://localhost:#{port}/auth")

      conn =
        conn(:post, "/")
        |> Map.put(:req_headers, [
          {"authorization", "Bearer secret-token"},
          {"cookie", "session=abc123"},
          {"x-ebb-token", "opaque-ebb-token"},
          # An unrelated header — should NOT be forwarded.
          {"x-internal-foo", "bar"}
        ])
        |> AuthPlug.call([])

      assert conn.assigns.actor_id == "captured_actor"
      refute conn.halted

      [captured] = HeaderCaptureAgent.all(:capture)
      headers = captured.headers
      assert headers["authorization"] == "Bearer secret-token"
      assert headers["cookie"] == "session=abc123"
      assert headers["x-ebb-token"] == "opaque-ebb-token"

      refute Map.has_key?(headers, "x-internal-foo"),
             "non-allowlisted headers must not be forwarded to the auth URL"
    end
  end
end
