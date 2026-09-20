defmodule EbbServer.Sync.AuthPlug do
  @moduledoc """
  Plug-based authentication for EbbServer.

  Supports two modes:
  - `:bypass` - reads actor_id from `x-ebb-actor-id` request header
  - `:external` - forwards auth headers to a configured auth URL

  Configure via `Application.get_env(:ebb_server, :auth_mode)` and
  `Application.get_env(:ebb_server, :auth_url)`.

  ## Security warning

  `:bypass` mode is intended for local dev and the demo only. Any actor
  can claim any identity by sending `x-ebb-actor-id: <anything>` — there
  is no signature, no session, no verification. Production deployments
  MUST run in `:external` mode and point `:auth_url` at a real identity
  service.
  """

  @behaviour Plug

  import Plug.Conn

  @impl true
  def init(opts), do: opts

  @impl true
  def call(conn, _opts) do
    case auth_mode() do
      :bypass -> bypass_auth(conn)
      :external -> external_auth(conn)
    end
  end

  defp auth_mode do
    Application.get_env(:ebb_server, :auth_mode, :external)
  end

  defp bypass_auth(conn) do
    actor_id =
      case get_req_header(conn, "x-ebb-actor-id") do
        [actor_id] when actor_id != "" -> actor_id
        _ -> nil
      end

    case actor_id do
      id when is_binary(id) and id != "" ->
        assign(conn, :actor_id, id)

      _ ->
        conn
        |> put_resp_content_type("application/json")
        |> send_resp(
          401,
          Jason.encode!(%{
            "error" => "unauthorized",
            "details" => "missing x-ebb-actor-id header"
          })
        )
        |> halt()
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
          assign(conn, :actor_id, actor_id)

        {:error, reason} ->
          conn
          |> put_resp_content_type("application/json")
          |> send_resp(401, Jason.encode!(%{"error" => "unauthorized", "details" => reason}))
          |> halt()
      end
    end
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
