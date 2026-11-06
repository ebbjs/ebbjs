defmodule EbbServer.Functions.Admin do
  @moduledoc """
  The functions deploy credential.

  Rolling out code is an operator action, not an invocation. It is gated by the
  node-level admin token (`EbbServer.Admin.Token`), presented as
  `Authorization: Bearer <token>`. That token is a separate credential from
  whatever `AuthPlug` resolved the caller from, and holding it never implies
  invoke permission: the actor behind the request still needs its
  `function.<name>` grant to call the function it just deployed, exactly as it
  would for any other.

  A node with no token configured has no admin credential, so the admin routes
  deny rather than open. This module keeps the functions router's
  `{:error, :denied}` shape for both cases; `EbbServer.Admin.Token` is the one
  implementation of resolution and constant-time comparison, shared with the
  app registry's admin routes.

  `:admin_token` under `:ebb_server, :functions` still configures the
  credential (and `EBB_FUNCTIONS_ADMIN_TOKEN` still overlays it), but
  `EBB_ADMIN_TOKEN` / `:ebb_server, :admin_token` takes precedence.
  """

  alias EbbServer.Admin.Token
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
    token =
      case Keyword.fetch(opts, :admin_token) do
        {:ok, value} -> value
        :error -> Functions.admin_token()
      end

    case Token.authorize(conn, token: token) do
      :ok -> :ok
      _denied -> {:error, :denied}
    end
  end
end
