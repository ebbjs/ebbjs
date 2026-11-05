defmodule EbbServer.Sync.AuthPlug do
  @moduledoc """
  Plug-based authentication for EbbServer.

  Supports three modes:
  - `:bypass` - reads actor_id from `x-ebb-actor-id` request header
  - `:external` - forwards auth headers to a configured auth URL
  - `:tailscale` - trusts `tailscale-user-login` from a loopback peer

  The mode is resolved once at boot by `EbbServer.Application.runtime_auth/0`
  from `EBB_AUTH_MODE` and `EBB_AUTH_URL`, which win over
  `Application.get_env/2`, and written back to the application env. This
  plug reads `:auth_mode` and `:auth_url` from that env unchanged.

  ## Tailscale mode

  A Tailscale gateway (the embedded node, a `tailscale serve`, or a sidecar)
  sits in front of the server and injects the connecting user's identity. The
  server trusts those headers only when all of these hold:

    - `conn.remote_ip` is loopback (`127.0.0.1` or `::1`); the application also
      binds Bandit to `127.0.0.1`, but the check is the enforcement;
    - exactly one non-empty `tailscale-user-login` header is present;
    - when `:tailscale_proxy_secret` is configured, exactly one
      `x-ebb-tailscale-secret` header matches it.

  The login becomes `actor_id` unchanged (design D3). `tailscale-user-name` is
  kept as a display name only, and `x-ebb-tailscale-user-id` as an optional
  gateway-supplied provider id (published as a JSON number); neither affects
  authorization. `x-ebb-actor-id` is ignored in this mode: there is no
  fallback, because a fallback would let the browser choose its own identity.

  `tailscale serve` cannot inject a secret, so a deployment without the embedded
  gateway leaves `:tailscale_proxy_secret` unset and relies on loopback alone.
  Any local process could then claim an identity, which is why the embedded
  gateway always configures one. A configured secret must be a non-empty
  string; the application rejects anything else at boot.

  There is no default mode. A node booted without `EBB_AUTH_MODE` (or a
  compiled `:auth_mode`) refuses to start, and `:external` without a URL
  fails at boot as well. The request-time `500` for a missing
  `:auth_url` only covers configuration mutated after boot.

  ## Security warning

  `:bypass` mode is intended for local dev and the demo only, and logs a
  warning at boot. Any actor can claim any identity by sending
  `x-ebb-actor-id: <anything>` — there is no signature, no session, no
  verification. Production deployments MUST run in `:external` or
  `:tailscale` mode.
  """

  @behaviour Plug

  import Plug.Conn

  @loopback_addresses [{127, 0, 0, 1}, {0, 0, 0, 0, 0, 0, 0, 1}]

  @impl true
  def init(opts), do: opts

  @impl true
  def call(conn, _opts) do
    # A function service credential authenticates the request at the functions
    # router, which verifies it against the configured credentials. This plug
    # must not also try to resolve an actor for it: the service is the
    # principal, and asking the identity service about a job token would both
    # fail and leak the token. The header is not copied onto the conn for the
    # same reason; the router reads it itself. On a sync route no actor is
    # assigned, so the route denies exactly as an anonymous request would.
    if service_token?(conn) do
      conn
    else
      case auth_mode() do
        :bypass -> bypass_auth(conn)
        :external -> external_auth(conn)
        :tailscale -> tailscale_auth(conn)
      end
    end
  end

  defp service_token?(conn) do
    case get_req_header(conn, "x-ebb-service-token") do
      [token] when token != "" -> true
      _missing_or_repeated -> false
    end
  end

  # Boot always writes the resolved mode, so a missing value means the
  # plug is running outside `EbbServer.Application`; fail loudly rather
  # than picking a mode.
  defp auth_mode do
    Application.fetch_env!(:ebb_server, :auth_mode)
  end

  defp bypass_auth(conn) do
    actor_id =
      case get_req_header(conn, "x-ebb-actor-id") do
        [actor_id] when actor_id != "" -> actor_id
        _ -> nil
      end

    case actor_id do
      id when is_binary(id) and id != "" ->
        conn
        |> assign(:actor_id, id)
        |> assign(:actor_provider, "bypass")

      _ ->
        unauthorized(conn, "missing x-ebb-actor-id header")
    end
  end

  defp external_auth(conn) do
    auth_url = Application.get_env(:ebb_server, :auth_url)

    if is_nil(auth_url) do
      conn
      |> put_resp_content_type("application/json")
      |> send_resp(500, Jason.encode!(%{"error" => "auth_url not configured"}))
      |> halt()
    else
      headers = extract_auth_headers(conn)

      case call_auth_url(auth_url, headers) do
        {:ok, actor_id} ->
          conn
          |> assign(:actor_id, actor_id)
          |> assign(:actor_provider, "external")

        {:error, reason} ->
          unauthorized(conn, reason)
      end
    end
  end

  # Order matters only for which error the client sees: a non-loopback peer is
  # rejected before its headers are inspected.
  defp tailscale_auth(conn) do
    with :ok <- loopback_peer(conn),
         {:ok, login} <- single_header(conn, "tailscale-user-login"),
         :ok <- verify_tailscale_proxy_secret(conn) do
      conn
      |> assign(:actor_id, login)
      |> assign(:actor_provider, "tailscale")
      |> assign_optional(:actor_display_name, "tailscale-user-name")
      |> assign_provider_id()
    else
      {:error, details} -> unauthorized(conn, details)
    end
  end

  defp loopback_peer(conn) do
    if conn.remote_ip in @loopback_addresses do
      :ok
    else
      {:error, "tailscale identity headers are trusted only from loopback"}
    end
  end

  # A gateway forwards a trusted header once. Two copies, an empty value, or a
  # missing header are all rejected rather than one being picked, because a
  # duplicate is how a spoofing attempt reaches a trusting proxy.
  defp single_header(conn, header) do
    case get_req_header(conn, header) do
      [value] when value != "" ->
        {:ok, value}

      [] ->
        {:error, "missing #{header} header"}

      [_empty] ->
        {:error, "empty #{header} header"}

      _duplicates ->
        {:error, "duplicate #{header} header"}
    end
  end

  # An unset secret is the `tailscale serve` path: loopback is the only
  # credential. A misconfigured one fails closed (the application rejects a bad
  # value at boot) instead of silently degrading to that weaker rule.
  defp verify_tailscale_proxy_secret(conn) do
    case Application.get_env(:ebb_server, :tailscale_proxy_secret) do
      nil ->
        :ok

      secret when is_binary(secret) ->
        compare_proxy_secret(conn, secret)

      _misconfigured ->
        {:error, "invalid tailscale proxy secret configuration"}
    end
  end

  defp compare_proxy_secret(conn, secret) do
    case single_header(conn, "x-ebb-tailscale-secret") do
      {:ok, supplied} -> proxy_secret_matches?(supplied, secret)
      {:error, _} = error -> error
    end
  end

  defp proxy_secret_matches?(supplied, secret) do
    if Plug.Crypto.secure_compare(supplied, secret),
      do: :ok,
      else: {:error, "wrong x-ebb-tailscale-secret header"}
  end

  # Display metadata is informational, so a malformed value is dropped rather
  # than rejecting an otherwise authenticated request.
  defp assign_optional(conn, assign_key, header) do
    case single_header(conn, header) do
      {:ok, value} -> assign(conn, assign_key, value)
      {:error, _} -> conn
    end
  end

  # The gateway supplies Tailscale's numeric user id as text; the endpoint
  # publishes it as a JSON number, and drops it when it is absent or not
  # numeric because nothing authorization-related depends on it.
  defp assign_provider_id(conn) do
    with {:ok, raw} <- single_header(conn, "x-ebb-tailscale-user-id"),
         {id, ""} <- Integer.parse(raw) do
      assign(conn, :actor_provider_id, id)
    else
      _absent_or_not_numeric -> conn
    end
  end

  defp unauthorized(conn, details) do
    conn
    |> put_resp_content_type("application/json")
    |> send_resp(401, Jason.encode!(%{"error" => "unauthorized", "details" => details}))
    |> halt()
  end

  defp extract_auth_headers(conn) do
    conn.req_headers
    |> Enum.filter(fn {name, _} -> name in ["authorization", "cookie", "x-ebb-token"] end)
  end

  defp call_auth_url(url, headers) do
    case Req.post(url, headers: headers, receive_timeout: 5_000) do
      {:ok, %Req.Response{status: 200, body: %{"actor_id" => actor_id}}}
      when is_binary(actor_id) ->
        {:ok, actor_id}

      {:ok, %Req.Response{status: 200}} ->
        {:error, "invalid auth response"}

      {:ok, %Req.Response{status: status}} ->
        {:error, "auth server returned #{status}"}

      {:error, exception} ->
        {:error, "auth request failed: #{Exception.message(exception)}"}
    end
  end
end
