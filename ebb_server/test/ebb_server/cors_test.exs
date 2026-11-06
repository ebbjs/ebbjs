defmodule EbbServer.CORSTest do
  @moduledoc """
  Drives the CORS plug: origin matching, reflection, `Vary`, credentials,
  preflight, and the no-match path that leaves non-browser callers untouched.
  """

  use ExUnit.Case, async: true

  import Plug.Conn
  import Plug.Test, only: [conn: 2]

  alias EbbServer.CORS

  @exact %{allow_any: false, origins: ["https://app.example.com"]}

  test "a request without an Origin header is untouched" do
    conn = CORS.call(conn(:get, "/sync/handshake"), policy: deny_all())

    refute header(conn, "access-control-allow-origin")
    assert header(conn, "vary") == "Origin"
    refute conn.halted
  end

  test "a static exact origin is reflected with Vary and credentials" do
    conn = CORS.call(get("https://app.example.com"), policy: @exact)

    assert header(conn, "access-control-allow-origin") == "https://app.example.com"
    assert header(conn, "access-control-allow-credentials") == "true"
    assert header(conn, "vary") == "Origin"
  end

  test "the request origin is normalized before it is reflected" do
    conn = CORS.call(get("HTTPS://APP.EXAMPLE.COM:443"), policy: @exact)

    assert header(conn, "access-control-allow-origin") == "https://app.example.com"
  end

  test "a wildcard pattern matches subdomains but never the parent domain" do
    policy = %{allow_any: false, origins: ["https://*.example.com"]}

    assert header(
             CORS.call(get("https://a.example.com"), policy: policy),
             "access-control-allow-origin"
           ) ==
             "https://a.example.com"

    assert header(
             CORS.call(get("https://a.b.example.com"), policy: policy),
             "access-control-allow-origin"
           ) ==
             "https://a.b.example.com"

    conn = CORS.call(get("https://example.com"), policy: policy)
    refute header(conn, "access-control-allow-origin")
  end

  test "a registered app admits its origin and assigns the app id" do
    lookup = fn "https://notes.example.com" -> {:ok, "app_notes"} end
    conn = CORS.call(get("https://notes.example.com"), policy: deny_all(), lookup: lookup)

    assert header(conn, "access-control-allow-origin") == "https://notes.example.com"
    assert conn.assigns.app_id == "app_notes"
  end

  test "the static-origin path does not assign an app id" do
    conn = CORS.call(get("https://app.example.com"), policy: @exact)
    refute Map.has_key?(conn.assigns, :app_id)
  end

  test "no match adds no Access-Control headers but still serves the request" do
    conn = CORS.call(get("https://evil.example.com"), policy: @exact)

    refute header(conn, "access-control-allow-origin")
    refute header(conn, "access-control-allow-credentials")
    assert header(conn, "vary") == "Origin"
    refute conn.halted
  end

  test "allow_any answers with a bare wildcard and no credentials" do
    conn = CORS.call(get("https://anything.example"), policy: %{allow_any: true, origins: []})

    assert header(conn, "access-control-allow-origin") == "*"
    refute header(conn, "access-control-allow-credentials")
  end

  test "duplicate Origin headers and null are refused" do
    duplicated =
      conn(:get, "/sync/handshake")
      |> prepend_req_headers([
        {"origin", "https://app.example.com"},
        {"origin", "https://app.example.com"}
      ])

    refute header(CORS.call(duplicated, policy: @exact), "access-control-allow-origin")
    refute header(CORS.call(get("null"), policy: @exact), "access-control-allow-origin")
  end

  describe "preflight" do
    test "an allowed preflight answers 204 with methods, requested headers, and Max-Age" do
      conn =
        preflight("POST", "content-type, X-Ebb-Actor-Id")
        |> CORS.call(policy: @exact)

      assert conn.status == 204
      assert header(conn, "access-control-allow-origin") == "https://app.example.com"
      assert header(conn, "access-control-allow-methods") == "GET, POST, DELETE, OPTIONS"
      assert header(conn, "access-control-allow-headers") == "content-type, x-ebb-actor-id"
      assert header(conn, "access-control-max-age") == "300"
      assert header(conn, "vary") =~ "Access-Control-Request-Method"
      assert conn.halted
    end

    test "preflight omits allow-headers when the client asks for none" do
      conn = preflight("GET", nil) |> CORS.call(policy: @exact)

      assert conn.status == 204
      refute header(conn, "access-control-allow-headers")
    end

    test "an unknown method is refused before auth" do
      conn = preflight("PUT", nil) |> CORS.call(policy: @exact)

      assert conn.status == 403
      refute header(conn, "access-control-allow-origin")
      assert conn.halted
    end

    test "an unknown requested header is refused" do
      conn = preflight("POST", "x-secret") |> CORS.call(policy: @exact)

      assert conn.status == 403
      refute header(conn, "access-control-allow-headers")
    end

    test "an unmatched origin is refused" do
      conn =
        preflight("POST", "content-type", "https://evil.example") |> CORS.call(policy: @exact)

      assert conn.status == 403
      refute header(conn, "access-control-allow-origin")
    end

    test "an OPTIONS request without Access-Control-Request-Method is not a preflight" do
      conn =
        conn(:options, "/sync/actions")
        |> put_req_header("origin", "https://app.example.com")
        |> CORS.call(policy: @exact)

      refute conn.status
      refute conn.halted
      assert header(conn, "access-control-allow-origin") == "https://app.example.com"
    end
  end

  defp get(origin) do
    conn(:get, "/sync/handshake")
    |> put_req_header("origin", origin)
  end

  defp preflight(method, headers, origin \\ "https://app.example.com") do
    conn =
      conn(:options, "/sync/actions")
      |> put_req_header("origin", origin)
      |> put_req_header("access-control-request-method", method)

    if headers do
      put_req_header(conn, "access-control-request-headers", headers)
    else
      conn
    end
  end

  defp deny_all, do: %{allow_any: false, origins: []}

  defp header(conn, name) do
    conn.resp_headers
    |> Enum.find_value(fn {key, value} -> if key == name, do: value end)
  end
end
