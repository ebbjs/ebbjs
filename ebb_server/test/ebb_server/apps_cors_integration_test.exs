defmodule EbbServer.AppsCORSIntegrationTest do
  @moduledoc """
  End-to-end acceptance for #729 through the real router: an app's origin is
  refused until it is registered, registration admits the handshake and SSE
  preflight, revocation is immediate for new requests, and auth failures carry
  the CORS headers a browser needs to read them.
  """

  use ExUnit.Case, async: false
  use EbbServer.Integration.StorageCase, with_auth_mode: true

  import Plug.Conn
  import Plug.Test, only: [conn: 2, conn: 3]
  import EbbServer.TestHelpers, only: [put_config: 2, safe_stop: 1, tmp_dir: 1]

  alias EbbServer.Apps
  alias EbbServer.Storage.{CacheTables, GroupCache, WatermarkTracker}
  alias EbbServer.Sync.Router

  @token "integration-admin"
  @origin "https://notes.example.com"

  setup context do
    put_config(:cors, %{allow_any: false, origins: []})

    key = {Apps, :apps}
    name = :"apps_#{System.unique_integer([:positive])}"
    {:ok, pid} = Apps.start_link(data_dir: tmp_dir(context), name: name, key: key)

    on_exit(fn ->
      safe_stop(pid)
      :persistent_term.erase(key)
    end)

    %{apps: [server: name, key: key]}
  end

  test "a cross-origin app is refused until its origin is registered", %{apps: apps} do
    refused = handshake()
    refute header(refused, "access-control-allow-origin")
    assert refused.status == 200

    app = register(apps, @origin)

    admitted = handshake()
    assert header(admitted, "access-control-allow-origin") == @origin
    assert header(admitted, "access-control-allow-credentials") == "true"
    assert admitted.assigns.app_id == app["id"]
    assert admitted.status == 200

    assert %{status: 204} = delete_app(apps, app["id"])

    revoked = handshake()
    refute header(revoked, "access-control-allow-origin")
    assert revoked.status == 200
  end

  test "preflight succeeds before registration and names the client's headers", %{apps: apps} do
    app = register(apps, @origin)

    preflight =
      conn(:options, "/sync/actions")
      |> put_req_header("origin", @origin)
      |> put_req_header("access-control-request-method", "POST")
      |> put_req_header("access-control-request-headers", "content-type, x-ebb-actor-id")
      |> Router.call([])

    assert preflight.status == 204
    assert header(preflight, "access-control-allow-origin") == @origin
    assert header(preflight, "access-control-allow-methods") == "GET, POST, DELETE, OPTIONS"
    assert header(preflight, "access-control-allow-headers") == "content-type, x-ebb-actor-id"
    assert header(preflight, "access-control-max-age") == "300"

    sse =
      conn(:options, "/sync/live?groups=g_1&cursor=0")
      |> put_req_header("origin", @origin)
      |> put_req_header("access-control-request-method", "GET")
      |> put_req_header("access-control-request-headers", "last-event-id")
      |> Router.call([])

    assert sse.status == 204
    assert header(sse, "access-control-allow-headers") == "last-event-id"

    # The app still exists after the two preflights; they mutate nothing.
    assert [%{"id" => id}] = list_apps(apps)
    assert id == app["id"]
  end

  test "a registered origin can write", %{apps: apps} do
    register(apps, @origin)

    response =
      conn(:post, "/sync/actions", Msgpax.pack!(%{"actions" => []}) |> IO.iodata_to_binary())
      |> put_req_header("content-type", "application/msgpack")
      |> put_req_header("x-ebb-actor-id", "actor_1")
      |> put_req_header("origin", @origin)
      |> Router.call([])

    assert response.status == 200
    assert Jason.decode!(response.resp_body) == %{"rejected" => []}
    assert header(response, "access-control-allow-origin") == @origin
  end

  test "an admitted SSE response carries the CORS headers", %{apps: apps} do
    register(apps, @origin)
    group_id = "g_cors_#{System.unique_integer([:positive])}"

    :ok =
      GroupCache.put_group_member(
        %{
          id: "gm_#{System.unique_integer([:positive])}",
          actor_id: "actor_1",
          group_id: group_id,
          permissions: ["read"]
        },
        group_members: CacheTables.group_members(),
        group_members_by_id: CacheTables.group_members_by_id(),
        group_members_by_group: CacheTables.group_members_by_group()
      )

    cursor = WatermarkTracker.committed_watermark() + 1

    response =
      conn(:get, "/sync/live?groups=#{group_id}&cursor=#{cursor}")
      |> put_req_header("x-ebb-actor-id", "actor_1")
      |> put_req_header("origin", @origin)
      |> Router.call([])

    assert response.status == 200
    assert header(response, "content-type") =~ "text/event-stream"
    assert header(response, "access-control-allow-origin") == @origin
  end

  test "a 401 carries the CORS headers", %{apps: apps} do
    register(apps, @origin)

    response =
      conn(:get, "/entities/anything")
      |> put_req_header("origin", @origin)
      |> Router.call([])

    assert response.status == 401
    assert header(response, "access-control-allow-origin") == @origin
  end

  test "admin routes fail closed without the credential and work with it", %{apps: apps} do
    unauthenticated = admin(apps, :get, "/admin/apps", nil, :missing_header)
    assert unauthenticated.status == 401

    assert [] = list_apps(apps)
  end

  test "an unconfigured node denies admin routes rather than opening them", %{apps: apps} do
    response = admin(apps, :get, "/admin/apps", nil, nil)
    assert response.status == 403
    assert Jason.decode!(response.resp_body)["error"] == "admin_not_configured"
  end

  test "non-browser clients are unaffected" do
    refusal = conn(:get, "/entities/anything") |> Router.call([])
    assert refusal.status == 401
    refute header(refusal, "access-control-allow-origin")
  end

  defp handshake do
    conn(:post, "/sync/handshake", Jason.encode!(%{}))
    |> put_req_header("content-type", "application/json")
    |> put_req_header("x-ebb-actor-id", "actor_1")
    |> put_req_header("origin", @origin)
    |> Router.call([])
  end

  defp register(apps, origin) do
    %{status: 201, resp_body: body} =
      admin(apps, :post, "/admin/apps", %{"name" => "notes", "origins" => [origin]})

    Jason.decode!(body)["app"]
  end

  defp delete_app(apps, id), do: admin(apps, :delete, "/admin/apps/#{id}")

  defp list_apps(apps) do
    %{status: 200, resp_body: body} = admin(apps, :get, "/admin/apps")
    Jason.decode!(body)["apps"]
  end

  defp admin(apps, method, path, body \\ nil, token \\ @token) do
    encoded = if is_nil(body), do: "", else: Jason.encode!(body)
    configured = if token == nil, do: nil, else: @token

    conn(method, path, encoded)
    |> put_req_header("content-type", "application/json")
    |> Plug.Conn.assign(:admin_opts, apps: apps, token: configured)
    |> put_admin_auth(token)
    |> then(&Router.call(&1, []))
  end

  defp put_admin_auth(conn, {:header, value}),
    do: put_req_header(conn, "authorization", value)

  defp put_admin_auth(conn, token) when is_binary(token) and token != "",
    do: put_req_header(conn, "authorization", "Bearer " <> token)

  defp put_admin_auth(conn, _missing_or_nil), do: conn

  defp header(conn, name) do
    conn.resp_headers
    |> Enum.find_value(fn {key, value} -> if key == name, do: value end)
  end
end
