defmodule EbbServer.Admin.RouterTest do
  @moduledoc """
  Drives `/admin/apps` through the router: the admin credential gate and the
  registry mutations it exposes.
  """

  use ExUnit.Case, async: false

  import EbbServer.TestHelpers, only: [tmp_dir: 1]

  alias EbbServer.Admin.Router
  alias EbbServer.Apps

  @token "admin-secret"

  setup context do
    key = make_ref()
    name = :"apps_#{System.unique_integer([:positive])}"
    {:ok, pid} = Apps.start_link(data_dir: tmp_dir(context), name: name, key: key)

    on_exit(fn ->
      EbbServer.TestHelpers.safe_stop(pid)
      :persistent_term.erase(key)
    end)

    %{apps: [server: name, key: key]}
  end

  describe "the admin credential" do
    test "a valid bearer token reaches the registry", %{apps: apps} do
      assert %{status: 200, resp_body: body} = call(apps, :get, "/apps")
      assert Jason.decode!(body) == %{"apps" => []}
    end

    test "a missing, malformed, or wrong credential is 401", %{apps: apps} do
      assert %{status: 401} = call(apps, :get, "/apps", nil, :missing_header)
      assert %{status: 401} = call(apps, :get, "/apps", nil, {:header, "Basic nope"})
      assert %{status: 401} = call(apps, :get, "/apps", nil, "wrong")
    end

    test "a node with no credential configured denies rather than opens", %{apps: apps} do
      assert %{status: 403, resp_body: body} = call(apps, :get, "/apps", nil, nil)
      assert Jason.decode!(body)["error"] == "admin_not_configured"
    end

    test "unknown paths are 404 only after authentication", %{apps: apps} do
      assert %{status: 404} = call(apps, :get, "/nope")
      assert %{status: 401} = call(apps, :get, "/nope", nil, "wrong")
    end
  end

  describe "apps" do
    test "register, list, and remove", %{apps: apps} do
      assert %{status: 201, resp_body: body} =
               call(apps, :post, "/apps", %{
                 "name" => "notes",
                 "origins" => ["HTTPS://Notes.Example.com:443"]
               })

      app = Jason.decode!(body)["app"]
      assert app["name"] == "notes"
      assert app["origins"] == ["https://notes.example.com"]
      assert String.starts_with?(app["id"], "app_")
      assert is_binary(app["created_at"])

      assert %{status: 200, resp_body: list} = call(apps, :get, "/apps")
      assert [%{"id" => id}] = Jason.decode!(list)["apps"]
      assert id == app["id"]

      assert %{status: 204, resp_body: ""} = call(apps, :delete, "/apps/#{app["id"]}")
      assert %{status: 404} = call(apps, :delete, "/apps/#{app["id"]}")
      assert %{status: 200, resp_body: list} = call(apps, :get, "/apps")
      assert Jason.decode!(list) == %{"apps" => []}
    end

    test "duplicate names and origins conflict", %{apps: apps} do
      assert %{status: 201} = create(apps, "notes", ["https://notes.example.com"])

      assert %{status: 409, resp_body: body} =
               create(apps, "NOTES", ["https://other.example.com"])

      assert Jason.decode!(body)["error"] == "duplicate_name"

      assert %{status: 409, resp_body: body} =
               create(apps, "issues", ["https://notes.example.com"])

      assert Jason.decode!(body)["error"] == "duplicate_origin"
    end

    test "invalid payloads are 422", %{apps: apps} do
      assert %{status: 422} = create(apps, "notes", ["https://notes.example.com/path"])
      assert %{status: 422} = create(apps, "notes", ["null"])
      assert %{status: 422} = call(apps, :post, "/apps", %{"name" => "notes"})
      assert %{status: 422} = call(apps, :post, "/apps", %{"name" => "notes", "origins" => [1]})
    end

    test "malformed JSON is 400", %{apps: apps} do
      assert %{status: 400} = call_raw(apps, :post, "/apps", "{")
    end
  end

  describe "origins" do
    test "add and remove an origin", %{apps: apps} do
      app = create_app(apps, "notes", ["https://notes.example.com"])
      id = app["id"]
      origin = "https://preview.example.com"

      assert %{status: 200, resp_body: body} =
               call(apps, :post, "/apps/#{id}/origins", %{"origin" => origin})

      assert Jason.decode!(body)["app"]["origins"] == [
               "https://notes.example.com",
               origin
             ]

      assert %{status: 409} = call(apps, :post, "/apps/#{id}/origins", %{"origin" => origin})

      path = "/apps/#{id}/origins/#{URI.encode_www_form(origin)}"
      assert %{status: 200, resp_body: body} = call(apps, :delete, path)
      assert Jason.decode!(body)["app"]["origins"] == ["https://notes.example.com"]

      assert %{status: 404} = call(apps, :delete, path)

      assert %{status: 404} =
               call(apps, :post, "/apps/app_missing/origins", %{"origin" => origin})
    end

    test "an invalid origin is 422", %{apps: apps} do
      app = create_app(apps, "notes", ["https://notes.example.com"])
      assert %{status: 422} = call(apps, :post, "/apps/#{app["id"]}/origins", %{"origin" => "*"})
      assert %{status: 422} = call(apps, :post, "/apps/#{app["id"]}/origins", %{})
    end
  end

  defp create(apps, name, origins) do
    call(apps, :post, "/apps", %{"name" => name, "origins" => origins})
  end

  defp create_app(apps, name, origins) do
    %{status: 201, resp_body: body} = create(apps, name, origins)
    Jason.decode!(body)["app"]
  end

  defp call(apps, method, path, body \\ nil, token \\ @token) do
    encoded = if is_nil(body), do: "", else: Jason.encode!(body)
    call_raw(apps, method, path, encoded, token)
  end

  defp call_raw(apps, method, path, body, token \\ @token) do
    configured = if token == nil, do: nil, else: @token

    conn =
      Plug.Test.conn(method, path, body)
      |> Plug.Conn.put_req_header("content-type", "application/json")
      |> Plug.Conn.assign(:admin_opts, apps: apps, token: configured)

    conn
    |> put_auth(token)
    |> then(&Router.call(&1, []))
  end

  defp put_auth(conn, {:header, value}),
    do: Plug.Conn.put_req_header(conn, "authorization", value)

  defp put_auth(conn, token) when is_binary(token) and token != "",
    do: Plug.Conn.put_req_header(conn, "authorization", "Bearer " <> token)

  defp put_auth(conn, _missing_or_nil), do: conn
end
