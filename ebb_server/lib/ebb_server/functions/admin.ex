defmodule EbbServer.Functions.Admin do
  @moduledoc """
  The deploy credential that upload and activation require.

  Rolling out code is an operator action, not an invocation. It is gated by one
  node-level token, configured as `:admin_token` under the nested
  `:ebb_server, :functions` key, and presented as
  `Authorization: Bearer <token>`. That token is a separate credential from
  whatever `AuthPlug` resolved the caller from, and holding it never implies
  invoke permission: the actor behind the request still needs its
  `function.<name>` grant to call the function it just deployed, exactly as it
  would for any other.

  A node with no token configured has no admin credential, so the admin routes
  deny rather than open. That is the point of failing closed here: a missing
  secret is an operational mistake, and answering `403` is recoverable in a way
  that an unauthenticated deploy route is not.

  Comparison is constant time (`Plug.Crypto.secure_compare/2`) and only
  happens once both sides are known non-empty strings, so a request cannot
  learn the token's length, nor which byte differs, from timing or from which
  branch answered.
  """

  alias EbbServer.Functions

  @type error :: {:error, :denied}

  @doc """
  Authorizes a request to deploy or activate.

  Options:

    * `:admin_token` — the credential to compare against (default:
      `EbbServer.Functions.admin_token/0`). Tests pass their own so they do not
      have to mutate application config.
  """
  @spec authorize(Plug.Conn.t(), keyword()) :: :ok | error()
  def authorize(conn, opts \\ []) do
    token = Keyword.get(opts, :admin_token) || Functions.admin_token()

    with true <- configured?(token),
         {:ok, presented} <- bearer(Plug.Conn.get_req_header(conn, "authorization")),
         true <- Plug.Crypto.secure_compare(presented, token) do
      :ok
    else
      _denied -> {:error, :denied}
    end
  end

  defp configured?(token), do: is_binary(token) and token != ""

  # The scheme is case-insensitive per RFC 6750; the token is not, and is
  # compared verbatim.
  defp bearer([header]) do
    case String.split(header, " ", parts: 2) do
      [scheme, presented] when presented != "" ->
        if String.downcase(scheme) == "bearer", do: {:ok, presented}, else: :error

      _malformed ->
        :error
    end
  end

  defp bearer(_headers), do: :error
end
