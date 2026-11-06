defmodule EbbServer.CORS do
  @moduledoc """
  Browser-origin admission for the sync and admin surfaces.

  This plug runs after the readiness probe and before `AuthPlug`, so a
  preflight is answered without a credential and an error response (`401`,
  `422`, …) still carries the headers a browser needs to read it. It never
  decides whether a caller may read or write: groups and the authorizer do
  that. Admitting an origin only lets a browser read the response.

  ## What it matches

  Every request with an `Origin` header is matched against, in order:

    1. `allow_any` from `EbbServer.CORS.Policy` (explicit
       `EBB_CORS_ALLOW_ANY`, or the `:bypass` default) → `*`;
    2. the static origins from `EBB_CORS_ORIGINS`;
    3. the registered apps (`EbbServer.Apps.match_origin/1`), which also
       assigns `:app_id` for the audit/grants seam.

  A matched origin is reflected verbatim (never the wildcard pattern) with
  `Vary: Origin`; an exact-origin match also sets
  `Access-Control-Allow-Credentials: true`, so cookie-authenticated apps work
  from a registered origin. `*` is never combined with credentials. No match
  means no `Access-Control-*` headers — the response is still served, the
  browser just refuses to expose it.

  Requests without an `Origin` header (CLI, functions, server-to-server) are
  untouched; CORS is a browser rule and is not an authorization boundary.

  ## Preflight

  `OPTIONS` with `Access-Control-Request-Method` is answered here, before
  auth. It allows `GET`, `POST`, `DELETE`, `OPTIONS` and only the request
  headers the client actually sends, drawn from a fixed set; a method or
  header outside that set is a `403` with no allow headers. `Max-Age` is 300
  seconds so `DELETE /admin/apps/:id` (or removing an origin) revokes within
  about five minutes rather than after a long-lived cache.

  ## Configuration

  The policy is resolved at boot by `EbbServer.CORS.Policy.resolve!/1`; this
  plug reads only the resolved value. Tests can inject `:policy` and
  `:lookup` through `call/2`.
  """

  @behaviour Plug

  import Plug.Conn

  alias EbbServer.Apps.Origin
  alias EbbServer.CORS.Policy

  @allow_methods ~w(GET POST DELETE OPTIONS)
  @allow_headers ~w(accept authorization cache-control content-type last-event-id x-ebb-actor-id)
  @max_age_seconds 300

  @impl true
  def init(opts), do: opts

  @impl true
  def call(conn, opts) do
    policy = Keyword.get(opts, :policy) || Policy.current()
    lookup = Keyword.get(opts, :lookup, &default_lookup/1)

    conn
    |> put_vary()
    |> apply_origin(policy, lookup)
  end

  defp apply_origin(conn, policy, lookup) do
    case request_origin(conn) do
      :none -> conn
      :invalid -> deny(conn)
      origin -> apply_decision(conn, decide(origin, policy, lookup))
    end
  end

  defp apply_decision(conn, {:allow, allowed_origin, app_id}) do
    case preflight(conn) do
      :none ->
        conn
        |> put_allow_headers(allowed_origin)
        |> put_app_id(app_id)

      {:ok, headers} ->
        conn
        |> put_allow_headers(allowed_origin)
        |> put_app_id(app_id)
        |> send_preflight(headers)

      :error ->
        deny_preflight(conn)
    end
  end

  defp apply_decision(conn, :deny), do: deny(conn)

  # The registry is read from `:persistent_term`, so this adds no mailbox
  # traffic to the request path.
  defp default_lookup(origin), do: EbbServer.Apps.match_origin(origin)

  defp request_origin(conn) do
    case get_req_header(conn, "origin") do
      [] ->
        :none

      [origin] when origin != "" ->
        case Origin.normalize(origin) do
          {:ok, canonical} -> canonical
          {:error, :invalid_origin} -> :invalid
        end

      _duplicate_or_empty ->
        :invalid
    end
  end

  defp decide(_origin, %{allow_any: true}, _lookup), do: {:allow, "*", nil}

  defp decide(origin, %{origins: origins}, lookup) do
    if Enum.any?(origins, &Origin.match?(origin, &1)) do
      {:allow, origin, nil}
    else
      case lookup.(origin) do
        {:ok, app_id} -> {:allow, origin, app_id}
        :error -> :deny
      end
    end
  end

  # A wildcard response cannot carry credentials; browsers reject the pair.
  defp put_allow_headers(conn, "*") do
    put_resp_header(conn, "access-control-allow-origin", "*")
  end

  defp put_allow_headers(conn, origin) do
    conn
    |> put_resp_header("access-control-allow-origin", origin)
    |> put_resp_header("access-control-allow-credentials", "true")
  end

  defp put_app_id(conn, nil), do: conn
  defp put_app_id(conn, app_id), do: assign(conn, :app_id, app_id)

  defp put_vary(conn), do: put_resp_header(conn, "vary", "Origin")

  defp preflight(%Plug.Conn{method: "OPTIONS"} = conn) do
    case access_control_request_method(conn) do
      nil ->
        :none

      method ->
        with {:ok, _method} <- requested_method(method),
             {:ok, headers} <- requested_headers(conn) do
          {:ok, headers}
        else
          :error -> :error
        end
    end
  end

  defp preflight(_conn), do: :none

  defp requested_method(method) when is_binary(method) and method != "" do
    normalized = String.upcase(method)
    if normalized in @allow_methods, do: {:ok, normalized}, else: :error
  end

  defp requested_method(_missing), do: :error

  defp access_control_request_method(conn) do
    case get_req_header(conn, "access-control-request-method") do
      [method] -> method
      _missing_or_repeated -> nil
    end
  end

  defp requested_headers(conn) do
    headers =
      conn
      |> get_req_header("access-control-request-headers")
      |> Enum.flat_map(&String.split(&1, ",", trim: true))
      |> Enum.map(&(&1 |> String.trim() |> String.downcase()))
      |> Enum.reject(&(&1 == ""))
      |> Enum.uniq()

    if Enum.all?(headers, &(&1 in @allow_headers)) do
      {:ok, headers}
    else
      :error
    end
  end

  defp send_preflight(conn, headers) do
    conn
    |> put_resp_header(
      "vary",
      "Origin, Access-Control-Request-Method, Access-Control-Request-Headers"
    )
    |> put_resp_header("access-control-allow-methods", Enum.join(@allow_methods, ", "))
    |> maybe_put_allow_headers(headers)
    |> put_resp_header("access-control-max-age", Integer.to_string(@max_age_seconds))
    |> send_resp(204, "")
    |> halt()
  end

  defp maybe_put_allow_headers(conn, []), do: conn

  defp maybe_put_allow_headers(conn, headers) do
    put_resp_header(conn, "access-control-allow-headers", Enum.join(headers, ", "))
  end

  defp deny(conn) do
    if access_control_request_method(conn), do: deny_preflight(conn), else: conn
  end

  defp deny_preflight(conn) do
    conn
    |> put_resp_content_type("application/json")
    |> send_resp(403, ~s({"error":"cors_preflight_denied"}))
    |> halt()
  end
end
